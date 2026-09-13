import { describe, it, expect } from "vitest";
import {
  calculateBoosterDiscount,
  isBoostActive,
  formatBoosterCardBadge,
  DEFAULT_BOOST_DISCOUNT_PERCENT,
  calculateVariantBoosterPrice,
  buildTelegramBoostUrl,
  generateBoosterAdTemplates,
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
    it("formats badge text for percentage and fixed price", () => {
      expect(formatBoosterCardBadge(15)).toBe("🚀 Скидка за буст (-15%)");
      expect(formatBoosterCardBadge(25, 45_000)).toBe("🚀 Спеццена за буст");
    });
  });

  describe("calculateVariantBoosterPrice", () => {
    it("returns base price when boost discount is disabled for variant", () => {
      const res = calculateVariantBoosterPrice({
        basePriceUzs: 100_000,
        boostDiscountEnabled: false,
        boostDiscountPercent: 25,
      });
      expect(res.price).toBe(100_000);
      expect(res.isDiscounted).toBe(false);
      expect(res.label).toBeNull();
    });

    it("applies fixed price override when boostPriceUzs is set", () => {
      const res = calculateVariantBoosterPrice({
        basePriceUzs: 80_000,
        boostDiscountEnabled: true,
        boostPriceUzs: 59_000,
      });
      expect(res.price).toBe(59_000);
      expect(res.isDiscounted).toBe(true);
      expect(res.label).toBe("🚀 Спеццена за буст");
      expect(res.discountAmount).toBe(21_000);
    });

    it("applies variant-specific percent override when set", () => {
      const res = calculateVariantBoosterPrice({
        basePriceUzs: 50_000,
        boostDiscountEnabled: true,
        boostDiscountPercent: 30,
        globalPercent: 10,
      });
      expect(res.price).toBe(35_000);
      expect(res.isDiscounted).toBe(true);
      expect(res.discountPercent).toBe(30);
      expect(res.label).toBe("🚀 Скидка за буст (-30%)");
    });

    it("falls back to global percent when variant percent is not set", () => {
      const res = calculateVariantBoosterPrice({
        basePriceUzs: 100_000,
        boostDiscountEnabled: true,
        globalPercent: 15,
      });
      expect(res.price).toBe(85_000);
      expect(res.isDiscounted).toBe(true);
      expect(res.discountPercent).toBe(15);
      expect(res.label).toBe("🚀 Скидка за буст (-15%)");
    });
  });

  describe("buildTelegramBoostUrl", () => {
    it("constructs proper boost URLs", () => {
      expect(buildTelegramBoostUrl("@mychannel")).toBe("https://t.me/boost/mychannel");
      expect(buildTelegramBoostUrl("mychannel")).toBe("https://t.me/boost/mychannel");
      expect(buildTelegramBoostUrl("https://t.me/boost/custom")).toBe("https://t.me/boost/custom");
      expect(buildTelegramBoostUrl("-100123456789")).toBe("https://t.me/boost?c=123456789");
    });
  });

  describe("generateBoosterAdTemplates", () => {
    it("generates 3 ready-made templates with custom percent and bot username", () => {
      const templates = generateBoosterAdTemplates({
        channelTitle: "Test Channel",
        defaultPercent: 15,
        botUsername: "TestShopBot",
      });
      expect(templates.length).toBe(3);
      expect(templates[0].id).toBe("hot_discount");
      expect(templates[0].text).toContain("15%");
      expect(templates[1].id).toBe("vip_club");
      expect(templates[2].id).toBe("monthly_savings");
    });
  });
});

