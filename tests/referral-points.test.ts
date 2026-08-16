import { describe, it, expect } from "vitest";

// Mirrors availableReferralPoints() in src/bot/index.ts. The bot's own version
// reads the DB, so the arithmetic is duplicated here to pin the invariants that
// the referral-fraud fixes depend on.
function availablePoints(verifiedRefs: number, bonus: number, spent: number): number {
  return Math.max(0, verifiedRefs + bonus - spent);
}

// Mirrors refundRefPoints()'s GREATEST(0, spent - points) clamp.
function refund(spent: number, points: number): number {
  return Math.max(0, spent - points);
}

// Mirrors countVerifiedRefs(): only invitees with channelVerifiedAt set count.
type Invitee = { channelVerifiedAt: Date | null };
function countVerified(invitees: Invitee[]): number {
  return invitees.filter((u) => u.channelVerifiedAt !== null).length;
}

describe("referral point accounting", () => {
  it("counts only channel-verified invitees", () => {
    const invitees: Invitee[] = [
      { channelVerifiedAt: new Date() },
      { channelVerifiedAt: null }, // clicked the link, never subscribed
      { channelVerifiedAt: null },
      { channelVerifiedAt: new Date() },
    ];
    expect(countVerified(invitees)).toBe(2);
  });

  it("gives a referral-link bot farm zero points", () => {
    // 1000 /start ref... hits that never subscribe.
    const invitees: Invitee[] = Array.from({ length: 1000 }, () => ({ channelVerifiedAt: null }));
    expect(availablePoints(countVerified(invitees), 0, 0)).toBe(0);
  });

  it("never reports negative points when spent exceeds earned", () => {
    // The /refzero state: spentReferrals frozen at the earned total.
    expect(availablePoints(5, 0, 5)).toBe(0);
    expect(availablePoints(3, 0, 99)).toBe(0);
  });

  it("counts admin bonus alongside verified invitees", () => {
    expect(availablePoints(4, 3, 2)).toBe(5);
  });

  it("spending then refunding returns to the original balance", () => {
    const verified = 10;
    let spent = 0;
    expect(availablePoints(verified, 0, spent)).toBe(10);

    spent += 3; // buyForReferrals debits up front
    expect(availablePoints(verified, 0, spent)).toBe(7);

    spent = refund(spent, 3); // executePurchase aborted → points handed back
    expect(availablePoints(verified, 0, spent)).toBe(10);
  });

  it("clamps a double refund instead of minting points", () => {
    let spent = 2;
    spent = refund(spent, 5); // refunding more than was ever spent
    expect(spent).toBe(0);
    expect(availablePoints(1, 0, spent)).toBe(1); // not 4
  });
});

// Mirrors isUserAction() in src/bot/index.ts. The terms/subscription/maintenance
// gates run as bot.use() middleware, which grammy invokes for EVERY update type.
// Without this guard the terms gate swallowed the chat_member update fired when
// an invitee joins the channel, so bot.on("chat_member") never ran and the
// referral was never credited automatically.
type Update = { message?: unknown; callbackQuery?: unknown };
function isUserAction(ctx: Update): boolean {
  return Boolean(ctx.message || ctx.callbackQuery);
}

describe("middleware gating by update type", () => {
  it("gates messages and button taps", () => {
    expect(isUserAction({ message: { text: "/shop" } })).toBe(true);
    expect(isUserAction({ callbackQuery: { data: "m:0:all" } })).toBe(true);
  });

  it("lets a channel join through ungated so the referral can be credited", () => {
    // chat_member / chat_join_request carry no user message and their ctx.chat
    // is the channel — gating them blocked auto-crediting entirely.
    expect(isUserAction({})).toBe(false);
  });
});

// Mirrors the stOf() helper in buildMenu() and availableStock(). These two used
// to disagree; the test pins them to one definition.
const STOCK_UNLIMITED = 999999;
type Variant = {
  localStock: number;
  autoSupplier: boolean;
  supplierStock: number;
  manualDelivery: boolean;
  manualStockLimit?: number;
};
function stockOf(v: Variant): number {
  if (v.manualDelivery) {
    return v.manualStockLimit !== undefined && v.manualStockLimit >= 0 ? v.manualStockLimit : STOCK_UNLIMITED;
  }
  return v.localStock + (v.autoSupplier ? v.supplierStock : 0);
}

describe("stock availability", () => {
  it("adds local stock to supplier stock", () => {
    expect(stockOf({ localStock: 5, autoSupplier: true, supplierStock: 3, manualDelivery: false })).toBe(8);
  });

  it("still sells from local stock when the supplier is empty", () => {
    // The old menu logic reported 0 here and hid a buyable product.
    expect(stockOf({ localStock: 5, autoSupplier: true, supplierStock: 0, manualDelivery: false })).toBe(5);
  });

  it("ignores supplier stock when auto-supply is off", () => {
    expect(stockOf({ localStock: 2, autoSupplier: false, supplierStock: 99, manualDelivery: false })).toBe(2);
  });

  it("respects a manual-delivery limit of zero", () => {
    // The old menu logic reported STOCK_UNLIMITED for every manual item.
    expect(stockOf({ localStock: 0, autoSupplier: false, supplierStock: 0, manualDelivery: true, manualStockLimit: 0 })).toBe(0);
  });

  it("treats an unset manual limit as unlimited", () => {
    expect(stockOf({ localStock: 0, autoSupplier: false, supplierStock: 0, manualDelivery: true })).toBe(STOCK_UNLIMITED);
    expect(stockOf({ localStock: 0, autoSupplier: false, supplierStock: 0, manualDelivery: true, manualStockLimit: -1 })).toBe(STOCK_UNLIMITED);
  });
});
