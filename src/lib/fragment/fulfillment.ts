// Automatic fulfilment of a paid Stars / Premium order through fragment-api.com.
//
// Everything here is orchestration over an injected `FulfillmentDeps`, so the
// whole flow — including every crash and duplicate scenario — is testable with
// fakes, without a database, a network, or a satoshi of real money.
//
// The invariant this file exists to protect:
//
//     ONE PAID ORDER  =  AT MOST ONE REAL SUPPLIER PURCHASE
//
// The vendor gives us no idempotency key, so that guarantee has to come from our
// side: an atomic claim before the request, and a hard rule that an ambiguous
// outcome is investigated, never retried.

import type { FragmentOrderResponse, MoneyAmount } from "./api-types";
import {
  isValidFragmentUsername,
  isValidPremiumMonths,
  isValidStarsQuantity,
  normalizeUsername,
} from "./api-types";
import {
  classifyPostFailure,
  interpretStatus,
  mayCreateSupplierOrder,
  preflight,
  totalSupplierCost,
  type PostFailure,
  type PreflightBlock,
  type PurchaseState,
} from "./purchase-policy";

/** What fulfilment needs to know. Deliberately no payment details: this layer
 *  starts from an order that is already paid and must not care how. */
export interface FulfillmentIntent {
  orderId: number;
  kind: "stars" | "premium";
  /** Stars: quantity. Premium: months (3/6/12). */
  amount: number;
  /** Recipient Telegram username; "@" and spacing are tolerated. */
  recipient: string;
  /** What the customer paid, in UZS — used only for the margin guard. */
  customerRevenueUzs: number;
}

export interface ClaimedPurchase {
  purchaseId: number;
  state: PurchaseState;
  /** Set when a previous attempt already created a supplier order. */
  supplierOrderId: string | null;
}

export interface FulfillmentConfig {
  minWalletReserve: string;
  minMarginBps: number;
  /** TON→UZS and USDT→UZS rates; null means "unknown", which blocks the buy. */
  rateToUzs: (currency: string) => number | null;
}

export interface FulfillmentDeps {
  cfg: FulfillmentConfig;
  /**
   * Atomically move this order into CLAIMED and return the purchase row, or
   * null if another worker already holds it. MUST be a compare-and-set at the
   * database level — an in-memory lock does not survive two processes.
   */
  claim(orderId: number): Promise<ClaimedPurchase | null>;
  /** Persist a state change, plus whatever is known so far. */
  update(purchaseId: number, patch: PurchasePatch): Promise<void>;

  checkRecipient(username: string): Promise<{ ok: boolean; reason?: string }>;
  /** Live unit price for this kind/amount, or null when unavailable. */
  quote(kind: "stars" | "premium", amount: number): Promise<MoneyAmount | null>;
  /** Wallet balance in the quote currency, or null when unavailable. */
  walletBalance(currency: string): Promise<string | null>;

  createOrder(intent: FulfillmentIntent): Promise<
    | { ok: true; order: FragmentOrderResponse }
    | { ok: false; failure: PostFailure }
  >;
  fetchOrder(supplierOrderId: string): Promise<
    | { ok: true; order: FragmentOrderResponse }
    | { ok: false; failure: PostFailure }
  >;
  /**
   * Look for an order we may have created but never recorded — the gap between
   * "request sent" and "response stored". Returns null when nothing matches.
   */
  findRecentOrder?(intent: FulfillmentIntent): Promise<FragmentOrderResponse | null>;

  log(event: string, data: Record<string, unknown>): void;
}

export interface PurchasePatch {
  state?: PurchaseState;
  supplierOrderId?: string | null;
  supplierStatus?: string | null;
  quotedAmount?: string | null;
  quotedCurrency?: string | null;
  fee?: string | null;
  lastError?: string | null;
  attempts?: number;
  completedAt?: Date | null;
}

export type FulfillmentOutcome =
  | { kind: "completed"; supplierOrderId: string }
  /** In flight at the vendor; the reconciler takes it from here. */
  | { kind: "pending"; supplierOrderId: string }
  /** Nothing was bought. Safe to refund. */
  | { kind: "failed"; reason: string; block?: PreflightBlock }
  /** Another worker owns this order. Do nothing. */
  | { kind: "already_claimed" }
  /** An order may exist. Never re-purchase; the reconciler resolves it. */
  | { kind: "needs_reconcile"; reason: string };

/**
 * Buy one paid order. Safe to call twice: the second call loses the claim and
 * returns `already_claimed` without touching the vendor.
 */
export async function fulfillFragmentOrder(
  intent: FulfillmentIntent,
  deps: FulfillmentDeps,
): Promise<FulfillmentOutcome> {
  const recipient = normalizeUsername(intent.recipient);

  // --- Cheap validation first: never claim an order we cannot possibly fill ---
  if (!isValidFragmentUsername(recipient)) {
    return { kind: "failed", reason: "recipient username is not valid on Fragment" };
  }
  if (intent.kind === "stars" && !isValidStarsQuantity(intent.amount)) {
    return { kind: "failed", reason: `Stars quantity ${intent.amount} is outside the supplier range` };
  }
  if (intent.kind === "premium" && !isValidPremiumMonths(intent.amount)) {
    return { kind: "failed", reason: `Premium duration ${intent.amount} months is not offered` };
  }

  // --- The claim. Everything after this point is exclusive to one worker. ---
  const claimed = await deps.claim(intent.orderId);
  if (!claimed) return { kind: "already_claimed" };

  // A previous attempt may have got further than we know. If an order already
  // exists, or the state says one might, we resolve it instead of buying again.
  if (claimed.supplierOrderId) {
    return finishFromSupplier(claimed, claimed.supplierOrderId, deps);
  }
  if (!mayCreateSupplierOrder(claimed.state)) {
    return { kind: "needs_reconcile", reason: `state ${claimed.state} may already have an order` };
  }

  const { purchaseId } = claimed;

  // --- Recipient must exist before money moves; a gift cannot be recalled ---
  const rec = await deps.checkRecipient(recipient);
  if (!rec.ok) {
    await deps.update(purchaseId, { state: "FAILED", lastError: rec.reason ?? "recipient not found" });
    return { kind: "failed", reason: rec.reason ?? "recipient not found on Fragment" };
  }

  // --- Live price, live balance, margin. No stale numbers. ---
  const price = await deps.quote(intent.kind, intent.amount);
  if (!price) {
    await deps.update(purchaseId, { state: "FAILED", lastError: "no live quote" });
    return { kind: "failed", reason: "supplier price unavailable", block: "NO_PRICE" };
  }
  const balance = await deps.walletBalance(price.currency);
  const verdict = preflight({
    customerRevenueUzs: intent.customerRevenueUzs,
    supplierCost: price,
    rateToUzs: deps.cfg.rateToUzs(price.currency),
    walletBalance: balance,
    minWalletReserve: deps.cfg.minWalletReserve,
    minMarginBps: deps.cfg.minMarginBps,
  });
  if (!verdict.ok) {
    await deps.update(purchaseId, {
      state: "FAILED",
      quotedAmount: price.amount,
      quotedCurrency: price.currency,
      lastError: `${verdict.reason}: ${verdict.detail}`,
    });
    deps.log("fragment.preflight_blocked", { orderId: intent.orderId, reason: verdict.reason });
    return { kind: "failed", reason: verdict.detail, block: verdict.reason };
  }

  // --- The point of no return. Record the intent to buy BEFORE buying, so a
  //     crash mid-request still leaves evidence that an order may exist. ---
  await deps.update(purchaseId, {
    state: "ORDER_CREATING",
    quotedAmount: price.amount,
    quotedCurrency: price.currency,
  });
  deps.log("fragment.order_creating", {
    orderId: intent.orderId, kind: intent.kind, amount: intent.amount,
    recipient, quote: `${price.amount} ${price.currency}`,
  });

  const res = await deps.createOrder({ ...intent, recipient });

  if (!res.ok) {
    const verdictPost = classifyPostFailure(res.failure, 0);
    if (verdictPost.kind === "failed") {
      await deps.update(purchaseId, { state: "FAILED", lastError: verdictPost.reason });
      return { kind: "failed", reason: verdictPost.reason };
    }
    // Retry is only ever offered for provably-unprocessed rejections, and even
    // then the caller decides when; we do not loop here holding a claim.
    if (verdictPost.kind === "retry") {
      await deps.update(purchaseId, { state: "CLAIMED", lastError: "retryable rejection" });
      return { kind: "needs_reconcile", reason: "retryable rejection; will be retried" };
    }
    // Ambiguous. An order may exist and the wallet may already be lighter.
    await deps.update(purchaseId, { state: "UNKNOWN_SUPPLIER_STATE", lastError: verdictPost.reason });
    deps.log("fragment.ambiguous_post", { orderId: intent.orderId, reason: verdictPost.reason });

    // Best effort: try to find the order rather than leaving it unresolved.
    if (deps.findRecentOrder) {
      const found = await deps.findRecentOrder({ ...intent, recipient }).catch(() => null);
      if (found) return finishFromResponse(purchaseId, found, deps);
    }
    return { kind: "needs_reconcile", reason: verdictPost.reason };
  }

  return finishFromResponse(purchaseId, res.order, deps);
}

/** Apply a supplier response to our record and say what it means. */
async function finishFromResponse(
  purchaseId: number,
  order: FragmentOrderResponse,
  deps: FulfillmentDeps,
): Promise<FulfillmentOutcome> {
  const verdict = interpretStatus(order.status, order.error);
  const common: PurchasePatch = {
    supplierOrderId: order.id,
    supplierStatus: order.status,
    fee: order.fee?.amount ?? null,
  };

  if (verdict.kind === "completed") {
    await deps.update(purchaseId, { ...common, state: "COMPLETED", completedAt: new Date(), lastError: null });
    deps.log("fragment.completed", { supplierOrderId: order.id, receiver: order.receiver });
    return { kind: "completed", supplierOrderId: order.id };
  }
  if (verdict.kind === "failed") {
    await deps.update(purchaseId, { ...common, state: "FAILED", lastError: verdict.detail });
    deps.log("fragment.failed", { supplierOrderId: order.id, reason: verdict.detail });
    return { kind: "failed", reason: verdict.detail || "supplier reported failure" };
  }
  await deps.update(purchaseId, { ...common, state: "ORDER_PENDING" });
  return { kind: "pending", supplierOrderId: order.id };
}

/** Resolve a purchase we already have a supplier order id for. */
async function finishFromSupplier(
  claimed: ClaimedPurchase,
  supplierOrderId: string,
  deps: FulfillmentDeps,
): Promise<FulfillmentOutcome> {
  const res = await deps.fetchOrder(supplierOrderId);
  if (!res.ok) {
    return { kind: "needs_reconcile", reason: "could not read the existing supplier order" };
  }
  return finishFromResponse(claimed.purchaseId, res.order, deps);
}

/**
 * Chase one in-flight purchase. This is what runs after a restart, and what a
 * webhook callback triggers — the callback is only a nudge to come and ask the
 * vendor, never the answer itself.
 */
export async function reconcilePurchase(
  purchase: { purchaseId: number; supplierOrderId: string | null; state: PurchaseState },
  intent: FulfillmentIntent | null,
  deps: FulfillmentDeps,
): Promise<FulfillmentOutcome> {
  if (purchase.supplierOrderId) {
    return finishFromSupplier(
      { purchaseId: purchase.purchaseId, state: purchase.state, supplierOrderId: purchase.supplierOrderId },
      purchase.supplierOrderId,
      deps,
    );
  }

  // No id recorded: the crash happened around the request itself. Search rather
  // than assume — assuming "not created" here is what buys the same gift twice.
  if (intent && deps.findRecentOrder) {
    const found = await deps.findRecentOrder(intent).catch(() => null);
    if (found) return finishFromResponse(purchase.purchaseId, found, deps);
  }
  return { kind: "needs_reconcile", reason: "no supplier order id and none found" };
}

/** Supplier cost including fee, for reporting and the canary preview. */
export function costWithFee(order: FragmentOrderResponse): MoneyAmount | null {
  if (!order.price) return null;
  return totalSupplierCost(order.price, order.fee);
}
