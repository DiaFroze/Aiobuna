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

export interface TelegramEntityLike {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
  url?: string;
}

/**
 * Converts a Telegram message string and its entities (from message.entities or caption_entities)
 * into clean Telegram HTML, preserving custom animated emojis (<tg-emoji emoji-id="..."),
 * bold, italic, code, pre, underline, strikethrough, spoiler, and text links.
 */
export function messageEntitiesToHtml(
  text: string,
  entities?: TelegramEntityLike[],
): string {
  if (!text) return "";
  if (!entities || entities.length === 0) {
    return escHtml(text);
  }

  const opensAt = new Map<number, Array<{ tag: string; length: number }>>();
  const closesAt = new Map<number, string[]>();

  for (const ent of entities) {
    let openTag = "";
    let closeTag = "";

    switch (ent.type) {
      case "custom_emoji":
        if (ent.custom_emoji_id) {
          openTag = `<tg-emoji emoji-id="${ent.custom_emoji_id}">`;
          closeTag = `</tg-emoji>`;
        }
        break;
      case "bold":
        openTag = "<b>";
        closeTag = "</b>";
        break;
      case "italic":
        openTag = "<i>";
        closeTag = "</i>";
        break;
      case "code":
        openTag = "<code>";
        closeTag = "</code>";
        break;
      case "pre":
        openTag = "<pre>";
        closeTag = "</pre>";
        break;
      case "underline":
        openTag = "<u>";
        closeTag = "</u>";
        break;
      case "strikethrough":
        openTag = "<s>";
        closeTag = "</s>";
        break;
      case "spoiler":
        openTag = "<tg-spoiler>";
        closeTag = "</tg-spoiler>";
        break;
      case "text_link":
        if (ent.url) {
          openTag = `<a href="${ent.url.replace(/"/g, "&quot;")}">`;
          closeTag = "</a>";
        }
        break;
      default:
        continue;
    }

    if (!openTag) continue;

    const start = ent.offset;
    const end = ent.offset + ent.length;

    if (!opensAt.has(start)) opensAt.set(start, []);
    opensAt.get(start)!.push({ tag: openTag, length: ent.length });

    if (!closesAt.has(end)) closesAt.set(end, []);
    closesAt.get(end)!.push(closeTag);
  }

  // Sort opens at same pos by length descending (outer wraps inner)
  for (const list of opensAt.values()) {
    list.sort((a, b) => b.length - a.length);
  }

  let out = "";
  for (let i = 0; i <= text.length; i++) {
    if (closesAt.has(i)) {
      const tags = closesAt.get(i)!;
      for (const t of tags) out += t;
    }
    if (opensAt.has(i)) {
      const list = opensAt.get(i)!;
      for (const item of list) out += item.tag;
    }
    if (i < text.length) {
      const ch = text[i];
      if (ch === "&") out += "&amp;";
      else if (ch === "<") out += "&lt;";
      else if (ch === ">") out += "&gt;";
      else out += ch;
    }
  }

  return sanitizeTextCustomEmojis(out);
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
  "5897658922600240288", // Stars
  "5332606428068737460", // Click
  "5204128408463744787", // Payme
  "6269458311381258421", // Admin
  "5204242830687494041", // Чек
  "5449872877929127395", // Статистика
  "5255860701133552970", // Склад
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
  "🎥": { id: "5375464961822695044", char: "🎥" },
  "📹": { id: "5375464961822695044", char: "📹" },
  "🖤": { id: "5375464961822695044", char: "🖤" }, // CapCut / dark theme - keeps 🖤 character!
  "🎁": { id: "6283073379184415506", char: "🎁" },
  "🛡": { id: "5197288647275071607", char: "🛡" },
  "🛡️": { id: "5197288647275071607", char: "🛡️" },
  "👇": { id: "5231102735817918643", char: "👇" },
  "💎": { id: "5424972470023104089", char: "💎" },
  "⭐": { id: "5359512328003941083", char: "⭐" },
  "⭐️": { id: "5897658922600240288", char: "⭐️" },
  "🌟": { id: "5895708410447401643", char: "🌟" },
  "✨": { id: "5278711610775457808", char: "✨" },
  "🎨": { id: "5256251637646787356", char: "🎨" },
  "🔥": { id: "5472164874886846427", char: "🔥" },
  "🔖": { id: "5416081784641168838", char: "🔖" },
  "🔔": { id: "5458466632400412271", char: "🔔" },
  "⚡": { id: "5372917041193828849", char: "⚡" },
  "💳": { id: "5332606428068737460", char: "💳" },
  "💸": { id: "5204128408463744787", char: "💸" },
  "👩‍💻": { id: "6269458311381258421", char: "👩‍💻" },
  "🧾": { id: "5204242830687494041", char: "🧾" },
  "📈": { id: "5449872877929127395", char: "📈" },
  "📦": { id: "5255860701133552970", char: "📦" },
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
 * Normalizes custom emoji tags inside message text or captions.
 * Telegram Bot API only allows valid animated custom emoji IDs in message text.
 * Strictly preserves the user's emoji character without ever swapping or altering it.
 */
export function sanitizeTextCustomEmojis(text: string): string {
  if (!text) return "";
  return text.replace(
    /<tg-emoji\s+(?:emoji-)?id=(?:\\*["']|&quot;)?(\d+)(?:\\*["']|&quot;)?\s*>([\s\S]*?)<\/tg-emoji>/gi,
    (_m, id, inner) => {
      const cleanChar = (inner || "").trim() || "✨";
      // 1. If an explicit valid Telegram custom emoji ID is present (6+ digits),
      // PRESERVE IT 100%! Never overwrite or strip an ID the user/admin provided.
      if (id && /^\d{6,}$/.test(id)) {
        return `<tg-emoji emoji-id="${id}">${cleanChar}</tg-emoji>`;
      }
      if (OFFICIAL_TEXT_EMOJI_IDS.has(id)) {
        return `<tg-emoji emoji-id="${id}">${cleanChar}</tg-emoji>`;
      }
      if (EMOJI_CHAR_TO_PREMIUM[cleanChar]) {
        return `<tg-emoji emoji-id="${EMOJI_CHAR_TO_PREMIUM[cleanChar].id}">${cleanChar}</tg-emoji>`;
      }
      return cleanChar;
    },
  );
}

export interface ResolvedPremiumEmoji {
  id: string;
  char: string;
  textTag: string; // '<tg-emoji emoji-id="...">char</tg-emoji>'
  buttonIcon: string; // emoji ID for .icon(...)
}

/**
 * Resolves the animated Telegram premium custom emoji for a product.
 * Respects what the admin explicitly configured (premiumEmoji and emoji) 100%,
 * falling back to brand keywords or character defaults only when not configured.
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
  const rawEmoji = (product?.emoji || "").trim();
  const rawPremium = (product?.premiumEmoji || "").trim();

  // 1. HIGHEST PRIORITY: If admin explicitly configured premiumEmoji on the product, NEVER override it!
  if (rawPremium) {
    const char = rawEmoji || "✨";
    return {
      id: rawPremium,
      char,
      textTag: `<tg-emoji emoji-id="${rawPremium}">${char}</tg-emoji>`,
      buttonIcon: rawPremium,
    };
  }

  // 2. If product has a specific unicode emoji configured (e.g. 🖤, ⭐, 🌟, 🎓, 🧠, 📸, etc.)
  if (rawEmoji && rawEmoji !== "✨" && EMOJI_CHAR_TO_PREMIUM[rawEmoji]) {
    const matched = EMOJI_CHAR_TO_PREMIUM[rawEmoji];
    return {
      id: matched.id,
      char: rawEmoji,
      textTag: `<tg-emoji emoji-id="${matched.id}">${rawEmoji}</tg-emoji>`,
      buttonIcon: matched.id,
    };
  }

  // 3. Check brand keywords match in product title or code
  const titles = [
    contextTitle,
    product?.titleRu,
    product?.titleUz,
    product?.titleEn,
    product?.code,
  ].filter(Boolean).join(" ");

  for (const b of BRAND_PREMIUM_EMOJIS) {
    if (b.match.test(titles)) {
      const char = (rawEmoji && rawEmoji !== "✨") ? rawEmoji : b.char;
      return {
        id: b.id,
        char,
        textTag: `<tg-emoji emoji-id="${b.id}">${char}</tg-emoji>`,
        buttonIcon: b.id,
      };
    }
  }

  // 4. Default fallback: Sparkles or configured emoji
  const fallbackChar = rawEmoji || "✨";
  const fallbackId = EMOJI_CHAR_TO_PREMIUM[fallbackChar]?.id || "5278711610775457808";
  return {
    id: fallbackId,
    char: fallbackChar,
    textTag: `<tg-emoji emoji-id="${fallbackId}">${fallbackChar}</tg-emoji>`,
    buttonIcon: fallbackId,
  };
}

/**
 * Safely truncates an HTML string to fit within maxLen characters (Telegram media caption limit is 1024),
 * ensuring that HTML tags (<b/i/code/s/u/tg-emoji/a/tg-spoiler/pre/blockquote>) are never cut in half,
 * and any unclosed tags at the cutoff point are properly closed in reverse order.
 */
export function fitCaption(html: string, maxLen = 1024): string {
  if (!html) return "";

  // In Telegram Bot API, media caption limits (1024 characters) are enforced strictly
  // AFTER entities parsing (i.e. plain rendered text).
  // Rich HTML tags (<tg-emoji>, <b>, <a>, <i>, <code>) do not count towards the 1024 character limit.
  // If the plain rendered text is within maxLen, the caption is fully accepted by Telegram!
  if (maxLen >= 1024) {
    const plain = stripHtml(html);
    if (plain.length <= maxLen) {
      return html;
    }
  } else if (html.length <= maxLen) {
    return html;
  }

  const ellipsis = "...";
  const targetLen = maxLen - ellipsis.length;
  const openTags: string[] = [];
  let result = "";
  let i = 0;

  while (i < html.length) {
    if (html[i] === "<") {
      const closeIdx = html.indexOf(">", i);
      if (closeIdx === -1) break;

      const tagContent = html.slice(i + 1, closeIdx);
      const isClosing = tagContent.startsWith("/");
      const tagNameMatch = tagContent.match(/^\/?([a-zA-Z0-9_-]+)/);
      const tagName = tagNameMatch ? tagNameMatch[1].toLowerCase() : "";
      const fullTag = html.slice(i, closeIdx + 1);

      const closingTagsLen = openTags.reduce((acc, t) => acc + t.length + 3, 0);
      if (result.length + fullTag.length + closingTagsLen > targetLen) break;

      result += fullTag;
      i = closeIdx + 1;

      if (tagName) {
        if (isClosing) {
          const lastIdx = openTags.lastIndexOf(tagName);
          if (lastIdx !== -1) openTags.splice(lastIdx, 1);
        } else if (!tagContent.endsWith("/")) {
          openTags.push(tagName);
        }
      }
    } else if (html[i] === "&") {
      const semiIdx = html.indexOf(";", i);
      const entity = semiIdx !== -1 && semiIdx - i <= 10 ? html.slice(i, semiIdx + 1) : html[i];
      const closingTagsLen = openTags.reduce((acc, t) => acc + t.length + 3, 0);
      if (result.length + entity.length + closingTagsLen > targetLen) break;
      result += entity;
      i += entity.length;
    } else {
      const closingTagsLen = openTags.reduce((acc, t) => acc + t.length + 3, 0);
      if (result.length + 1 + closingTagsLen > targetLen) break;
      result += html[i];
      i++;
    }
  }

  result = result.trimEnd() + ellipsis;
  while (openTags.length > 0) {
    const t = openTags.pop()!;
    result += `</${t}>`;
  }

  return result;
}
