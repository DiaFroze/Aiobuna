import { describe, it, expect } from "vitest";
import {
  parseBulkPrices,
  parseBulkBonus,
  bulkTotal,
  bonusQty,
  bulkSaving,
} from "../src/lib/domain/bulk-pricing";

describe("parseBulkPrices", () => {
  it("parses the admin's tier spec", () => {
    expect(parseBulkPrices("2=55000,3=80000")).toEqual([
      { qty: 2, totalUzs: 55000 },
      { qty: 3, totalUzs: 80000 },
    ]);
  });

  it("tolerates spaces, newlines and semicolons", () => {
    expect(parseBulkPrices(" 3 = 80000 ;\n2=55000 ")).toEqual([
      { qty: 2, totalUzs: 55000 },
      { qty: 3, totalUzs: 80000 },
    ]);
  });

  it("ignores junk, duplicates and a meaningless qty of 1", () => {
    expect(parseBulkPrices("abc,1=30000,2=55000,2=99999,=,5=")).toEqual([{ qty: 2, totalUzs: 55000 }]);
  });

  it("refuses a half-typed rule instead of pricing it at zero", () => {
    // Number("") is 0, so "5=" must not become "5 items for free".
    expect(parseBulkPrices("5=")).toEqual([]);
    expect(parseBulkPrices("=50000")).toEqual([]);
    expect(parseBulkPrices("3=0")).toEqual([]);
    expect(parseBulkPrices("2=3=4")).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(parseBulkPrices("")).toEqual([]);
    expect(parseBulkPrices(null)).toEqual([]);
    expect(parseBulkPrices(undefined)).toEqual([]);
  });
});

describe("parseBulkBonus", () => {
  it("parses buy+free rules", () => {
    expect(parseBulkBonus("2+1,5+3")).toEqual([
      { buy: 2, free: 1 },
      { buy: 5, free: 3 },
    ]);
  });

  it("ignores rules that give nothing away", () => {
    expect(parseBulkBonus("2+0,0+1,3+1")).toEqual([{ buy: 3, free: 1 }]);
  });
});

describe("bulkTotal", () => {
  // The admin's own example: 1 = 30 000, 2 = 55 000, 3 = 80 000.
  const tiers = parseBulkPrices("2=55000,3=80000");
  const unit = 30000;

  it("charges the base price when no tier applies", () => {
    expect(bulkTotal(unit, 1, tiers)).toBe(30000);
  });

  it("charges the exact bundle price", () => {
    expect(bulkTotal(unit, 2, tiers)).toBe(55000);
    expect(bulkTotal(unit, 3, tiers)).toBe(80000);
  });

  it("extends the best tier's unit rate above the largest tier", () => {
    // 80000/3 ≈ 26 667 per item, so 4 costs ~106 667 — never more than 3.
    expect(bulkTotal(unit, 4, tiers)).toBe(106667);
    expect(bulkTotal(unit, 6, tiers)).toBe(160000);
  });

  it("never lets a larger order cost less than a smaller one", () => {
    let prev = 0;
    for (let q = 1; q <= 20; q++) {
      const total = bulkTotal(unit, q, tiers);
      expect(total).toBeGreaterThanOrEqual(prev);
      prev = total;
    }
  });

  it("falls back to plain multiplication with no tiers", () => {
    expect(bulkTotal(unit, 7, [])).toBe(210000);
  });

  it("handles zero and negative quantities", () => {
    expect(bulkTotal(unit, 0, tiers)).toBe(0);
    expect(bulkTotal(unit, -3, tiers)).toBe(0);
  });
});

describe("bonusQty", () => {
  const twoPlusOne = parseBulkBonus("2+1");

  it("gives the bonus once the threshold is reached", () => {
    expect(bonusQty(1, twoPlusOne)).toBe(0);
    expect(bonusQty(2, twoPlusOne)).toBe(1);
    expect(bonusQty(3, twoPlusOne)).toBe(1);
  });

  it("repeats the bonus for each full group", () => {
    expect(bonusQty(4, twoPlusOne)).toBe(2);
    expect(bonusQty(6, twoPlusOne)).toBe(3);
  });

  it("uses the most generous rule the order qualifies for", () => {
    const rules = parseBulkBonus("2+1,5+3");
    expect(bonusQty(4, rules)).toBe(2); // 2+1 twice
    expect(bonusQty(5, rules)).toBe(3); // 5+3 once beats 2+1 twice
  });

  it("gives nothing without rules", () => {
    expect(bonusQty(10, [])).toBe(0);
  });
});

describe("bulkSaving", () => {
  const tiers = parseBulkPrices("2=55000,3=80000");

  it("reports the discount versus the base price", () => {
    expect(bulkSaving(30000, 2, tiers)).toBe(5000);
    expect(bulkSaving(30000, 3, tiers)).toBe(10000);
  });

  it("is zero when no tier applies", () => {
    expect(bulkSaving(30000, 1, tiers)).toBe(0);
  });

  it("never reports a negative saving", () => {
    // A tier priced ABOVE the base price must not show as a loss.
    expect(bulkSaving(10000, 2, parseBulkPrices("2=50000"))).toBe(0);
  });
});
