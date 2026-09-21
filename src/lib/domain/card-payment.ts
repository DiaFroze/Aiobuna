// Domain logic for HUMO Card payments:
// Access control, unique amount allocation, and atomic CAS state transitions.

export type PaymentMonitorMode = "disabled" | "admin_only" | "all";

export interface CardPaymentConfig {
  mode: PaymentMonitorMode;
  ttlSeconds: number;
  minExtra: number;
  maxExtra: number;
  cardLast4: string;
  cardNumber: string; // Formatted card number for copy & display
  cardDigitsOnly: string; // Raw digits without spaces
  adminUsername: string;
  humoChatId: string;
  // MTProto credentials check (flags and masked values only)
  apiId: number;
  hasApiId: boolean;
  hasApiHash: boolean;
  hasSession: boolean;
  hasChatId: boolean;
  isConfigured: boolean;
}

/**
 * Case-insensitive, quote-tolerant, and whitespace-trimming environment variable lookup.
 * Critical on Linux / Railway where process.env is case-sensitive and values may contain quotes.
 */
export function getEnvTolerant(canonicalName: string, aliases: string[] = []): string {
  const allNames = [canonicalName, ...aliases];

  // 1. Direct match
  for (const name of allNames) {
    const val = process.env[name];
    if (typeof val === "string" && val.trim()) {
      return sanitizeEnvValue(val);
    }
  }

  // 2. Case-insensitive match across all keys
  const lowerMap = new Map<string, string>();
  for (const [key, val] of Object.entries(process.env)) {
    if (typeof val === "string") {
      lowerMap.set(key.toLowerCase(), val);
    }
  }

  for (const name of allNames) {
    const val = lowerMap.get(name.toLowerCase());
    if (typeof val === "string" && val.trim()) {
      return sanitizeEnvValue(val);
    }
  }

  return "";
}

function sanitizeEnvValue(val: string): string {
  let cleaned = val.trim();
  // Strip surrounding quotes: "value" or 'value'
  cleaned = cleaned.replace(/^["']|["']$/g, "").trim();
  // Strip trailing carriage return if present
  cleaned = cleaned.replace(/\r$/, "");
  return cleaned;
}

/**
 * Masks a card number safely: outputs only the last 4 digits (e.g. "**** **** **** 1234").
 * NEVER returns or leaks full 16 digits.
 */
export function maskCardNumber(cardNumber: string, cardLast4?: string): string {
  const last4 = (cardLast4 || cardNumber.replace(/\D/g, "").slice(-4)).trim();
  if (last4.length === 4) {
    return `**** **** **** ${last4}`;
  }
  return "Не задана";
}

/**
 * Masks a Telegram chat ID: e.g. "-1001234567890" -> "-100*****7890".
 */
export function maskChatId(chatId: string): string {
  const str = chatId.trim();
  if (!str) return "Не настроен";
  if (str.length <= 6) return str;
  const prefix = str.startsWith("-100") ? "-100" : str.slice(0, 2);
  const suffix = str.slice(-4);
  return `${prefix}*****${suffix}`;
}

export function getCardPaymentConfig(): CardPaymentConfig {
  const modeRaw = getEnvTolerant("PAYMENT_MONITOR_MODE", ["payment_monitor_mode", "MONITOR_MODE"]).toLowerCase();
  const mode: PaymentMonitorMode =
    modeRaw === "all" ? "all" : modeRaw === "disabled" ? "disabled" : "admin_only";

  const ttlSeconds = Math.max(
    60,
    Number.parseInt(getEnvTolerant("CARD_PAYMENT_TTL_SECONDS", ["card_payment_ttl_seconds", "CARD_TTL_SECONDS"]) || "300", 10) || 300
  );
  const minExtra = Math.max(
    1,
    Number.parseInt(getEnvTolerant("CARD_PAYMENT_MIN_EXTRA", ["card_payment_min_extra"]) || "1", 10) || 1
  );
  const maxExtra = Math.max(
    minExtra,
    Number.parseInt(getEnvTolerant("CARD_PAYMENT_MAX_EXTRA", ["card_payment_max_extra"]) || "99", 10) || 99
  );

  // Card number and last 4
  const rawCardNumber = getEnvTolerant("HUMO_CARD_NUMBER", ["humo_card_number", "CARD_NUMBER", "HUMO_CARD"]);
  const cleanDigits = rawCardNumber.replace(/\D/g, "");

  const rawLast4 = getEnvTolerant("HUMO_CARD_LAST4", ["humo_card_last4", "CARD_LAST4", "HUMO_LAST4"]);
  let cleanLast4 = rawLast4.replace(/\D/g, "");
  if (!cleanLast4 && cleanDigits.length >= 4) {
    cleanLast4 = cleanDigits.slice(-4);
  }

  const formattedCardNumber =
    cleanDigits.length === 16
      ? `${cleanDigits.slice(0, 4)} ${cleanDigits.slice(4, 8)} ${cleanDigits.slice(8, 12)} ${cleanDigits.slice(12, 16)}`
      : rawCardNumber.trim();

  // Telegram MTProto credentials
  // Primary: TELEGRAM_API_ID / TELEGRAM_API_HASH
  // Fallback: Appapi_id / Appapi_hash
  const rawApiId = getEnvTolerant("TELEGRAM_API_ID", ["Appapi_id", "appapi_id", "telegram_api_id", "API_ID"]);
  const rawApiHash = getEnvTolerant("TELEGRAM_API_HASH", ["Appapi_hash", "appapi_hash", "telegram_api_hash", "API_HASH"]);
  const rawSession = getEnvTolerant("TELEGRAM_SESSION", ["telegram_session", "SESSION", "HUMO_SESSION", "STRING_SESSION"]);
  const humoChatId = getEnvTolerant("HUMO_CHAT_ID", ["humo_chat_id", "CHAT_ID", "HUMO_CHAT"]);
  const adminUsername = getEnvTolerant("ADMIN_USERNAME", ["admin_username", "SUPPORT_USERNAME"]).replace(/^@/, "");

  const apiId = Number.parseInt(rawApiId, 10) || 0;
  const hasApiId = apiId > 0;
  const hasApiHash = Boolean(rawApiHash && rawApiHash.length >= 10);
  const hasSession = Boolean(rawSession && rawSession.length >= 10);
  const hasChatId = Boolean(humoChatId && humoChatId.length >= 4);
  const isConfigured = hasApiId && hasApiHash && hasSession && hasChatId && Boolean(cleanDigits.length >= 12 && cleanLast4.length === 4);

  return {
    mode,
    ttlSeconds,
    minExtra,
    maxExtra,
    cardLast4: cleanLast4,
    cardNumber: formattedCardNumber,
    cardDigitsOnly: cleanDigits,
    adminUsername,
    humoChatId,
    apiId,
    hasApiId,
    hasApiHash,
    hasSession,
    hasChatId,
    isConfigured,
  };
}

/**
 * Access gate check:
 * - "disabled": no one can access
 * - "admin_only": only IDs in PAYMENT_ADMIN_IDS
 * - "all": open to everyone
 *
 * Strictly checks against PAYMENT_ADMIN_IDS (not TELEGRAM_ADMIN_CHAT_ID).
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
  const rawAdminIds = getEnvTolerant("PAYMENT_ADMIN_IDS", ["payment_admin_ids"]);
  const adminIds = new Set(
    rawAdminIds
      .split(/[,;\s]+/)
      .map((id) => sanitizeEnvValue(id))
      .filter(Boolean)
  );

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
 * Atomic Compare-And-Swap (CAS) to expire a pending request past its TTL.
 * Returns true if this call changed the state, false if already handled.
 */
export async function claimPaymentExpiration(dbClient: any, requestId: number): Promise<boolean> {
  const res = await dbClient.cardPaymentRequest.updateMany({
    where: {
      id: requestId,
      status: "pending",
    },
    data: {
      status: "expired",
    },
  });
  return res.count === 1;
}

/**
 * Atomic Compare-And-Swap (CAS) to cancel a pending request by the customer.
 */
export async function claimPaymentCancellation(dbClient: any, requestId: number): Promise<boolean> {
  const res = await dbClient.cardPaymentRequest.updateMany({
    where: {
      id: requestId,
      status: "pending",
    },
    data: {
      status: "cancelled",
    },
  });
  return res.count === 1;
}

/**
 * Atomic admin manual confirm or reject for unmatched or expired payments.
 */
export async function claimManualReview(
  dbClient: any,
  requestId: number,
  action: "confirm" | "reject",
  note: string
): Promise<boolean> {
  const newStatus = action === "confirm" ? "manual_confirmed" : "manual_rejected";
  const res = await dbClient.cardPaymentRequest.updateMany({
    where: {
      id: requestId,
      status: { in: ["pending", "expired"] },
    },
    data: {
      status: newStatus,
      adminNote: note,
    },
  });
  return res.count === 1;
}
