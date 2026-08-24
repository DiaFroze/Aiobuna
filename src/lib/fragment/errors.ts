// Fragment error classifier.
//
// Every Fragment interaction failure maps to exactly one category. The caller
// decides what to do (retry, refund, alert) based on the category alone — the
// raw error message is for logs, not for control flow.

export const FragmentErrorCategory = {
  // Retryable (before signing)
  AUTH_EXPIRED:          "AUTH_EXPIRED",
  HASH_STALE:           "HASH_STALE",
  RATE_LIMIT:           "RATE_LIMIT",
  TRANSPORT_ERROR:      "TRANSPORT_ERROR",

  // Non-retryable business errors
  RECIPIENT_NOT_FOUND:  "RECIPIENT_NOT_FOUND",
  PRICE_CHANGED:        "PRICE_CHANGED",
  WALLET_UNVERIFIED:    "WALLET_UNVERIFIED",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  MARGIN_TOO_LOW:       "MARGIN_TOO_LOW",

  // Post-sign errors (reconcile only, never retry purchase)
  TON_BROADCAST_FAILED: "TON_BROADCAST_FAILED",
  CONFIRM_FAILED:       "CONFIRM_FAILED",
  CONFIRM_TIMEOUT:      "CONFIRM_TIMEOUT",

  // Protocol / infra
  PROTOCOL_UNHEALTHY:   "PROTOCOL_UNHEALTHY",
  SIGNER_UNAVAILABLE:   "SIGNER_UNAVAILABLE",
  TON_RPC_UNAVAILABLE:  "TON_RPC_UNAVAILABLE",

  // Catch-all
  UNKNOWN:              "UNKNOWN",
} as const;

export type FragmentErrorCategory = typeof FragmentErrorCategory[keyof typeof FragmentErrorCategory];

// Whether it is safe to retry the entire purchase flow from scratch.
const RETRYABLE: ReadonlySet<FragmentErrorCategory> = new Set([
  FragmentErrorCategory.AUTH_EXPIRED,
  FragmentErrorCategory.HASH_STALE,
  FragmentErrorCategory.RATE_LIMIT,
  FragmentErrorCategory.TRANSPORT_ERROR,
]);

// Whether TON may have been spent — must reconcile, never retry blindly.
const POST_SIGN: ReadonlySet<FragmentErrorCategory> = new Set([
  FragmentErrorCategory.TON_BROADCAST_FAILED,
  FragmentErrorCategory.CONFIRM_FAILED,
  FragmentErrorCategory.CONFIRM_TIMEOUT,
]);

export class FragmentError extends Error {
  readonly category: FragmentErrorCategory;
  readonly retryable: boolean;
  readonly postSign: boolean;

  constructor(category: FragmentErrorCategory, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "FragmentError";
    this.category = category;
    this.retryable = RETRYABLE.has(category);
    this.postSign = POST_SIGN.has(category);
  }
}

// ---- Classifier -------------------------------------------------------------
// Inspect a raw error (HTTP response, exception, Fragment JSON) and return a
// typed FragmentError. This is the ONLY place that touches raw error shapes.

export function classifyFragmentError(err: unknown): FragmentError {
  if (err instanceof FragmentError) return err;

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // HTTP status based
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("auth")) {
    return new FragmentError(FragmentErrorCategory.AUTH_EXPIRED, msg, err);
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many")) {
    return new FragmentError(FragmentErrorCategory.RATE_LIMIT, msg, err);
  }
  if (lower.includes("hash") && (lower.includes("invalid") || lower.includes("stale") || lower.includes("mismatch"))) {
    return new FragmentError(FragmentErrorCategory.HASH_STALE, msg, err);
  }

  // Fragment business errors
  if (lower.includes("recipient") && (lower.includes("not found") || lower.includes("invalid"))) {
    return new FragmentError(FragmentErrorCategory.RECIPIENT_NOT_FOUND, msg, err);
  }
  if (lower.includes("price") && lower.includes("changed")) {
    return new FragmentError(FragmentErrorCategory.PRICE_CHANGED, msg, err);
  }
  if (lower.includes("wallet") && (lower.includes("verify") || lower.includes("unverified"))) {
    return new FragmentError(FragmentErrorCategory.WALLET_UNVERIFIED, msg, err);
  }
  if (lower.includes("insufficient") || lower.includes("not enough")) {
    return new FragmentError(FragmentErrorCategory.INSUFFICIENT_BALANCE, msg, err);
  }

  // TON / broadcast
  if (lower.includes("broadcast") || lower.includes("send_boc")) {
    return new FragmentError(FragmentErrorCategory.TON_BROADCAST_FAILED, msg, err);
  }
  if (lower.includes("confirm") && lower.includes("fail")) {
    return new FragmentError(FragmentErrorCategory.CONFIRM_FAILED, msg, err);
  }
  if (lower.includes("confirm") && lower.includes("timeout")) {
    return new FragmentError(FragmentErrorCategory.CONFIRM_TIMEOUT, msg, err);
  }

  // Network / transport
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("timeout") || lower.includes("fetch")) {
    return new FragmentError(FragmentErrorCategory.TRANSPORT_ERROR, msg, err);
  }
  if (lower.includes("signer") && (lower.includes("unavailable") || lower.includes("unreachable"))) {
    return new FragmentError(FragmentErrorCategory.SIGNER_UNAVAILABLE, msg, err);
  }

  return new FragmentError(FragmentErrorCategory.UNKNOWN, msg, err);
}
