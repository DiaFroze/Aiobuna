/**
 * Domain logic for Interactive Telegram Channel Promos with Reactions.
 * 
 * Replaces message deletion with an engaging reaction teaser:
 * When an active promo ends, the channel post is edited to invite reactions (e.g. 10 🔥).
 * When the reaction threshold is reached, the bot automatically launches the next configured promo!
 */

export interface TeaserParams {
  nextProductName?: string | null;
  nextPriceUzs?: number | null;
  targetEmoji: string;
  targetCount: number;
  currentCount?: number;
  customTemplate?: string | null;
}

export const DEFAULT_TARGET_EMOJI = "🔥";
export const DEFAULT_TARGET_REACTIONS = 10;
export const ALLOWED_REACTION_EMOJIS = ["🔥", "❤️", "👍", "⚡", "🚀", "🎉", "💯", "👏", "😍"];

export function formatUzs(n: number): string {
  return Math.round(n).toLocaleString("ru-RU").replace(/\u00A0/g, " ");
}

/**
 * Builds the interactive teaser message text for the channel post when promo ends.
 */
export function buildPromoTeaserText(params: TeaserParams): string {
  const { nextProductName, nextPriceUzs, targetEmoji, targetCount, customTemplate } = params;

  if (customTemplate && customTemplate.trim().length > 0) {
    return customTemplate
      .replace(/\{next_product\}/g, nextProductName || "новый товар")
      .replace(/\{next_price\}/g, nextPriceUzs ? formatUzs(nextPriceUzs) : "спеццене")
      .replace(/\{target_count\}/g, String(targetCount))
      .replace(/\{emoji\}/g, targetEmoji);
  }

  const productPart = nextProductName
    ? `<b>${nextProductName}</b>`
    : `<b>следующий товар</b>`;

  const pricePart = nextPriceUzs
    ? ` со скидкой всего за <b>${formatUzs(nextPriceUzs)} сум</b>`
    : "";

  return (
    `⚡️ <b>Акция завершена!</b>\n\n` +
    `Следующая супер-скидка на ${productPart}${pricePart} откроется, как только этот пост наберёт ` +
    `<b>${targetCount} реакций ${targetEmoji}</b>!\n\n` +
    `Ставьте реакцию ${targetEmoji} ниже ⬇️`
  );
}

/**
 * Builds active promo announcement text for Telegram Channel.
 */
export function buildChannelPromoText(params: {
  productName: string;
  originalPriceUzs: number;
  promoPriceUzs: number;
  hours: number;
}): string {
  const { productName, originalPriceUzs, promoPriceUzs, hours } = params;
  const discountPct = originalPriceUzs > promoPriceUzs
    ? Math.round(((originalPriceUzs - promoPriceUzs) / originalPriceUzs) * 100)
    : 0;

  return (
    `🔥 <b>МЕГА-СКИДКА В НАШЕМ МАГАЗИНЕ!</b>\n\n` +
    `Товар: <b>${productName}</b>\n` +
    `Старая цена: <s>${formatUzs(originalPriceUzs)} сум</s>\n` +
    `Новая цена: <b>${formatUzs(promoPriceUzs)} сум</b> (−${discountPct}%)\n` +
    `⏳ Срок действия акции: <b>${hours} ч.</b>\n\n` +
    `👇 Нажмите кнопку ниже, чтобы забрать по спеццене!`
  );
}

export interface ReactionEvaluation {
  reached: boolean;
  currentCount: number;
  targetCount: number;
  targetEmoji: string;
}

/**
 * Evaluates whether reaction threshold has been reached from Telegram message_reaction_count update.
 */
export function evaluateReactionCount(
  reactions: Array<{ type: { type: string; emoji?: string }; total_count: number }>,
  targetEmoji: string,
  targetReactions: number
): ReactionEvaluation {
  let currentCount = 0;

  for (const r of reactions) {
    if (r.type?.type === "emoji" && r.type.emoji === targetEmoji) {
      currentCount = r.total_count;
      break;
    }
  }

  return {
    reached: currentCount >= targetReactions,
    currentCount,
    targetCount: targetReactions,
    targetEmoji,
  };
}
