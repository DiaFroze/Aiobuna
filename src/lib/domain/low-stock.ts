// "Осталось 4 шт." — but only when it is true.
//
// Scarcity sells, and the temptation is to print a small number whatever the
// warehouse actually holds. This module exists so that number is never invented:
// it is shown when stock is genuinely low, and otherwise no line is printed at
// all. There is deliberately no path here that returns a count the caller did
// not measure.

/** Below or at this many units left, the count is worth telling the customer. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 10;

/**
 * How many units to advertise as remaining, or null for "say nothing".
 *
 * @param stock     real units available right now
 * @param threshold at or below this, the count is shown
 * @param unlimited goods bought on demand (Stars, Premium) have no warehouse
 */
export function lowStockCount(stock: number, threshold: number, unlimited: boolean): number | null {
  if (unlimited) return null;
  if (!Number.isFinite(stock) || stock <= 0) return null;
  const limit = Number.isFinite(threshold) ? Math.trunc(threshold) : DEFAULT_LOW_STOCK_THRESHOLD;
  // A threshold of 0 (or less) switches the whole thing off.
  if (limit <= 0) return null;
  return stock <= limit ? Math.trunc(stock) : null;
}

/** Parse the admin-configured threshold, falling back to the default. */
export function parseLowStockThreshold(raw: string | null | undefined): number {
  const text = String(raw ?? "").trim();
  // An unset setting must not read as 0 — Number("") is 0, and that would
  // silently switch the whole feature off instead of using the default.
  if (text === "") return DEFAULT_LOW_STOCK_THRESHOLD;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LOW_STOCK_THRESHOLD;
  return Math.trunc(n);
}
