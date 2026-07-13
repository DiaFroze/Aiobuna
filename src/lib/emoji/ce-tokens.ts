// Parser for the supplier's inline custom-emoji tokens embedded in product text.
//
// The Vex reseller API encodes Telegram custom emoji inside descriptions as:
//     {ce:5278711610775457808}          -> code only
//     {ce:5350619413533958825:⚡}        -> code + fallback emoji/char
//
// Codes are long numeric IDs and MUST be kept as strings (precision). Telegram
// custom emoji cannot render on a normal website, so for public text we replace
// each token with its fallback char (or drop it), and we lift the FIRST code
// into the product's premiumEmojiCode for <ProductTitleIcon>.

export interface CeToken {
  code: string; // numeric id as string
  fallback: string | null; // emoji/char after the colon, if any
}

const CE_RE = /\{ce:(\d+)(?::([^}]*))?\}/g;

/** Extract all {ce:...} tokens in order of appearance. */
export function extractCeTokens(text: string | null | undefined): CeToken[] {
  if (!text) return [];
  const out: CeToken[] = [];
  for (const m of text.matchAll(CE_RE)) {
    out.push({ code: m[1], fallback: m[2] ? m[2].trim() || null : null });
  }
  return out;
}

/** The first custom-emoji code (used as the product title icon), or null. */
export function primaryCeCode(text: string | null | undefined): CeToken | null {
  return extractCeTokens(text)[0] ?? null;
}

/**
 * Replace {ce:...} tokens for public display: use the fallback char when the
 * token has one, otherwise drop the token entirely. Leaves the rest of the
 * text (including <b> tags) untouched — sanitization happens downstream.
 */
export function replaceCeTokensForPublic(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(CE_RE, (_full, _code, fallback) => (fallback ? String(fallback).trim() : ""))
    // collapse leftover leading spaces created by dropped tokens
    .replace(/^[ \t]+/gm, "")
    .trim();
}
