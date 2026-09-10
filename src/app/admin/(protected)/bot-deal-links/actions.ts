"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";
import { generateDealSlug } from "@/lib/domain/deal-links";

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}
function num(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").replace(",", ".").replace(/\s/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Create a new promotional deal link with a custom price and buyer limit.
 */
export async function createPromoLinkAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);

  const title = str(formData.get("title"));
  const variantId = num(formData.get("variantId"));
  const priceUzs = num(formData.get("priceUzs"));
  const maxUses = Math.max(0, num(formData.get("maxUses")));
  const perUserLimit = Math.max(0, num(formData.get("perUserLimit")) || 1);
  const rawExpiresAt = str(formData.get("expiresAt"));
  const customSlug = str(formData.get("customSlug"));

  if (!title || !variantId || priceUzs <= 0) {
    redirect("/admin/bot-deal-links?error=missing");
  }

  // Ensure variant exists
  const variant = await botDb.variant.findUnique({ where: { id: variantId } });
  if (!variant) {
    redirect("/admin/bot-deal-links?error=novariant");
  }

  // Generate unique code slug
  let code = generateDealSlug(customSlug);
  const existing = await botDb.promoLink.findUnique({ where: { code } });
  if (existing) {
    code = `${code}_${Math.floor(1000 + Math.random() * 9000)}`;
  }

  const expiresAt = rawExpiresAt ? new Date(rawExpiresAt) : null;

  const link = await botDb.promoLink.create({
    data: {
      code,
      title,
      variantId,
      priceUzs,
      maxUses,
      perUserLimit,
      expiresAt: expiresAt && !isNaN(expiresAt.getTime()) ? expiresAt : null,
      isActive: true,
    },
  });

  await audit({
    adminId: admin.id,
    action: "promo_link.create",
    entityType: "PromoLink",
    entityId: String(link.id),
    metadata: { code, variantId, priceUzs, maxUses, perUserLimit },
  });

  revalidatePath("/admin/bot-deal-links");
  redirect("/admin/bot-deal-links?ok=created");
}

/**
 * Toggle active state of a promotional link.
 */
export async function togglePromoLinkAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = num(formData.get("id"));
  if (!id) return;

  const link = await botDb.promoLink.findUnique({ where: { id } });
  if (!link) return;

  const updated = await botDb.promoLink.update({
    where: { id },
    data: { isActive: !link.isActive },
  });

  await audit({
    adminId: admin.id,
    action: "promo_link.toggle",
    entityType: "PromoLink",
    entityId: String(id),
    metadata: { isActive: updated.isActive },
  });

  revalidatePath("/admin/bot-deal-links");
}

/**
 * Delete a promotional deal link.
 */
export async function deletePromoLinkAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = num(formData.get("id"));
  if (!id) return;

  await botDb.promoLink.delete({ where: { id } });

  await audit({
    adminId: admin.id,
    action: "promo_link.delete",
    entityType: "PromoLink",
    entityId: String(id),
  });

  revalidatePath("/admin/bot-deal-links");
}
