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
