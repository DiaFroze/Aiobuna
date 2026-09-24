"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { audit } from "@/lib/security/audit";
import { buildChannelPromoText, formatUzs } from "@/lib/domain/channel-promos";
import { launchConfiguredNextPromo } from "@/lib/services/channel-reactions";

export async function launchChannelPromoAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);

  const variantId = Number.parseInt(String(formData.get("variantId")), 10);
  const promoPriceUzs = Number.parseInt(String(formData.get("promoPriceUzs")), 10);
  const hours = Math.max(1, Number.parseInt(String(formData.get("hours") || "2"), 10));
  const targetEmoji = String(formData.get("targetEmoji") || "🔥").trim();
  const targetReactions = Math.max(1, Number.parseInt(String(formData.get("targetReactions") || "10"), 10));
  const autoLaunchNext = formData.get("autoLaunchNext") === "true" || formData.get("autoLaunchNext") === "on";

  const nextVariantId = formData.get("nextVariantId")
    ? Number.parseInt(String(formData.get("nextVariantId")), 10)
    : null;
  const nextPriceUzs = formData.get("nextPriceUzs")
    ? Number.parseInt(String(formData.get("nextPriceUzs")), 10)
    : null;
  const nextHours = formData.get("nextHours")
    ? Number.parseInt(String(formData.get("nextHours")), 10)
    : 2;
  const teaserTemplate = String(formData.get("teaserTemplate") || "").trim() || null;

  if (!variantId || !promoPriceUzs) {
    throw new Error("Выберите товар и укажите акционную цену.");
  }

  const variant = await prisma.variant.findUnique({
    where: { id: variantId },
    include: {
      plan: {
        include: { product: true },
      },
    },
  });

  if (!variant) throw new Error("Товар не найден");

  const originalPriceUzs = variant.priceUzs;
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);

  const prodTitle = variant.plan?.product?.titleRu || "Товар";
  const varTitle = variant.titleRu || "";
  const productName = `${prodTitle} — ${varTitle}`.trim();

  // 1. Determine promo channel
  const customChan = await prisma.botSetting.findUnique({ where: { key: "promo_post_channel" } });
  let channelId = (customChan?.valueRu || "").trim();
  if (!channelId) {
    const req = await prisma.requiredChannel.findFirst({ where: { isActive: true } });
    channelId = req?.chatId?.trim() || "";
  }

  const botToken = process.env.BOT_TOKEN;
  const botSetting = await prisma.botSetting.findFirst({ where: { key: "bot_username" } });
  const botUsername = botSetting?.valueRu || process.env.BOT_USERNAME || "Aiobuna_bot";

  let sentMessageId: number | null = null;

  // 2. Post to Telegram Channel if channelId and botToken are available
  if (channelId && botToken) {
    const promoText = buildChannelPromoText({
      productName,
      originalPriceUzs,
      promoPriceUzs,
      hours,
    });

    const pct = originalPriceUzs > promoPriceUzs
      ? Math.round(((originalPriceUzs - promoPriceUzs) / originalPriceUzs) * 100)
      : 0;

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        text: promoText,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `🛒 Купить со скидкой −${pct}%`,
                url: `https://t.me/${botUsername}?start=buy_${variant.id}`,
              },
            ],
          ],
        },
      }),
    });

    const data = await res.json();
    if (data.ok && data.result?.message_id) {
      sentMessageId = data.result.message_id;
    } else {
      console.error("[channel-promos] Bot API error sending message to channel:", data);
    }
  }

  // 3. Update shop price and promo_active marker
  await prisma.variant.update({
    where: { id: variant.id },
    data: { priceUzs: promoPriceUzs },
  });

  const marker = {
    variantId: variant.id,
    originalPrice: originalPriceUzs,
    price: promoPriceUzs,
    hours,
    expiresAt: expiresAt.getTime(),
    name: productName,
  };

  await prisma.botSetting.upsert({
    where: { key: "promo_active" },
    create: { key: "promo_active", valueRu: JSON.stringify(marker) },
    update: { valueRu: JSON.stringify(marker) },
  });

  // 4. Save campaign record if sent to channel
  if (sentMessageId && channelId) {
    // If an existing campaign row with same channel+messageId exists, update or delete it first
    await prisma.channelPromoCampaign.deleteMany({
      where: { channelId, messageId: sentMessageId },
    });

    await prisma.channelPromoCampaign.create({
      data: {
        channelId,
        messageId: sentMessageId,
        variantId: variant.id,
        originalPriceUzs,
        promoPriceUzs,
        expiresAt,
        state: "active",
        targetEmoji,
        targetReactions,
        autoLaunchNext,
        nextVariantId,
        nextPriceUzs,
        nextHours,
        teaserTemplate,
      },
    });
  }

  await audit({
    adminId: admin.id,
    action: "channel_promo.launch",
    entityType: "Variant",
    entityId: String(variant.id),
    metadata: {
      originalPriceUzs,
      promoPriceUzs,
      hours,
      targetEmoji,
      targetReactions,
      sentMessageId,
    },
  }).catch(() => {});

  revalidatePath("/admin/channel-promos");
}

export async function forceLaunchNextAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const campaignId = Number.parseInt(String(formData.get("campaignId")), 10);
  if (!campaignId) throw new Error("Missing campaignId");

  const campaign = await prisma.channelPromoCampaign.findUnique({
    where: { id: campaignId },
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

  if (!campaign) throw new Error("Кампания не найдена");

  // Create Bot API adapter for direct fetch
  const botToken = process.env.BOT_TOKEN;
  const botApi = {
    editMessageText: async (chatId: string, messageId: number, text: string, opts?: any) => {
      if (!botToken) return;
      await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: opts?.parse_mode || "HTML",
          reply_markup: opts?.reply_markup,
        }),
      });
    },
  };

  const botSetting = await prisma.botSetting.findFirst({ where: { key: "bot_username" } });
  const botUsername = botSetting?.valueRu || process.env.BOT_USERNAME || "Aiobuna_bot";

  // Mark current as completed
  await prisma.channelPromoCampaign.update({
    where: { id: campaignId },
    data: { state: "completed", triggeredAt: new Date() },
  });

  const res = await launchConfiguredNextPromo(prisma, botApi, campaign, botUsername);
  if (!res.success) {
    throw new Error(res.message || "Не удалось запустить следующую акцию");
  }

  await audit({
    adminId: admin.id,
    action: "channel_promo.force_launch_next",
    entityType: "ChannelPromoCampaign",
    entityId: String(campaignId),
    metadata: { triggeredBy: admin.email },
  }).catch(() => {});

  revalidatePath("/admin/channel-promos");
}

export async function cancelPromoCampaignAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const campaignId = Number.parseInt(String(formData.get("campaignId")), 10);
  if (!campaignId) throw new Error("Missing campaignId");

  const campaign = await prisma.channelPromoCampaign.findUnique({
    where: { id: campaignId },
  });

  if (!campaign) throw new Error("Кампания не найдена");

  // Restore price
  await prisma.variant.update({
    where: { id: campaign.variantId },
    data: { priceUzs: campaign.originalPriceUzs },
  });

  await prisma.channelPromoCampaign.update({
    where: { id: campaignId },
    data: { state: "cancelled" },
  });

  await prisma.botSetting.update({
    where: { key: "promo_active" },
    data: { valueRu: "" },
  }).catch(() => {});

  await audit({
    adminId: admin.id,
    action: "channel_promo.cancel",
    entityType: "ChannelPromoCampaign",
    entityId: String(campaignId),
    metadata: { adminEmail: admin.email },
  }).catch(() => {});

  revalidatePath("/admin/channel-promos");
}
