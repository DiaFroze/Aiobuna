import { describe, expect, it } from "vitest";
import { adSource } from "../src/lib/domain/ad-attribution";

describe("paid traffic start payload", () => {
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
