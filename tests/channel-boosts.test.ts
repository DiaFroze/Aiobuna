import { describe, it, expect } from "vitest";
import {
  calculateBoosterDiscount,
  isBoostActive,
  formatBoosterCardBadge,
  DEFAULT_BOOST_DISCOUNT_PERCENT,
} from "../src/lib/domain/channel-boosts";

describe("channel-boosts domain logic", () => {
  describe("calculateBoosterDiscount", () => {
    it("applies default 10% discount correctly", () => {
      const res = calculateBoosterDiscount(100_000);
      expect(res.discountPercent).toBe(10);
      expect(res.discountAmount).toBe(10_000);
      expect(res.price).toBe(90_000);
    });

    it("applies custom discount percentage", () => {
      const res = calculateBoosterDiscount(55_000, 20);
      expect(res.discountPercent).toBe(20);
      expect(res.discountAmount).toBe(11_000);
      expect(res.price).toBe(44_000);
    });

    it("handles zero or negative price", () => {
      expect(calculateBoosterDiscount(0, 10)).toEqual({
        price: 0,
        discountAmount: 0,
        discountPercent: 0,
      });
      expect(calculateBoosterDiscount(-100, 10)).toEqual({
        price: 0,
        discountAmount: 0,
        discountPercent: 0,
      });
    });

    it("clamps discount percentage between 0 and 100", () => {
      const zero = calculateBoosterDiscount(100_000, 0);
      expect(zero.price).toBe(100_000);
      expect(zero.discountAmount).toBe(0);

      const max = calculateBoosterDiscount(100_000, 150);
      expect(max.discountPercent).toBe(100);
      expect(max.price).toBe(0);
      expect(max.discountAmount).toBe(100_000);
    });
  });

  describe("isBoostActive", () => {
    it("returns true when expiresAt is in the future", () => {
      const now = new Date("2026-09-13T12:00:00Z");
      const future = new Date("2026-09-20T12:00:00Z");
      expect(isBoostActive(future, now)).toBe(true);
      expect(isBoostActive(future.toISOString(), now)).toBe(true);
    });

    it("returns false when expiresAt is in the past", () => {
      const now = new Date("2026-09-13T12:00:00Z");
      const past = new Date("2026-09-10T12:00:00Z");
      expect(isBoostActive(past, now)).toBe(false);
    });

    it("returns false for null, undefined or invalid dates", () => {
      expect(isBoostActive(null)).toBe(false);
      expect(isBoostActive(undefined)).toBe(false);
      expect(isBoostActive("invalid-date")).toBe(false);
    });
  });

  describe("formatBoosterCardBadge", () => {
    it("formats badge text", () => {
      expect(formatBoosterCardBadge(15)).toBe("🚀 Скидка за буст (-15%)");
    });
  });
});
