/**
 * Domain logic for Telegram Channel Boosts and Booster Discounts.
 */

export const DEFAULT_BOOST_DISCOUNT_PERCENT = 10;

export interface BoosterDiscountResult {
  price: number;
  discountAmount: number;
  discountPercent: number;
}

/**
 * Calculates discounted price for users who gave a boost to the Telegram channel.
 */
export function calculateBoosterDiscount(
  basePriceUzs: number,
  discountPercent: number = DEFAULT_BOOST_DISCOUNT_PERCENT,
): BoosterDiscountResult {
  if (basePriceUzs <= 0) {
    return { price: 0, discountAmount: 0, discountPercent: 0 };
  }

  const safePercent = Math.min(100, Math.max(0, discountPercent));
  if (safePercent <= 0) {
    return { price: basePriceUzs, discountAmount: 0, discountPercent: 0 };
  }

  const discountAmount = Math.round((basePriceUzs * safePercent) / 100);
  const price = Math.max(0, basePriceUzs - discountAmount);

  return { price, discountAmount, discountPercent: safePercent };
}

/**
 * Checks if a channel boost is currently active based on its expiration date.
 */
export function isBoostActive(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false;
  const exp = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  if (isNaN(exp.getTime())) return false;
  return exp.getTime() > now.getTime();
}

/**
 * Builds standard badge label for booster discount.
 */
export function formatBoosterCardBadge(discountPercent: number): string {
  return `🚀 Скидка за буст (-${discountPercent}%)`;
}
