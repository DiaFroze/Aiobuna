// Quantity-based pricing for a single variant.
//
// Two independent, admin-configurable mechanics:
//
//   Bundle prices — an explicit TOTAL for a given quantity.
//     "2=55000,3=80000" → 2 pcs cost 55 000 сум together, 3 cost 80 000.
//
//   Bonus items — buy N, receive M extra free.
//     "2+1" → every 2 bought adds 1 free (4 bought → 2 free).
//
// Both are stored as short strings on Variant so they stay editable from the
// admin panel without a schema change per rule.

export type BulkTier = { qty: number; totalUzs: number };
export type BulkBonus = { buy: number; free: number };

// Number("") is 0, not NaN — so a half-typed rule like "5=" would otherwise
// parse as "5 items for 0 сум" and hand the goods away for free. Every field
// has to be non-empty and numeric before it counts.
function strictNum(s: string | undefined): number {
  const v = String(s ?? "").trim();
  if (v === "") return NaN;
  return Number(v);
}

/** "2=55000, 3=80000" → tiers sorted by quantity, ascending. Junk is ignored. */
export function parseBulkPrices(spec: string | null | undefined): BulkTier[] {
  const out: BulkTier[] = [];
  const seen = new Set<number>();
  for (const part of (spec ?? "").split(/[,\n;]/)) {
    const [qRaw, pRaw, ...rest] = part.split("=");
    if (rest.length > 0) continue; // "2=3=4" is not a rule
    const q = strictNum(qRaw);
    const p = strictNum(pRaw);
    if (!Number.isFinite(q) || !Number.isFinite(p)) continue;
    const qty = Math.trunc(q);
    const totalUzs = Math.round(p);
    // qty must be at least 2 — a "tier" for a single item is just the price.
    // A zero total is rejected too: giving stock away is what pointsCost and
    // the bonus rules are for, never a typo in the price box.
    if (qty < 2 || totalUzs <= 0 || seen.has(qty)) continue;
    seen.add(qty);
    out.push({ qty, totalUzs });
  }
  return out.sort((a, b) => a.qty - b.qty);
}

/** "2+1, 5+3" → bonus rules sorted by purchase size, ascending. */
export function parseBulkBonus(spec: string | null | undefined): BulkBonus[] {
  const out: BulkBonus[] = [];
  const seen = new Set<number>();
  for (const part of (spec ?? "").split(/[,\n;]/)) {
    const [bRaw, fRaw, ...rest] = part.split("+");
    if (rest.length > 0) continue;
    const b = strictNum(bRaw);
    const f = strictNum(fRaw);
    if (!Number.isFinite(b) || !Number.isFinite(f)) continue;
    const buy = Math.trunc(b);
    const free = Math.trunc(f);
    if (buy < 1 || free < 1 || seen.has(buy)) continue;
    seen.add(buy);
    out.push({ buy, free });
  }
  return out.sort((a, b) => a.buy - b.buy);
}

/**
 * Total price for `qty` items.
 *
 * An exact tier wins. Above the largest tier, that tier's per-unit rate is
 * applied to the whole order — otherwise buying 4 at the base rate could cost
 * more than buying 3 at a bundle rate, which reads as a bug to the customer.
 * Below or between tiers, the base unit price applies.
 */
export function bulkTotal(unitPrice: number, qty: number, tiers: BulkTier[]): number {
  const n = Math.max(0, Math.trunc(qty));
  if (n === 0) return 0;
  if (tiers.length === 0) return unitPrice * n;

  const exact = tiers.find((t) => t.qty === n);
  if (exact) return exact.totalUzs;

  const largest = tiers[tiers.length - 1];
  if (n > largest.qty && largest.qty > 0) {
    return Math.round((largest.totalUzs / largest.qty) * n);
  }
  return unitPrice * n;
}

/** Extra free items earned by buying `qty`. Uses the largest rule that fits. */
export function bonusQty(qty: number, rules: BulkBonus[]): number {
  const n = Math.max(0, Math.trunc(qty));
  if (n === 0 || rules.length === 0) return 0;
  const applicable = rules.filter((r) => r.buy <= n);
  if (applicable.length === 0) return 0;
  const best = applicable[applicable.length - 1];
  return Math.floor(n / best.buy) * best.free;
}

/** What the customer saves versus paying the base unit price for each item. */
export function bulkSaving(unitPrice: number, qty: number, tiers: BulkTier[]): number {
  return Math.max(0, unitPrice * Math.max(0, Math.trunc(qty)) - bulkTotal(unitPrice, qty, tiers));
}

/** One-line human summary of the rules, for the product card. Empty if none. */
export function describeBulk(
  unitPrice: number,
  tiers: BulkTier[],
  bonuses: BulkBonus[],
  fmt: (n: number) => string,
): string[] {
  const lines: string[] = [];
  for (const t of tiers) {
    const saved = Math.max(0, unitPrice * t.qty - t.totalUzs);
    lines.push(`${t.qty} шт. — ${fmt(t.totalUzs)}${saved > 0 ? ` (выгода ${fmt(saved)})` : ""}`);
  }
  for (const b of bonuses) lines.push(`${b.buy} шт. → +${b.free} в подарок 🎁`);
  return lines;
}
