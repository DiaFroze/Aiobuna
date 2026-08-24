// Pricing Telegram Stars from a single rate.
//
// The catalogue holds fixed packs (50, 150, 250, 500, 1000 …) and each one used
// to be priced by hand. That is busywork with a trap in it: the supplier price
// follows the TON rate, so every pack has to move together, and the one pack
// that gets forgotten is sold below cost.
//
// So the admin sets one rate — "50 stars = 13 000 сум" — and every pack is
// derived from it. The rate also prices freely typed amounts, through a
// carrier variant holding the price of a single star.

export interface StarsRate {
  /** How many stars the quoted price buys. */
  stars: number;
  /** What those stars cost the customer, in UZS. */
  priceUzs: number;
}

export interface StarsVariantLike {
  id: number;
  /** Stars in this pack; 1 marks the carrier that prices custom amounts. */
  fragmentAmount: number;
  priceUzs: number;
}

export interface Repricing {
  id: number;
  amount: number;
  from: number;
  to: number;
}

/** The carrier variant: one star, used to price any typed quantity. */
export const STARS_RATE_CARRIER_AMOUNT = 1;

/** Rounding steps offered in the admin panel, in UZS. */
export const STARS_ROUNDING_STEPS = [1, 100, 500, 1000] as const;

export function isValidStarsRate(rate: StarsRate): boolean {
  return (
    Number.isFinite(rate.stars) && rate.stars > 0 &&
    Number.isFinite(rate.priceUzs) && rate.priceUzs > 0
  );
}

/** Price of one star. Not rounded — rounding belongs to the caller. */
export function perStarPrice(rate: StarsRate): number | null {
  if (!isValidStarsRate(rate)) return null;
  return rate.priceUzs / rate.stars;
}

/**
 * Price of a pack, rounded UP to `step`. Up, never down: rounding down is how
 * a pack quietly ends up under the supplier's own price.
 *
 * The pack the rate was quoted for keeps exactly the quoted price — typing
 * "50 stars = 13 000" and getting 13 100 back would be indefensible.
 */
export function priceForStars(amount: number, rate: StarsRate, step: number): number {
  const per = perStarPrice(rate);
  if (per === null || !Number.isFinite(amount) || amount <= 0) return 0;
  if (amount === rate.stars) return Math.round(rate.priceUzs);
  // The carrier is a rate, not a pack: rounding one star to the nearest 100
  // would inflate every custom order by up to 38%.
  const s = amount === STARS_RATE_CARRIER_AMOUNT ? 1 : Math.max(1, Math.round(step));
  return Math.ceil((amount * per) / s) * s;
}

/**
 * What repricing every Stars variant at this rate would change. Returns only
 * the rows that actually move, so an unchanged save writes nothing and the
 * audit log stays readable.
 */
export function planStarsRepricing(
  variants: StarsVariantLike[],
  rate: StarsRate,
  step: number,
): Repricing[] {
  if (!isValidStarsRate(rate)) return [];
  const out: Repricing[] = [];
  for (const v of variants) {
    if (!Number.isFinite(v.fragmentAmount) || v.fragmentAmount <= 0) continue;
    const to = priceForStars(v.fragmentAmount, rate, step);
    if (to <= 0 || to === v.priceUzs) continue;
    out.push({ id: v.id, amount: v.fragmentAmount, from: v.priceUzs, to });
  }
  return out;
}

/**
 * Smallest quantity of this variant that reaches the supplier's 50-star floor.
 * A 50-star pack can be bought singly; the one-star carrier cannot.
 */
export function minQtyForStars(starsPerUnit: number, supplierMinimum: number): number {
  if (!Number.isFinite(starsPerUnit) || starsPerUnit <= 0) return 1;
  return Math.max(1, Math.ceil(supplierMinimum / starsPerUnit));
}

/** Serialised form for BotSetting, which stores plain strings. */
export function encodeStarsRate(rate: StarsRate, step: number): string {
  return `${Math.round(rate.stars)}:${Math.round(rate.priceUzs)}:${Math.max(1, Math.round(step))}`;
}

export function decodeStarsRate(raw: string): { rate: StarsRate; step: number } | null {
  const [s, p, st] = String(raw ?? "").split(":").map((n) => Number(n));
  const rate = { stars: s, priceUzs: p };
  if (!isValidStarsRate(rate)) return null;
  return { rate, step: Number.isFinite(st) && st > 0 ? st : 100 };
}
