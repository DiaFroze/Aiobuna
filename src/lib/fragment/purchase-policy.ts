// Decision rules for buying Stars / Premium through fragment-api.com.
// Pure functions only — no HTTP, no database — so every rule below is testable
// without touching the vendor or spending anything.
//
// The rules exist because of one property of this vendor: the order endpoint
// takes NO client-supplied idempotency key (verified against their OpenAPI
// schema — ref_id is response-only). We can therefore never ask "did my earlier
// attempt go through?" by replaying the request. A second POST is a second real
// purchase, paid out of the hot wallet, delivered to a real person, and not
// reversible. Every rule here is built around not doing that.

import type { FragmentOrderStatus, MoneyAmount } from "./api-types";

// ---------------------------------------------------------------------------
// Decimal money, kept as strings
// ---------------------------------------------------------------------------

/** Compare two decimal strings. Returns -1, 0 or 1. No floats involved. */
export function compareDecimal(a: string, b: string): number {
  const norm = (s: string) => {
    const neg = s.trim().startsWith("-");
    const [int = "0", frac = ""] = s.trim().replace(/^[+-]/, "").split(".");
    return { neg, int: int.replace(/^0+(?=\d)/, ""), frac: frac.replace(/0+$/, "") };
  };
  const x = norm(a), y = norm(b);
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  const sign = x.neg ? -1 : 1;
  if (x.int.length !== y.int.length) return x.int.length > y.int.length ? sign : -sign;
  if (x.int !== y.int) return x.int > y.int ? sign : -sign;
  const len = Math.max(x.frac.length, y.frac.length);
  const xf = x.frac.padEnd(len, "0"), yf = y.frac.padEnd(len, "0");
  if (xf === yf) return 0;
  return xf > yf ? sign : -sign;
}

/** Sum decimal strings exactly, without going through Number. */
export function addDecimal(a: string, b: string): string {
  const split = (s: string) => {
    const [i = "0", f = ""] = s.trim().split(".");
    return { i, f };
  };
  const x = split(a), y = split(b);
  const len = Math.max(x.f.length, y.f.length);
  const scale = (v: { i: string; f: string }) => BigInt(v.i + v.f.padEnd(len, "0"));
  const total = scale(x) + scale(y);
  const s = total.toString().padStart(len + 1, "0");
  return len === 0 ? s : `${s.slice(0, -len)}.${s.slice(-len)}`;
}

/** Total the supplier will take: price + fee (fee may be absent). */
export function totalSupplierCost(price: MoneyAmount, fee: MoneyAmount | null): MoneyAmount {
  if (!fee) return price;
  if (fee.currency !== price.currency) {
    // Mixing currencies silently would understate the cost; refuse instead.
    throw new Error(`fee currency ${fee.currency} does not match price ${price.currency}`);
  }
  return { currency: price.currency, amount: addDecimal(price.amount, fee.amount) };
}

// ---------------------------------------------------------------------------
// Pre-flight gates
// ---------------------------------------------------------------------------

export interface PreflightInput {
  /** What the customer paid us, in UZS. */
  customerRevenueUzs: number;
  /** Live supplier cost (price + fee) for this order. */
  supplierCost: MoneyAmount;
  /** Exchange rate for supplierCost.currency into UZS, from a price oracle. */
  rateToUzs: number | null;
  /** Wallet balance in the same currency as supplierCost, or null if unknown. */
  walletBalance: string | null;
  /** Reserve that must remain after the purchase (gas, safety). */
  minWalletReserve: string;
  /** Minimum acceptable margin, in basis points of revenue (100 bps = 1%). */
  minMarginBps: number;
}

export type PreflightBlock =
  | "NO_PRICE"
  | "NO_RATE"
  | "NO_BALANCE"
  | "INSUFFICIENT_BALANCE"
  | "MARGIN_TOO_LOW";

export type PreflightVerdict =
  | { ok: true; marginUzs: number; marginBps: number }
  | { ok: false; reason: PreflightBlock; detail: string };

/**
 * Everything that must hold before a single TON leaves the wallet. Any failure
 * stops the purchase — an order we cannot fulfil profitably is refunded, not
 * pushed through and sorted out afterwards.
 */
export function preflight(input: PreflightInput): PreflightVerdict {
  const { supplierCost, rateToUzs, walletBalance, minWalletReserve, minMarginBps } = input;

  if (!supplierCost || !supplierCost.amount) {
    return { ok: false, reason: "NO_PRICE", detail: "no live supplier quote" };
  }
  if (rateToUzs === null || !Number.isFinite(rateToUzs) || rateToUzs <= 0) {
    // Without a rate we cannot judge margin. Buying blind is how you sell at a
    // loss all day without noticing.
    return { ok: false, reason: "NO_RATE", detail: "no usable exchange rate" };
  }
  if (walletBalance === null) {
    return { ok: false, reason: "NO_BALANCE", detail: "wallet balance unavailable" };
  }

  // Balance must cover the cost AND still leave the reserve behind.
  const needed = addDecimal(supplierCost.amount, minWalletReserve);
  if (compareDecimal(walletBalance, needed) < 0) {
    return {
      ok: false,
      reason: "INSUFFICIENT_BALANCE",
      detail: `balance ${walletBalance} < cost ${supplierCost.amount} + reserve ${minWalletReserve}`,
    };
  }

  const costUzs = Number(supplierCost.amount) * rateToUzs;
  const marginUzs = input.customerRevenueUzs - costUzs;
  const marginBps = input.customerRevenueUzs > 0
    ? Math.round((marginUzs / input.customerRevenueUzs) * 10_000)
    : -10_000;

  if (marginBps < minMarginBps) {
    return {
      ok: false,
      reason: "MARGIN_TOO_LOW",
      detail: `margin ${marginBps}bps below required ${minMarginBps}bps`,
    };
  }
  return { ok: true, marginUzs: Math.round(marginUzs), marginBps };
}

// ---------------------------------------------------------------------------
// What a supplier status means for us
// ---------------------------------------------------------------------------

export type StatusVerdict =
  /** Delivered. Terminal, and the only path to COMPLETED. */
  | { kind: "completed" }
  /** Not delivered, and never will be. Safe to refund. */
  | { kind: "failed"; detail: string }
  /** Still moving. Keep polling. */
  | { kind: "pending" };

export function interpretStatus(status: FragmentOrderStatus, error?: unknown): StatusVerdict {
  switch (status) {
    case "COMPLETED":
      return { kind: "completed" };
    case "FAILED":
      return { kind: "failed", detail: describeVendorError(error) };
    // CREATED / PENDING / BLOCKCHAIN_SENT are all in flight. BLOCKCHAIN_SENT in
    // particular means money has already moved on-chain — the status where
    // giving up and retrying would be most expensive of all.
    case "CREATED":
    case "PENDING":
    case "BLOCKCHAIN_SENT":
      return { kind: "pending" };
    default:
      return { kind: "pending" };
  }
}

/** Pull a human-readable reason out of the vendor error shape, safely. */
export function describeVendorError(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  const e = error as { errors?: Array<{ error?: string }>; detail?: string };
  if (Array.isArray(e.errors)) {
    const msgs = e.errors.map((x) => x?.error).filter(Boolean) as string[];
    if (msgs.length) return msgs.join("; ");
  }
  if (typeof e.detail === "string") return e.detail;
  return "";
}

// ---------------------------------------------------------------------------
// What to do when the order POST itself fails
// ---------------------------------------------------------------------------

export type PostFailure =
  /** The vendor answered with a status code. */
  | { kind: "http"; status: number; body?: unknown }
  /** No answer: timeout, aborted, socket dropped, DNS. */
  | { kind: "transport"; message: string };

export type PostVerdict =
  /** Provably never processed — a fresh attempt cannot double-charge. */
  | { kind: "retry"; afterMs: number }
  /** Rejected for good; no order exists. */
  | { kind: "failed"; reason: string }
  /** Unknown whether an order was created. MUST reconcile, never re-POST. */
  | { kind: "reconcile"; reason: string };

export const POST_RETRY_BACKOFF_MS = [2_000, 10_000, 30_000] as const;

/**
 * The split that matters: did the request provably NOT reach the vendor's
 * order-creation logic? Only then may we send it again.
 *
 * A 4xx is a rejection — the vendor looked at the request and refused it, so no
 * order and no charge. A 5xx, a timeout or a dropped connection means the
 * request may well have been accepted and the wallet already debited; the only
 * safe move then is to go looking for the order, never to create a second one.
 */
export function classifyPostFailure(f: PostFailure, attempts: number): PostVerdict {
  if (f.kind === "transport") {
    return { kind: "reconcile", reason: `no response from vendor: ${f.message}` };
  }
  const { status } = f;

  if (status >= 500) {
    return { kind: "reconcile", reason: `vendor returned ${status}; an order may exist` };
  }
  if (status === 429) {
    // Rate limited: rejected before any order was made, so retrying is safe.
    return attempts < POST_RETRY_BACKOFF_MS.length
      ? { kind: "retry", afterMs: POST_RETRY_BACKOFF_MS[attempts] }
      : { kind: "failed", reason: "rate limited, attempts exhausted" };
  }
  if (status === 401 || status === 403) {
    return { kind: "failed", reason: "Fragment Connection JWT rejected" };
  }
  if (status >= 400) {
    return { kind: "failed", reason: `vendor rejected the order (${status})` };
  }
  return { kind: "reconcile", reason: `unexpected status ${status}` };
}

// ---------------------------------------------------------------------------
// Supplier purchase state machine
// ---------------------------------------------------------------------------

export const PURCHASE_STATES = [
  "PAID",
  "CLAIMED",
  "ORDER_CREATING",
  "ORDER_PENDING",
  "COMPLETED",
  "FAILED",
  "UNKNOWN_SUPPLIER_STATE",
  "REFUND_PENDING",
  "REFUNDED",
] as const;
export type PurchaseState = (typeof PURCHASE_STATES)[number];

const PURCHASE_TRANSITIONS: Record<PurchaseState, readonly PurchaseState[]> = {
  PAID: ["CLAIMED", "FAILED"],
  CLAIMED: ["ORDER_CREATING", "FAILED", "REFUND_PENDING"],
  // Once we are about to POST, the outcome can become unknown at any moment.
  ORDER_CREATING: ["ORDER_PENDING", "COMPLETED", "FAILED", "UNKNOWN_SUPPLIER_STATE"],
  ORDER_PENDING: ["COMPLETED", "FAILED", "UNKNOWN_SUPPLIER_STATE"],
  COMPLETED: [],
  FAILED: ["REFUND_PENDING"],
  UNKNOWN_SUPPLIER_STATE: ["COMPLETED", "FAILED", "ORDER_PENDING"],
  REFUND_PENDING: ["REFUNDED", "FAILED"],
  REFUNDED: [],
};

export function canTransitionPurchase(from: PurchaseState, to: PurchaseState): boolean {
  return PURCHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * States from which a NEW supplier order must never be created, because one may
 * already exist and already be paid for. ORDER_CREATING is included on purpose:
 * the danger starts when the request begins, not when it succeeds.
 */
export const NO_NEW_ORDER_STATES: ReadonlySet<PurchaseState> = new Set([
  "ORDER_CREATING",
  "ORDER_PENDING",
  "COMPLETED",
  "UNKNOWN_SUPPLIER_STATE",
  "REFUND_PENDING",
  "REFUNDED",
]);

export function mayCreateSupplierOrder(state: PurchaseState): boolean {
  return !NO_NEW_ORDER_STATES.has(state);
}

/** Orders the reconciliation worker must keep chasing, including after a restart. */
export const RECONCILABLE_STATES: ReadonlySet<PurchaseState> = new Set([
  "ORDER_CREATING",
  "ORDER_PENDING",
  "UNKNOWN_SUPPLIER_STATE",
]);
