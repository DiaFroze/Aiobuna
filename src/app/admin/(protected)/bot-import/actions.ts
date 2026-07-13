"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";
import { sourceProducts, type Source } from "@/lib/supplier";
import { geminiLocalize } from "@/lib/gemini";

function num(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}
function priceWithMarkup(base: number, markupPct: number): number {
  return Math.round(base * (1 + markupPct / 100) * 100) / 100;
}

async function getSource(slug: string): Promise<Source | null> {
  const row = await botDb.apiSource.findFirst({ where: { slug, isActive: true } });
  return row ? { slug: row.slug, baseUrl: row.baseUrl, apiKey: row.apiKey, format: row.format } : null;
}

/**
 * Import ONE product from an API source as an auto-fulfilled variant. When a
 * customer buys it, the bot orders from that source on demand (no manual stock).
 */
export async function importSourceProductAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const slug = String(formData.get("slug") ?? "").trim();
  const extId = String(formData.get("extId") ?? "").trim();
  const markup = num(formData.get("markup"));
  if (!slug || !extId) return;

  const src = await getSource(slug);
  if (!src) return;

  // Re-fetch from the API so imported data is authoritative.
  const products = await sourceProducts(src);
  const p = products.find((x) => x.id === extId);
  if (!p) {
    revalidatePath("/admin/bot-import");
    return;
  }

  // Idempotent: skip if already linked to a variant of this source.
  const existing = await botDb.variant.findFirst({ where: { supplierKey: slug, supplierExternalId: extId } });
  if (existing) {
    revalidatePath("/admin/bot-import");
    return;
  }

  const last = await botDb.product.findFirst({ orderBy: { sortOrder: "desc" } });
  const sellPrice = priceWithMarkup(p.price, markup);

  // Localize the supplier text (any language) into RU/EN/UZ via Gemini.
  const loc = await geminiLocalize(p.name, p.descriptionClean);

  await botDb.product.create({
    data: {
      code: `${slug}_${extId.slice(0, 12)}`,
      emoji: "✨",
      premiumEmoji: p.premiumEmojiCode,
      titleRu: loc?.titleRu ?? p.name,
      titleUz: loc?.titleUz ?? p.name,
      titleEn: loc?.titleEn ?? p.name,
      descRu: loc?.descRu ?? p.descriptionClean,
      descUz: loc?.descUz ?? p.descriptionClean,
      descEn: loc?.descEn ?? p.descriptionClean,
      sortOrder: (last?.sortOrder ?? 0) + 1,
      isActive: true,
      plans: {
        create: {
          titleRu: "Тарифы",
          titleUz: "Tariflar",
          variants: {
            create: {
              titleRu: p.name,
              titleUz: p.name,
              durationDays: 0,
              priceUsdt: sellPrice,
              priceUzs: Math.round(sellPrice * Number(process.env.USDT_UZS_RATE ?? 12600)),
              autoSupplier: true,
              supplierKey: slug,
              supplierExternalId: extId,
              supplierPriceUsdt: p.price,
              supplierStock: p.stock,
              isActive: true,
            },
          },
        },
      },
    },
  });

  await audit({
    adminId: admin.id,
    action: "bot.source.import",
    entityType: "ApiProduct",
    entityId: `${slug}:${extId}`,
    metadata: { name: p.name, buy: p.price, sell: sellPrice, markup },
  });
  revalidatePath("/admin/bot-import");
  revalidatePath("/admin/bot-products");
}
