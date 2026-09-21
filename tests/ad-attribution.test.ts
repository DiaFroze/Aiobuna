import { describe, expect, it } from "vitest";
import {
  adSource,
  validateAdCode,
  parseAdStartPayload,
  isCrawlerBot,
  hashVisitorIp,
  buildAdRedirectUrl,
  buildAdWebUrl,
  calculateAdMetrics,
  buildFunnelSteps,
} from "../src/lib/domain/ad-attribution";

describe("adSource (legacy backwards compatibility)", () => {
  it("accepts distinct sources within Telegram's limit", () => {
    expect(adSource("ad_meta_d1a")).toBe("meta_d1a");
    expect(adSource("ad_meta_d1b")).toBe("meta_d1b");
    expect(adSource("ad_" + "a".repeat(61))).toHaveLength(61);
  });

  it("does not treat referrals, product links or malformed payloads as ads", () => {
    for (const payload of ["", "ref123", "p_1", "promo", "ad_", "ad_a b", "ad_a?x=1", "ad_" + "a".repeat(62)]) {
      expect(adSource(payload)).toBeNull();
    }
  });
});

describe("validateAdCode", () => {
  it("accepts valid alphanumeric, underscore and dash codes", () => {
    expect(validateAdCode("meta_reels5_broad")).toEqual({ valid: true, code: "meta_reels5_broad" });
    expect(validateAdCode("ad_insta_story_1")).toEqual({ valid: true, code: "insta_story_1" });
    expect(validateAdCode("tg-ads-channel")).toEqual({ valid: true, code: "tg-ads-channel" });
  });

  it("rejects empty or whitespace codes", () => {
    expect(validateAdCode("")).toEqual({ valid: false, code: "", reason: "empty" });
    expect(validateAdCode("   ")).toEqual({ valid: false, code: "", reason: "empty" });
  });

  it("rejects codes that are too short or too long", () => {
    expect(validateAdCode("a")).toEqual({ valid: false, code: "a", reason: "too_short" });
    expect(validateAdCode("a".repeat(65))).toEqual({ valid: false, code: "a".repeat(65), reason: "too_long" });
  });

  it("rejects special characters or spaces", () => {
    expect(validateAdCode("code with space")).toEqual({ valid: false, code: "code with space", reason: "invalid_chars" });
    expect(validateAdCode("code?param=1")).toEqual({ valid: false, code: "code?param=1", reason: "invalid_chars" });
    expect(validateAdCode("code#hash")).toEqual({ valid: false, code: "code#hash", reason: "invalid_chars" });
  });

  it("rejects collision with reserved bot prefixes (ref, deal_, p_, etc.)", () => {
    expect(validateAdCode("ref12345")).toEqual({ valid: false, code: "ref12345", reason: "reserved_prefix" });
    expect(validateAdCode("deal_gemini")).toEqual({ valid: false, code: "deal_gemini", reason: "reserved_prefix" });
    expect(validateAdCode("p_42")).toEqual({ valid: false, code: "p_42", reason: "reserved_prefix" });
    expect(validateAdCode("buy_99")).toEqual({ valid: false, code: "buy_99", reason: "reserved_prefix" });
    expect(validateAdCode("gw_5")).toEqual({ valid: false, code: "gw_5", reason: "reserved_prefix" });
  });
});

describe("parseAdStartPayload", () => {
  it("parses codes with ad_ prefix", () => {
    expect(parseAdStartPayload("ad_meta_reels5")).toBe("meta_reels5");
  });

  it("parses direct ad codes without reserved prefixes", () => {
    expect(parseAdStartPayload("meta_reels5_broad")).toBe("meta_reels5_broad");
  });

  it("returns null for non-ad payloads like referrals and deals", () => {
    expect(parseAdStartPayload("ref123456")).toBeNull();
    expect(parseAdStartPayload("deal_discount50")).toBeNull();
    expect(parseAdStartPayload("p_12")).toBeNull();
    expect(parseAdStartPayload("gifts")).toBeNull();
    expect(parseAdStartPayload("boost")).toBeNull();
  });
});

describe("isCrawlerBot", () => {
  it("detects Meta and Facebook crawlers", () => {
    expect(isCrawlerBot("facebookexternalhit/1.1 (+https://www.facebook.com/externalhit_uatext.php)")).toBe(true);
    expect(isCrawlerBot("Facebot")).toBe(true);
    expect(isCrawlerBot("Meta-ExternalAgent/1.0")).toBe(true);
  });

  it("detects Telegram and Google bots", () => {
    expect(isCrawlerBot("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isCrawlerBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isCrawlerBot("WhatsApp/2.21.12.21 A")).toBe(true);
  });

  it("detects preview headers", () => {
    const headers = new Headers({ "x-purpose": "preview" });
    expect(isCrawlerBot("Mozilla/5.0 (iPhone)", headers)).toBe(true);
  });

  it("allows real human browsers", () => {
    expect(isCrawlerBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15")).toBe(false);
    expect(isCrawlerBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36")).toBe(false);
  });
});

describe("hashVisitorIp", () => {
  it("produces deterministic 64-char sha256 hex string", () => {
    const hash1 = hashVisitorIp("192.168.1.1", "Mozilla/5.0");
    const hash2 = hashVisitorIp("192.168.1.1", "Mozilla/5.0");
    const hash3 = hashVisitorIp("192.168.1.2", "Mozilla/5.0");
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).toHaveLength(64);
  });
});

describe("buildAdRedirectUrl & buildAdWebUrl", () => {
  it("builds correct Telegram start url", () => {
    expect(buildAdRedirectUrl("Aiobunabot", "meta_reels5")).toBe("https://t.me/Aiobunabot?start=meta_reels5");
    expect(buildAdRedirectUrl("@Aiobunabot", "meta_reels5")).toBe("https://t.me/Aiobunabot?start=meta_reels5");
  });

  it("builds correct public web url", () => {
    expect(buildAdWebUrl("https://sb.eu", "meta_reels5")).toBe("https://sb.eu/go/meta_reels5");
    expect(buildAdWebUrl("https://sb.eu/", "meta_reels5")).toBe("https://sb.eu/go/meta_reels5");
  });
});

describe("calculateAdMetrics", () => {
  it("calculates accurate revenue, profit, ROAS and conversions", () => {
    const res = calculateAdMetrics({
      clicks: 1000,
      uniqueClicks: 800,
      starts: 400,
      newUsers: 300,
      payingUsers: 50,
      paidOrdersCount: 65,
      repeatBuyers: 10,
      revenueUzs: 6_500_000,
      costPriceUzs: 2_000_000,
      hasIncompleteCostPrice: false,
      actualSpendUzs: 1_300_000,
    });

    expect(res.conversionClickToStart).toBe(50); // 400 / 800 * 100
    expect(res.conversionStartToBuyer).toBe(12.5); // 50 / 400 * 100
    expect(res.aov).toBe(100_000); // 6.5M / 65
    expect(res.repeatOrdersCount).toBe(15); // 65 - 50
    expect(res.cpc).toBe(1300); // 1.3M / 1000
    expect(res.costPerStart).toBe(3250); // 1.3M / 400
    expect(res.cacNewUser).toBe(4333); // 1.3M / 300
    expect(res.cacPayingUser).toBe(26000); // 1.3M / 50
    expect(res.roas).toBe(5); // 6.5M / 1.3M
    expect(res.profitBeforeAds).toBe(4_500_000); // 6.5M - 2M
    expect(res.profitAfterAds).toBe(3_200_000); // 4.5M - 1.3M
    expect(res.roi).toBe(246.2); // (3.2M / 1.3M) * 100
    expect(res.arpu).toBe(21667); // 6.5M / 300
  });

  it("handles zero spend without division by zero", () => {
    const res = calculateAdMetrics({
      clicks: 50,
      uniqueClicks: 40,
      starts: 20,
      newUsers: 15,
      payingUsers: 2,
      paidOrdersCount: 2,
      revenueUzs: 200_000,
      costPriceUzs: 50_000,
      actualSpendUzs: 0,
    });

    expect(res.roas).toBeNull();
    expect(res.roi).toBeNull();
    expect(res.cpc).toBeNull();
    expect(res.costPerStart).toBeNull();
    expect(res.cacNewUser).toBeNull();
    expect(res.cacPayingUser).toBeNull();
    expect(res.profitBeforeAds).toBe(150_000);
    expect(res.profitAfterAds).toBe(150_000);
  });

  it("marks profit as null when cost price is missing/incomplete", () => {
    const res = calculateAdMetrics({
      clicks: 100,
      uniqueClicks: 80,
      starts: 40,
      newUsers: 30,
      payingUsers: 5,
      paidOrdersCount: 5,
      revenueUzs: 500_000,
      costPriceUzs: null,
      hasIncompleteCostPrice: true,
      actualSpendUzs: 100_000,
    });

    expect(res.hasIncompleteCostPrice).toBe(true);
    expect(res.profitBeforeAds).toBeNull();
    expect(res.profitAfterAds).toBeNull();
    expect(res.roi).toBeNull();
    expect(res.roas).toBe(5); // ROAS depends on revenue / spend, so it is still valid!
  });
});

describe("buildFunnelSteps", () => {
  it("builds 5-step funnel with drop-off percentages", () => {
    const funnel = buildFunnelSteps({
      clicks: 1000,
      starts: 500,
      newUsers: 400,
      payingUsers: 80,
      repeatBuyers: 20,
    });

    expect(funnel).toHaveLength(5);
    expect(funnel[0].name).toContain("Clicks");
    expect(funnel[0].count).toBe(1000);
    expect(funnel[0].conversionFromPrev).toBe(100);

    expect(funnel[1].name).toContain("Starts");
    expect(funnel[1].count).toBe(500);
    expect(funnel[1].conversionFromPrev).toBe(50); // 500 / 1000

    expect(funnel[2].name).toContain("Новые");
    expect(funnel[2].count).toBe(400);
    expect(funnel[2].conversionFromPrev).toBe(80); // 400 / 500

    expect(funnel[3].name).toContain("Покупатели");
    expect(funnel[3].count).toBe(80);
    expect(funnel[3].conversionFromPrev).toBe(20); // 80 / 400

    expect(funnel[4].name).toContain("Повторные");
    expect(funnel[4].count).toBe(20);
    expect(funnel[4].conversionFromPrev).toBe(25); // 20 / 80
  });
});
