// Validation for the @username a Stars / Premium order is delivered to.
//
// This is the single most dangerous field in the whole shop: Fragment sends the
// goods to whatever username it is given, and the transfer cannot be undone. A
// typo means a stranger keeps the purchase and the customer is owed a refund,
// so the rules are applied strictly and the user is made to confirm afterwards.
//
// Telegram's rules: 5–32 characters, latin letters, digits and underscores,
// must start with a letter. Telegram itself also rejects a trailing underscore
// and doubled underscores, so they are rejected here rather than at delivery.

export type UsernameCheck =
  | { ok: true; username: string }
  | { ok: false; reason: "empty" | "short" | "long" | "chars" | "start" | "end" | "double" };

/** Strip the decorations people paste: @name, t.me/name, https://t.me/name. */
export function normalizeUsername(input: string): string {
  return String(input ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?t(elegram)?\.me\//i, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "")
    .trim();
}

export function checkUsername(input: string): UsernameCheck {
  const u = normalizeUsername(input);
  if (!u) return { ok: false, reason: "empty" };
  if (!/^[A-Za-z0-9_]+$/.test(u)) return { ok: false, reason: "chars" };
  if (u.length < 5) return { ok: false, reason: "short" };
  if (u.length > 32) return { ok: false, reason: "long" };
  if (!/^[A-Za-z]/.test(u)) return { ok: false, reason: "start" };
  if (u.endsWith("_")) return { ok: false, reason: "end" };
  if (u.includes("__")) return { ok: false, reason: "double" };
  return { ok: true, username: u };
}
