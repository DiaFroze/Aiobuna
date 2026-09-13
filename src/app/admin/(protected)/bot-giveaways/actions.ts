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
} from "@/lib/domain/giveaways";
import { generateDealSlug } from "@/lib/domain/deal-links";

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

  const newStatus = gw.status === "active" ? "draft" : "active";
  await botDb.giveaway.update({
    where: { id },
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

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    redirect("/admin/bot-giveaways?error=nobottoken");
  }

  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || "Aiobunabot";
  const botUrl = buildGiveawayBotUrl(botUsername, gw.id);

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
      const errMsg = encodeURIComponent(data.description || "Publish failed");
      redirect(`/admin/bot-giveaways?error=${errMsg}`);
    }

    const messageId = data.result?.message_id;
    await botDb.giveaway.update({
      where: { id },
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
    redirect("/admin/bot-giveaways?ok=published");
  } catch (err) {
    console.error("[giveaway] publish exception:", err);
    redirect("/admin/bot-giveaways?error=publishexception");
  }
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

  if (gw.status === "completed") {
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
  const promoLink = await botDb.promoLink.create({
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

  // Assign winner records and UserDealClaim
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || "Aiobunabot";
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
    // 1. Create GiveawayWinner
    await botDb.giveawayWinner.create({
      data: {
        giveawayId: gw.id,
        userId: part.userId,
        promoLinkId: promoLink.id,
        expiresAt: claimExpiry,
        isClaimed: false,
      },
    });

    // 2. Create UserDealClaim
    await botDb.userDealClaim.upsert({
      where: {
        userId_promoLinkId: {
          userId: part.userId,
          promoLinkId: promoLink.id,
        },
      },
      create: {
        userId: part.userId,
        promoLinkId: promoLink.id,
      },
      update: {},
    });

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
      }).catch((e) => console.warn("[giveaway] failed to notify winner:", e));
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
    }).catch((e) => console.warn("[giveaway] failed to post results to channel:", e));
  }

  // 5. Update giveaway status to completed
  await botDb.giveaway.update({
    where: { id: gw.id },
    data: {
      status: "completed",
      drawnAt: new Date(),
    },
  });

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
  redirect("/admin/bot-giveaways?ok=drawn");
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

function escapeHtml(s: string): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
