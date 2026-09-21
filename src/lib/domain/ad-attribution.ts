import { createHash } from "node:crypto";

// Reserved prefixes in /start payloads that belong to other subsystems
export const RESERVED_START_PREFIXES = [
  "ref",
  "p_",
  "buy_",
  "deal_",
  "offer_",
  "promo_",
  "gw_",
  "giveaway_",
  "gifts",
  "boost",
  "booster",
  "promo",
  "cb:",
] as const;

export interface CodeValidationResult {
  valid: boolean;
  code: string;
  reason?: "empty" | "too_short" | "too_long" | "invalid_chars" | "reserved_prefix";
}

/**
 * Validates and normalizes an advertising link code.
 * Telegram start payloads are limited to 64 URL-safe characters: [A-Za-z0-9_-].
 */
export function validateAdCode(rawCode: string): CodeValidationResult {
  const trimmed = (rawCode ?? "").trim();
  if (!trimmed) {
    return { valid: false, code: "", reason: "empty" };
  }

  // Strip optional leading 'ad_' prefix for validation of the core slug
  const code = trimmed.startsWith("ad_") ? trimmed.slice(3) : trimmed;

  if (code.length < 2) {
    return { valid: false, code, reason: "too_short" };
  }

  if (code.length > 64) {
    return { valid: false, code, reason: "too_long" };
  }

  if (!/^[A-Za-z0-9_-]+$/.test(code)) {
    return { valid: false, code, reason: "invalid_chars" };
  }

  const lower = code.toLowerCase();
  for (const prefix of RESERVED_START_PREFIXES) {
    if (lower === prefix || lower.startsWith(prefix)) {
      return { valid: false, code, reason: "reserved_prefix" };
    }
  }

  return { valid: true, code };
}

/**
 * Legacy adSource function preserved for backwards compatibility.
 * Checks if the payload starts with 'ad_' and is within Telegram's character limits.
 */
export function adSource(payload: string): string | null {
  if (!payload) return null;
  // If it has ad_ prefix:
  if (/^ad_[A-Za-z0-9_-]{1,61}$/.test(payload)) {
    return payload.slice(3);
  }
  return null;
}

/**
 * Extracts candidate ad code from any /start payload.
 * Supports both 'ad_xxx' and direct 'xxx' codes as long as it does not collide
 * with other bot routes (ref, deal_, p_, etc.).
 */
export function parseAdStartPayload(payload: string): string | null {
  if (!payload) return null;
  const trimmed = payload.trim();

  // 1. Direct ad_ prefix
  if (trimmed.startsWith("ad_")) {
    const slug = trimmed.slice(3);
    const v = validateAdCode(slug);
    return v.valid ? v.code : null;
  }

  // 2. Direct code (must not match any reserved prefix)
  const validation = validateAdCode(trimmed);
  if (validation.valid) {
    return validation.code;
  }

  return null;
}

/**
 * Detects search engine crawlers, social network link preview bots (Meta, Telegram, Google, etc.).
 */
export function isCrawlerBot(
  userAgent: string | null | undefined,
  headers?: { get(name: string): string | null },
): boolean {
  if (headers) {
    const purpose = headers.get("purpose") || headers.get("x-purpose");
    if (purpose && purpose.toLowerCase().includes("preview")) {
      return true;
    }
  }

  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();

  const botTokens = [
    "facebookexternalhit",
    "facebot",
    "meta-externalagent",
    "telegrambot",
    "twitterbot",
    "slackbot",
    "whatsapp",
    "googlebot",
    "bingbot",
    "yandexbot",
    "baiduspider",
    "crawler",
    "spider",
    "bot/",
    "bot;",
    "preview",
  ];

  return botTokens.some((token) => ua.includes(token));
}

/**
 * Privacy-preserving visitor IP hash for deduplicating clicks without storing PII.
 */
export function hashVisitorIp(ip: string, userAgent = ""): string {
  const cleanIp = (ip || "127.0.0.1").trim();
  const cleanUa = (userAgent || "").slice(0, 100);
  return createHash("sha256").update(`${cleanIp}:${cleanUa}`).digest("hex");
}

/**
 * Constructs the Telegram deep link URL to open the bot with attribution.
 */
export function buildAdRedirectUrl(botUsername: string, code: string): string {
  const cleanUser = (botUsername || "Aiobunabot").replace(/^@/, "").trim() || "Aiobunabot";
  return `https://t.me/${cleanUser}?start=${encodeURIComponent(code)}`;
}

/**
 * Constructs the public web link for ad platforms (Meta Ads, Instagram Reels, etc.).
 */
export function buildAdWebUrl(appUrl: string, code: string): string {
  const cleanAppUrl = (appUrl || "http://localhost:3000").replace(/\/+$/, "");
  return `${cleanAppUrl}/go/${encodeURIComponent(code)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/**
 * Returns the part of an expense that belongs to the selected date range.
 * Expense periods and report filters are inclusive calendar-day ranges.
 */
export function prorateExpenseForRange(
  amount: number,
  expenseStart: Date,
  expenseEnd: Date,
  rangeStart?: Date | null,
  rangeEnd?: Date | null,
): number {
  const start = utcDay(expenseStart);
  const end = utcDay(expenseEnd);
  if (!Number.isFinite(amount) || amount <= 0 || end < start) return 0;

  const selectedStart = rangeStart ? Math.max(start, utcDay(rangeStart)) : start;
  const selectedEnd = rangeEnd ? Math.min(end, utcDay(rangeEnd)) : end;
  if (selectedEnd < selectedStart) return 0;

  const totalDays = Math.floor((end - start) / DAY_MS) + 1;
  const selectedDays = Math.floor((selectedEnd - selectedStart) / DAY_MS) + 1;
  return Math.round((amount * selectedDays) / totalDays);
}

export interface AdMetricsInput {
  clicks: number;
  uniqueClicks: number;
  starts: number;
  newUsers: number;
  orderCreators?: number;
  payingUsers: number;
  paidOrdersCount: number;
  repeatBuyers?: number;
  revenueUzs: number;
  costPriceUzs?: number | null;
  hasIncompleteCostPrice?: boolean;
  actualSpendUzs: number;
}

export interface AdMetricsOutput {
  clicks: number;
  uniqueClicks: number;
  starts: number;
  newUsers: number;
  orderCreators: number;
  payingUsers: number;
  paidOrdersCount: number;
  repeatBuyers: number;
  repeatOrdersCount: number;
  revenueUzs: number;
  costPriceUzs: number | null;
  hasIncompleteCostPrice: boolean;
  actualSpendUzs: number;
  // Conversions & Rates
  conversionClickToStart: number; // in %
  conversionStartToBuyer: number; // in %
  aov: number; // Average Order Value in UZS
  cpc: number | null; // Cost per Click in UZS
  costPerStart: number | null; // Cost per Bot Start in UZS
  cacNewUser: number | null; // Cost per New User in UZS
  cacPayingUser: number | null; // Cost per Paying Customer in UZS
  roas: number | null; // Revenue / Spend
  profitBeforeAds: number | null; // Revenue - Cost Price
  profitAfterAds: number | null; // (Revenue - Cost Price) - Spend
  roi: number | null; // (Profit After Ads / Spend) * 100 in %
  arpu: number; // Revenue per acquired user
}

/**
 * Calculates marketing and financial performance metrics with strict division-by-zero protection.
 */
export function calculateAdMetrics(input: AdMetricsInput): AdMetricsOutput {
  const clicks = Math.max(0, input.clicks);
  const uniqueClicks = Math.max(0, input.uniqueClicks);
  const starts = Math.max(0, input.starts);
  const newUsers = Math.max(0, input.newUsers);
  const payingUsers = Math.max(0, input.payingUsers);
  const orderCreators = Math.max(payingUsers, input.orderCreators ?? payingUsers);
  const paidOrdersCount = Math.max(0, input.paidOrdersCount);
  const repeatBuyers = Math.max(0, input.repeatBuyers ?? (paidOrdersCount > payingUsers ? 1 : 0));
  const repeatOrdersCount = Math.max(0, paidOrdersCount - payingUsers);

  const revenueUzs = Math.max(0, input.revenueUzs);
  const actualSpendUzs = Math.max(0, input.actualSpendUzs);

  const hasIncompleteCostPrice = Boolean(input.hasIncompleteCostPrice);
  const costPriceUzs =
    input.costPriceUzs !== undefined && input.costPriceUzs !== null && !hasIncompleteCostPrice
      ? Math.max(0, input.costPriceUzs)
      : null;

  // Conversions
  const baseClicks = uniqueClicks > 0 ? uniqueClicks : clicks;
  const conversionClickToStart =
    baseClicks > 0 ? Number(((starts / baseClicks) * 100).toFixed(1)) : 0;
  const conversionStartToBuyer =
    starts > 0 ? Number(((payingUsers / starts) * 100).toFixed(1)) : 0;

  // AOV
  const aov = paidOrdersCount > 0 ? Math.round(revenueUzs / paidOrdersCount) : 0;

  // Cost metrics (Strictly null when spend is 0 or result count is 0)
  const cpc = actualSpendUzs > 0 && clicks > 0 ? Math.round(actualSpendUzs / clicks) : null;
  const costPerStart =
    actualSpendUzs > 0 && starts > 0 ? Math.round(actualSpendUzs / starts) : null;
  const cacNewUser =
    actualSpendUzs > 0 && newUsers > 0 ? Math.round(actualSpendUzs / newUsers) : null;
  const cacPayingUser =
    actualSpendUzs > 0 && payingUsers > 0 ? Math.round(actualSpendUzs / payingUsers) : null;

  // ROAS: Revenue / Ad Spend
  const roas =
    actualSpendUzs > 0 ? Number((revenueUzs / actualSpendUzs).toFixed(2)) : null;

  // Profit calculations
  const profitBeforeAds =
    costPriceUzs !== null ? revenueUzs - costPriceUzs : null;
  const profitAfterAds =
    profitBeforeAds !== null ? profitBeforeAds - actualSpendUzs : null;

  // ROI: (Profit after ads / Ad Spend) * 100
  const roi =
    actualSpendUzs > 0 && profitAfterAds !== null
      ? Number(((profitAfterAds / actualSpendUzs) * 100).toFixed(1))
      : null;

  // ARPU
  const arpuUsers = newUsers > 0 ? newUsers : starts;
  const arpu = arpuUsers > 0 ? Math.round(revenueUzs / arpuUsers) : 0;

  return {
    clicks,
    uniqueClicks,
    starts,
    newUsers,
    orderCreators,
    payingUsers,
    paidOrdersCount,
    repeatBuyers,
    repeatOrdersCount,
    revenueUzs,
    costPriceUzs,
    hasIncompleteCostPrice,
    actualSpendUzs,
    conversionClickToStart,
    conversionStartToBuyer,
    aov,
    cpc,
    costPerStart,
    cacNewUser,
    cacPayingUser,
    roas,
    profitBeforeAds,
    profitAfterAds,
    roi,
    arpu,
  };
}

export interface FunnelStep {
  name: string;
  count: number;
  conversionFromPrev: number; // in %
  conversionFromStart: number; // in %
}

/**
 * Builds the visual conversion funnel steps.
 */
export function buildFunnelSteps(metrics: {
  clicks: number;
  starts: number;
  newUsers: number;
  payingUsers: number;
  repeatBuyers: number;
}): FunnelStep[] {
  const stepsData = [
    { name: "Переход (Clicks)", count: Math.max(0, metrics.clicks) },
    { name: "Запуск бота (Starts)", count: Math.max(0, metrics.starts) },
    { name: "Новые пользователи", count: Math.max(0, metrics.newUsers) },
    { name: "Покупатели (Buyers)", count: Math.max(0, metrics.payingUsers) },
    { name: "Повторные покупки", count: Math.max(0, metrics.repeatBuyers) },
  ];

  const firstCount = stepsData[0].count;

  return stepsData.map((step, idx) => {
    const prevCount = idx > 0 ? stepsData[idx - 1].count : step.count;
    const conversionFromPrev =
      prevCount > 0 ? Number(((step.count / prevCount) * 100).toFixed(1)) : 0;
    const conversionFromStart =
      firstCount > 0 ? Number(((step.count / firstCount) * 100).toFixed(1)) : 0;

    return {
      name: step.name,
      count: step.count,
      conversionFromPrev: idx === 0 ? 100 : Math.min(100, conversionFromPrev),
      conversionFromStart: idx === 0 ? 100 : Math.min(100, conversionFromStart),
    };
  });
}
