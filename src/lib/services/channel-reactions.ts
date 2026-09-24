import { InlineKeyboard } from "grammy";
import {
  buildPromoTeaserText,
  buildChannelPromoText,
  evaluateReactionCount,
  formatUzs,
} from "@/lib/domain/channel-promos";

export interface LaunchNextPromoResult {
  success: boolean;
  message?: string;
  nextCampaignId?: number;
}

/**
 * Handles Telegram `message_reaction_count` updates on channel posts.
 * When target reactions (e.g. 10 🔥) are reached on an expired promo post,
 * automatically launches the configured next promotional discount in the shop and edits the channel post!
 */
export async function handleMessageReactionCountUpdate(
  db: any,
  botApi: any,
  update: {
    chat: { id: number | string };
    message_id: number;
    reactions: Array<{ type: { type: string; emoji?: string }; total_count: number }>;
  },
  botUsername?: string
): Promise<{ reached: boolean; launched: boolean; count: number }> {
  const channelId = String(update.chat.id);
  const messageId = update.message_id;

  const campaign = await db.channelPromoCampaign.findUnique({
    where: {
      channelId_messageId: {
        channelId,
        messageId,
      },
    },
    include: {
      variant: {
        include: {
          plan: {
            include: { product: true },
          },
        },
      },
    },
  });

  if (!campaign) {
    return { reached: false, launched: false, count: 0 };
  }

  const evalResult = evaluateReactionCount(
    update.reactions || [],
    campaign.targetEmoji,
    campaign.targetReactions
  );

  // Update current reaction count in DB
  await db.channelPromoCampaign.update({
    where: { id: campaign.id },
    data: { currentReactions: evalResult.currentCount },
  }).catch(() => {});

  // If already completed or not in waiting_reactions, do not launch
  if (campaign.state !== "waiting_reactions" || !evalResult.reached || !campaign.autoLaunchNext) {
    return { reached: evalResult.reached, launched: false, count: evalResult.currentCount };
  }

  // Atomically lock and transition state to completed to prevent race conditions
  const cas = await db.channelPromoCampaign.updateMany({
    where: {
      id: campaign.id,
      state: "waiting_reactions",
    },
    data: {
      state: "completed",
      triggeredAt: new Date(),
    },
  });

  if (cas.count === 0) {
    return { reached: true, launched: false, count: evalResult.currentCount };
  }

  // Launch next promo!
  const launchRes = await launchConfiguredNextPromo(db, botApi, campaign, botUsername);
  return { reached: true, launched: launchRes.success, count: evalResult.currentCount };
}

function formatVariantDisplayName(v: any): string {
  const prodTitle = v?.plan?.product?.titleRu || v?.product?.titleRu || v?.product?.nameRu || v?.product?.title || "";
  const varTitle = v?.titleRu || v?.nameRu || v?.name || "";
  if (prodTitle && varTitle) {
    return `${prodTitle} ${varTitle}`.trim();
  }
  return (prodTitle || varTitle || "Товар").trim();
}

/**
 * Launches the next configured promo for a campaign whose reaction threshold was reached.
 */
export async function launchConfiguredNextPromo(
  db: any,
  botApi: any,
  campaign: any,
  botUsername?: string
): Promise<LaunchNextPromoResult> {
  if (!campaign.nextVariantId || !campaign.nextPriceUzs) {
    return { success: false, message: "No next variant configured" };
  }

  const nextVariant = await db.variant.findUnique({
    where: { id: campaign.nextVariantId },
    include: {
      plan: {
        include: { product: true },
      },
    },
  });

  if (!nextVariant) {
    return { success: false, message: "Next variant not found in database" };
  }

  const originalPrice = nextVariant.priceUzs;
  const promoPrice = campaign.nextPriceUzs;
  const hours = campaign.nextHours || 2;
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);

  // 1. Update shop price in DB
  await db.variant.update({
    where: { id: nextVariant.id },
    data: { priceUzs: promoPrice },
  });

  // 2. Set active promo marker in DB setting
  const fullDisplayName = formatVariantDisplayName(nextVariant);

  const marker = {
    variantId: nextVariant.id,
    originalPrice,
    price: promoPrice,
    hours,
    expiresAt: expiresAt.getTime(),
    name: fullDisplayName,
  };

  const settingTable = db.botSetting || db.setting;
  await settingTable.upsert({
    where: { key: "promo_active" },
    create: { key: "promo_active", valueRu: JSON.stringify(marker) },
    update: { valueRu: JSON.stringify(marker) },
  });

  // 3. Edit the channel post into the new active promo announcement
  const promoText = buildChannelPromoText({
    productName: fullDisplayName,
    originalPriceUzs: originalPrice,
    promoPriceUzs: promoPrice,
    hours,
  });

  const username = botUsername || "Aiobuna_bot";
  const pct = originalPrice > promoPrice ? Math.round(((originalPrice - promoPrice) / originalPrice) * 100) : 0;
  const kb = new InlineKeyboard().url(`🛒 Купить со скидкой −${pct}%`, `https://t.me/${username}?start=buy_${nextVariant.id}`);

  try {
    await botApi.editMessageText(campaign.channelId, campaign.messageId, promoText, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } catch (e: any) {
    console.error("[channel-reactions] Failed to edit channel message:", e.message || e);
  }

  // 4. Create new active campaign record for this new promo cycle
  const newCampaign = await db.channelPromoCampaign.create({
    data: {
      channelId: campaign.channelId,
      messageId: campaign.messageId,
      variantId: nextVariant.id,
      originalPriceUzs: originalPrice,
      promoPriceUzs: promoPrice,
      expiresAt,
      state: "active",
      targetEmoji: campaign.targetEmoji || "🔥",
      targetReactions: campaign.targetReactions || 10,
      autoLaunchNext: false, // next chain can be configured in admin
    },
  }).catch(() => null);

  return { success: true, nextCampaignId: newCampaign?.id };
}

/**
 * Transitions an expired or stopped promo message into a reaction teaser.
 * Invoked from stopPromo instead of deleting the channel message.
 */
export async function transitionPromoToTeaser(
  db: any,
  botApi: any,
  variantId: number
): Promise<{ handled: boolean; campaignId?: number }> {
  const campaign = await db.channelPromoCampaign.findFirst({
    where: {
      variantId,
      state: "active",
    },
    include: {
      variant: {
        include: {
          plan: {
            include: { product: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!campaign) {
    return { handled: false };
  }

  let nextProductName = "";
  if (campaign.nextVariantId) {
    const nextVar = await db.variant.findUnique({
      where: { id: campaign.nextVariantId },
      include: {
        plan: {
          include: { product: true },
        },
      },
    });
    if (nextVar) {
      nextProductName = formatVariantDisplayName(nextVar);
    }
  }

  const teaserText = buildPromoTeaserText({
    nextProductName: nextProductName || undefined,
    nextPriceUzs: campaign.nextPriceUzs,
    targetEmoji: campaign.targetEmoji,
    targetCount: campaign.targetReactions,
    customTemplate: campaign.teaserTemplate,
  });

  // Edit channel post
  try {
    await botApi.editMessageText(campaign.channelId, campaign.messageId, teaserText, {
      parse_mode: "HTML",
    });
  } catch (e: any) {
    console.error("[channel-reactions] Error editing message to teaser:", e.message || e);
  }

  // Transition state to waiting_reactions
  await db.channelPromoCampaign.update({
    where: { id: campaign.id },
    data: { state: "waiting_reactions" },
  });

  return { handled: true, campaignId: campaign.id };
}
