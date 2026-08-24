"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";
import {
  STARS_RATE_CARRIER_AMOUNT,
  encodeStarsRate,
  isValidStarsRate,
  planStarsRepricing,
} from "@/lib/domain/stars-pricing";

/**
 * Save every Stars / Premium price on one product in a single submit.
 *
 * Only prices are touched. Titles, durations, Fragment metadata and the active
 * flags are deliberately left alone, so this screen can be used quickly and
 * often without any risk of disturbing how a variant is fulfilled.
 */
export async function updateFragmentPricesAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const productId = Number(formData.get("productId"));
  if (!productId) return;

  const changed: Array<{ id: number; from: number; to: number }> = [];

  for (const [field, raw] of formData.entries()) {
    if (!field.startsWith("price_")) continue;
    const variantId = Number(field.slice("price_".length));
    if (!Number.isFinite(variantId)) continue;

    const next = Math.round(Number(String(raw).replace(",", ".").trim()));
    // A blank or nonsense box means "leave it alone", never "make it free".
    if (!Number.isFinite(next) || next < 0) continue;

    const current = await botDb.variant.findUnique({
      where: { id: variantId },
      select: { priceUzs: true, planId: true, plan: { select: { productId: true } } },
    });
    if (!current) continue;
    // Only variants belonging to the submitted product may be written, so a
    // tampered form field cannot reprice something else in the catalogue.
    if (current.plan.productId !== productId) continue;
    if (current.priceUzs === next) continue;

    await botDb.variant.update({ where: { id: variantId }, data: { priceUzs: next } });
    changed.push({ id: variantId, from: current.priceUzs, to: next });
  }

  if (changed.length) {
    await audit({
      adminId: admin.id,
      action: "bot.fragment.prices",
      entityType: "BotProduct",
      entityId: String(productId),
      metadata: { changed },
    });
  }

  revalidatePath("/admin/bot-fragment");
  revalidatePath(`/admin/bot-products/${productId}`);
}

/**
 * Reprice every Telegram Stars variant from a single rate.
 *
 * The supplier price follows the TON rate, so all the packs have to move
 * together. Typing five prices by hand invites the one mistake that matters:
 * the pack that gets forgotten and is then sold under cost.
 *
 * A one-star carrier variant is created if the product has none, because that
 * is what prices freely typed amounts — without it the bot cannot offer
 * "своё количество" at all. It is hidden from the pack list in the bot.
 */
export async function applyStarsRateAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const productId = Number(formData.get("productId"));
  if (!productId) return;

  const rate = {
    stars: Math.round(Number(String(formData.get("rateStars") ?? "").replace(",", ".")) || 0),
    priceUzs: Math.round(Number(String(formData.get("ratePrice") ?? "").replace(",", ".")) || 0),
  };
  const step = Math.max(1, Math.round(Number(formData.get("rateStep")) || 100));
  if (!isValidStarsRate(rate)) return;

  const plans = await botDb.plan.findMany({
    where: { productId },
    include: { variants: { orderBy: { sortOrder: "asc" } } },
  });
  const stars = plans.flatMap((pl) => pl.variants).filter((v) => v.fragmentKind === "stars");
  if (stars.length === 0) return;

  // The carrier inherits its delivery flags from a real pack, so a rate change
  // can never invent a variant that is fulfilled differently from its siblings.
  let carrier = stars.find((v) => v.fragmentAmount === STARS_RATE_CARRIER_AMOUNT);
  let created = false;
  if (!carrier) {
    const sibling = stars[0];
    carrier = await botDb.variant.create({
      data: {
        planId: sibling.planId,
        titleRu: "1 звезда (курс)",
        titleUz: "1 yulduz (kurs)",
        durationDays: sibling.durationDays,
        priceUzs: Math.ceil(rate.priceUzs / rate.stars),
        sortOrder: 999,
        isActive: true,
        needsUsername: sibling.needsUsername,
        manualDelivery: sibling.manualDelivery,
        fragmentKind: "stars",
        fragmentAmount: STARS_RATE_CARRIER_AMOUNT,
      },
    });
    created = true;
    stars.push(carrier);
  }

  const changes = planStarsRepricing(stars, rate, step);
  for (const c of changes) {
    await botDb.variant.update({ where: { id: c.id }, data: { priceUzs: c.to } });
  }

  const key = `stars_rate_${productId}`;
  const value = encodeStarsRate(rate, step);
  await botDb.botSetting.upsert({
    where: { key },
    create: { key, valueRu: value, valueUz: value, type: "text" },
    update: { valueRu: value, valueUz: value },
  });

  await audit({
    adminId: admin.id,
    action: "bot.fragment.stars_rate",
    entityType: "BotProduct",
    entityId: String(productId),
    metadata: { rate, step, changed: changes, carrierCreated: created },
  });

  revalidatePath("/admin/bot-fragment");
  revalidatePath(`/admin/bot-products/${productId}`);
}
