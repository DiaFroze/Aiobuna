// Helper module for parsing and formatting Telegram custom/premium emojis
// and Telegram HTML formatting in product descriptions.

const TG_TAGS = ["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "blockquote"];

/**
 * Escapes raw HTML characters (&, <, >).
 */
export function escHtml(s: string): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Strips all HTML tags.
 */
export function stripHtml(s: string): string {
  if (!s) return "";
  return s.replace(/<[^>]*>/g, "");
}

/**
 * Converts various friendly custom emoji formats into native Telegram HTML <tg-emoji> tags.
 * Supports:
 * - [emoji:12345:🚀] or [emoji:12345] (admin shortcodes)
 * - {ce:12345:🚀} or {ce:12345} (reseller API tokens)
 * - :emoji:12345: (compact shortcode)
 * - <tg-emoji id="12345"> (normalizes id attr to emoji-id)
 */
export function formatRichText(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw;

  // 1. Normalize ANY existing <tg-emoji ...> tag, removing backslashes, unescaping quotes or &quot;,
  // handling id or emoji-id:
  s = s.replace(/<tg-emoji\s+(?:emoji-)?id=(?:\\*["']|&quot;)?(\d+)(?:\\*["']|&quot;)?\s*>/gi, '<tg-emoji emoji-id="$1">');
  s = s.replace(/<\/tg-emoji\s*>/gi, '</tg-emoji>');

  // 2. Bracket syntax: [emoji:12345:🚀] or [emoji:12345]
  s = s.replace(/\[emoji:(\d+)(?::([^\]]+))?\]/gi, (_m, id, fallback) => {
    const char = fallback?.trim() || "✨";
    return `<tg-emoji emoji-id="${id}">${char}</tg-emoji>`;
  });

  // 3. Reseller syntax: {ce:12345:🚀} or {ce:12345}
  s = s.replace(/\{ce:(\d+)(?::([^}]+))?\}/gi, (_m, id, fallback) => {
    const char = fallback?.trim() || "✨";
    return `<tg-emoji emoji-id="${id}">${char}</tg-emoji>`;
  });

  // 4. Compact syntax: :emoji:12345:
  s = s.replace(/:emoji:(\d+):/gi, (_m, id) => `<tg-emoji emoji-id="${id}">✨</tg-emoji>`);

  return s;
}

/**
 * Safely sanitizes and restores permitted Telegram HTML tags (including <tg-emoji> and <a>).
 * Naked & or < or disallowed tags are escaped, preventing Telegram 400 parse errors.
 */
export function tgHtml(s: string | null | undefined): string {
  if (!s) return "";
  let out = escHtml(s);

  // Restore allowed Telegram standard formatting tags
  for (const tag of TG_TAGS) {
    out = out.replace(new RegExp(`&lt;(/?${tag})&gt;`, "gi"), "<$1>");
  }

  // Restore links: <a href="...">text</a>
  out = out.replace(/&lt;a\s+href=["']([^"']+)["']&gt;([\s\S]*?)&lt;\/a&gt;/gi, '<a href="$1">$2</a>');

  // Restore <tg-emoji emoji-id="...">char</tg-emoji>
  // Even if there were escaped quotes or backslashes before escaping
  out = out.replace(
    /&lt;tg-emoji\s+(?:emoji-)?id=(?:\\*["']|&quot;)?(\d+)(?:\\*["']|&quot;)?\s*&gt;([\s\S]*?)&lt;\/tg-emoji&gt;/gi,
    '<tg-emoji emoji-id="$1">$2</tg-emoji>',
  );

  return out;
}

/**
 * Strips custom emojis and HTML tags into plain text with fallback characters.
 * Useful for plain-text contexts or Telegram message entity offset calculations.
 */
export function stripRichText(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw;
  s = s.replace(/\[emoji:\d+(?::([^\]]+))?\]/gi, (_m, fb) => fb?.trim() || "✨");
  s = s.replace(/\{ce:\d+(?::([^}]+))?\}/gi, (_m, fb) => fb?.trim() || "✨");
  s = s.replace(/:emoji:\d+:/gi, "✨");
  s = s.replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/gi, "$1");
  return stripHtml(s).trim();
}

/**
 * Safely truncates an HTML string to maxLen characters without cutting inside tags.
 */
export function safeTruncateHtml(html: string, maxLen: number): string {
  if (!html || html.length <= maxLen) return html;
  const plain = stripHtml(html);
  if (plain.length <= maxLen) return html;
  return escHtml(plain.slice(0, maxLen - 1).trim()) + "…";
}

/**
 * Official public animated Telegram custom emoji IDs that bots are permitted
 * to send in message text/captions without triggering 400 "can't use custom emoji".
 */
export const OFFICIAL_TEXT_EMOJI_IDS = new Set<string>([
  "5255920066171537833", // Gemini / AI / Diamond
  "5256251637646787356", // Canva / Art / Palette
  "5375464961822695044", // CapCut / Video / Cinema
  "5927026418616636353", // ChatGPT / OpenAI / Claude / Brain
  "5359512328003941083", // Telegram Premium Star / Pay Star
  "5895708410447401643", // Telegram Stars
  "5467512909909214089", // Course / Cap / Student
  "5197288647275071607", // Shield / VPN / Security
  "5256131095094652290", // Target / Goals
  "5235837920081887219", // Camera / Photo
  "5278711610775457808", // Sparkles
  "5424972470023104089", // Blue Diamond
  "5372917041193828849", // Rocket
  "6283073379184415506", // Gift
  "5231102735817918643", // Down arrow
  "5416081784641168838", // Bookmark / Tag
  "5472164874886846427", // Fire / Hot
  "5458466632400412271", // Bell / Notification
  "5188481279963715781", // Film / Video
  "5771449161123631882", // Pay arrow
  "5289682726775967230", // Flash pct
  "5382194935057372936", // Flash timer
]);

/**
 * Mapping of unicode emoji characters to official animated Telegram custom emojis.
 */
export const EMOJI_CHAR_TO_PREMIUM: Record<string, { id: string; char: string }> = {
  "🚀": { id: "5372917041193828849", char: "🚀" },
  "🎓": { id: "5467512909909214089", char: "🎓" },
  "🧠": { id: "5927026418616636353", char: "🧠" },
  "📸": { id: "5235837920081887219", char: "📸" },
  "🎯": { id: "5256131095094652290", char: "🎯" },
  "🎬": { id: "5375464961822695044", char: "🎬" },
  "🎥": { id: "5375464961822695044", char: "🎬" },
  "📹": { id: "5375464961822695044", char: "🎬" },
  "🖤": { id: "5375464961822695044", char: "🎬" }, // CapCut / dark theme
  "🎁": { id: "6283073379184415506", char: "🎁" },
  "🛡": { id: "5197288647275071607", char: "🛡" },
  "🛡️": { id: "5197288647275071607", char: "🛡" },
  "👇": { id: "5231102735817918643", char: "👇" },
  "💎": { id: "5424972470023104089", char: "💎" },
  "⭐": { id: "5359512328003941083", char: "⭐" },
  "🌟": { id: "5895708410447401643", char: "🌟" },
  "✨": { id: "5278711610775457808", char: "✨" },
  "🎨": { id: "5256251637646787356", char: "🎨" },
  "🔥": { id: "5472164874886846427", char: "🔥" },
  "🔖": { id: "5416081784641168838", char: "🔖" },
  "🔔": { id: "5458466632400412271", char: "🔔" },
  "⚡": { id: "5372917041193828849", char: "⚡" },
};

/**
 * Brand-to-premium-emoji matching table.
 */
export const BRAND_PREMIUM_EMOJIS: Array<{ match: RegExp; id: string; char: string }> = [
  { match: /gemini/i, id: "5255920066171537833", char: "💎" },
  { match: /canva/i, id: "5256251637646787356", char: "🎨" },
  { match: /capcut/i, id: "5375464961822695044", char: "🎬" },
  { match: /(?:chatgpt|openai|gpt|claude|midjourney|deepseek|perplexity)/i, id: "5927026418616636353", char: "🧠" },
  { match: /telegram\s*premium/i, id: "5359512328003941083", char: "⭐" },
  { match: /(?:telegram\s*stars|stars|звезд|yulduz)/i, id: "5895708410447401643", char: "🌟" },
  { match: /(?:kurs|course|darslik|subhub)/i, id: "5467512909909214089", char: "🎓" },
  { match: /vpn/i, id: "5197288647275071607", char: "🛡" },
  { match: /(?:youtube|netflix|cinema|kino)/i, id: "5375464961822695044", char: "🎬" },
  { match: /(?:spotify|music|apple)/i, id: "5424972470023104089", char: "🎵" },
  { match: /(?:steam|game|discord)/i, id: "5372917041193828849", char: "🚀" },
];

/**
 * Normalizes and sanitizes custom emoji tags inside message text or captions.
 * Telegram Bot API only allows official animated custom emoji IDs in message text.
 * Any unofficial ID is mapped by fallback character to an official ID, or stripped to plain char.
 */
export function sanitizeTextCustomEmojis(text: string): string {
  if (!text) return "";
  return text.replace(/<tg-emoji\s+(?:emoji-)?id=["']?(\d+)["']?\s*>([\s\S]*?)<\/tg-emoji>/gi, (_m, id, inner) => {
    const cleanChar = (inner || "").trim() || "✨";
    if (OFFICIAL_TEXT_EMOJI_IDS.has(id)) {
      return `<tg-emoji emoji-id="${id}">${cleanChar}</tg-emoji>`;
    }
    if (EMOJI_CHAR_TO_PREMIUM[cleanChar]) {
      const mapped = EMOJI_CHAR_TO_PREMIUM[cleanChar];
      return `<tg-emoji emoji-id="${mapped.id}">${mapped.char}</tg-emoji>`;
    }
    return cleanChar;
  });
}

export interface ResolvedPremiumEmoji {
  id: string;
  char: string;
  textTag: string; // '<tg-emoji emoji-id="...">char</tg-emoji>'
  buttonIcon: string; // emoji ID for .icon(...)
}

/**
 * Resolves the appropriate animated Telegram premium custom emoji for a product,
 * taking into account brand keywords, configured unicode emoji, and custom emoji IDs.
 */
export function resolveProductPremiumEmoji(
  product?: {
    titleRu?: string | null;
    titleUz?: string | null;
    titleEn?: string | null;
    emoji?: string | null;
    premiumEmoji?: string | null;
    code?: string | null;
  } | null,
  contextTitle?: string | null,
): ResolvedPremiumEmoji {
  const titles = [
    contextTitle,
    product?.titleRu,
    product?.titleUz,
    product?.titleEn,
    product?.code,
  ].filter(Boolean).join(" ");

  // 1. Check brand match
  for (const b of BRAND_PREMIUM_EMOJIS) {
    if (b.match.test(titles)) {
      const textId = (product?.premiumEmoji && OFFICIAL_TEXT_EMOJI_IDS.has(product.premiumEmoji.trim()))
        ? product.premiumEmoji.trim()
        : b.id;
      const buttonIcon = product?.premiumEmoji?.trim() || b.id;
      return {
        id: textId,
        char: b.char,
        textTag: `<tg-emoji emoji-id="${textId}">${b.char}</tg-emoji>`,
        buttonIcon,
      };
    }
  }

  // 2. Check product emoji character match
  const rawEmoji = (product?.emoji || "").trim();
  if (rawEmoji && EMOJI_CHAR_TO_PREMIUM[rawEmoji]) {
    const matched = EMOJI_CHAR_TO_PREMIUM[rawEmoji];
    const textId = (product?.premiumEmoji && OFFICIAL_TEXT_EMOJI_IDS.has(product.premiumEmoji.trim()))
      ? product.premiumEmoji.trim()
      : matched.id;
    const buttonIcon = product?.premiumEmoji?.trim() || matched.id;
    return {
      id: textId,
      char: matched.char,
      textTag: `<tg-emoji emoji-id="${textId}">${matched.char}</tg-emoji>`,
      buttonIcon,
    };
  }

  // 3. If product has an explicit premiumEmoji
  if (product?.premiumEmoji && product.premiumEmoji.trim()) {
    const id = product.premiumEmoji.trim();
    const char = rawEmoji || "✨";
    const textId = OFFICIAL_TEXT_EMOJI_IDS.has(id) ? id : (EMOJI_CHAR_TO_PREMIUM[char]?.id || "5278711610775457808");
    const textChar = OFFICIAL_TEXT_EMOJI_IDS.has(id) ? char : (EMOJI_CHAR_TO_PREMIUM[char]?.char || "✨");
    return {
      id: textId,
      char: textChar,
      textTag: `<tg-emoji emoji-id="${textId}">${textChar}</tg-emoji>`,
      buttonIcon: id,
    };
  }

  // 4. Default fallback: Sparkles
  return {
    id: "5278711610775457808",
    char: rawEmoji || "✨",
    textTag: `<tg-emoji emoji-id="5278711610775457808">${rawEmoji || "✨"}</tg-emoji>`,
    buttonIcon: "5278711610775457808",
  };
}
