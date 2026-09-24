import { describe, it, expect } from "vitest";
import {
  buildPromoTeaserText,
  buildChannelPromoText,
  evaluateReactionCount,
  DEFAULT_TARGET_EMOJI,
  DEFAULT_TARGET_REACTIONS,
} from "../src/lib/domain/channel-promos";

describe("Channel Promos Domain - Teaser and Promo Texts", () => {
  it("builds default teaser message with product and price placeholders filled", () => {
    const text = buildPromoTeaserText({
      nextProductName: "ChatGPT Plus",
      nextPriceUzs: 150000,
      targetEmoji: "🔥",
      targetCount: 10,
    });

    expect(text).toContain("Акция завершена!");
    expect(text).toContain("ChatGPT Plus");
    expect(text).toContain("150 000 сум");
    expect(text).toContain("10 реакций 🔥");
    expect(text).toContain("Ставьте реакцию 🔥 ниже");
  });

  it("supports custom teaser template", () => {
    const customTemplate = "🎉 Готовим скидку на {next_product}! Жми {emoji} ({target_count} шт) и лови {next_price}!";
    const text = buildPromoTeaserText({
      nextProductName: "Canva Pro",
      nextPriceUzs: 25000,
      targetEmoji: "🚀",
      targetCount: 15,
      customTemplate,
    });

    expect(text).toBe("🎉 Готовим скидку на Canva Pro! Жми 🚀 (15 шт) и лови 25 000!");
  });

  it("builds channel promo announcement text with discount percentage", () => {
    const text = buildChannelPromoText({
      productName: "Gemini Advanced",
      originalPriceUzs: 50000,
      promoPriceUzs: 25000,
      hours: 4,
    });

    expect(text).toContain("Gemini Advanced");
    expect(text).toContain("50 000 сум");
    expect(text).toContain("25 000 сум");
    expect(text).toContain("−50%");
    expect(text).toContain("4 ч.");
  });
});

describe("Channel Promos Domain - Reaction Evaluation", () => {
  it("correctly identifies when reaction count has not reached target", () => {
    const reactions = [
      { type: { type: "emoji", emoji: "👍" }, total_count: 3 },
      { type: { type: "emoji", emoji: "🔥" }, total_count: 7 },
    ];

    const res = evaluateReactionCount(reactions, "🔥", 10);
    expect(res.reached).toBe(false);
    expect(res.currentCount).toBe(7);
    expect(res.targetCount).toBe(10);
  });

  it("correctly triggers when target reaction threshold is reached or exceeded", () => {
    const reactions = [
      { type: { type: "emoji", emoji: "🔥" }, total_count: 10 },
    ];

    const res = evaluateReactionCount(reactions, "🔥", 10);
    expect(res.reached).toBe(true);
    expect(res.currentCount).toBe(10);

    const exceed = evaluateReactionCount([
      { type: { type: "emoji", emoji: "🔥" }, total_count: 14 },
    ], "🔥", 10);
    expect(exceed.reached).toBe(true);
    expect(exceed.currentCount).toBe(14);
  });

  it("returns 0 if target emoji is not present in reactions array", () => {
    const reactions = [
      { type: { type: "emoji", emoji: "👍" }, total_count: 5 },
    ];

    const res = evaluateReactionCount(reactions, "🔥", 10);
    expect(res.reached).toBe(false);
    expect(res.currentCount).toBe(0);
  });
});
