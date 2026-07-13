"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

/** Bulk-import links as stock items for a given variant. */
export async function importStockAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const variantId = Number(formData.get("variantId"));
  const raw = String(formData.get("links") ?? "").trim();
  if (!variantId || !raw) return;

  const links = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (links.length === 0) return;

  const existing = await botDb.stockItem.findMany({
    where: { variantId, payload: { in: links } },
    select: { payload: true },
  });
  const existingSet = new Set(existing.map((e) => e.payload));
  const newLinks = links.filter((l) => !existingSet.has(l));

  if (newLinks.length > 0) {
    await botDb.stockItem.createMany({
      data: newLinks.map((payload) => ({ variantId, payload })),
    });
  }

  await audit({
    adminId: admin.id,
    action: "stock.import",
    entityType: "StockItem",
    metadata: { variantId, total: links.length, new: newLinks.length, duplicates: links.length - newLinks.length },
  });

  revalidatePath("/admin/bot-stock");
}

/** Delete a single stock item. */
export async function deleteStockItemAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  if (!id) return;
  await botDb.stockItem.delete({ where: { id } });
  await audit({
    adminId: admin.id,
    action: "stock.delete",
    entityType: "StockItem",
    entityId: String(id),
  });
  revalidatePath("/admin/bot-stock");
}

/** Delete all unsold stock for a variant. */
export async function clearVariantStockAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const variantId = Number(formData.get("variantId"));
  if (!variantId) return;
  const result = await botDb.stockItem.deleteMany({
    where: { variantId, isSold: false },
  });
  await audit({
    adminId: admin.id,
    action: "stock.clear",
    entityType: "StockItem",
    metadata: { variantId, deleted: result.count },
  });
  revalidatePath("/admin/bot-stock");
}
