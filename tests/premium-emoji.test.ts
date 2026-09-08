import { describe, it, expect } from "vitest";
import {
  resolveIcon,
  registerEmojiProvider,
  type EmojiConfig,
} from "@/lib/emoji/renderer";
import {
  formatRichText,
  tgHtml,
  stripRichText,
  safeTruncateHtml,
  resolveProductPremiumEmoji,
  sanitizeTextCustomEmojis,
} from "@/lib/emoji/rich-text";

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

describe("rich-text formatting for Telegram custom emoji", () => {
  it("converts [emoji:ID:fallback] to native <tg-emoji> tag", () => {
    const raw = "[emoji:5372917041193828849:🚀] SUBHUB AI KURS";
    expect(formatRichText(raw)).toBe(
      '<tg-emoji emoji-id="5372917041193828849">🚀</tg-emoji> SUBHUB AI KURS',
    );
  });

  it("converts [emoji:ID] with default fallback ✨", () => {
    const raw = "[emoji:5372917041193828849] Title";
    expect(formatRichText(raw)).toBe(
      '<tg-emoji emoji-id="5372917041193828849">✨</tg-emoji> Title',
    );
  });

  it("converts reseller {ce:ID:fallback} tokens", () => {
    const raw = "{ce:5467512909909214089:🎓} 20 ta dars";
    expect(formatRichText(raw)).toBe(
      '<tg-emoji emoji-id="5467512909909214089">🎓</tg-emoji> 20 ta dars',
    );
  });

  it("converts compact :emoji:ID: syntax", () => {
    const raw = ":emoji:5927026418616636353: AI Asoslari";
    expect(formatRichText(raw)).toBe(
      '<tg-emoji emoji-id="5927026418616636353">✨</tg-emoji> AI Asoslari',
    );
  });

  it("normalizes <tg-emoji id='...'> to emoji-id", () => {
    const raw = '<tg-emoji id="5235837920081887219">📸</tg-emoji>';
    expect(formatRichText(raw)).toBe(
      '<tg-emoji emoji-id="5235837920081887219">📸</tg-emoji>',
    );
  });

  it("handles and cleans escaped quotes \\\" inside tg-emoji tag", () => {
    const raw = '<tg-emoji emoji-id=\\"5372917041193828849\\">🚀</tg-emoji> SUBHUB AI KURS';
    expect(formatRichText(raw)).toBe(
      '<tg-emoji emoji-id="5372917041193828849">🚀</tg-emoji> SUBHUB AI KURS',
    );
    expect(tgHtml(formatRichText(raw))).toBe(
      '<tg-emoji emoji-id="5372917041193828849">🚀</tg-emoji> SUBHUB AI KURS',
    );
  });
});

describe("tgHtml safe Telegram HTML escaping & tag preservation", () => {
  it("escapes naked & and < while preserving <tg-emoji> and <b>", () => {
    const input = '<tg-emoji emoji-id="5372917041193828849">🚀</tg-emoji> <b>AI & Design</b> <unknown>';
    const output = tgHtml(input);
    expect(output).toBe(
      '<tg-emoji emoji-id="5372917041193828849">🚀</tg-emoji> <b>AI &amp; Design</b> &lt;unknown&gt;',
    );
  });

  it("preserves links with href", () => {
    const input = '<a href="https://t.me/subhub">SubHub Channel</a>';
    expect(tgHtml(input)).toBe(input);
  });

  it("recovers and cleans <tg-emoji> even if it has raw backslashes and quotes", () => {
    const input = '<tg-emoji emoji-id=\\"5372917041193828849\\">🚀</tg-emoji>';
    expect(tgHtml(input)).toBe('<tg-emoji emoji-id="5372917041193828849">🚀</tg-emoji>');
  });
});

describe("stripRichText plain-text fallback extraction", () => {
  it("extracts clean emojis and drops HTML tags", () => {
    const input = '<tg-emoji emoji-id="5372917041193828849">🚀</tg-emoji> <b>Course</b> [emoji:5467512909909214089:🎓]';
    expect(stripRichText(input)).toBe("🚀 Course 🎓");
  });
});

describe("safeTruncateHtml", () => {
  it("does not truncate if under max length", () => {
    const input = '<b>Short</b>';
    expect(safeTruncateHtml(input, 50)).toBe('<b>Short</b>');
  });

  it("truncates cleanly without broken tags if over max length", () => {
    const input = '<b>Very long description with <tg-emoji emoji-id="123">🚀</tg-emoji></b>';
    const truncated = safeTruncateHtml(input, 20);
    expect(truncated).not.toContain('<tg-emoji');
    expect(truncated.endsWith('…')).toBe(true);
  });
});

describe("resolveProductPremiumEmoji", () => {
  it("resolves CapCut Pro correctly to official cinema/video emoji 5375464961822695044", () => {
    const pe = resolveProductPremiumEmoji({
      titleRu: "CapCut Pro — 1 месяц",
      titleUz: "CapCut Pro — 1 oylik obuna",
      emoji: "🖤",
    });
    expect(pe.id).toBe("5375464961822695044");
    expect(pe.char).toBe("🎬");
    expect(pe.textTag).toBe('<tg-emoji emoji-id="5375464961822695044">🎬</tg-emoji>');
    expect(pe.buttonIcon).toBe("5375464961822695044");
  });

  it("keeps custom button icon if admin set a custom emoji for CapCut, while ensuring text uses official emoji", () => {
    const pe = resolveProductPremiumEmoji({
      titleRu: "CapCut Pro",
      emoji: "🖤",
      premiumEmoji: "9999999999999999999", // Unofficial custom sticker pack ID
    });
    // In text, must use official ID to prevent Telegram 400 rejection
    expect(pe.id).toBe("5375464961822695044");
    expect(pe.textTag).toBe('<tg-emoji emoji-id="5375464961822695044">🎬</tg-emoji>');
    // For inline button, keeps the custom ID
    expect(pe.buttonIcon).toBe("9999999999999999999");
  });

  it("resolves ChatGPT / OpenAI to brain emoji 5927026418616636353", () => {
    const pe = resolveProductPremiumEmoji({
      titleRu: "ChatGPT Plus (GPT-4o)",
      emoji: "🧠",
    });
    expect(pe.id).toBe("5927026418616636353");
    expect(pe.char).toBe("🧠");
    expect(pe.textTag).toBe('<tg-emoji emoji-id="5927026418616636353">🧠</tg-emoji>');
  });

  it("resolves Telegram Premium to star emoji 5359512328003941083", () => {
    const pe = resolveProductPremiumEmoji({
      titleRu: "Telegram Premium",
      emoji: "⭐",
    });
    expect(pe.id).toBe("5359512328003941083");
    expect(pe.char).toBe("⭐");
    expect(pe.textTag).toBe('<tg-emoji emoji-id="5359512328003941083">⭐</tg-emoji>');
  });

  it("resolves Telegram Stars to star emoji 5895708410447401643", () => {
    const pe = resolveProductPremiumEmoji({
      titleRu: "Telegram Stars",
      emoji: "🌟",
    });
    expect(pe.id).toBe("5895708410447401643");
    expect(pe.char).toBe("🌟");
    expect(pe.textTag).toBe('<tg-emoji emoji-id="5895708410447401643">🌟</tg-emoji>');
  });

  it("resolves Gemini Pro to diamond emoji 5255920066171537833", () => {
    const pe = resolveProductPremiumEmoji({
      titleRu: "План Gemini AI Pro 18m",
      emoji: "✨",
    });
    expect(pe.id).toBe("5255920066171537833");
    expect(pe.char).toBe("💎");
    expect(pe.textTag).toBe('<tg-emoji emoji-id="5255920066171537833">💎</tg-emoji>');
  });

  it("resolves SUBHUB AI Kurs to graduation cap emoji 5467512909909214089", () => {
    const pe = resolveProductPremiumEmoji({
      titleRu: "SUBHUB AI Kurs — 20 практических уроков",
      emoji: "🎓",
    });
    expect(pe.id).toBe("5467512909909214089");
    expect(pe.char).toBe("🎓");
    expect(pe.textTag).toBe('<tg-emoji emoji-id="5467512909909214089">🎓</tg-emoji>');
  });

  it("resolves by unicode emoji character when no brand matches", () => {
    const pe = resolveProductPremiumEmoji({
      titleRu: "Unknown VPN Service",
      emoji: "🛡",
    });
    expect(pe.id).toBe("5197288647275071607");
    expect(pe.char).toBe("🛡");
  });
});

describe("sanitizeTextCustomEmojis", () => {
  it("preserves official Telegram custom emoji tags in text", () => {
    const text = '<tg-emoji emoji-id="5372917041193828849">🚀</tg-emoji> <b>Super Fast</b>';
    expect(sanitizeTextCustomEmojis(text)).toBe(text);
  });

  it("maps unofficial custom emoji IDs with known fallback emojis to official IDs", () => {
    const text = '<tg-emoji emoji-id="999999999999">🚀</tg-emoji> Start now';
    expect(sanitizeTextCustomEmojis(text)).toBe(
      '<tg-emoji emoji-id="5372917041193828849">🚀</tg-emoji> Start now',
    );
  });

  it("maps unofficial custom emoji with black heart to official cinema emoji", () => {
    const text = '<tg-emoji emoji-id="888888888888">🖤</tg-emoji> CapCut Video';
    expect(sanitizeTextCustomEmojis(text)).toBe(
      '<tg-emoji emoji-id="5375464961822695044">🎬</tg-emoji> CapCut Video',
    );
  });

  it("strips unrecognized tags into clean character without causing 400 errors", () => {
    const text = '<tg-emoji emoji-id="777777777777">XYZ</tg-emoji> Description';
    expect(sanitizeTextCustomEmojis(text)).toBe("XYZ Description");
  });
});

