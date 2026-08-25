import { describe, it, expect } from "vitest";
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  lowStockCount,
  parseLowStockThreshold,
} from "../src/lib/domain/low-stock";

const T = DEFAULT_LOW_STOCK_THRESHOLD; // 10

describe("lowStockCount", () => {
  it("shows the real count when stock is genuinely low", () => {
    expect(lowStockCount(4, T, false)).toBe(4);
    expect(lowStockCount(1, T, false)).toBe(1);
    expect(lowStockCount(10, T, false)).toBe(10);
  });

  it("says nothing when there is plenty — never a smaller invented number", () => {
    expect(lowStockCount(11, T, false)).toBeNull();
    expect(lowStockCount(500, T, false)).toBeNull();
    expect(lowStockCount(999_999, T, false)).toBeNull();
  });

  it("never reports a number the caller did not measure", () => {
    // Whatever the inputs, the answer is either the real stock or nothing.
    for (const stock of [0, 1, 5, 9, 10, 11, 50, 1000]) {
      const out = lowStockCount(stock, T, false);
      expect(out === null || out === stock).toBe(true);
    }
  });

  it("stays silent for goods with no warehouse (Stars, Premium)", () => {
    expect(lowStockCount(5, T, true)).toBeNull();
    expect(lowStockCount(999_999, T, true)).toBeNull();
  });

  it("stays silent when sold out — that screen says it better", () => {
    expect(lowStockCount(0, T, false)).toBeNull();
    expect(lowStockCount(-3, T, false)).toBeNull();
  });

  it("is switched off entirely by a zero threshold", () => {
    expect(lowStockCount(2, 0, false)).toBeNull();
    expect(lowStockCount(2, -5, false)).toBeNull();
  });

  it("honours a custom threshold in both directions", () => {
    expect(lowStockCount(20, 25, false)).toBe(20);
    expect(lowStockCount(20, 15, false)).toBeNull();
  });

  it("does not fall over on nonsense input", () => {
    expect(lowStockCount(NaN, T, false)).toBeNull();
    expect(lowStockCount(5, NaN, false)).toBe(5); // bad threshold → default
  });
});

describe("parseLowStockThreshold", () => {
  it("reads what the admin typed", () => {
    expect(parseLowStockThreshold("5")).toBe(5);
    expect(parseLowStockThreshold(" 25 ")).toBe(25);
    expect(parseLowStockThreshold("0")).toBe(0);
  });
  it("falls back to the default rather than disabling itself by accident", () => {
    expect(parseLowStockThreshold("")).toBe(T);
    expect(parseLowStockThreshold(null)).toBe(T);
    expect(parseLowStockThreshold("abc")).toBe(T);
    expect(parseLowStockThreshold("-4")).toBe(T);
  });
});
