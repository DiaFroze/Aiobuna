import { randomBytes } from "node:crypto";

export interface DealLinkSnapshot {
  id: number;
  code: string;
  title: string;
  variantId: number;
  priceUzs: number;
  maxUses: number;
  usedCount: number;
  perUserLimit: number;
  expiresAt: Date | string | null;
  isActive: boolean;
}

export type DealEligibilityReason =
  | "inactive"
  | "expired"
  | "limit_reached"
  | "user_limit_reached";

export interface DealEligibilityResult {
  valid: boolean;
  reason?: DealEligibilityReason;
  remainingUses?: number; // total remaining uses if maxUses > 0
}

/**
 * Generate a clean, URL-safe deal code slug (e.g. "deal_k8f2a9").
 */
export function generateDealSlug(customSlug?: string): string {
  if (customSlug && customSlug.trim()) {
    const cleaned = customSlug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
    if (cleaned.length >= 2) {
      return cleaned.startsWith("deal_") ? cleaned : `deal_${cleaned}`;
    }
  }
  const rand = randomBytes(4).toString("hex"); // 8 hex characters
  return `deal_${rand}`;
}

/**
 * Normalize and extract deal code from /start payload.
 * Matches: "deal_xyz", "offer_xyz", "promo_xyz", or raw code.
 */
export function parseDealPayload(payload: string): string {
  const trimmed = payload.trim().toLowerCase();
  return trimmed;
}

/**
 * Construct full Telegram deep link URL.
 */
export function buildDealLinkUrl(botUsername: string, code: string): string {
  const cleanUsername = botUsername.replace(/^@/, "").trim() || "Aiobunabot";
  return `https://t.me/${cleanUsername}?start=${encodeURIComponent(code)}`;
}

/**
 * Validate deal link eligibility based on active state, expiration, total max uses, and per-user limits.
 */
export function validateDealEligibility(
  deal: DealLinkSnapshot,
  userUsageCount: number,
  now: Date = new Date(),
): DealEligibilityResult {
  if (!deal.isActive) {
    return { valid: false, reason: "inactive" };
  }

  if (deal.expiresAt) {
    const expDate = typeof deal.expiresAt === "string" ? new Date(deal.expiresAt) : deal.expiresAt;
    if (now.getTime() > expDate.getTime()) {
      return { valid: false, reason: "expired" };
    }
  }

  if (deal.maxUses > 0 && deal.usedCount >= deal.maxUses) {
    return { valid: false, reason: "limit_reached", remainingUses: 0 };
  }

  if (deal.perUserLimit > 0 && userUsageCount >= deal.perUserLimit) {
    return { valid: false, reason: "user_limit_reached" };
  }

  const remainingUses = deal.maxUses > 0 ? Math.max(0, deal.maxUses - deal.usedCount) : undefined;

  return { valid: true, remainingUses };
}

/**
 * Calculate discount amount and discount percentage relative to original price.
 */
export function calculateDealDiscount(
  originalPriceUzs: number,
  dealPriceUzs: number,
): { discountAmount: number; discountPercent: number } {
  if (originalPriceUzs <= 0 || dealPriceUzs >= originalPriceUzs) {
    return { discountAmount: 0, discountPercent: 0 };
  }
  const discountAmount = originalPriceUzs - dealPriceUzs;
  const discountPercent = Math.round((discountAmount / originalPriceUzs) * 100);
  return { discountAmount, discountPercent };
}
