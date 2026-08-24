import { describe, it, expect } from "vitest";
import {
  fulfillFragmentOrder,
  reconcilePurchase,
  type ClaimedPurchase,
  type FulfillmentDeps,
  type FulfillmentIntent,
  type PurchasePatch,
} from "../src/lib/fragment/fulfillment";
import type { FragmentOrderResponse } from "../src/lib/fragment/api-types";
import type { PurchaseState } from "../src/lib/fragment/purchase-policy";

const INTENT: FulfillmentIntent = {
  orderId: 782,
  kind: "stars",
  amount: 50,
  recipient: "@Abdulloh_Zokirov",
  customerRevenueUzs: 13_000,
};

function order(over: Partial<FragmentOrderResponse> = {}): FragmentOrderResponse {
  return {
    success: true,
    id: "sup-1",
    receiver: "Abdulloh_Zokirov",
    goods_quantity: 50,
    sender: null,
    price: { currency: "ton", amount: "0.5040000000" },
    fee: { currency: "ton", amount: "0.0100000000" },
    ref_id: "order-1",
    status: "COMPLETED",
    type: "STARS",
    error: null,
    created_at: "2026-08-25T00:00:00Z",
    ...over,
  };
}

/**
 * Stands in for the database and the vendor. `claim` behaves like a real
 * compare-and-set: the first caller gets the row, everyone else gets null.
 */
class Fake implements FulfillmentDeps {
  cfg = {
    minWalletReserve: "0.05",
    minMarginBps: 1000,
    rateToUzs: () => 15_000 as number | null,
  };
  claimed = false;
  purchase: ClaimedPurchase = { purchaseId: 1, state: "PAID" as PurchaseState, supplierOrderId: null };
  patches: PurchasePatch[] = [];
  /** Every real order-creation attempt. Length > 1 means we bought twice. */
  createCalls: FulfillmentIntent[] = [];
  logs: Array<{ event: string; data: Record<string, unknown> }> = [];

  recipientOk = true;
  quoteValue: { currency: "ton"; amount: string } | null = { currency: "ton", amount: "0.514" };
  balance: string | null = "10";
  createResult: { ok: true; order: FragmentOrderResponse } | { ok: false; failure: any } = { ok: true, order: order() };
  fetchResult: { ok: true; order: FragmentOrderResponse } | { ok: false; failure: any } = { ok: true, order: order() };
  recentOrder: FragmentOrderResponse | null = null;

  async claim(_orderId: number) {
    if (this.claimed) return null;
    this.claimed = true;
    return this.purchase;
  }
  async update(_id: number, patch: PurchasePatch) { this.patches.push(patch); }
  async checkRecipient() { return this.recipientOk ? { ok: true } : { ok: false, reason: "Recipient username was not found on Fragment" }; }
  async quote() { return this.quoteValue; }
  async walletBalance() { return this.balance; }
  async createOrder(intent: FulfillmentIntent) { this.createCalls.push(intent); return this.createResult; }
  async fetchOrder() { return this.fetchResult; }
  async findRecentOrder() { return this.recentOrder; }
  log(event: string, data: Record<string, unknown>) { this.logs.push({ event, data }); }

  get states() { return this.patches.map((p) => p.state).filter(Boolean); }
}

describe("happy path", () => {
  it("buys once and completes", async () => {
    const d = new Fake();
    const out = await fulfillFragmentOrder(INTENT, d);

    expect(out).toEqual({ kind: "completed", supplierOrderId: "sup-1" });
    expect(d.createCalls).toHaveLength(1);
    expect(d.states).toEqual(["ORDER_CREATING", "COMPLETED"]);
    // The "@" must be stripped before the username reaches the vendor.
    expect(d.createCalls[0].recipient).toBe("Abdulloh_Zokirov");
  });

  it("goes pending when the vendor is still working", async () => {
    const d = new Fake();
    d.createResult = { ok: true, order: order({ status: "PENDING" }) };
    const out = await fulfillFragmentOrder(INTENT, d);
    expect(out).toEqual({ kind: "pending", supplierOrderId: "sup-1" });
    expect(d.states).toContain("ORDER_PENDING");
  });

  it("treats BLOCKCHAIN_SENT as still in flight, never as done", async () => {
    const d = new Fake();
    d.createResult = { ok: true, order: order({ status: "BLOCKCHAIN_SENT" }) };
    const out = await fulfillFragmentOrder(INTENT, d);
    expect(out.kind).toBe("pending");
  });

  it("buys Premium for a supported duration", async () => {
    const d = new Fake();
    d.createResult = { ok: true, order: order({ type: "PREMIUM" }) };
    const out = await fulfillFragmentOrder({ ...INTENT, kind: "premium", amount: 3, customerRevenueUzs: 250_000 }, d);
    expect(out.kind).toBe("completed");
  });
});

describe("ONE PAID ORDER = AT MOST ONE PURCHASE", () => {
  it("a second worker gets nothing and never reaches the vendor", async () => {
    const d = new Fake();
    await fulfillFragmentOrder(INTENT, d);
    const second = await fulfillFragmentOrder(INTENT, d);

    expect(second).toEqual({ kind: "already_claimed" });
    expect(d.createCalls).toHaveLength(1);
  });

  it("two workers racing produce exactly one purchase", async () => {
    const d = new Fake();
    const results = await Promise.all([
      fulfillFragmentOrder(INTENT, d),
      fulfillFragmentOrder(INTENT, d),
      fulfillFragmentOrder(INTENT, d),
    ]);
    expect(d.createCalls).toHaveLength(1);
    expect(results.filter((r) => r.kind === "already_claimed")).toHaveLength(2);
  });

  it("refuses to buy again when the row already carries a supplier order", async () => {
    // This is the restart case: we crashed after creating the order.
    const d = new Fake();
    d.purchase = { purchaseId: 1, state: "ORDER_PENDING", supplierOrderId: "sup-1" };
    const out = await fulfillFragmentOrder(INTENT, d);

    expect(d.createCalls).toHaveLength(0);
    expect(out).toEqual({ kind: "completed", supplierOrderId: "sup-1" });
  });

  it("refuses to buy from any state where an order might exist", async () => {
    for (const state of ["ORDER_CREATING", "ORDER_PENDING", "UNKNOWN_SUPPLIER_STATE", "COMPLETED"] as const) {
      const d = new Fake();
      d.purchase = { purchaseId: 1, state, supplierOrderId: null };
      const out = await fulfillFragmentOrder(INTENT, d);
      expect(out.kind, state).toBe("needs_reconcile");
      expect(d.createCalls, state).toHaveLength(0);
    }
  });
});

describe("ambiguous outcomes never buy twice", () => {
  it("a timeout goes to reconciliation, not a second order", async () => {
    const d = new Fake();
    d.createResult = { ok: false, failure: { kind: "transport", message: "timeout" } };
    const out = await fulfillFragmentOrder(INTENT, d);

    expect(out.kind).toBe("needs_reconcile");
    expect(d.states).toContain("UNKNOWN_SUPPLIER_STATE");
    expect(d.createCalls).toHaveLength(1);
  });

  it("a 5xx goes to reconciliation — the order may exist", async () => {
    const d = new Fake();
    d.createResult = { ok: false, failure: { kind: "http", status: 502 } };
    const out = await fulfillFragmentOrder(INTENT, d);
    expect(out.kind).toBe("needs_reconcile");
    expect(d.states).toContain("UNKNOWN_SUPPLIER_STATE");
  });

  it("recovers silently when the lost order is found", async () => {
    const d = new Fake();
    d.createResult = { ok: false, failure: { kind: "transport", message: "socket hang up" } };
    d.recentOrder = order({ id: "sup-lost" });

    const out = await fulfillFragmentOrder(INTENT, d);
    expect(out).toEqual({ kind: "completed", supplierOrderId: "sup-lost" });
    expect(d.createCalls).toHaveLength(1); // still only one attempt
  });

  it("marks a plain rejection failed without reconciliation", async () => {
    const d = new Fake();
    d.createResult = { ok: false, failure: { kind: "http", status: 400, body: { detail: "bad request" } } };
    const out = await fulfillFragmentOrder(INTENT, d);
    expect(out.kind).toBe("failed");
    expect(d.states).toContain("FAILED");
  });
});

describe("nothing is bought that cannot be delivered or afforded", () => {
  it("rejects an invalid username before claiming anything", async () => {
    const d = new Fake();
    const out = await fulfillFragmentOrder({ ...INTENT, recipient: "no" }, d);
    expect(out.kind).toBe("failed");
    expect(d.claimed).toBe(false);
    expect(d.createCalls).toHaveLength(0);
  });

  it("rejects a Stars amount under the supplier minimum", async () => {
    const d = new Fake();
    const out = await fulfillFragmentOrder({ ...INTENT, amount: 49 }, d);
    expect(out.kind).toBe("failed");
    expect(d.createCalls).toHaveLength(0);
  });

  it("rejects an unsupported Premium duration", async () => {
    const d = new Fake();
    const out = await fulfillFragmentOrder({ ...INTENT, kind: "premium", amount: 9 }, d);
    expect(out.kind).toBe("failed");
    expect(d.createCalls).toHaveLength(0);
  });

  it("stops when the recipient does not exist on Fragment", async () => {
    const d = new Fake();
    d.recipientOk = false;
    const out = await fulfillFragmentOrder(INTENT, d);
    expect(out.kind).toBe("failed");
    expect(d.createCalls).toHaveLength(0);
    expect(d.states).toContain("FAILED");
  });

  it("stops when there is no live quote", async () => {
    const d = new Fake();
    d.quoteValue = null;
    const out = await fulfillFragmentOrder(INTENT, d);
    expect(out).toMatchObject({ kind: "failed", block: "NO_PRICE" });
    expect(d.createCalls).toHaveLength(0);
  });

  it("stops when the wallet cannot cover cost plus reserve", async () => {
    const d = new Fake();
    d.balance = "0.2";
    const out = await fulfillFragmentOrder(INTENT, d);
    expect(out).toMatchObject({ kind: "failed", block: "INSUFFICIENT_BALANCE" });
    expect(d.createCalls).toHaveLength(0);
  });

  it("stops rather than selling at a loss", async () => {
    const d = new Fake();
    // 0.514 TON at 15 000 ≈ 7 710 сум; charging 5 000 would lose money.
    const out = await fulfillFragmentOrder({ ...INTENT, customerRevenueUzs: 5_000 }, d);
    expect(out).toMatchObject({ kind: "failed", block: "MARGIN_TOO_LOW" });
    expect(d.createCalls).toHaveLength(0);
  });

  it("stops when the exchange rate is unknown instead of guessing", async () => {
    const d = new Fake();
    d.cfg.rateToUzs = () => null;
    const out = await fulfillFragmentOrder(INTENT, d);
    expect(out).toMatchObject({ kind: "failed", block: "NO_RATE" });
    expect(d.createCalls).toHaveLength(0);
  });
});

describe("reconciliation after a restart", () => {
  it("completes a pending purchase from the supplier's answer", async () => {
    const d = new Fake();
    const out = await reconcilePurchase(
      { purchaseId: 1, supplierOrderId: "sup-1", state: "ORDER_PENDING" }, null, d,
    );
    expect(out).toEqual({ kind: "completed", supplierOrderId: "sup-1" });
    expect(d.createCalls).toHaveLength(0);
  });

  it("marks a purchase failed when the supplier says so", async () => {
    const d = new Fake();
    d.fetchResult = { ok: true, order: order({ status: "FAILED", error: { errors: [{ error: "Recipient not found" }] } }) };
    const out = await reconcilePurchase(
      { purchaseId: 1, supplierOrderId: "sup-1", state: "ORDER_PENDING" }, null, d,
    );
    expect(out.kind).toBe("failed");
  });

  it("keeps chasing while the supplier is still working", async () => {
    const d = new Fake();
    d.fetchResult = { ok: true, order: order({ status: "PENDING" }) };
    const out = await reconcilePurchase(
      { purchaseId: 1, supplierOrderId: "sup-1", state: "ORDER_PENDING" }, null, d,
    );
    expect(out.kind).toBe("pending");
  });

  it("finds an order that was created but never recorded", async () => {
    // The nastiest crash window: request sent, process died before the id was saved.
    const d = new Fake();
    d.recentOrder = order({ id: "sup-orphan" });
    const out = await reconcilePurchase(
      { purchaseId: 1, supplierOrderId: null, state: "UNKNOWN_SUPPLIER_STATE" }, INTENT, d,
    );
    expect(out).toEqual({ kind: "completed", supplierOrderId: "sup-orphan" });
    expect(d.createCalls).toHaveLength(0);
  });

  it("stays unresolved rather than buying again when nothing is found", async () => {
    const d = new Fake();
    d.recentOrder = null;
    const out = await reconcilePurchase(
      { purchaseId: 1, supplierOrderId: null, state: "UNKNOWN_SUPPLIER_STATE" }, INTENT, d,
    );
    expect(out.kind).toBe("needs_reconcile");
    expect(d.createCalls).toHaveLength(0);
  });

  it("does not resolve on an unreadable supplier response", async () => {
    const d = new Fake();
    d.fetchResult = { ok: false, failure: { kind: "transport", message: "timeout" } };
    const out = await reconcilePurchase(
      { purchaseId: 1, supplierOrderId: "sup-1", state: "ORDER_PENDING" }, null, d,
    );
    expect(out.kind).toBe("needs_reconcile");
  });
});
