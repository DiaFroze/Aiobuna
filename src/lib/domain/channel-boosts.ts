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
export function formatBoosterCardBadge(discountPercent: number, fixedPrice?: number | null): string {
  if (fixedPrice && fixedPrice > 0) {
    return `🚀 Спеццена за буст`;
  }
  return `🚀 Скидка за буст (-${discountPercent}%)`;
}

export interface VariantBoosterPriceParams {
  basePriceUzs: number;
  boostDiscountEnabled?: boolean;
  boostDiscountPercent?: number | null;
  boostPriceUzs?: number | null;
  globalPercent?: number;
}

export interface VariantBoosterPriceResult {
  price: number;
  isDiscounted: boolean;
  label: string | null;
  discountPercent: number;
  discountAmount: number;
}

/**
 * Calculates effective booster price for a specific variant taking into account:
 * - per-variant on/off switch (boostDiscountEnabled)
 * - per-variant fixed price override (boostPriceUzs)
 * - per-variant custom percent (boostDiscountPercent)
 * - global fallback discount percent
 */
export function calculateVariantBoosterPrice(
  params: VariantBoosterPriceParams,
): VariantBoosterPriceResult {
  const {
    basePriceUzs,
    boostDiscountEnabled = true,
    boostDiscountPercent,
    boostPriceUzs,
    globalPercent = DEFAULT_BOOST_DISCOUNT_PERCENT,
  } = params;

  if (basePriceUzs <= 0) {
    return { price: 0, isDiscounted: false, label: null, discountPercent: 0, discountAmount: 0 };
  }

  // If booster discount is explicitly disabled for this variant
  if (boostDiscountEnabled === false) {
    return { price: basePriceUzs, isDiscounted: false, label: null, discountPercent: 0, discountAmount: 0 };
  }

  // 1. Fixed price override has highest priority if specified and positive
  if (boostPriceUzs !== null && boostPriceUzs !== undefined && boostPriceUzs > 0) {
    if (boostPriceUzs < basePriceUzs) {
      const discountAmount = basePriceUzs - boostPriceUzs;
      const discountPercent = Math.round((discountAmount / basePriceUzs) * 100);
      return {
        price: boostPriceUzs,
        isDiscounted: true,
        label: formatBoosterCardBadge(discountPercent, boostPriceUzs),
        discountPercent,
        discountAmount,
      };
    }
    // Fixed price is equal or higher than base price
    return {
      price: boostPriceUzs,
      isDiscounted: false,
      label: null,
      discountPercent: 0,
      discountAmount: 0,
    };
  }

  // 2. Custom percent override for this variant
  const effectivePercent =
    boostDiscountPercent !== null && boostDiscountPercent !== undefined && boostDiscountPercent > 0
      ? boostDiscountPercent
      : globalPercent;

  if (effectivePercent > 0) {
    const { price, discountAmount, discountPercent } = calculateBoosterDiscount(basePriceUzs, effectivePercent);
    return {
      price,
      isDiscounted: true,
      label: formatBoosterCardBadge(discountPercent),
      discountPercent,
      discountAmount,
    };
  }

  return { price: basePriceUzs, isDiscounted: false, label: null, discountPercent: 0, discountAmount: 0 };
}

/**
 * Builds direct Telegram boost URL for a channel.
 */
export function buildTelegramBoostUrl(channelTarget: string): string {
  if (!channelTarget) return "https://t.me/boost";
  const clean = channelTarget.trim();
  if (clean.startsWith("http://") || clean.startsWith("https://")) {
    return clean;
  }
  const cleanUser = clean.replace(/^@/, "");
  if (/^-?\d+$/.test(cleanUser)) {
    const numericId = cleanUser.replace(/^-100/, "").replace(/^-/, "");
    return `https://t.me/boost?c=${numericId}`;
  }
  return `https://t.me/boost/${cleanUser}`;
}

export interface BoosterAdTemplate {
  id: string;
  title: string;
  text: string;
  buttonText: string;
  storeButtonText: string;
}

/**
 * Generates 3 ready-made promotional advertising post templates for Telegram channels.
 */
export function generateBoosterAdTemplates(params: {
  channelTitle?: string;
  boostLink?: string;
  defaultPercent?: number;
  botUsername?: string;
}): BoosterAdTemplate[] {
  const percent = params.defaultPercent || DEFAULT_BOOST_DISCOUNT_PERCENT;
  const botUsername = params.botUsername || "Aiobunabot";

  return [
    {
      id: "hot_discount",
      title: "🔥 Горячая скидка для бустеров",
      text:
        `🔥 <b>ПОЛУЧИТЕ СКИДКУ ЗА БУСТ НАШЕГО КАНАЛА!</b>\n\n` +
        `Отдайте свой голос (буст) нашему каналу и забирайте эксклюзивные скидки <b>до ${percent}%</b> на все подписки в нашем магазине!\n\n` +
        `⚡️ <b>Как получить скидку?</b>\n` +
        `1. Нажмите кнопку «🚀 Забустить канал» ниже\n` +
        `2. Подтвердите голос в Telegram\n` +
        `3. Переходите в бота — скидка применится автоматически!\n\n` +
        `<i>Скидка действует автоматически всё время, пока активен ваш буст.</i>`,
      buttonText: "🚀 Забустить канал",
      storeButtonText: "🛍 Открыть магазин",
    },
    {
      id: "vip_club",
      title: "👑 Закрытый VIP-клуб спонсоров",
      text:
        `👑 <b>VIP-КЛУБ БУСТЕРОВ КАНАЛА!</b>\n\n` +
        `Каждый, кто поддерживает наш канал бустом, автоматически получает статус <b>VIP-спонсора</b> в нашем боте:\n\n` +
        `💎 Спеццены на подписки (скидки <b>${percent}%</b> и больше)\n` +
        `⚡️ Мгновенная автоматическая скидка в корзине\n` +
        `🎁 Эксклюзивный бейдж бустера и приоритет\n\n` +
        `Жмите «🚀 Забустить канал» ниже и забирайте свои привилегии прямо сейчас!`,
      buttonText: "🚀 Забустить канал",
      storeButtonText: "🛍 Открыть магазин",
    },
    {
      id: "monthly_savings",
      title: "💰 Экономьте на подписках каждый месяц",
      text:
        `💰 <b>ЭКОНОМЬТЕ НА ПОДПИСКАХ КАЖДЫЙ МЕСЯЦ!</b>\n\n` +
        `У вас есть Telegram Premium? Вы можете отдать бесплатный буст нашему каналу и получать скидку <b>${percent}%</b> на каждую покупку!\n\n` +
        `Вам это абсолютно ничего не стоит, а экономия — тысячи сумов на каждой подписке!\n\n` +
        `👇 Отдайте буст в один клик:`,
      buttonText: "🚀 Забустить канал",
      storeButtonText: "🛍 Открыть магазин",
    },
  ];
}

