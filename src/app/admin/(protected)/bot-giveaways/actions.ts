"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";
import {
  buildGiveawayBotUrl,
  calculateClaimExpiry,
  selectRandomWinners,
  formatGiveawayResultsPost,
  formatGiveawayCountdown,
  generateSampleWinnersPost,
} from "@/lib/domain/giveaways";
import { generateDealSlug } from "@/lib/domain/deal-links";
import { buildTelegramBoostUrl, generateBoosterAdTemplates } from "@/lib/domain/channel-boosts";

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}

function num(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").replace(",", ".").replace(/\s/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function bool(v: FormDataEntryValue | null): boolean {
  return v === "on" || v === "true" || v === "1";
}

/**
 * Create a new giveaway / contest.
 */
export async function createGiveawayAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);

  const title = str(formData.get("title"));
  const variantId = num(formData.get("variantId"));
  const prizeType = str(formData.get("prizeType")) || "discount";
  const rawDiscount = num(formData.get("discountPriceUzs"));
  const discountPriceUzs = prizeType === "free" ? 0 : Math.max(0, rawDiscount);
  const winnersCount = Math.max(1, num(formData.get("winnersCount")) || 1);
  const claimHours = Math.max(1, num(formData.get("claimHours")) || 24);

  const channelTarget = str(formData.get("channelTarget")) || null;
  const postText = str(formData.get("postText"));
  const buttonText = str(formData.get("buttonText")) || "🎉 Участвовать";

  const reqChannels = bool(formData.get("reqChannels"));
  const extraChannelId = str(formData.get("extraChannelId")) || null;
  const extraChannelUrl = str(formData.get("extraChannelUrl")) || null;
  const reqFriends = Math.max(0, num(formData.get("reqFriends")));
  const rawEndsAt = str(formData.get("endsAt"));
  const endsAt = rawEndsAt ? new Date(rawEndsAt) : null;

  if (!title || !variantId || !postText) {
    redirect("/admin/bot-giveaways?error=missing");
  }
  if (![variantId, winnersCount, claimHours, reqFriends, discountPriceUzs].every(Number.isSafeInteger) ||
      !["free", "discount"].includes(prizeType) || rawDiscount < 0 ||
      title.length > 200 || postText.length > 4096 || winnersCount > 1000 || claimHours > 8760 ||
      (extraChannelId && !extraChannelId.startsWith("@") && !extraChannelUrl)) {
    redirect("/admin/bot-giveaways?error=invalid");
  }

  const variant = await botDb.variant.findUnique({ where: { id: variantId } });
  if (!variant) {
    redirect("/admin/bot-giveaways?error=novariant");
  }

  const giveaway = await botDb.giveaway.create({
    data: {
      title,
      variantId,
      prizeType,
      discountPriceUzs,
      winnersCount,
      claimHours,
      channelTarget,
      postText,
      buttonText,
      reqChannels,
      extraChannelId,
      extraChannelUrl,
      reqFriends,
      endsAt: endsAt && !isNaN(endsAt.getTime()) ? endsAt : null,
      status: "draft",
    },
  });

  await audit({
    adminId: admin.id,
    action: "giveaway.create",
    entityType: "Giveaway",
    entityId: String(giveaway.id),
    metadata: { title, variantId, prizeType, discountPriceUzs, winnersCount, claimHours },
  });

  revalidatePath("/admin/bot-giveaways");
  redirect("/admin/bot-giveaways?ok=created");
}

/**
 * Toggle giveaway status between draft and active.
 */
export async function toggleGiveawayAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = num(formData.get("id"));
  if (!id) return;

  const gw = await botDb.giveaway.findUnique({ where: { id } });
  if (!gw) return;
  if (!["draft", "active"].includes(gw.status)) redirect("/admin/bot-giveaways?error=alreadydrawn");

  const newStatus = gw.status === "active" ? "draft" : "active";
  await botDb.giveaway.updateMany({
    where: { id, status: gw.status },
    data: { status: newStatus },
  });

  await audit({
    adminId: admin.id,
    action: "giveaway.toggle",
    entityType: "Giveaway",
    entityId: String(id),
    metadata: { status: newStatus },
  });

  revalidatePath("/admin/bot-giveaways");
  redirect("/admin/bot-giveaways?ok=updated");
}

/**
 * Publish giveaway post to the specified Telegram channel.
 */
export async function publishGiveawayAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = num(formData.get("id"));
  if (!id) return;

  const gw = await botDb.giveaway.findUnique({ where: { id } });
  if (!gw || !gw.channelTarget || !gw.postText) {
    redirect("/admin/bot-giveaways?error=nochannel");
  }
  if (!["draft", "active"].includes(gw.status)) redirect("/admin/bot-giveaways?error=alreadydrawn");

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    redirect("/admin/bot-giveaways?error=nobottoken");
  }

  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || "Aiobunabot";
  const botUrl = buildGiveawayBotUrl(botUsername, gw.id);

  let publishError = "";
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: gw.channelTarget,
        text: gw.postText,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: gw.buttonText || "🎉 Участвовать",
                url: botUrl,
              },
            ],
          ],
        },
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      console.error("[giveaway] telegram publish failed:", data);
      throw new Error(data.description || "Publish failed");
    }

    const messageId = data.result?.message_id;
    await botDb.giveaway.updateMany({
      where: { id, status: { in: ["draft", "active"] } },
      data: {
        postedMessageId: messageId || null,
        status: "active",
      },
    });

    await audit({
      adminId: admin.id,
      action: "giveaway.publish",
      entityType: "Giveaway",
      entityId: String(id),
      metadata: { channelTarget: gw.channelTarget, messageId },
    });

    revalidatePath("/admin/bot-giveaways");
  } catch (err) {
    publishError = err instanceof Error ? err.message : "publishexception";
  }
  if (publishError) redirect(`/admin/bot-giveaways?error=${encodeURIComponent(publishError)}`);
  redirect("/admin/bot-giveaways?ok=published");
}

/**
 * Conduct draw: randomly select winners, create claims, notify in bot, and post results.
 */
export async function drawGiveawayAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = num(formData.get("id"));
  if (!id) return;

  const gw = await botDb.giveaway.findUnique({
    where: { id },
    include: {
      variant: {
        include: {
          plan: {
            include: {
              product: true,
            },
          },
        },
      },
      participants: {
        where: { isEligible: true },
        include: {
          user: true,
        },
      },
      winners: true,
    },
  });

  if (!gw) {
    redirect("/admin/bot-giveaways?error=notfound");
  }

  if (!["draft", "active"].includes(gw.status) || gw.winners.length > 0) {
    redirect("/admin/bot-giveaways?error=alreadydrawn");
  }

  if (gw.participants.length === 0) {
    redirect("/admin/bot-giveaways?error=noparticipants");
  }

  // Draw winners without replacement
  const selected = selectRandomWinners(gw.participants, gw.winnersCount);
  if (selected.length === 0) {
    redirect("/admin/bot-giveaways?error=nowinners");
  }

  const claimExpiry = calculateClaimExpiry(new Date(), gw.claimHours || 24);

  // Create dedicated PromoLink for the winners
  const promoCode = generateDealSlug(`gw_${gw.id}`);
  // Commit the draw and all claims together. Only one concurrent submission wins.
  const promoLink = await botDb.$transaction(async (tx) => {
    const claimed = await tx.giveaway.updateMany({
      where: { id: gw.id, status: { in: ["draft", "active"] }, winners: { none: {} } },
      data: { status: "completed", drawnAt: new Date() },
    });
    if (claimed.count !== 1) return null;
    const link = await tx.promoLink.create({
    data: {
      code: promoCode,
      title: `🏆 Победитель розыгрыша: ${gw.title}`,
      variantId: gw.variantId,
      priceUzs: gw.discountPriceUzs,
      maxUses: selected.length,
      perUserLimit: 1,
      expiresAt: claimExpiry,
      isActive: true,
    },
    });
    for (const part of selected) {
      await tx.giveawayWinner.create({ data: {
        giveawayId: gw.id, userId: part.userId, promoLinkId: link.id,
        expiresAt: claimExpiry, isClaimed: false,
      } });
      await tx.userDealClaim.create({ data: { userId: part.userId, promoLinkId: link.id } });
    }
    return link;
  }, { timeout: 30_000 });
  if (!promoLink) redirect("/admin/bot-giveaways?error=alreadydrawn");

  // Assign winner records and UserDealClaim
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || "Aiobunabot";
  let notificationFailed = !token;
  const p = gw.variant.plan.product;
  const v = gw.variant;
  const productTitle = `${p.titleRu} — ${v.titleRu}`;
  const priceDisplay =
    gw.discountPriceUzs === 0 || gw.prizeType === "free"
      ? "Бесплатно (0 сум)"
      : `${gw.discountPriceUzs.toLocaleString("ru-RU")} сум`;

  const expiryDisplay = claimExpiry.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  for (const part of selected) {
    // 3. Send personal Telegram message to winner
    if (token && part.user.tgId) {
      const winnerMsg =
        `🏆 <b>ПОЗДРАВЛЯЕМ! ВЫ ПОБЕДИЛИ В РОЗЫГРЫШЕ!</b>\n\n` +
        `🎁 Розыгрыш: <b>${escapeHtml(gw.title)}</b>\n` +
        `📦 Товар: <b>${escapeHtml(productTitle)}</b>\n` +
        `💰 Ваша цена: <b>${priceDisplay}</b> <s>${v.priceUzs.toLocaleString("ru-RU")} сум</s>\n` +
        `⏳ Срок действия спеццены: <b>до ${expiryDisplay}</b>\n\n` +
        `Нажмите кнопку ниже, чтобы забрать и оформить товар:`;

      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: part.user.tgId,
          text: winnerMsg,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🎁 Забрать / купить приз",
                  url: `https://t.me/${botUsername}?start=gw_${gw.id}`,
                },
              ],
            ],
          },
        }),
      }).then(async (response) => {
        const result = await response.json();
        if (!result.ok) throw new Error(result.description || "Telegram rejected notification");
      }).catch(() => { notificationFailed = true; });
    }
  }

  // 4. Publish results to channel if channelTarget is specified
  if (token && gw.channelTarget) {
    const resultsPost = formatGiveawayResultsPost({
      title: gw.title,
      productTitle,
      prizeType: gw.prizeType,
      discountPriceUzs: gw.discountPriceUzs,
      winners: selected.map((s) => ({
        username: s.user.username,
        firstName: s.user.firstName,
        tgId: s.user.tgId,
      })),
      botUsername,
    });

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: gw.channelTarget,
        text: resultsPost,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🛍 Перейти в магазин",
                url: `https://t.me/${botUsername}`,
              },
            ],
          ],
        },
      }),
    }).then(async (response) => {
      const result = await response.json();
      if (!result.ok) throw new Error(result.description || "Telegram rejected results");
    }).catch(() => { notificationFailed = true; });
  }

  await audit({
    adminId: admin.id,
    action: "giveaway.draw",
    entityType: "Giveaway",
    entityId: String(gw.id),
    metadata: {
      winnersCount: selected.length,
      claimExpiry: claimExpiry.toISOString(),
      promoLinkId: promoLink.id,
    },
  });

  revalidatePath("/admin/bot-giveaways");
  redirect(`/admin/bot-giveaways?ok=drawn${notificationFailed ? "&warning=notifyfailed" : ""}`);
}

/**
 * Delete giveaway.
 */
export async function deleteGiveawayAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = num(formData.get("id"));
  if (!id) return;

  await botDb.giveaway.delete({ where: { id } });

  await audit({
    adminId: admin.id,
    action: "giveaway.delete",
    entityType: "Giveaway",
    entityId: String(id),
  });

  revalidatePath("/admin/bot-giveaways");
  redirect("/admin/bot-giveaways?ok=deleted");
}

export async function sendTestGiveawayPostAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = num(formData.get("id"));
  if (!id) return;

  const gw = await botDb.giveaway.findUnique({
    where: { id },
    include: {
      variant: {
        include: { plan: { include: { product: true } } },
      },
    },
  });
  if (!gw) redirect("/admin/bot-giveaways?error=notfound");

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) redirect("/admin/bot-giveaways?error=nobottoken");

  const targetChat = str(formData.get("targetChat")) || process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!targetChat) redirect("/admin/bot-giveaways?error=notargetchat");

  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || "Aiobunabot";
  const botUrl = buildGiveawayBotUrl(botUsername, gw.id);

  let postText = gw.postText;
  if (gw.endsAt && !postText.includes("Итоги")) {
    postText += `\n\n${formatGiveawayCountdown(gw.endsAt)}`;
  }
  postText += "\n\n<i>🧪 [ТЕСТОВЫЙ ПРЕДПРОСМОТР ПОСТА]</i>";

  let testError = "";
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: targetChat,
        text: postText,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: gw.buttonText || "🎉 Участвовать",
                url: botUrl,
              },
            ],
          ],
        },
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.description || "Telegram send failed");
    }

    await audit({
      adminId: admin.id,
      action: "giveaway.test_post",
      entityType: "Giveaway",
      entityId: String(id),
      metadata: { targetChat },
    });
  } catch (err) {
    testError = err instanceof Error ? err.message : "testpostexception";
  }

  if (testError) redirect(`/admin/bot-giveaways?error=${encodeURIComponent(testError)}`);
  redirect("/admin/bot-giveaways?ok=test_sent");
}

export async function sendTestGiveawayResultsAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = num(formData.get("id"));
  if (!id) return;

  const gw = await botDb.giveaway.findUnique({
    where: { id },
    include: {
      variant: {
        include: { plan: { include: { product: true } } },
      },
    },
  });
  if (!gw) redirect("/admin/bot-giveaways?error=notfound");

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) redirect("/admin/bot-giveaways?error=nobottoken");

  const targetChat = str(formData.get("targetChat")) || process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!targetChat) redirect("/admin/bot-giveaways?error=notargetchat");

  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || "Aiobunabot";
  const p = gw.variant.plan.product;
  const v = gw.variant;
  const productTitle = `${p.titleRu} — ${v.titleRu}`;

  const resultsText = generateSampleWinnersPost({
    title: gw.title,
    productTitle,
    prizeType: gw.prizeType,
    discountPriceUzs: gw.discountPriceUzs,
    sampleCount: Math.min(5, gw.winnersCount),
  });

  let testError = "";
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: targetChat,
        text: resultsText,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🛍 Перейти в магазин",
                url: `https://t.me/${botUsername}`,
              },
            ],
          ],
        },
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.description || "Telegram send failed");
    }

    await audit({
      adminId: admin.id,
      action: "giveaway.test_results",
      entityType: "Giveaway",
      entityId: String(id),
      metadata: { targetChat },
    });
  } catch (err) {
    testError = err instanceof Error ? err.message : "testresultsexception";
  }

  if (testError) redirect(`/admin/bot-giveaways?error=${encodeURIComponent(testError)}`);
  redirect("/admin/bot-giveaways?ok=test_results_sent");
}

export async function updateBoostSettingsAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const percent = Math.min(100, Math.max(0, num(formData.get("boostDiscountPercent"))));
  const channelBoostLink = str(formData.get("channelBoostLink"));

  await botDb.botSetting.upsert({
    where: { key: "boost_discount_percent" },
    create: {
      key: "boost_discount_percent",
      valueRu: String(percent),
      valueUz: String(percent),
      type: "text",
    },
    update: {
      valueRu: String(percent),
      valueUz: String(percent),
    },
  });

  if (channelBoostLink) {
    await botDb.botSetting.upsert({
      where: { key: "channel_boost_link" },
      create: {
        key: "channel_boost_link",
        valueRu: channelBoostLink,
        valueUz: channelBoostLink,
        type: "text",
      },
      update: {
        valueRu: channelBoostLink,
        valueUz: channelBoostLink,
      },
    });
  }

  await audit({
    adminId: admin.id,
    action: "channel_boost.settings_update",
    entityType: "BotSetting",
    entityId: "boost_discount_percent",
    metadata: { percent, channelBoostLink },
  });

  revalidatePath("/admin/bot-giveaways");
  redirect("/admin/bot-giveaways?ok=boost_updated");
}

export async function toggleGlobalBoostDiscountAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const current = await botDb.botSetting.findUnique({ where: { key: "boost_discount_enabled" } });
  const isEnabled = current ? current.valueRu !== "0" && current.valueRu !== "false" : true;
  const nextVal = isEnabled ? "0" : "1";

  await botDb.botSetting.upsert({
    where: { key: "boost_discount_enabled" },
    create: { key: "boost_discount_enabled", valueRu: nextVal, valueUz: nextVal, type: "text" },
    update: { valueRu: nextVal, valueUz: nextVal },
  });

  await audit({
    adminId: admin.id,
    action: "channel_boost.toggle_global",
    entityType: "BotSetting",
    entityId: "boost_discount_enabled",
    metadata: { enabled: nextVal === "1" },
  });

  revalidatePath("/admin/bot-giveaways");
  redirect("/admin/bot-giveaways?ok=boost_updated");
}

export async function updateVariantBoostPricingAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const variantId = num(formData.get("variantId"));
  if (!variantId) return;

  const boostDiscountEnabled = bool(formData.get("boostDiscountEnabled"));
  const mode = str(formData.get("pricingMode")) || "percent";
  const rawValue = num(formData.get("pricingValue"));

  let boostDiscountPercent: number | null = null;
  let boostPriceUzs: number | null = null;

  if (mode === "price") {
    boostPriceUzs = rawValue > 0 ? Math.round(rawValue) : null;
  } else if (mode === "percent") {
    boostDiscountPercent = rawValue > 0 ? Math.min(100, Math.round(rawValue)) : null;
  }

  await botDb.variant.update({
    where: { id: variantId },
    data: {
      boostDiscountEnabled,
      boostDiscountPercent,
      boostPriceUzs,
    },
  });

  await audit({
    adminId: admin.id,
    action: "variant.boost_pricing_update",
    entityType: "Variant",
    entityId: String(variantId),
    metadata: { boostDiscountEnabled, mode, boostDiscountPercent, boostPriceUzs },
  });

  revalidatePath("/admin/bot-giveaways");
  redirect("/admin/bot-giveaways?ok=boost_variant_updated");
}

export async function publishBoosterAdAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) redirect("/admin/bot-giveaways?error=nobottoken");

  const channelTarget = str(formData.get("channelTarget")) || (await botDb.botSetting.findUnique({ where: { key: "channel_username" } }))?.valueRu || "";
  if (!channelTarget) redirect("/admin/bot-giveaways?error=nochannel");

  const adText = str(formData.get("adText"));
  if (!adText) redirect("/admin/bot-giveaways?error=missing");

  const customBoostLink = (await botDb.botSetting.findUnique({ where: { key: "channel_boost_link" } }))?.valueRu;
  const boostUrl = customBoostLink || buildTelegramBoostUrl(channelTarget);
  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || "Aiobunabot";
  const shopBoostUrl = `https://t.me/${botUsername}?start=boost`;

  let publishError = "";
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelTarget,
        text: adText,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚀 Забустить канал", url: boostUrl }],
            [{ text: "🛍 Открыть магазин со скидкой", url: shopBoostUrl }],
          ],
        },
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.description || "Telegram rejected publish");
    }

    await audit({
      adminId: admin.id,
      action: "channel_boost.publish_ad",
      entityType: "ChannelBoostAd",
      entityId: channelTarget,
      metadata: { messageId: data.result?.message_id },
    });
  } catch (err) {
    publishError = err instanceof Error ? err.message : "publishexception";
  }

  if (publishError) redirect(`/admin/bot-giveaways?error=${encodeURIComponent(publishError)}`);
  redirect("/admin/bot-giveaways?ok=ad_published");
}

export async function sendTestBoosterAdAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) redirect("/admin/bot-giveaways?error=nobottoken");

  const targetChat = str(formData.get("targetChat")) || process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!targetChat) redirect("/admin/bot-giveaways?error=notargetchat");

  const adText = str(formData.get("adText"));
  if (!adText) redirect("/admin/bot-giveaways?error=missing");

  const channelTarget = str(formData.get("channelTarget")) || "@channel";
  const customBoostLink = (await botDb.botSetting.findUnique({ where: { key: "channel_boost_link" } }))?.valueRu;
  const boostUrl = customBoostLink || buildTelegramBoostUrl(channelTarget);
  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || "Aiobunabot";
  const shopBoostUrl = `https://t.me/${botUsername}?start=boost`;

  const testText = `${adText}\n\n<i>🧪 [ТЕСТОВЫЙ ПРЕДПРОСМОТР РЕКЛАМЫ БУСТА]</i>`;

  let testError = "";
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: targetChat,
        text: testText,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚀 Забустить канал", url: boostUrl }],
            [{ text: "🛍 Открыть магазин со скидкой", url: shopBoostUrl }],
          ],
        },
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.description || "Telegram rejected test send");
    }

    await audit({
      adminId: admin.id,
      action: "channel_boost.test_ad",
      entityType: "ChannelBoostAd",
      entityId: targetChat,
    });
  } catch (err) {
    testError = err instanceof Error ? err.message : "testpostexception";
  }

  if (testError) redirect(`/admin/bot-giveaways?error=${encodeURIComponent(testError)}`);
  redirect("/admin/bot-giveaways?ok=ad_test_sent");
}

function escapeHtml(s: string): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


