"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";
import { geminiLocalize, geminiAiFormatProduct } from "@/lib/gemini";
import { parseBulkPrices, parseBulkBonus } from "@/lib/domain/bulk-pricing";
import fs from "node:fs";
import path from "node:path";

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}

/** (Re)generate RU/UZ title + description + premium emojis for a product via Gemini AI. */
export async function retranslateProductAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  const p = await botDb.product.findUnique({ where: { id } });
  if (!p) return;

  const formatted = await geminiAiFormatProduct(p.titleRu, p.descRu || p.descUz || p.descEn, p.emoji);
  if (formatted) {
    await botDb.product.update({
      where: { id },
      data: {
        titleRu: formatted.titleRu || p.titleRu,
        titleUz: formatted.titleUz || p.titleUz,
        descRu: formatted.descRu,
        descUz: formatted.descUz,
        emoji: formatted.emoji || p.emoji,
        premiumEmoji: p.premiumEmoji || formatted.premiumEmoji || null,
      },
    });
    await audit({ adminId: admin.id, action: "bot.product.ai_format", entityType: "BotProduct", entityId: String(id) });
  } else {
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
  }
  revalidatePath(`/admin/bot-products/${id}`);
}

/**
 * Interactive AI format action: formats product content via Gemini AI
 * and returns JSON for the admin UI editor.
 */
export async function aiFormatProductContentAction(name: string, description: string, emoji?: string) {
  await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  return await geminiAiFormatProduct(name, description, emoji);
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

/**
 * Flip a product between visible and hidden straight from the products list.
 *
 * Hiding is the fast lever when something is sold but cannot be delivered right
 * now — a supplier outage, an empty wallet, an integration still being wired up.
 * It used to mean opening the product, finding the checkbox, saving; that is too
 * many steps for something you reach for in a hurry, so it is one click here.
 *
 * This only controls whether customers see the product. It never touches prices,
 * variants or stock, so switching it back on restores exactly what was there.
 */
export async function toggleBotProductActiveAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  const product = await botDb.product.findUnique({ where: { id }, select: { isActive: true } });
  if (!product) return;

  const next = !product.isActive;
  await botDb.product.update({ where: { id }, data: { isActive: next } });
  await audit({
    adminId: admin.id,
    action: next ? "bot.product.enable" : "bot.product.disable",
    entityType: "BotProduct",
    entityId: String(id),
  });
  revalidatePath("/admin/bot-products");
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

  // Round-trip the quantity rules through the parser before storing them, so a
  // typo like "5=" (which Number() would read as "5 items for 0 сум") is
  // dropped here rather than becoming a free-goods bug in the shop.
  const bulkPrices = parseBulkPrices(str(formData.get("bulkPrices")))
    .map((t) => `${t.qty}=${t.totalUzs}`)
    .join(",");
  const bulkBonus = parseBulkBonus(str(formData.get("bulkBonus")))
    .map((b) => `${b.buy}+${b.free}`)
    .join(",");

  await botDb.variant.update({
    where: { id },
    data: {
      titleRu: str(formData.get("titleRu")) || undefined,
      durationDays: Math.round(num(formData.get("durationDays"))),
      priceUzs, // сум — the only price the bot uses
      priceStars: Math.round(num(formData.get("priceStars"))),
      pointsCost: Math.max(0, Math.round(num(formData.get("pointsCost")))),
      bulkPrices,
      bulkBonus,
      needsUsername: formData.get("needsUsername") === "on",
      // Only "stars" and "premium" reach the DB — an unexpected value would
      // silently disable the Fragment block in the admin's delivery task.
      fragmentKind: ["stars", "premium"].includes(str(formData.get("fragmentKind")))
        ? str(formData.get("fragmentKind"))
        : "",
      fragmentAmount: Math.max(0, Math.round(num(formData.get("fragmentAmount")))),
      manualDelivery: manual,
      manualStockLimit,
      isActive: formData.get("isActive") === "on",
      autoSupplier: formData.get("autoSupplier") === "on",
      routingStrategy: ["priority", "cheapest", "balance"].includes(str(formData.get("routingStrategy")))
        ? str(formData.get("routingStrategy"))
        : "priority",
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

/** Link a supplier (Level 1, Level 2 cascade, etc.) to a variant */
export async function addVariantSupplierAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const variantId = Number(formData.get("variantId"));
  const productId = str(formData.get("productId"));
  const supplierKey = str(formData.get("supplierKey"));
  const supplierExternalId = str(formData.get("supplierExternalId"));
  const supplierPriceUsdt = num(formData.get("supplierPriceUsdt"));
  const supplierStock = Math.round(num(formData.get("supplierStock")));
  const priority = Math.round(num(formData.get("priority"))) || 1;
  const name = str(formData.get("name")) || null;
  const isActive = formData.get("isActive") === "on";

  if (!variantId || !supplierKey || !supplierExternalId) return;

  await botDb.variantSupplier.upsert({
    where: {
      variantId_supplierKey_supplierExternalId: {
        variantId,
        supplierKey,
        supplierExternalId,
      },
    },
    create: {
      variantId,
      supplierKey,
      supplierExternalId,
      supplierPriceUsdt,
      supplierStock,
      priority,
      name,
      isActive,
    },
    update: {
      supplierPriceUsdt,
      supplierStock,
      priority,
      name,
      isActive,
    },
  });

  // Automatically enable autoSupplier on variant
  await botDb.variant.update({
    where: { id: variantId },
    data: { autoSupplier: true },
  });

  await audit({
    adminId: admin.id,
    action: "bot.variant.supplier.add",
    entityType: "VariantSupplier",
    entityId: `${variantId}:${supplierKey}:${supplierExternalId}`,
    metadata: { priority, supplierPriceUsdt },
  });

  revalidatePath(`/admin/bot-products/${productId}`);
}

/** Update priority or details of a linked supplier */
export async function updateVariantSupplierAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  const productId = str(formData.get("productId"));
  const priority = Math.max(1, Math.round(num(formData.get("priority"))) || 1);
  const supplierPriceUsdt = num(formData.get("supplierPriceUsdt"));
  const supplierStock = Math.round(num(formData.get("supplierStock")));
  const isActive = formData.get("isActive") === "on";
  const name = str(formData.get("name")) || null;

  if (!id) return;

  await botDb.variantSupplier.update({
    where: { id },
    data: {
      priority,
      supplierPriceUsdt,
      supplierStock,
      isActive,
      name,
    },
  });

  await audit({
    adminId: admin.id,
    action: "bot.variant.supplier.update",
    entityType: "VariantSupplier",
    entityId: String(id),
    metadata: { priority, supplierPriceUsdt, isActive },
  });

  revalidatePath(`/admin/bot-products/${productId}`);
}

/** Remove a linked supplier from a variant */
export async function deleteVariantSupplierAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  const productId = str(formData.get("productId"));

  if (!id) return;

  await botDb.variantSupplier.delete({ where: { id } });

  await audit({
    adminId: admin.id,
    action: "bot.variant.supplier.delete",
    entityType: "VariantSupplier",
    entityId: String(id),
  });

  revalidatePath(`/admin/bot-products/${productId}`);
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

/** Save the referral promo config — each row is its own tier (invite N → free variant). */
export async function saveRefPromoAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const tiers: string[] = [];
  for (let i = 0; ; i++) {
    const thresholdRaw = formData.get(`tier${i}_threshold`);
    const variantRaw = formData.get(`tier${i}_variant`);
    if (thresholdRaw === null && variantRaw === null) break; // no more rows in the form
    const threshold = Math.round(num(thresholdRaw));
    const variantId = Math.round(num(variantRaw));
    if (threshold > 0 && variantId > 0) tiers.push(`${threshold}:${variantId}`);
  }
  const map: Record<string, string> = {
    ref_reward_enabled: formData.get("enabled") === "on" ? "1" : "0",
    ref_reward_tiers: tiers.join(","),
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
  const titleUzInput = str(formData.get("titleUz"));
  const descUzInput = str(formData.get("descUz"));
  const descEnInput = str(formData.get("descEn"));
  const bannerFileId = str(formData.get("bannerFileId")) || null;

  let tRu = titleRu;
  let tUz = titleUzInput || titleRu;
  let tEn = str(formData.get("titleEn")) || titleRu;
  let dRu = descRu;
  let dUz = descUzInput;
  let dEn = descEnInput;

  // Only auto-translate with Gemini if Uzbek description is completely empty:
  if (!dUz && dRu) {
    try {
      const loc = await geminiLocalize(titleRu, descRu);
      if (loc) {
        if (!titleUzInput && loc.titleUz) tUz = loc.titleUz;
        if (loc.descUz) dUz = loc.descUz;
        if (!dEn && loc.descEn) dEn = loc.descEn;
      }
    } catch (err) {
      console.error("Gemini localization failed on update:", err);
    }
  }

  const sortOrderRaw = formData.get("sortOrder");
  const sortOrder = sortOrderRaw !== null && sortOrderRaw !== undefined ? Math.round(num(sortOrderRaw)) : undefined;
  const videoFileIdRaw = formData.get("videoFileId");
  const videoFileId = videoFileIdRaw !== null && videoFileIdRaw !== undefined ? str(videoFileIdRaw) || null : undefined;

  await botDb.product.update({
    where: { id },
    data: {
      titleRu: tRu,
      titleUz: tUz,
      titleEn: tEn,
      emoji: em.emoji,
      premiumEmoji: em.premium, // string custom_emoji_id, precision-safe
      bannerFileId,
      descRu: dRu,
      descUz: dUz,
      descEn: dEn,
      isActive: formData.get("isActive") === "on",
      refDiscount: formData.get("refDiscount") === "on",
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      ...(videoFileId !== undefined ? { videoFileId } : {}),
    },
  });

  await audit({
    adminId: admin.id,
    action: "bot.product.update",
    entityType: "BotProduct",
    entityId: String(id),
    metadata: { premiumEmoji: premiumEmoji || null, bannerFileId, videoFileId, sortOrder },
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

/** Upload a banner image for a product. Saves locally and optionally registers with Telegram. */
export async function uploadBannerAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const productId = Number(formData.get("productId"));
  const file = formData.get("file") as File | null;
  if (!productId || !file || file.size === 0) return;

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  const ext = path.extname(file.name) || ".jpg";
  const filename = `banner-product-${productId}${ext}`;

  // Save to public/banners and src/bot/assets for universal serving
  const publicDir = path.join(process.cwd(), "public", "banners");
  const botAssetsDir = path.join(process.cwd(), "src", "bot", "assets");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  if (!fs.existsSync(botAssetsDir)) fs.mkdirSync(botAssetsDir, { recursive: true });

  fs.writeFileSync(path.join(publicDir, filename), buffer);
  fs.writeFileSync(path.join(botAssetsDir, filename), buffer);

  const p = await botDb.product.findUnique({ where: { id: productId }, select: { code: true } });
  if (p?.code === "ai_darslik" || productId === 8) {
    fs.writeFileSync(path.join(publicDir, "course-banner.jpg"), buffer);
    fs.writeFileSync(path.join(botAssetsDir, "course-banner.jpg"), buffer);
  }

  let fileId = filename;

  // Optional: Also try to upload to Telegram to get a file_id if bot credentials are valid
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID ?? "";
  if (token && chatId) {
    try {
      const tgForm = new FormData();
      tgForm.append("chat_id", chatId);
      tgForm.append("photo", new Blob([buffer]), file.name);
      tgForm.append("caption", `📷 Banner for product #${productId}`);
      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        body: tgForm,
      });
      const json = await res.json() as { ok: boolean; result?: { photo?: { file_id: string }[]; message_id?: number } };
      if (json.ok && json.result?.photo && json.result.photo.length > 0) {
        fileId = json.result.photo[json.result.photo.length - 1].file_id;
        if (json.result.message_id) {
          await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_id: json.result.message_id }),
          }).catch(() => {});
        }
      }
    } catch {
      // Offline / invalid bot token: local file asset will be used
    }
  }

  await botDb.product.update({ where: { id: productId }, data: { bannerFileId: fileId } });
  await audit({ adminId: admin.id, action: "product.banner.upload", entityType: "BotProduct", entityId: String(productId) });
  revalidatePath(`/admin/bot-products/${productId}`);
  revalidatePath("/admin/bot-products");
}

/** Delete the banner image for a product. */
export async function deleteBannerAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const productId = Number(formData.get("productId"));
  if (!productId) return;

  const p = await botDb.product.findUnique({ where: { id: productId }, select: { bannerFileId: true } });
  if (p?.bannerFileId) {
    const filename = p.bannerFileId;
    const publicPath = path.join(process.cwd(), "public", "banners", filename);
    const botAssetsPath = path.join(process.cwd(), "src", "bot", "assets", filename);
    if (fs.existsSync(publicPath)) fs.unlinkSync(publicPath);
    if (fs.existsSync(botAssetsPath)) fs.unlinkSync(botAssetsPath);
  }

  await botDb.product.update({ where: { id: productId }, data: { bannerFileId: null } });
  await audit({ adminId: admin.id, action: "product.banner.delete", entityType: "BotProduct", entityId: String(productId) });
  revalidatePath(`/admin/bot-products/${productId}`);
  revalidatePath("/admin/bot-products");
}

/** Move a product up or down in the catalog ordering. */
export async function moveBotProductAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  const direction = str(formData.get("direction")); // "up" | "down"
  if (!id || (direction !== "up" && direction !== "down")) return;

  const all = await botDb.product.findMany({
    orderBy: { sortOrder: "asc" },
    select: { id: true, sortOrder: true },
  });

  const idx = all.findIndex((p) => p.id === id);
  if (idx === -1) return;

  const targetIdx = direction === "up" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= all.length) return;

  const current = all[idx];
  const target = all[targetIdx];

  let currentSort = current.sortOrder;
  let targetSort = target.sortOrder;

  // If sort orders collide, re-index all with a clean stride
  if (currentSort === targetSort) {
    for (let i = 0; i < all.length; i++) {
      all[i].sortOrder = (i + 1) * 10;
      await botDb.product.update({ where: { id: all[i].id }, data: { sortOrder: all[i].sortOrder } });
    }
    currentSort = (idx + 1) * 10;
    targetSort = (targetIdx + 1) * 10;
  }

  await botDb.$transaction([
    botDb.product.update({ where: { id: current.id }, data: { sortOrder: targetSort } }),
    botDb.product.update({ where: { id: target.id }, data: { sortOrder: currentSort } }),
  ]);

  await audit({
    adminId: admin.id,
    action: `bot.product.move_${direction}`,
    entityType: "BotProduct",
    entityId: String(id),
  });

  revalidatePath("/admin/bot-products");
}

/** Delete the video attached to a product. */
export async function deleteVideoAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const productId = Number(formData.get("productId"));
  if (!productId) return;

  await botDb.product.update({ where: { id: productId }, data: { videoFileId: null } });
  await audit({ adminId: admin.id, action: "product.video.delete", entityType: "BotProduct", entityId: String(productId) });
  revalidatePath(`/admin/bot-products/${productId}`);
  revalidatePath("/admin/bot-products");
}

