// Domain logic for HUMO Card payments:
// Access control, unique amount allocation, and atomic CAS state transitions.

export type PaymentMonitorMode = "disabled" | "admin_only" | "all";

export interface CardPaymentConfig {
  mode: PaymentMonitorMode;
  ttlSeconds: number;
  minExtra: number;
  maxExtra: number;
  cardLast4: string;
  cardNumber: string;
  adminUsername: string;
  humoChatId: string;
}

export function getCardPaymentConfig(): CardPaymentConfig {
  const modeRaw = (process.env.PAYMENT_MONITOR_MODE || "admin_only").trim().toLowerCase();
  const mode: PaymentMonitorMode =
    modeRaw === "all" ? "all" : modeRaw === "disabled" ? "disabled" : "admin_only";

  const ttlSeconds = Math.max(60, Number.parseInt(process.env.CARD_PAYMENT_TTL_SECONDS || "300", 10) || 300);
  const minExtra = Math.max(1, Number.parseInt(process.env.CARD_PAYMENT_MIN_EXTRA || "1", 10) || 1);
  const maxExtra = Math.max(minExtra, Number.parseInt(process.env.CARD_PAYMENT_MAX_EXTRA || "99", 10) || 99);

  return {
    mode,
    ttlSeconds,
    minExtra,
    maxExtra,
    cardLast4: (process.env.HUMO_CARD_LAST4 || "").trim(),
    cardNumber: (process.env.HUMO_CARD_NUMBER || "").trim(),
    adminUsername: (process.env.ADMIN_USERNAME || "").trim().replace(/^@/, ""),
    humoChatId: (process.env.HUMO_CHAT_ID || "").trim(),
  };
}

/**
 * Access gate check:
 * - "disabled": no one can access
 * - "admin_only": only IDs in PAYMENT_ADMIN_IDS
 * - "all": open to everyone
 */
export function canAccessCardPayment(tgId?: string | number | null): boolean {
  const config = getCardPaymentConfig();
  if (config.mode === "disabled") {
    return false;
  }
  if (config.mode === "all") {
    return true;
  }
  if (!tgId) {
    return false;
  }

  const strId = String(tgId).trim();
  const rawAdminIds = (process.env.PAYMENT_ADMIN_IDS || "").split(",");
  const adminIds = new Set(rawAdminIds.map((id) => id.trim()).filter(Boolean));

  return adminIds.has(strId);
}

/**
 * Generates an unoccupied extra amount in [minExtra, maxExtra] for the given baseAmount and cardLast4.
 * Guarantees that totalAmount = baseAmount + extraAmount has no collision among active pending requests.
 */
export async function generateUniqueAmount(
  baseAmount: number,
  cardLast4: string,
  dbClient: any,
  now: Date = new Date()
): Promise<{ extraAmount: number; totalAmount: number }> {
  const config = getCardPaymentConfig();

  // Find all active pending requests for this card
  const activeRequests = await dbClient.cardPaymentRequest.findMany({
    where: {
      cardLast4,
      status: "pending",
      expiresAt: { gt: now },
    },
    select: {
      extraAmount: true,
      totalAmount: true,
    },
  });

  const usedExtras = new Set<number>(activeRequests.map((r: { extraAmount: number }) => r.extraAmount));
  const usedTotals = new Set<number>(activeRequests.map((r: { totalAmount: number }) => r.totalAmount));

  // Build candidate pool within [minExtra, maxExtra]
  const candidates: number[] = [];
  for (let e = config.minExtra; e <= config.maxExtra; e++) {
    if (!usedExtras.has(e) && !usedTotals.has(baseAmount + e)) {
      candidates.push(e);
    }
  }

  if (candidates.length === 0) {
    // If range is exhausted, dynamically expand above maxExtra
    for (let e = config.maxExtra + 1; e <= config.maxExtra + 500; e++) {
      if (!usedExtras.has(e) && !usedTotals.has(baseAmount + e)) {
        candidates.push(e);
        break;
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error("No available unique payment amount slots for this card at this moment. Please try again shortly.");
  }

  // Pick a random candidate from available slots
  const selectedExtra = candidates[Math.floor(Math.random() * candidates.length)];
  return {
    extraAmount: selectedExtra,
    totalAmount: baseAmount + selectedExtra,
  };
}

/**
 * Atomic Compare-And-Swap (CAS) to confirm a pending request with a matching notification.
 * Returns true if this invocation successfully transitioned the request from 'pending' to 'confirmed'.
 * Returns false if already confirmed, cancelled, expired, or notification already used.
 */
export async function claimPaymentConfirmation(
  dbClient: any,
  requestId: number,
  notificationId: number
): Promise<boolean> {
  try {
    const result = await dbClient.$transaction(async (tx: any) => {
      // 1. Atomically claim the notification (must be unmatched)
      const claimedNotification = await tx.bankNotification.updateMany({
        where: {
          id: notificationId,
          status: "unmatched",
        },
        data: {
          status: "matched",
          matchedRequestId: requestId,
        },
      });

      if (claimedNotification.count === 0) {
        return false;
      }

      // 2. Atomically claim the request (must be pending)
      const claimedRequest = await tx.cardPaymentRequest.updateMany({
        where: {
          id: requestId,
          status: "pending",
        },
        data: {
          status: "confirmed",
          matchedNotificationId: notificationId,
        },
      });

      if (claimedRequest.count === 0) {
        throw new Error("REQUEST_NOT_PENDING");
      }

      return true;
    });
    return Boolean(result);
  } catch {
    return false;
  }
}

/**
 * Atomic CAS: mark pending request as expired.
 * Only transitions if current status is 'pending'.
 */
export async function claimPaymentExpiration(dbClient: any, requestId: number): Promise<boolean> {
  const result = await dbClient.cardPaymentRequest.updateMany({
    where: {
      id: requestId,
      status: "pending",
    },
    data: {
      status: "expired",
    },
  });
  return result.count > 0;
}

/**
 * Atomic CAS: mark pending request as cancelled by buyer.
 */
export async function claimPaymentCancellation(dbClient: any, requestId: number): Promise<boolean> {
  const result = await dbClient.cardPaymentRequest.updateMany({
    where: {
      id: requestId,
      status: "pending",
    },
    data: {
      status: "cancelled",
    },
  });
  return result.count > 0;
}

/**
 * Atomic CAS: Manual admin confirmation or rejection.
 */
export async function claimManualReview(
  dbClient: any,
  requestId: number,
  action: "confirm" | "reject",
  adminNote?: string
): Promise<boolean> {
  const targetStatus = action === "confirm" ? "manual_confirmed" : "manual_rejected";
  const result = await dbClient.cardPaymentRequest.updateMany({
    where: {
      id: requestId,
      status: { in: ["pending", "expired"] },
    },
    data: {
      status: targetStatus,
      adminNote: adminNote || null,
    },
  });
  return result.count > 0;
}
