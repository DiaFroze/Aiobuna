"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

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
