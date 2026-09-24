/**
 * Domain logic for AI-Creators & Media Team Affiliate Platform.
 * 
 * Invariants:
 * 1. Strict financial ledger accounting:
 *    balanceUzs (available) + holdBalanceUzs (pending payouts) + totalPaidUzs = totalEarnedUzs (+ adjustments).
 * 2. Exactly-once commission accrual per order (enforced via unique orderId on CreatorOrderReward).
 * 3. CAS updates on balance deduction to prevent overdrafts / double payout requests.
 * 4. Payout minimum: 50,000 UZS.
 */

export const MIN_CREATOR_PAYOUT_UZS = 50_000;
export const DEFAULT_CREATOR_RATE_UZS = 10_000;
export const CREATOR_START_PREFIX = "c_";

export interface CreatorCodeValidation {
  valid: boolean;
  code: string;
  reason?: "empty" | "too_short" | "too_long" | "invalid_chars" | "reserved_prefix";
}

/**
 * Extracts and cleans a creator slug from a raw string or full URL.
 * Handles:
 * - "https://aiobuna.vercel.app/go/meta_dcntjqbicwm_2026092" -> "meta_dcntjqbicwm_2026092"
 * - "https://t.me/Aiobuna_bot?start=c_alex" -> "alex"
 * - "t.me/Aiobuna_bot?start=c_alex" -> "alex"
 * - "c_alex" -> "alex"
 * - "alex" -> "alex"
 */
export function extractCreatorSlug(rawInput: string): string {
  let str = (rawInput ?? "").trim();
  if (!str) return "";

  // If input contains URL patterns (http://, https://, t.me/, /go/, etc.)
  if (str.includes("://") || str.includes("t.me/") || str.includes("/go/")) {
    try {
      const parsed = new URL(str.startsWith("http") ? str : `https://${str}`);
      const startParam = parsed.searchParams.get("start");
      if (startParam) {
        str = startParam;
      } else {
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (segments.length > 0) {
          str = segments[segments.length - 1];
        }
      }
    } catch {
      const parts = str.split("/").filter(Boolean);
      str = parts[parts.length - 1] || str;
    }
  }

  // Strip query/hash if still present
  str = str.split("?")[0].split("#")[0];

  // Strip prefixes: c_ or creator_
  str = str.replace(/^(?:c_|creator_)/i, "");

  return str.trim().toLowerCase();
}

export function getCreatorCodeValidationErrorRu(reason?: string): string {
  switch (reason) {
    case "empty":
      return "Укажите код или ссылку для креатора";
    case "too_short":
      return "Код ссылки слишком короткий (минимум 2 символа)";
    case "too_long":
      return "Код ссылки слишком длинный (максимум 64 символа)";
    case "invalid_chars":
      return "Код ссылки может содержать только латинские буквы, цифры, дефис и знак подчеркивания";
    default:
      return "Некорректный код ссылки";
  }
}

/**
 * Validates and normalizes a creator code slug.
 * Allowed: alphanumeric characters, underscores, dashes (2 to 64 chars).
 */
export function validateCreatorCode(rawCode: string): CreatorCodeValidation {
  const code = extractCreatorSlug(rawCode);
  if (!code) {
    return { valid: false, code: "", reason: "empty" };
  }

  if (code.length < 2) {
    return { valid: false, code, reason: "too_short" };
  }
  if (code.length > 64) {
    return { valid: false, code, reason: "too_long" };
  }
  if (!/^[a-z0-9_-]+$/.test(code)) {
    return { valid: false, code, reason: "invalid_chars" };
  }

  return { valid: true, code };
}

/**
 * Extracts a creator code from a Telegram /start parameter.
 * Supports: c_alex, c-alex, creator_alex
 */
export function parseCreatorStartPayload(startParam?: string | null): string | null {
  if (!startParam) return null;
  const trimmed = startParam.trim();
  const match = trimmed.match(/^(?:c_|creator_)([a-zA-Z0-9_-]+)$/i);
  if (!match) return null;
  const validation = validateCreatorCode(match[1]);
  return validation.valid ? validation.code : null;
}

/**
 * Formats full referral link for the creator.
 */
export function formatCreatorLink(botUsername: string, code: string): string {
  const cleanCode = code.startsWith("c_") ? code.slice(2) : code;
  return `https://t.me/${botUsername}?start=c_${cleanCode}`;
}

/**
 * Returns commission rate for a specific creator and variant.
 * 1. Checks custom CreatorProductRate.
 * 2. Falls back to Creator.defaultRateUzs.
 */
export async function getCreatorCommission(
  client: any,
  creatorId: number,
  variantId?: number | null
): Promise<number> {
  if (variantId) {
    const customRate = await client.creatorProductRate.findUnique({
      where: {
        creatorId_variantId: {
          creatorId,
          variantId,
        },
      },
    });
    if (customRate) {
      return Math.max(0, customRate.rewardUzs);
    }
  }

  const creator = await client.creator.findUnique({
    where: { id: creatorId },
    select: { defaultRateUzs: true, isActive: true },
  });

  if (!creator || !creator.isActive) return 0;
  return Math.max(0, creator.defaultRateUzs);
}

export interface AccrueCommissionParams {
  orderId: number;
  buyerId: number;
  variantId?: number | null;
  orderTotalUzs: number;
  creatorId: number;
  customAmountUzs?: number;
}

export interface AccrueCommissionResult {
  success: boolean;
  alreadyCredited?: boolean;
  rewardId?: number;
  amountUzs: number;
  error?: string;
}

/**
 * Atomically accrues commission to a creator for a completed order.
 * Guarantees exactly-once accrual via unique constraint on orderId.
 */
export async function accrueOrderCommission(
  client: any,
  params: AccrueCommissionParams
): Promise<AccrueCommissionResult> {
  const { orderId, buyerId, variantId, orderTotalUzs, creatorId, customAmountUzs } = params;

  // Execute within transaction if client supports it
  const run = async (tx: any) => {
    // 1. Idempotency check: reward already recorded?
    const existing = await tx.creatorOrderReward.findUnique({
      where: { orderId },
    });
    if (existing) {
      return {
        success: true,
        alreadyCredited: true,
        rewardId: existing.id,
        amountUzs: existing.amountUzs,
      };
    }

    // 2. Fetch creator
    const creator = await tx.creator.findUnique({
      where: { id: creatorId },
    });
    if (!creator || !creator.isActive) {
      return { success: false, amountUzs: 0, error: "CREATOR_NOT_ACTIVE" };
    }

    // 3. Determine reward amount
    let rewardAmount = customAmountUzs !== undefined ? customAmountUzs : 0;
    if (customAmountUzs === undefined) {
      rewardAmount = await getCreatorCommission(tx, creatorId, variantId);
    }
    if (rewardAmount <= 0) {
      return { success: false, amountUzs: 0, error: "ZERO_COMMISSION" };
    }

    // 4. Create reward record (unique orderId prevents concurrent duplicates)
    let rewardRecord;
    try {
      rewardRecord = await tx.creatorOrderReward.create({
        data: {
          creatorId,
          orderId,
          buyerId,
          variantId: variantId ?? null,
          amountUzs: rewardAmount,
          orderTotalUzs,
        },
      });
    } catch (e: any) {
      if (e?.code === "P2002" || String(e?.message).includes("unique constraint")) {
        const existingAfterRace = await tx.creatorOrderReward.findUnique({ where: { orderId } });
        return {
          success: true,
          alreadyCredited: true,
          rewardId: existingAfterRace?.id,
          amountUzs: existingAfterRace?.amountUzs ?? rewardAmount,
        };
      }
      throw e;
    }

    // 5. Update creator balances
    const balanceBefore = creator.balanceUzs;
    const balanceAfter = balanceBefore + rewardAmount;

    await tx.creator.update({
      where: { id: creatorId },
      data: {
        balanceUzs: { increment: rewardAmount },
        totalEarnedUzs: { increment: rewardAmount },
      },
    });

    // 6. Record audit ledger entry
    await tx.creatorLedger.create({
      data: {
        creatorId,
        type: "COMMISSION",
        amountUzs: rewardAmount,
        balanceBefore,
        balanceAfter,
        referenceId: String(orderId),
        note: `Комиссия за заказ #${orderId} (Сумма заказа: ${orderTotalUzs.toLocaleString("ru-RU")} UZS)`,
      },
    });

    // 7. Stamp BotOrder if model exists
    if (tx.botOrder) {
      await tx.botOrder.update({
        where: { id: orderId },
        data: {
          attributedCreatorId: creatorId,
          creatorRewardUzs: rewardAmount,
        },
      }).catch(() => {});
    }

    return {
      success: true,
      rewardId: rewardRecord.id,
      amountUzs: rewardAmount,
    };
  };

  if (typeof client.$transaction === "function") {
    return client.$transaction(run);
  }
  return run(client);
}

export interface PayoutRequestParams {
  creatorId: number;
  amountUzs: number;
  cardNumber: string;
  cardHolder?: string | null;
}

export interface PayoutRequestResult {
  success: boolean;
  payoutId?: number;
  error?: "INSUFFICIENT_BALANCE" | "AMOUNT_BELOW_MINIMUM" | "CREATOR_NOT_FOUND" | "CREATOR_NOT_ACTIVE" | "INVALID_CARD";
}

/**
 * Creator requests a payout. Funds are moved from balanceUzs into holdBalanceUzs.
 */
export async function requestCreatorPayout(
  client: any,
  params: PayoutRequestParams
): Promise<PayoutRequestResult> {
  const { creatorId, amountUzs, cardHolder } = params;
  const cleanCard = (params.cardNumber || "").replace(/\D/g, "");

  if (cleanCard.length < 16) {
    return { success: false, error: "INVALID_CARD" };
  }
  if (!Number.isInteger(amountUzs) || amountUzs < MIN_CREATOR_PAYOUT_UZS) {
    return { success: false, error: "AMOUNT_BELOW_MINIMUM" };
  }

  const run = async (tx: any) => {
    const creator = await tx.creator.findUnique({ where: { id: creatorId } });
    if (!creator) return { success: false, error: "CREATOR_NOT_FOUND" as const };
    if (!creator.isActive) return { success: false, error: "CREATOR_NOT_ACTIVE" as const };

    // CAS deduction: only deduct if creator has enough available balance
    const updated = await tx.creator.updateMany({
      where: {
        id: creatorId,
        isActive: true,
        balanceUzs: { gte: amountUzs },
      },
      data: {
        balanceUzs: { decrement: amountUzs },
        holdBalanceUzs: { increment: amountUzs },
      },
    });

    if (updated.count === 0) {
      return { success: false, error: "INSUFFICIENT_BALANCE" as const };
    }

    const payout = await tx.creatorPayout.create({
      data: {
        creatorId,
        amountUzs,
        cardNumber: cleanCard,
        cardHolder: cardHolder?.trim() || null,
        status: "pending",
      },
    });

    // Audit ledger entry
    const balanceBefore = creator.balanceUzs;
    const balanceAfter = balanceBefore - amountUzs;

    await tx.creatorLedger.create({
      data: {
        creatorId,
        type: "PAYOUT_REQUEST",
        amountUzs: -amountUzs,
        balanceBefore,
        balanceAfter,
        referenceId: String(payout.id),
        note: `Заявка на вывод #${payout.id} на карту *${cleanCard.slice(-4)} (${amountUzs.toLocaleString("ru-RU")} UZS)`,
      },
    });

    return { success: true, payoutId: payout.id };
  };

  if (typeof client.$transaction === "function") {
    return client.$transaction(run);
  }
  return run(client);
}

export interface ApprovePayoutParams {
  payoutId: number;
  adminUser: string;
  note?: string | null;
}

export interface ApprovePayoutResult {
  success: boolean;
  error?: "PAYOUT_NOT_FOUND" | "PAYOUT_NOT_PENDING";
}

/**
 * Admin approves a payout request after sending money to Humo/Uzcard.
 * Moves funds from holdBalanceUzs to totalPaidUzs.
 */
export async function approveCreatorPayout(
  client: any,
  params: ApprovePayoutParams
): Promise<ApprovePayoutResult> {
  const { payoutId, adminUser, note } = params;

  const run = async (tx: any) => {
    const payout = await tx.creatorPayout.findUnique({
      where: { id: payoutId },
      include: { creator: true },
    });
    if (!payout) return { success: false, error: "PAYOUT_NOT_FOUND" as const };
    if (payout.status !== "pending") return { success: false, error: "PAYOUT_NOT_PENDING" as const };

    // CAS update on payout
    const cas = await tx.creatorPayout.updateMany({
      where: { id: payoutId, status: "pending" },
      data: {
        status: "paid",
        reviewedBy: adminUser,
        reviewedAt: new Date(),
        adminNote: note?.trim() || null,
      },
    });
    if (cas.count === 0) return { success: false, error: "PAYOUT_NOT_PENDING" as const };

    // Update balances: release hold, increment totalPaid
    await tx.creator.update({
      where: { id: payout.creatorId },
      data: {
        holdBalanceUzs: { decrement: payout.amountUzs },
        totalPaidUzs: { increment: payout.amountUzs },
      },
    });

    const currentCreator = await tx.creator.findUnique({ where: { id: payout.creatorId } });
    const currentBalance = currentCreator?.balanceUzs ?? 0;

    await tx.creatorLedger.create({
      data: {
        creatorId: payout.creatorId,
        type: "PAYOUT_APPROVED",
        amountUzs: 0, // balance was already deducted on request
        balanceBefore: currentBalance,
        balanceAfter: currentBalance,
        referenceId: String(payoutId),
        note: `Выплата #${payoutId} подтверждена админом ${adminUser}. ${note || ""}`.trim(),
      },
    });

    return { success: true };
  };

  if (typeof client.$transaction === "function") {
    return client.$transaction(run);
  }
  return run(client);
}

export interface RejectPayoutParams {
  payoutId: number;
  adminUser: string;
  reason: string;
}

export interface RejectPayoutResult {
  success: boolean;
  error?: "PAYOUT_NOT_FOUND" | "PAYOUT_NOT_PENDING";
}

/**
 * Admin rejects a payout request.
 * Funds are refunded from holdBalanceUzs back to available balanceUzs.
 */
export async function rejectCreatorPayout(
  client: any,
  params: RejectPayoutParams
): Promise<RejectPayoutResult> {
  const { payoutId, adminUser, reason } = params;

  const run = async (tx: any) => {
    const payout = await tx.creatorPayout.findUnique({
      where: { id: payoutId },
      include: { creator: true },
    });
    if (!payout) return { success: false, error: "PAYOUT_NOT_FOUND" as const };
    if (payout.status !== "pending") return { success: false, error: "PAYOUT_NOT_PENDING" as const };

    const cas = await tx.creatorPayout.updateMany({
      where: { id: payoutId, status: "pending" },
      data: {
        status: "rejected",
        reviewedBy: adminUser,
        reviewedAt: new Date(),
        adminNote: reason.trim(),
      },
    });
    if (cas.count === 0) return { success: false, error: "PAYOUT_NOT_PENDING" as const };

    // Refund hold back to balance
    const creatorBefore = await tx.creator.findUnique({ where: { id: payout.creatorId } });
    const balanceBefore = creatorBefore?.balanceUzs ?? 0;
    const balanceAfter = balanceBefore + payout.amountUzs;

    await tx.creator.update({
      where: { id: payout.creatorId },
      data: {
        holdBalanceUzs: { decrement: payout.amountUzs },
        balanceUzs: { increment: payout.amountUzs },
      },
    });

    await tx.creatorLedger.create({
      data: {
        creatorId: payout.creatorId,
        type: "PAYOUT_REJECTED",
        amountUzs: payout.amountUzs,
        balanceBefore,
        balanceAfter,
        referenceId: String(payoutId),
        note: `Выплата #${payoutId} отклонена (${reason}). Средства возвращены на баланс.`,
      },
    });

    return { success: true };
  };

  if (typeof client.$transaction === "function") {
    return client.$transaction(run);
  }
  return run(client);
}
