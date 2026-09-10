import { describe, it, expect } from "vitest";
import {
  generateDealSlug,
  parseDealPayload,
  buildDealLinkUrl,
  validateDealEligibility,
  calculateDealDiscount,
  type DealLinkSnapshot,
} from "../src/lib/domain/deal-links";

describe("deal-links domain logic", () => {
  describe("generateDealSlug", () => {
    it("generates random deal slug starting with deal_ when empty", () => {
      const slug = generateDealSlug();
      expect(slug).toMatch(/^deal_[a-f0-9]{8}$/);
    });

    it("cleans and formats custom slug", () => {
      expect(generateDealSlug("sale_10")).toBe("deal_sale_10");
      expect(generateDealSlug("deal_summer_sale")).toBe("deal_summer_sale");
      expect(generateDealSlug("Super-Deal#2026!")).toBe("deal_super-deal2026");
    });
  });

  describe("parseDealPayload", () => {
    it("normalizes deal payload", () => {
      expect(parseDealPayload("  deal_summer  ")).toBe("deal_summer");
      expect(parseDealPayload("DEAL_VIP")).toBe("deal_vip");
    });
  });

  describe("buildDealLinkUrl", () => {
    it("builds valid Telegram deep link", () => {
      expect(buildDealLinkUrl("Aiobunabot", "deal_abc123")).toBe(
        "https://t.me/Aiobunabot?start=deal_abc123",
      );
      expect(buildDealLinkUrl("@CustomBot", "deal_vip")).toBe(
        "https://t.me/CustomBot?start=deal_vip",
      );
    });
  });

  describe("validateDealEligibility", () => {
    const baseDeal: DealLinkSnapshot = {
      id: 1,
      code: "deal_gemini",
      title: "Gemini 50% Off",
      variantId: 10,
      priceUzs: 35000,
      maxUses: 10,
      usedCount: 3,
      perUserLimit: 1,
      expiresAt: null,
      isActive: true,
    };

    it("returns valid when within limits", () => {
      const res = validateDealEligibility(baseDeal, 0);
      expect(res.valid).toBe(true);
      expect(res.remainingUses).toBe(7);
    });

    it("fails when link is deactivated", () => {
      const res = validateDealEligibility({ ...baseDeal, isActive: false }, 0);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("inactive");
    });

    it("fails when link is expired", () => {
      const past = new Date(Date.now() - 10000);
      const res = validateDealEligibility({ ...baseDeal, expiresAt: past }, 0);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("expired");
    });

    it("passes when expiry date is in future", () => {
      const future = new Date(Date.now() + 100000);
      const res = validateDealEligibility({ ...baseDeal, expiresAt: future }, 0);
      expect(res.valid).toBe(true);
    });

    it("fails when maxUses is reached", () => {
      const res = validateDealEligibility({ ...baseDeal, maxUses: 5, usedCount: 5 }, 0);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("limit_reached");
      expect(res.remainingUses).toBe(0);
    });

    it("fails when user exceeded perUserLimit", () => {
      const res = validateDealEligibility(baseDeal, 1);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("user_limit_reached");
    });

    it("handles unlimited links (maxUses = 0, perUserLimit = 0)", () => {
      const unlimited: DealLinkSnapshot = {
        ...baseDeal,
        maxUses: 0,
        usedCount: 999,
        perUserLimit: 0,
      };
      const res = validateDealEligibility(unlimited, 50);
      expect(res.valid).toBe(true);
      expect(res.remainingUses).toBeUndefined();
    });
  });

  describe("calculateDealDiscount", () => {
    it("calculates discount amount and percent correctly", () => {
      const { discountAmount, discountPercent } = calculateDealDiscount(100000, 70000);
      expect(discountAmount).toBe(30000);
      expect(discountPercent).toBe(30);
    });

    it("returns 0 if deal price is higher or equal to base price", () => {
      expect(calculateDealDiscount(50000, 50000)).toEqual({
        discountAmount: 0,
        discountPercent: 0,
      });
      expect(calculateDealDiscount(50000, 60000)).toEqual({
        discountAmount: 0,
        discountPercent: 0,
      });
    });
  });
});
