import { describe, it, expect } from "vitest";
import {
  compareDecimal,
  addDecimal,
  totalSupplierCost,
  preflight,
  interpretStatus,
  describeVendorError,
  classifyPostFailure,
  canTransitionPurchase,
  mayCreateSupplierOrder,
  NO_NEW_ORDER_STATES,
  RECONCILABLE_STATES,
  POST_RETRY_BACKOFF_MS,
} from "../src/lib/fragment/purchase-policy";
import {
  normalizeUsername,
  isValidFragmentUsername,
  isValidStarsQuantity,
  isValidPremiumMonths,
  STARS_MIN_QUANTITY,
} from "../src/lib/fragment/api-types";

describe("decimal money — vendor amounts are strings and must stay exact", () => {
  it("compares without float error", () => {
    expect(compareDecimal("8.0800000000", "8.08")).toBe(0);
    expect(compareDecimal("0.1", "0.2")).toBe(-1);
    expect(compareDecimal("10", "9.99999")).toBe(1);
    expect(compareDecimal("1.0000000001", "1")).toBe(1);
  });

  it("adds without float error", () => {
    // 0.1 + 0.2 is the classic float trap; as decimals it must be exactly 0.3.
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(addDecimal("8.0800000000", "0.5")).toBe("8.5800000000");
    expect(addDecimal("1", "2")).toBe("3");
  });

  it("adds the fee to the price", () => {
    const total = totalSupplierCost(
      { currency: "ton", amount: "8.08" },
      { currency: "ton", amount: "0.5" },
    );
    expect(total).toEqual({ currency: "ton", amount: "8.58" });
  });

  it("treats a missing fee as zero", () => {
    expect(totalSupplierCost({ currency: "ton", amount: "8.08" }, null))
      .toEqual({ currency: "ton", amount: "8.08" });
  });

  it("refuses to add a fee in a different currency", () => {
    // Silently ignoring it would understate what the wallet is about to pay.
    expect(() => totalSupplierCost(
      { currency: "ton", amount: "8.08" },
      { currency: "usdt_ton", amount: "0.5" },
    )).toThrow(/currency/);
  });
});

describe("preflight — nothing leaves the wallet unless all of this holds", () => {
  const base = {
    customerRevenueUzs: 200_000,
    supplierCost: { currency: "ton" as const, amount: "8.58" },
    rateToUzs: 15_000,      // 8.58 TON ≈ 128 700 сум
    walletBalance: "50",
    minWalletReserve: "0.5",
    minMarginBps: 1000,      // 10%
  };

  it("passes a healthy order and reports the margin", () => {
    const v = preflight(base);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.marginUzs).toBe(200_000 - 128_700);
      expect(v.marginBps).toBeGreaterThan(3000);
    }
  });

  it("refuses without a live quote", () => {
    const v = preflight({ ...base, supplierCost: { currency: "ton", amount: "" } });
    expect(v).toMatchObject({ ok: false, reason: "NO_PRICE" });
  });

  it("refuses without an exchange rate rather than guessing", () => {
    for (const rate of [null, 0, -1, NaN]) {
      expect(preflight({ ...base, rateToUzs: rate })).toMatchObject({ ok: false, reason: "NO_RATE" });
    }
  });

  it("refuses when the balance is unknown", () => {
    expect(preflight({ ...base, walletBalance: null })).toMatchObject({ ok: false, reason: "NO_BALANCE" });
  });

  it("refuses when the balance cannot cover cost plus reserve", () => {
    // Exactly the cost is NOT enough — the gas reserve must survive.
    const v = preflight({ ...base, walletBalance: "8.58" });
    expect(v).toMatchObject({ ok: false, reason: "INSUFFICIENT_BALANCE" });
  });

  it("accepts when the balance covers cost plus reserve exactly", () => {
    expect(preflight({ ...base, walletBalance: "9.08" }).ok).toBe(true);
  });

  it("refuses to sell at a loss", () => {
    // Revenue below cost: this is the case that quietly drains a shop.
    const v = preflight({ ...base, customerRevenueUzs: 100_000 });
    expect(v).toMatchObject({ ok: false, reason: "MARGIN_TOO_LOW" });
  });

  it("refuses a margin that is positive but thinner than configured", () => {
    // ~132 000 revenue on ~128 700 cost is a real profit, but under 10%.
    const v = preflight({ ...base, customerRevenueUzs: 132_000 });
    expect(v).toMatchObject({ ok: false, reason: "MARGIN_TOO_LOW" });
  });
});

describe("supplier status", () => {
  it("only COMPLETED means delivered", () => {
    expect(interpretStatus("COMPLETED")).toEqual({ kind: "completed" });
  });

  it("keeps every in-flight status pending, including BLOCKCHAIN_SENT", () => {
    for (const s of ["CREATED", "PENDING", "BLOCKCHAIN_SENT"] as const) {
      expect(interpretStatus(s).kind, s).toBe("pending");
    }
  });

  it("reports FAILED with the vendor reason", () => {
    const v = interpretStatus("FAILED", { errors: [{ error: "Recipient username was not found on Fragment" }] });
    expect(v.kind).toBe("failed");
    if (v.kind === "failed") expect(v.detail).toMatch(/not found on Fragment/);
  });

  it("survives odd error shapes", () => {
    expect(describeVendorError(null)).toBe("");
    expect(describeVendorError("plain string")).toBe("plain string");
    expect(describeVendorError({ detail: "nope" })).toBe("nope");
    expect(describeVendorError({ errors: [] })).toBe("");
  });
});

describe("order POST failure — a second POST is a second real purchase", () => {
  it("routes a timeout to reconciliation, never a retry", () => {
    const v = classifyPostFailure({ kind: "transport", message: "timeout" }, 0);
    expect(v.kind).toBe("reconcile");
  });

  it("routes a 5xx to reconciliation — the order may already exist", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyPostFailure({ kind: "http", status }, 0).kind, String(status)).toBe("reconcile");
    }
  });

  it("retries a 429, which is rejected before any order is made", () => {
    expect(classifyPostFailure({ kind: "http", status: 429 }, 0))
      .toEqual({ kind: "retry", afterMs: POST_RETRY_BACKOFF_MS[0] });
    expect(classifyPostFailure({ kind: "http", status: 429 }, 2))
      .toEqual({ kind: "retry", afterMs: POST_RETRY_BACKOFF_MS[2] });
  });

  it("stops retrying a 429 once attempts run out", () => {
    expect(classifyPostFailure({ kind: "http", status: 429 }, 3).kind).toBe("failed");
  });

  it("fails a plain 400 permanently instead of looping", () => {
    expect(classifyPostFailure({ kind: "http", status: 400 }, 0).kind).toBe("failed");
  });

  it("names a rejected JWT rather than retrying it", () => {
    for (const status of [401, 403]) {
      const v = classifyPostFailure({ kind: "http", status }, 0);
      expect(v.kind).toBe("failed");
      if (v.kind === "failed") expect(v.reason).toMatch(/JWT/);
    }
  });
});

describe("purchase state machine", () => {
  it("walks the happy path", () => {
    expect(canTransitionPurchase("PAID", "CLAIMED")).toBe(true);
    expect(canTransitionPurchase("CLAIMED", "ORDER_CREATING")).toBe(true);
    expect(canTransitionPurchase("ORDER_CREATING", "ORDER_PENDING")).toBe(true);
    expect(canTransitionPurchase("ORDER_PENDING", "COMPLETED")).toBe(true);
  });

  it("allows a synchronous order to complete without a pending step", () => {
    // Omitting response_url makes the vendor answer with the final result.
    expect(canTransitionPurchase("ORDER_CREATING", "COMPLETED")).toBe(true);
  });

  it("never reopens a completed or refunded purchase", () => {
    for (const to of ["CLAIMED", "ORDER_CREATING", "ORDER_PENDING"] as const) {
      expect(canTransitionPurchase("COMPLETED", to)).toBe(false);
      expect(canTransitionPurchase("REFUNDED", to)).toBe(false);
    }
  });

  it("blocks a new supplier order from the moment the request starts", () => {
    // The danger begins at ORDER_CREATING, not at ORDER_PENDING: a crash mid-POST
    // leaves an order that may exist and may already be paid for.
    expect(mayCreateSupplierOrder("ORDER_CREATING")).toBe(false);
    expect(mayCreateSupplierOrder("ORDER_PENDING")).toBe(false);
    expect(mayCreateSupplierOrder("UNKNOWN_SUPPLIER_STATE")).toBe(false);
    expect(mayCreateSupplierOrder("COMPLETED")).toBe(false);
    expect(mayCreateSupplierOrder("REFUNDED")).toBe(false);
  });

  it("allows a first order only from PAID or CLAIMED", () => {
    expect(mayCreateSupplierOrder("PAID")).toBe(true);
    expect(mayCreateSupplierOrder("CLAIMED")).toBe(true);
  });

  it("keeps every ambiguous state in reconciliation", () => {
    expect([...RECONCILABLE_STATES].sort()).toEqual(
      ["ORDER_CREATING", "ORDER_PENDING", "UNKNOWN_SUPPLIER_STATE"].sort(),
    );
    // Anything reconcilable must also be barred from starting a new order.
    for (const s of RECONCILABLE_STATES) expect(NO_NEW_ORDER_STATES.has(s)).toBe(true);
  });
});

describe("recipient and quantity validation, from the vendor schema", () => {
  it("strips @ and whitespace", () => {
    expect(normalizeUsername("  @durov ")).toBe("durov");
    expect(normalizeUsername("@@durov")).toBe("durov");
    expect(normalizeUsername("durov")).toBe("durov");
  });

  it("accepts usernames the vendor regex allows", () => {
    for (const u of ["durov", "@durov", "a_b_c", "User123", "abc"]) {
      expect(isValidFragmentUsername(u), u).toBe(true);
    }
  });

  it("rejects usernames the vendor regex forbids", () => {
    // Must start with a letter, be 3-32 chars, letters/digits/underscore only.
    for (const u of ["", "ab", "1abc", "_abc", "has space", "has-dash", "a".repeat(33)]) {
      expect(isValidFragmentUsername(u), JSON.stringify(u)).toBe(false);
    }
  });

  it("enforces the Stars minimum of 50", () => {
    expect(STARS_MIN_QUANTITY).toBe(50);
    expect(isValidStarsQuantity(50)).toBe(true);
    expect(isValidStarsQuantity(49)).toBe(false);
    expect(isValidStarsQuantity(0)).toBe(false);
    expect(isValidStarsQuantity(1_000_000)).toBe(true);
    expect(isValidStarsQuantity(1_000_001)).toBe(false);
    expect(isValidStarsQuantity(100.5)).toBe(false);
  });

  it("accepts only 3, 6 and 12 months of Premium", () => {
    for (const m of [3, 6, 12]) expect(isValidPremiumMonths(m), String(m)).toBe(true);
    for (const m of [1, 2, 4, 9, 24, 0, -3]) expect(isValidPremiumMonths(m), String(m)).toBe(false);
  });
});
