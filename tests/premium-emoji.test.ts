import { describe, it, expect } from "vitest";
import {
  resolveIcon,
  registerEmojiProvider,
  type EmojiConfig,
} from "@/lib/emoji/renderer";

const base: EmojiConfig = {
  premiumEmojiCode: null,
  premiumEmojiFallbackImageUrl: null,
  premiumEmojiAltText: "Gemini",
  productLogoUrl: null,
  iconDisplayMode: "PREMIUM_EMOJI",
  rendererProvider: "default",
};

describe("premium emoji code is a string (precision safe)", () => {
  it("keeps very long numeric code exactly as string", () => {
    const longCode = "5789012345678901234567890";
    const cfg: EmojiConfig = {
      ...base,
      premiumEmojiCode: longCode,
      rendererProvider: "test-provider",
    };
    registerEmojiProvider({
      key: "test-provider",
      resolve: (code) => {
        // The code must arrive intact, no precision loss.
        expect(code).toBe(longCode);
        return { imageUrl: `https://cdn/${code}.png` };
      },
    });
    const icon = resolveIcon(cfg);
    expect(icon.kind).toBe("premium-emoji");
    if (icon.kind === "premium-emoji") {
      expect(icon.code).toBe(longCode);
      expect(icon.imageUrl).toBe(`https://cdn/${longCode}.png`);
    }
  });
});

describe("graceful fallback (never a broken image)", () => {
  it("default provider cannot resolve -> falls back to logo", () => {
    const cfg: EmojiConfig = {
      ...base,
      premiumEmojiCode: "12345",
      productLogoUrl: "https://cdn/logo.png",
    };
    const icon = resolveIcon(cfg);
    expect(icon.kind).toBe("image");
    if (icon.kind === "image") expect(icon.url).toBe("https://cdn/logo.png");
  });

  it("no emoji, no logo -> text fallback from alt", () => {
    const icon = resolveIcon({ ...base, premiumEmojiCode: null, productLogoUrl: null });
    expect(icon.kind).toBe("text");
    if (icon.kind === "text") expect(icon.text).toBe("Ge");
  });

  it("NONE mode returns none", () => {
    const icon = resolveIcon({ ...base, iconDisplayMode: "NONE" });
    expect(icon.kind).toBe("none");
  });

  it("LOGO mode uses logo then text", () => {
    expect(resolveIcon({ ...base, iconDisplayMode: "LOGO" }).kind).toBe("text");
    expect(
      resolveIcon({ ...base, iconDisplayMode: "LOGO", productLogoUrl: "u" }).kind,
    ).toBe("image");
  });
});
