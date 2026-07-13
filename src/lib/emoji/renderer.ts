// Extensible Premium Emoji rendering system.
//
// IMPORTANT: premium_emoji_code is ALWAYS a string (long numeric codes must not
// lose precision). No concrete emoji codes are hardcoded here — instead we
// expose a provider registry so a real source (Telegram custom emoji, an own
// CDN, etc.) can be plugged in later.

export type IconDisplayMode = "PREMIUM_EMOJI" | "LOGO" | "BOTH" | "NONE";

export interface EmojiConfig {
  premiumEmojiCode?: string | null; // STRING — never Number
  premiumEmojiFallbackImageUrl?: string | null;
  premiumEmojiAltText?: string | null;
  productLogoUrl?: string | null;
  iconDisplayMode: IconDisplayMode;
  rendererProvider?: string | null; // registry key
}

export type ResolvedIcon =
  | { kind: "premium-emoji"; provider: string; code: string; alt: string; imageUrl?: string }
  | { kind: "image"; url: string; alt: string }
  | { kind: "text"; text: string; alt: string }
  | { kind: "none" };

export interface PremiumEmojiProvider {
  key: string;
  /**
   * Return an image/render URL for a premium emoji code, or null if this
   * provider cannot render it (so we fall back gracefully).
   *
   * The DEFAULT provider cannot resolve codes on its own — it always returns
   * null so the UI falls back to logo/text. Replace with a real provider that
   * knows how to turn a code into a rendered asset.
   */
  resolve(code: string): { imageUrl?: string } | null;
}

// Default provider: no external source configured yet -> never resolves.
// This guarantees we NEVER show a broken image; UI falls back to logo/text.
const defaultProvider: PremiumEmojiProvider = {
  key: "default",
  resolve() {
    return null;
  },
};

const registry = new Map<string, PremiumEmojiProvider>([["default", defaultProvider]]);

export function registerEmojiProvider(provider: PremiumEmojiProvider): void {
  registry.set(provider.key, provider);
}

export function getEmojiProvider(key?: string | null): PremiumEmojiProvider {
  return registry.get(key ?? "default") ?? defaultProvider;
}

function textFallback(cfg: EmojiConfig): string {
  const alt = cfg.premiumEmojiAltText?.trim();
  if (alt) {
    // first grapheme-ish char, uppercased
    return alt.slice(0, 2);
  }
  return "★";
}

/**
 * Resolve the best icon to render given the config + provider capabilities.
 * Deterministic and side-effect free — safe for server & client.
 */
export function resolveIcon(cfg: EmojiConfig): ResolvedIcon {
  const alt = cfg.premiumEmojiAltText?.trim() || "product";
  const mode = cfg.iconDisplayMode;

  const tryEmoji = (): ResolvedIcon | null => {
    const code = cfg.premiumEmojiCode?.trim();
    if (!code) return null;
    const provider = getEmojiProvider(cfg.rendererProvider);
    const resolved = provider.resolve(code);
    if (resolved) {
      return {
        kind: "premium-emoji",
        provider: provider.key,
        code,
        alt,
        imageUrl: resolved.imageUrl,
      };
    }
    // provider can't render -> fall through to fallback image
    if (cfg.premiumEmojiFallbackImageUrl) {
      return { kind: "image", url: cfg.premiumEmojiFallbackImageUrl, alt };
    }
    return null;
  };

  const tryLogo = (): ResolvedIcon | null =>
    cfg.productLogoUrl ? { kind: "image", url: cfg.productLogoUrl, alt } : null;

  switch (mode) {
    case "NONE":
      return { kind: "none" };
    case "LOGO":
      return tryLogo() ?? { kind: "text", text: textFallback(cfg), alt };
    case "PREMIUM_EMOJI":
      return tryEmoji() ?? tryLogo() ?? { kind: "text", text: textFallback(cfg), alt };
    case "BOTH":
      // Prefer emoji, then logo, then text — but never a broken image.
      return tryEmoji() ?? tryLogo() ?? { kind: "text", text: textFallback(cfg), alt };
    default:
      return { kind: "text", text: textFallback(cfg), alt };
  }
}
