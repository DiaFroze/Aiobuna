"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";
import { geminiLocalize } from "@/lib/gemini";

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}

/** (Re)generate RU/EN/UZ title + description for a product via Gemini. */
export async function retranslateProductAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  const p = await botDb.product.findUnique({ where: { id } });
  if (!p) return;
  const loc = await geminiLocalize(p.titleRu, p.descRu || p.descUz || p.descEn);
  if (loc) {
    await botDb.product.update({
      where: { id },
      data: {
        titleRu: loc.titleRu,
        titleEn: loc.titleEn,
        titleUz: loc.titleUz,
        descRu: loc.descRu,
        descEn: loc.descEn,
        descUz: loc.descUz,
      },
    });
    await audit({ adminId: admin.id, action: "bot.product.translate", entityType: "BotProduct", entityId: String(id) });
  }
  revalidatePath(`/admin/bot-products/${id}`);
}

function num(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}

// A premium emoji ID is a long number (~19 digits). If the admin types it into
// the plain "emoji" field, move it to premiumEmoji so it works either way.
function resolveEmoji(emojiInput: string, premiumInput: string): { emoji: string; premium: string | null } {
  const emoji = emojiInput.trim();
  const premium = premiumInput.trim();
  if (!premium && /^\d{6,}$/.test(emoji)) return { emoji: "✨", premium: emoji };
  return { emoji: emoji || "✨", premium: premium || null };
}

/**
 * Create a bot product MANUALLY (the admin owns the catalog — no supplier
 * auto-import). A default plan is created so variants can be added right away.
 * On success redirects to the product's edit page.
 */
export async function createBotProductAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const code = str(formData.get("code"));
  const titleRu = str(formData.get("titleRu"));
  if (!code || !titleRu) redirect("/admin/bot-products?error=missing");

  const existing = await botDb.product.findUnique({ where: { code } });
  if (existing) redirect("/admin/bot-products?error=duplicate");

  const last = await botDb.product.findFirst({ orderBy: { sortOrder: "desc" } });
  const em = resolveEmoji(str(formData.get("emoji")), str(formData.get("premiumEmoji")));

  let tRu = titleRu;
  let tUz = str(formData.get("titleUz")) || titleRu;
  let tEn = titleRu;
  let dRu = str(formData.get("descRu"));
  let dUz = str(formData.get("descUz"));
  let dEn = "";

  try {
    const loc = await geminiLocalize(titleRu, dRu || dUz || "");
    if (loc) {
      tRu = loc.titleRu || tRu;
      tUz = loc.titleUz || tUz;
      tEn = loc.titleEn || tEn;
      dRu = loc.descRu || dRu;
      dUz = loc.descUz || dUz;
      dEn = loc.descEn || dEn;
    }
  } catch (err) {
    console.error("Gemini localization failed on create:", err);
  }

  const product = await botDb.product.create({
    data: {
      code,
      titleRu: tRu,
      titleUz: tUz,
      titleEn: tEn,
      emoji: em.emoji,
      premiumEmoji: em.premium,
      descRu: dRu,
      descUz: dUz,
      descEn: dEn,
      sortOrder: (last?.sortOrder ?? 0) + 1,
      isActive: true,
      plans: { create: { titleRu: "Тарифы", titleUz: "Tariflar" } },
    },
  });

  await audit({
    adminId: admin.id,
    action: "bot.product.create",
    entityType: "BotProduct",
    entityId: String(product.id),
    metadata: { code },
  });
  revalidatePath("/admin/bot-products");
  redirect(`/admin/bot-products/${product.id}`);
}

export async function deleteBotProductAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  await botDb.product.delete({ where: { id } }); // Plan/Variant cascade
  await audit({
    adminId: admin.id,
    action: "bot.product.delete",
    entityType: "BotProduct",
    entityId: String(id),
  });
  revalidatePath("/admin/bot-products");
  redirect("/admin/bot-products");
}

/** Add a plan (tariff group) to a product. */
export async function addPlanAction(formData: FormData) {
  await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const productId = Number(formData.get("productId"));
  const titleRu = str(formData.get("titleRu")) || "Тарифы";
  await botDb.plan.create({
    data: { productId, titleRu, titleUz: str(formData.get("titleUz")) || titleRu },
  });
  revalidatePath(`/admin/bot-products/${productId}`);
}

/** Add a variant (duration + prices) to a plan. */
export async function addVariantAction(formData: FormData) {
  await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const planId = Number(formData.get("planId"));
  const productId = str(formData.get("productId"));
  const titleRu = str(formData.get("titleRu"));
  if (!planId || !titleRu) redirect(`/admin/bot-products/${productId}?error=variant`);
  
  const manual = formData.get("manual") === "on";
  const manualStockLimit = manual
    ? (formData.get("manualStockLimit") ? Math.round(num(formData.get("manualStockLimit"))) : -1)
    : -1;

  await botDb.variant.create({
    data: {
      planId,
      titleRu,
      titleUz: str(formData.get("titleUz")) || titleRu,
      durationDays: Math.round(num(formData.get("durationDays"))) || 30,
      priceUzs: Math.round(num(formData.get("priceUzs"))),
      priceUsdt: num(formData.get("priceUsdt")),
      priceStars: Math.round(num(formData.get("priceStars"))),
      manualDelivery: manual,
      manualStockLimit,
      isActive: true,
    },
  });
  revalidatePath(`/admin/bot-products/${productId}`);
}

/** Edit an existing variant: title, duration, and your own price in UZS (сум). */
export async function updateVariantAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("variantId"));
  const productId = str(formData.get("productId"));
  const priceUzs = Math.round(num(formData.get("priceUzs")));
  
  const manual = formData.get("manual") === "on";
  const manualStockLimit = manual
    ? (formData.get("manualStockLimit") ? Math.round(num(formData.get("manualStockLimit"))) : -1)
    : -1;

  await botDb.variant.update({
    where: { id },
    data: {
      titleRu: str(formData.get("titleRu")) || undefined,
      durationDays: Math.round(num(formData.get("durationDays"))),
      priceUzs, // сум — the only price the bot uses
      priceStars: Math.round(num(formData.get("priceStars"))),
      manualDelivery: manual,
      manualStockLimit,
      isActive: formData.get("isActive") === "on",
    },
  });
  await audit({
    adminId: admin.id,
    action: "bot.variant.update",
    entityType: "BotVariant",
    entityId: String(id),
    metadata: { priceUzs },
  });
  revalidatePath(`/admin/bot-products/${productId}`);
}

export async function deleteVariantAction(formData: FormData) {
  await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("variantId"));
  await botDb.variant.delete({ where: { id } });
  revalidatePath(`/admin/bot-products/${formData.get("productId")}`);
}

/**
 * Add stock (deliverable codes) to a variant — one code per line. Each becomes a
 * StockItem handed to the next buyer. "Остаток" in the bot = unsold count.
 */
export async function addStockAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const variantId = Number(formData.get("variantId"));
  const productId = str(formData.get("productId"));
  const codes = str(formData.get("codes"))
    .split("\n")
    .map((c) => c.trim())
    .filter(Boolean);
  if (variantId && codes.length) {
    await botDb.stockItem.createMany({ data: codes.map((payload) => ({ variantId, payload })) });
    await audit({
      adminId: admin.id,
      action: "bot.stock.add",
      entityType: "BotVariant",
      entityId: String(variantId),
      metadata: { added: codes.length },
    });
  }
  revalidatePath(`/admin/bot-products/${productId}`);
}

/** Save the referral promo config (invite N → free variant(s), all delivered together). */
export async function saveRefPromoAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const variantIds = formData
    .getAll("variantIds")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  const map: Record<string, string> = {
    ref_reward_enabled: formData.get("enabled") === "on" ? "1" : "0",
    ref_reward_threshold: String(Math.max(0, Math.round(num(formData.get("threshold"))))),
    ref_reward_variant: variantIds.join(","),
  };
  for (const [key, valueRu] of Object.entries(map)) {
    await botDb.setting.upsert({ where: { key }, create: { key, valueRu, type: "text" }, update: { valueRu } });
  }
  await audit({ adminId: admin.id, action: "bot.refpromo.save", entityType: "BotSetting", entityId: "ref_promo", metadata: map });
  revalidatePath("/admin/bot-promo");
}

/** Delete all UNSOLD stock for a variant (sold items are kept for order history). */
export async function clearStockAction(formData: FormData) {
  await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const variantId = Number(formData.get("variantId"));
  await botDb.stockItem.deleteMany({ where: { variantId, isSold: false } });
  revalidatePath(`/admin/bot-products/${formData.get("productId")}`);
}

export async function updateBotProductAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  const em = resolveEmoji(str(formData.get("emoji")), str(formData.get("premiumEmoji")));
  const premiumEmoji = em.premium ?? "";

  const titleRu = str(formData.get("titleRu"));
  const descRu = str(formData.get("descRu"));

  let tRu = titleRu;
  let tUz = str(formData.get("titleUz")) || titleRu;
  let tEn = titleRu;
  let dRu = descRu;
  let dUz = str(formData.get("descUz"));
  let dEn = "";

  try {
    const loc = await geminiLocalize(titleRu, descRu || dUz || "");
    if (loc) {
      tRu = loc.titleRu || tRu;
      tUz = loc.titleUz || tUz;
      tEn = loc.titleEn || tEn;
      dRu = loc.descRu || dRu;
      dUz = loc.descUz || dUz;
      dEn = loc.descEn || dEn;
    }
  } catch (err) {
    console.error("Gemini localization failed on update:", err);
  }

  await botDb.product.update({
    where: { id },
    data: {
      titleRu: tRu,
      titleUz: tUz,
      titleEn: tEn,
      emoji: em.emoji,
      premiumEmoji: em.premium, // string custom_emoji_id, precision-safe
      descRu: dRu,
      descUz: dUz,
      descEn: dEn,
      isActive: formData.get("isActive") === "on",
    },
  });

  await audit({
    adminId: admin.id,
    action: "bot.product.update",
    entityType: "BotProduct",
    entityId: String(id),
    metadata: { premiumEmoji: premiumEmoji || null },
  });
  revalidatePath(`/admin/bot-products/${id}`);
  revalidatePath("/admin/bot-products");
}

export async function toggleVariantAction(formData: FormData) {
  await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("variantId"));
  const v = await botDb.variant.findUnique({ where: { id } });
  if (v) await botDb.variant.update({ where: { id }, data: { isActive: !v.isActive } });
  revalidatePath(`/admin/bot-products/${formData.get("productId")}`);
}

/**
 * Send a preview of the product's premium emoji to the admin's Telegram, using
 * a custom_emoji entity — so the admin can visually confirm it renders before
 * relying on it. Requires TELEGRAM_BOT_TOKEN + TELEGRAM_ADMIN_CHAT_ID.
 */
export async function testEmojiAction(formData: FormData) {
  await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID ?? "";
  const emoji = str(formData.get("emoji")) || "✨";
  const code = str(formData.get("premiumEmoji"));
  const title = str(formData.get("titleRu"));
  if (!token || !chatId || !code) return;

  const text = `${emoji} ${title}\n\nПревью Premium Emoji (код ${code}). Если слева виден кастомный эмодзи — всё работает.`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      entities: [{ type: "custom_emoji", offset: 0, length: emoji.length, custom_emoji_id: code }],
    }),
  }).catch(() => {});
}

/** Upload a banner image for a product via Telegram Bot API. */
export async function uploadBannerAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const productId = Number(formData.get("productId"));
  const file = formData.get("file") as File | null;
  if (!productId || !file || file.size === 0) return;

  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID ?? "";
  if (!token || !chatId) return;

  // Upload to Telegram to get a file_id
  const tgForm = new FormData();
  tgForm.append("chat_id", chatId);
  tgForm.append("photo", file, file.name);
  tgForm.append("caption", `📷 Banner for product #${productId}`);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    body: tgForm,
  });
  const json = await res.json() as { ok: boolean; result?: { photo?: { file_id: string }[]; message_id?: number } };
  if (!json.ok || !json.result?.photo) return;

  const fileId = json.result.photo[json.result.photo.length - 1].file_id;

  // Delete the temp message
  if (json.result.message_id) {
    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: json.result.message_id }),
    }).catch(() => {});
  }

  await botDb.product.update({ where: { id: productId }, data: { bannerFileId: fileId } });
  await audit({ adminId: admin.id, action: "product.banner.upload", entityType: "BotProduct", entityId: String(productId) });
  revalidatePath("/admin/bot-products");
}

/** Delete the banner image for a product. */
export async function deleteBannerAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const productId = Number(formData.get("productId"));
  if (!productId) return;
  await botDb.product.update({ where: { id: productId }, data: { bannerFileId: null } });
  await audit({ adminId: admin.id, action: "product.banner.delete", entityType: "BotProduct", entityId: String(productId) });
  revalidatePath("/admin/bot-products");
}
