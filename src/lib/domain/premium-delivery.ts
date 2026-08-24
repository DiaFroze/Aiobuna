// Pure decision logic for Telegram Premium delivery. No I/O, no Prisma, no
// grammY — so every rule here is unit-testable without a network or a database.
//
// The one constraint that shapes this whole module: giftPremiumSubscription
// returns only `true` and NO operation id (Bot API 9.0). We therefore cannot
// rely on the provider for idempotency, and — more importantly — we can never
// treat "the request failed" as "the gift was not sent". A blind retry after an
// ambiguous failure would gift twice and burn 1000-2500 Stars with no way to
// undo it (refundStarPayment refunds payments RECEIVED by the bot, not gifts
// SENT by it). Hence: ambiguity always routes through reconciliation, never
// straight to a retry.

/** Durations Telegram allows for a gifted Premium subscription. */
export const PREMIUM_MONTHS = [3, 6, 12] as const;
export type PremiumMonths = (typeof PREMIUM_MONTHS)[number];

/**
 * Star price per duration. Fixed BY TELEGRAM — `star_count` must be exactly
 * 1000/1500/2500 or the API rejects the call. This is not our pricing and is
 * not configurable; the shop's own sale price and purchase cost live elsewhere.
 */
export const PREMIUM_STAR_COST: Record<PremiumMonths, 1000 | 1500 | 2500> = {
  3: 1000,
  6: 1500,
  12: 2500,
};

/** Star cost for a month count, or null if Telegram doesn't support it. */
export function premiumStarCost(months: number): 1000 | 1500 | 2500 | null {
  return isPremiumMonths(months) ? PREMIUM_STAR_COST[months] : null;
}

export function isPremiumMonths(months: number): months is PremiumMonths {
  return (PREMIUM_MONTHS as readonly number[]).includes(months);
}

// ---------------------------------------------------------------------------
// Delivery state machine
// ---------------------------------------------------------------------------

export const DELIVERY_STATES = [
  "CREATED",
  "PAYMENT_PENDING",
  "PAID",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "MANUAL_REVIEW",
  "CANCELLED",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/**
 * Allowed transitions. COMPLETED is terminal on purpose: once the gift is out
 * the door nothing may move the order back into a deliverable state, which is
 * what stops a second delivery. FAILED/MANUAL_REVIEW can return to PROCESSING
 * only via an explicit admin retry.
 */
const TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  CREATED: ["PAYMENT_PENDING", "CANCELLED"],
  PAYMENT_PENDING: ["PAID", "CANCELLED", "FAILED"],
  PAID: ["PROCESSING", "MANUAL_REVIEW", "CANCELLED"],
  PROCESSING: ["COMPLETED", "FAILED", "MANUAL_REVIEW"],
  COMPLETED: [],
  FAILED: ["PROCESSING", "MANUAL_REVIEW", "CANCELLED"],
  MANUAL_REVIEW: ["PROCESSING", "COMPLETED", "FAILED", "CANCELLED"],
  CANCELLED: [],
};

export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(state: DeliveryState): boolean {
  return TRANSITIONS[state].length === 0;
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

/** Backoff before retry attempt 1, 2, 3. Length also caps the retry count. */
export const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_MS.length;

export type DeliveryOutcome =
  | { kind: "completed" }
  /** Request provably never reached Telegram — retrying cannot double-gift. */
  | { kind: "retry"; afterMs: number }
  /** Result unknown. MUST check getStarTransactions before doing anything. */
  | { kind: "reconcile" }
  | { kind: "manual_review"; reason: string }
  | { kind: "failed"; reason: string };

export interface GiftError {
  /** HTTP-ish status from the Bot API, when there was a response at all. */
  errorCode?: number;
  /** `description` from the Bot API response, or a transport error message. */
  description?: string;
  /** True when the call never got a response (timeout, socket hangup, abort). */
  networkError?: boolean;
}

const INSUFFICIENT_BALANCE = /balance|not enough|insufficient|BALANCE_TOO_LOW/i;

/**
 * Decide what to do after a failed giftPremiumSubscription call.
 *
 * The split that matters is "did Telegram definitely NOT process this?" — only
 * then is a retry safe. A 4xx means the request was rejected outright, so
 * nothing was charged. A 5xx, a timeout or a dropped socket means the request
 * may well have been applied server-side, so it goes to reconciliation, never
 * straight back to a retry.
 */
export function classifyGiftError(err: GiftError, attempts: number): DeliveryOutcome {
  const attemptsLeft = attempts < MAX_DELIVERY_ATTEMPTS;
  const desc = err.description ?? "";

  // No response at all → outcome unknown → reconcile.
  if (err.networkError || err.errorCode === undefined) return { kind: "reconcile" };

  // Server-side failure → may or may not have been applied → reconcile.
  if (err.errorCode >= 500) return { kind: "reconcile" };

  // Rate limited: rejected before processing, so a retry cannot double-gift.
  if (err.errorCode === 429) {
    return attemptsLeft
      ? { kind: "retry", afterMs: RETRY_BACKOFF_MS[attempts] }
      : { kind: "manual_review", reason: "rate limited, attempts exhausted" };
  }

  // Out of Stars: retrying changes nothing until the balance is topped up.
  if (INSUFFICIENT_BALANCE.test(desc)) {
    return { kind: "manual_review", reason: `insufficient star balance: ${desc}` };
  }

  // Auth/permission problems are a configuration fault, not a transient one.
  if (err.errorCode === 401 || err.errorCode === 403) {
    return { kind: "manual_review", reason: `not permitted: ${desc}` };
  }

  // Any other 4xx: rejected and will be rejected again (bad user_id, wrong
  // star_count, unsupported month_count). Retrying is pointless.
  if (err.errorCode >= 400) return { kind: "failed", reason: desc || `error ${err.errorCode}` };

  return { kind: "manual_review", reason: desc || `unexpected error ${err.errorCode}` };
}

/**
 * Decide what to do once reconciliation against getStarTransactions has run.
 *
 * `found` — a matching outgoing Star transaction exists, so the gift WAS sent.
 * `definitelyNotAccepted` — independent proof the request never applied. Absent
 * such proof, "not found" is NOT treated as "not sent": transaction history can
 * lag, and guessing wrong here means gifting twice. Ambiguity → a human looks.
 */
export function decideAfterReconcile(
  found: boolean,
  definitelyNotAccepted: boolean,
  attempts: number,
): DeliveryOutcome {
  if (found) return { kind: "completed" };
  if (definitelyNotAccepted) {
    return attempts < MAX_DELIVERY_ATTEMPTS
      ? { kind: "retry", afterMs: RETRY_BACKOFF_MS[attempts] }
      : { kind: "manual_review", reason: "not delivered, attempts exhausted" };
  }
  return { kind: "manual_review", reason: "delivery result could not be confirmed" };
}

// ---------------------------------------------------------------------------
// Recipient
// ---------------------------------------------------------------------------

/**
 * How the recipient's numeric Telegram id was obtained. giftPremiumSubscription
 * takes `user_id` only — a username is never enough on its own, so an order
 * without a numeric id can never be auto-delivered.
 */
export type RecipientSource = "self" | "shared" | "known_username" | "unresolved";

export interface Recipient {
  /** Numeric Telegram id. Null only when source is "unresolved". */
  tgId: string | null;
  /** Kept for display/audit only — never used as the delivery identifier. */
  username: string | null;
  source: RecipientSource;
}

/** Auto delivery requires a numeric id; a username alone cannot be delivered to. */
export function canAutoDeliver(r: Recipient): boolean {
  return r.tgId !== null && r.tgId.trim() !== "";
}

/** Human-readable recipient for admin messages. */
export function describeRecipient(r: Recipient): string {
  const uname = r.username ? `@${r.username}` : "—";
  return r.tgId ? `${uname} (id ${r.tgId})` : `${uname} (id не определён)`;
}

// ---------------------------------------------------------------------------
// Purchase note
// ---------------------------------------------------------------------------

/**
 * The note travels with a pending top-up through Payme / Click / Stars and comes
 * back when the payment is confirmed, so it is what carries the recipient across
 * the payment round-trip.
 *
 * Format: `buy:<variantId>:<qty>[:<username>[:<recipientTgId>]]`
 *
 * Older notes (`buy:12:1` and `buy:12:1:someone`) parse unchanged — existing
 * pending payments made before this field existed must keep working.
 * Usernames cannot contain ":", so the segments stay unambiguous.
 */
export interface BuyNote {
  variantId: number;
  qty: number;
  username: string | null;
  recipientTgId: string | null;
}

export function buildBuyNote(
  variantId: number,
  qty: number,
  username?: string | null,
  recipientTgId?: string | null,
): string {
  const base = `buy:${variantId}:${qty}`;
  if (!username && !recipientTgId) return base;
  // The username segment is kept (possibly empty) so the id stays at index 4:
  // gifting to a picked contact often has an id but no username.
  const withName = `${base}:${username ?? ""}`;
  return recipientTgId ? `${withName}:${recipientTgId}` : withName;
}

export function parseBuyNote(note: string | null | undefined): BuyNote | null {
  if (!note || !note.startsWith("buy:")) return null;
  const parts = note.split(":");
  const variantId = Number(parts[1]);
  const qty = Number(parts[2]);
  if (!Number.isFinite(variantId) || variantId <= 0) return null;
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return {
    variantId,
    qty,
    username: parts[3]?.trim() ? parts[3].trim() : null,
    recipientTgId: parts[4]?.trim() ? parts[4].trim() : null,
  };
}
