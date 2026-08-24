import { describe, it, expect } from "vitest";
import {
  PREMIUM_STAR_COST,
  premiumStarCost,
  isPremiumMonths,
  canTransition,
  isTerminal,
  classifyGiftError,
  decideAfterReconcile,
  canAutoDeliver,
  deliversToAccount,
  closeDeliveryPatch,
  isAlreadyDelivered,
  describeRecipient,
  buildBuyNote,
  parseBuyNote,
  RETRY_BACKOFF_MS,
  MAX_DELIVERY_ATTEMPTS,
  type Recipient,
} from "../src/lib/domain/premium-delivery";

describe("premium star cost", () => {
  it("matches the fixed Telegram prices", () => {
    expect(PREMIUM_STAR_COST).toEqual({ 3: 1000, 6: 1500, 12: 2500 });
    expect(premiumStarCost(3)).toBe(1000);
    expect(premiumStarCost(6)).toBe(1500);
    expect(premiumStarCost(12)).toBe(2500);
  });

  it("rejects durations Telegram does not support", () => {
    for (const m of [0, 1, 2, 4, 5, 9, 24, -3, 1.5]) {
      expect(premiumStarCost(m)).toBeNull();
      expect(isPremiumMonths(m)).toBe(false);
    }
  });
});

describe("delivery state machine", () => {
  it("walks the happy path", () => {
    expect(canTransition("CREATED", "PAYMENT_PENDING")).toBe(true);
    expect(canTransition("PAYMENT_PENDING", "PAID")).toBe(true);
    expect(canTransition("PAID", "PROCESSING")).toBe(true);
    expect(canTransition("PROCESSING", "COMPLETED")).toBe(true);
  });

  it("never lets a completed order be delivered again", () => {
    expect(isTerminal("COMPLETED")).toBe(true);
    for (const to of ["PROCESSING", "PAID", "MANUAL_REVIEW", "FAILED"] as const) {
      expect(canTransition("COMPLETED", to)).toBe(false);
    }
  });

  it("does not allow skipping the PROCESSING claim", () => {
    // PAID -> COMPLETED directly would mean delivering without claiming the
    // order first, which is exactly the race the claim exists to prevent.
    expect(canTransition("PAID", "COMPLETED")).toBe(false);
  });

  it("allows an admin retry only out of FAILED / MANUAL_REVIEW", () => {
    expect(canTransition("FAILED", "PROCESSING")).toBe(true);
    expect(canTransition("MANUAL_REVIEW", "PROCESSING")).toBe(true);
    expect(canTransition("CANCELLED", "PROCESSING")).toBe(false);
    expect(isTerminal("CANCELLED")).toBe(true);
  });
});

describe("classifyGiftError — ambiguity must never retry blindly", () => {
  it("sends a timeout / dropped connection to reconciliation", () => {
    expect(classifyGiftError({ networkError: true, description: "timeout" }, 0))
      .toEqual({ kind: "reconcile" });
  });

  it("sends a 5xx to reconciliation, not to a retry", () => {
    for (const code of [500, 502, 503, 504]) {
      expect(classifyGiftError({ errorCode: code, description: "server error" }, 0))
        .toEqual({ kind: "reconcile" });
    }
  });

  it("sends a response-less failure to reconciliation", () => {
    expect(classifyGiftError({ description: "no response" }, 0)).toEqual({ kind: "reconcile" });
  });

  it("retries a 429, which is rejected before processing", () => {
    expect(classifyGiftError({ errorCode: 429, description: "Too Many Requests" }, 0))
      .toEqual({ kind: "retry", afterMs: RETRY_BACKOFF_MS[0] });
    expect(classifyGiftError({ errorCode: 429, description: "Too Many Requests" }, 1))
      .toEqual({ kind: "retry", afterMs: RETRY_BACKOFF_MS[1] });
  });

  it("stops retrying a 429 once attempts are exhausted", () => {
    const out = classifyGiftError({ errorCode: 429, description: "x" }, MAX_DELIVERY_ATTEMPTS);
    expect(out.kind).toBe("manual_review");
  });

  it("routes an empty star balance to manual review, not a retry", () => {
    const out = classifyGiftError({ errorCode: 400, description: "BALANCE_TOO_LOW" }, 0);
    expect(out.kind).toBe("manual_review");
    const out2 = classifyGiftError({ errorCode: 400, description: "not enough Stars" }, 0);
    expect(out2.kind).toBe("manual_review");
  });

  it("treats auth problems as configuration faults", () => {
    expect(classifyGiftError({ errorCode: 403, description: "forbidden" }, 0).kind).toBe("manual_review");
    expect(classifyGiftError({ errorCode: 401, description: "unauthorized" }, 0).kind).toBe("manual_review");
  });

  it("fails a plain 400 permanently instead of looping", () => {
    const out = classifyGiftError({ errorCode: 400, description: "USER_ID_INVALID" }, 0);
    expect(out).toEqual({ kind: "failed", reason: "USER_ID_INVALID" });
  });
});

describe("decideAfterReconcile", () => {
  it("completes when the gift is found in star transactions", () => {
    expect(decideAfterReconcile(true, false, 0)).toEqual({ kind: "completed" });
    // Even with proof the request was rejected, a found transaction wins.
    expect(decideAfterReconcile(true, true, 0)).toEqual({ kind: "completed" });
  });

  it("retries only with proof the request never applied", () => {
    expect(decideAfterReconcile(false, true, 0)).toEqual({ kind: "retry", afterMs: RETRY_BACKOFF_MS[0] });
  });

  it("escalates to a human when the outcome stays unknown", () => {
    // Not found is NOT proof of not-sent: history can lag, and guessing wrong
    // here gifts twice.
    expect(decideAfterReconcile(false, false, 0).kind).toBe("manual_review");
  });

  it("escalates once attempts are exhausted", () => {
    expect(decideAfterReconcile(false, true, MAX_DELIVERY_ATTEMPTS).kind).toBe("manual_review");
  });
});

describe("recipient", () => {
  const mk = (r: Partial<Recipient>): Recipient => ({ tgId: null, username: null, source: "unresolved", ...r });

  it("allows auto delivery only with a numeric id", () => {
    expect(canAutoDeliver(mk({ tgId: "123456", source: "self" }))).toBe(true);
    expect(canAutoDeliver(mk({ tgId: "987", source: "shared" }))).toBe(true);
    // A username alone can never be delivered to: the API takes user_id only.
    expect(canAutoDeliver(mk({ username: "someone", source: "unresolved" }))).toBe(false);
    expect(canAutoDeliver(mk({ tgId: "   ", source: "unresolved" }))).toBe(false);
  });

  it("describes both resolved and unresolved recipients", () => {
    expect(describeRecipient(mk({ tgId: "42", username: "bob", source: "shared" }))).toBe("@bob (id 42)");
    expect(describeRecipient(mk({ username: "bob" }))).toContain("не определён");
  });
});

describe("deliversToAccount — regression guard for the existing catalogue", () => {
  // The buy flow branches on this. Anything that returns false keeps the
  // unchanged one-message checkout (video, qty ±, Payme/Click/Stars/admin);
  // anything true gets a single buy button that asks who it is for first.

  it("ordinary code-delivered products are UNCHANGED", () => {
    // Gemini, CapCut, Canva, ElevenLabs, Railway, Higgsfield … — every product
    // that hands over a login or a key. These must never start asking "кому?".
    for (const v of [
      {},
      { needsUsername: false },
      { fragmentKind: "" },
      { needsUsername: false, fragmentKind: "" },
      { needsUsername: null, fragmentKind: null },
    ]) {
      expect(deliversToAccount(v), JSON.stringify(v)).toBe(false);
    }
  });

  it("existing Stars items configured the documented way are UNCHANGED", () => {
    // The admin hint tells you to tick "Спрашивать @username" alongside the
    // Fragment type, so these already used the single buy button before.
    expect(deliversToAccount({ needsUsername: true, fragmentKind: "stars" })).toBe(true);
    expect(deliversToAccount({ needsUsername: true, fragmentKind: "" })).toBe(true);
  });

  it("Premium is caught even though it does not need a username", () => {
    // The bug: Premium is addressed by numeric id, so needsUsername is false,
    // and the old check let it reach payment without ever asking who it is for.
    expect(deliversToAccount({ needsUsername: false, fragmentKind: "premium" })).toBe(true);
  });

  it("a Stars item saved without the username tick is still caught", () => {
    // The two fields are independent in the admin form, so this combination is
    // reachable by mistake; it must not silently sell with no recipient.
    expect(deliversToAccount({ needsUsername: false, fragmentKind: "stars" })).toBe(true);
  });

  it("an unknown fragmentKind is treated as an ordinary product", () => {
    // updateVariantAction only ever writes "", "stars" or "premium"; anything
    // else means the field is not meaningfully configured.
    expect(deliversToAccount({ fragmentKind: "gift" })).toBe(false);
    expect(deliversToAccount({ fragmentKind: "PREMIUM" })).toBe(false);
  });
});

describe("delivery closure invariants — /give and the admin panel must agree", () => {
  // Regression: the admin web panel closed only `status`, leaving deliveryState
  // at PAID. The order then still counted as pending in /health AND /give would
  // deliver it a second time. Both paths now share this one patch.

  it("both paths produce the SAME final state for a Fragment order", () => {
    const order = { status: "awaiting_delivery", deliveryState: "PAID" };
    const now = new Date("2026-08-24T12:00:00Z");
    const viaGive = closeDeliveryPatch(order, now);
    const viaAdminPanel = closeDeliveryPatch(order, now);

    expect(viaGive).toEqual(viaAdminPanel);
    expect(viaGive).toEqual({ status: "delivered", deliveryState: "COMPLETED", deliveredAt: now });
  });

  it("closes the state machine and stamps deliveredAt", () => {
    const patch = closeDeliveryPatch({ status: "awaiting_delivery", deliveryState: "PAID" });
    expect(patch.deliveryState).toBe("COMPLETED");
    expect(patch.deliveredAt).toBeInstanceOf(Date);
  });

  it("a COMPLETED order is recognised as already delivered", () => {
    // This is what stops a second /give handing the goods over again.
    expect(isAlreadyDelivered({ status: "delivered", deliveryState: "COMPLETED" })).toBe(true);
    expect(isAlreadyDelivered({ status: "awaiting_delivery", deliveryState: "COMPLETED" })).toBe(true);
    expect(isAlreadyDelivered({ status: "delivered", deliveryState: "" })).toBe(true);
  });

  it("an order still awaiting delivery is not treated as delivered", () => {
    expect(isAlreadyDelivered({ status: "awaiting_delivery", deliveryState: "PAID" })).toBe(false);
    expect(isAlreadyDelivered({ status: "awaiting_delivery", deliveryState: "" })).toBe(false);
    expect(isAlreadyDelivered({ status: "processing", deliveryState: "PROCESSING" })).toBe(false);
  });

  it("ordinary products (Gemini/CapCut/Canva) are untouched by the state machine", () => {
    // No deliveryState in, no deliveryState out — their closure is exactly what
    // it has always been.
    for (const order of [{ status: "awaiting_delivery" }, { status: "awaiting_delivery", deliveryState: "" }, { status: "awaiting_delivery", deliveryState: null }]) {
      const patch = closeDeliveryPatch(order);
      expect(patch).toEqual({ status: "delivered" });
      expect(patch).not.toHaveProperty("deliveryState");
      expect(patch).not.toHaveProperty("deliveredAt");
    }
  });

  it("closing is idempotent in shape — re-closing yields the same patch", () => {
    const closed = { status: "delivered", deliveryState: "COMPLETED" };
    expect(closeDeliveryPatch(closed).deliveryState).toBe("COMPLETED");
    expect(isAlreadyDelivered(closed)).toBe(true); // …and callers must refuse first
  });
});

describe("buy note — carries the recipient across the payment round-trip", () => {
  it("round-trips every combination", () => {
    expect(parseBuyNote(buildBuyNote(12, 1))).toEqual({ variantId: 12, qty: 1, username: null, recipientTgId: null });
    expect(parseBuyNote(buildBuyNote(12, 2, "bob"))).toEqual({ variantId: 12, qty: 2, username: "bob", recipientTgId: null });
    expect(parseBuyNote(buildBuyNote(12, 1, "bob", "555"))).toEqual({ variantId: 12, qty: 1, username: "bob", recipientTgId: "555" });
  });

  it("keeps the id addressable when the contact has no username", () => {
    // Picking a contact often yields an id but no username; the empty segment
    // keeps the id at a fixed position instead of shifting it into `username`.
    const note = buildBuyNote(7, 1, null, "999");
    expect(note).toBe("buy:7:1::999");
    expect(parseBuyNote(note)).toEqual({ variantId: 7, qty: 1, username: null, recipientTgId: "999" });
  });

  it("still parses notes written before the recipient field existed", () => {
    expect(parseBuyNote("buy:5:3")).toEqual({ variantId: 5, qty: 3, username: null, recipientTgId: null });
    expect(parseBuyNote("buy:5:3:someone")).toEqual({ variantId: 5, qty: 3, username: "someone", recipientTgId: null });
  });

  it("rejects notes that are not purchases or are malformed", () => {
    for (const bad of [null, undefined, "", "topup:1000", "buy:", "buy:abc:1", "buy:5:0", "buy:0:1", "buy:5:-2"]) {
      expect(parseBuyNote(bad)).toBeNull();
    }
  });
});
