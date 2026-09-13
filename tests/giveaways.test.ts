import { describe, it, expect } from "vitest";
import {
  parseGiveawayStartPayload,
  buildGiveawayBotUrl,
  checkParticipantEligibility,
  calculateClaimExpiry,
  selectRandomWinners,
  maskUserIdentifier,
  formatGiveawayResultsPost,
} from "../src/lib/domain/giveaways";

describe("giveaways domain logic", () => {
  describe("parseGiveawayStartPayload", () => {
    it("parses direct giveaway payload gw_123", () => {
      expect(parseGiveawayStartPayload("gw_123")).toEqual({
        giveawayId: 123,
        refUserId: undefined,
      });
    });

    it("parses referral giveaway payload gw_123_456", () => {
      expect(parseGiveawayStartPayload("gw_123_456")).toEqual({
        giveawayId: 123,
        refUserId: 456,
      });
    });

    it("handles giveaway_ prefix and trims whitespace", () => {
      expect(parseGiveawayStartPayload("  giveaway_99_10  ")).toEqual({
        giveawayId: 99,
        refUserId: 10,
      });
    });

    it("returns null for non-giveaway payloads", () => {
      expect(parseGiveawayStartPayload("deal_summer")).toBeNull();
      expect(parseGiveawayStartPayload("gifts")).toBeNull();
      expect(parseGiveawayStartPayload("")).toBeNull();
      expect(parseGiveawayStartPayload("gw_abc")).toBeNull();
    });
  });

  describe("buildGiveawayBotUrl", () => {
    it("builds standard direct giveaway link", () => {
      expect(buildGiveawayBotUrl("Aiobunabot", 15)).toBe(
        "https://t.me/Aiobunabot?start=gw_15",
      );
      expect(buildGiveawayBotUrl("@Aiobunabot", 15)).toBe(
        "https://t.me/Aiobunabot?start=gw_15",
      );
    });

    it("builds referral giveaway link with referrer userId", () => {
      expect(buildGiveawayBotUrl("Aiobunabot", 15, 789)).toBe(
        "https://t.me/Aiobunabot?start=gw_15_789",
      );
    });
  });

  describe("checkParticipantEligibility", () => {
    it("passes when subs are satisfied and no friends required", () => {
      expect(
        checkParticipantEligibility({
          hasRequiredSubs: true,
          friendsCount: 0,
          reqFriends: 0,
        }),
      ).toBe(true);
    });

    it("fails when required subs are missing", () => {
      expect(
        checkParticipantEligibility({
          hasRequiredSubs: false,
          friendsCount: 15,
          reqFriends: 5,
        }),
      ).toBe(false);
    });

    it("checks friend count requirement", () => {
      expect(
        checkParticipantEligibility({
          hasRequiredSubs: true,
          friendsCount: 4,
          reqFriends: 5,
        }),
      ).toBe(false);

      expect(
        checkParticipantEligibility({
          hasRequiredSubs: true,
          friendsCount: 5,
          reqFriends: 5,
        }),
      ).toBe(true);

      expect(
        checkParticipantEligibility({
          hasRequiredSubs: true,
          friendsCount: 10,
          reqFriends: 5,
        }),
      ).toBe(true);
    });
  });

  describe("calculateClaimExpiry", () => {
    it("calculates expiry based on hours", () => {
      const now = new Date("2026-09-13T12:00:00Z");
      const expiry = calculateClaimExpiry(now, 24);
      expect(expiry.toISOString()).toBe("2026-09-14T12:00:00.000Z");
    });

    it("defaults to 24h on zero or negative values", () => {
      const now = new Date("2026-09-13T12:00:00Z");
      const expiry = calculateClaimExpiry(now, 0);
      expect(expiry.toISOString()).toBe("2026-09-14T12:00:00.000Z");
    });
  });

  describe("selectRandomWinners", () => {
    it("returns empty array for empty participants or count <= 0", () => {
      expect(selectRandomWinners([], 5)).toEqual([]);
      expect(selectRandomWinners([1, 2, 3], 0)).toEqual([]);
      expect(selectRandomWinners([1, 2, 3], -1)).toEqual([]);
    });

    it("returns all participants if count >= pool length", () => {
      const participants = ["user_1", "user_2", "user_3"];
      const winners = selectRandomWinners(participants, 10);
      expect(winners).toHaveLength(3);
      expect(new Set(winners)).toEqual(new Set(participants));
    });

    it("selects exact requested number of unique winners", () => {
      const participants = Array.from({ length: 50 }, (_, i) => `user_${i}`);
      const winners = selectRandomWinners(participants, 10);
      expect(winners).toHaveLength(10);
      expect(new Set(winners).size).toBe(10);
      winners.forEach((w) => expect(participants).toContain(w));
    });

    it("is reproducible with custom randomFn", () => {
      const participants = ["A", "B", "C", "D", "E"];
      // mock random returning fixed pseudo sequence
      let idx = 0;
      const sequence = [0.1, 0.9, 0.5];
      const customRandom = () => sequence[idx++ % sequence.length];

      const winners1 = selectRandomWinners(participants, 3, customRandom);
      idx = 0;
      const winners2 = selectRandomWinners(participants, 3, customRandom);
      expect(winners1).toEqual(winners2);
    });
  });

  describe("maskUserIdentifier", () => {
    it("masks username preserving prefix and suffix", () => {
      expect(maskUserIdentifier({ username: "johndoe" })).toBe("@jo***oe");
      expect(maskUserIdentifier({ username: "@superman" })).toBe("@su***an");
      expect(maskUserIdentifier({ username: "abc" })).toBe("@abc***");
    });

    it("masks by first name and tgId when username is missing", () => {
      expect(
        maskUserIdentifier({ firstName: "Alisher", tgId: "123456789" }),
      ).toBe("Alisher (ID: 12***89)");
    });

    it("falls back gracefully when fields are absent", () => {
      expect(maskUserIdentifier({ tgId: "987654" })).toBe("ID: 98***54");
      expect(maskUserIdentifier({})).toBe("Участник");
    });
  });

  describe("formatGiveawayResultsPost", () => {
    it("formats winners post for free prize", () => {
      const post = formatGiveawayResultsPost({
        title: "Конкурс Gemini Pro",
        productTitle: "Gemini 1.5 Pro (1 месяц)",
        prizeType: "free",
        discountPriceUzs: 0,
        winners: [
          { username: "john_doe" },
          { firstName: "Bob", tgId: "987654321" },
        ],
      });

      expect(post).toContain("Конкурс Gemini Pro");
      expect(post).toContain("Бесплатно (0 сум)");
      expect(post).toContain("1. @jo***oe");
      expect(post).toContain("2. Bob (ID: 98***21)");
      expect(post).toContain("Победители (2):");
    });

    it("formats winners post for discount price", () => {
      const post = formatGiveawayResultsPost({
        title: "Суперскидка на CapCut",
        productTitle: "CapCut Pro 1 год",
        prizeType: "discount",
        discountPriceUzs: 10000,
        winners: [{ username: "winner_1" }],
      });

      expect(post).toMatch(/10[\s\u00A0]000 сум/);
      expect(post).toContain("1. @wi***_1");
    });

    it("handles empty winners gracefully", () => {
      const post = formatGiveawayResultsPost({
        title: "Пустой конкурс",
        productTitle: "Товар",
        prizeType: "free",
        discountPriceUzs: 0,
        winners: [],
      });

      expect(post).toContain("не нашлось");
    });
  });
});
