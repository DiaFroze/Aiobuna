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

  // How many stock items to create per link. One invite link can carry many
  // seats, so the same URL may legitimately be sold N times. Asking for more
  // than one copy means duplicates are intended, so skip the dedup filter.
  const copies = Math.min(Math.max(Math.trunc(Number(formData.get("copies")) || 1), 1), 5000);
  const allowDuplicates = formData.get("allowDuplicates") === "on" || copies > 1;

  const links = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (links.length === 0) return;

  let toInsert = links;
  let duplicates = 0;
  if (!allowDuplicates) {
    const existing = await botDb.stockItem.findMany({
      where: { variantId, payload: { in: links } },
      select: { payload: true },
    });
    const existingSet = new Set(existing.map((e) => e.payload));
    toInsert = links.filter((l) => !existingSet.has(l));
    duplicates = links.length - toInsert.length;
  }

  const rows = toInsert.flatMap((payload) =>
    Array.from({ length: copies }, () => ({ variantId, payload })),
  );

  // Insert in chunks so a large import doesn't build one huge statement.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await botDb.stockItem.createMany({ data: rows.slice(i, i + CHUNK) });
  }

  await audit({
    adminId: admin.id,
    action: "stock.import",
    entityType: "StockItem",
    metadata: { variantId, links: links.length, copies, created: rows.length, duplicates },
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
