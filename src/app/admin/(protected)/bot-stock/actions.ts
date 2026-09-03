"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";
import { parseStockPayload, serializeStockPayload } from "@/lib/domain/stock-payload";

/** Bulk-import links, accounts, or codes as stock items for a given variant. */
export async function importStockAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const variantId = Number(formData.get("variantId"));
  if (!variantId) return;

  let items: string[] = [];

  // 1. Structured JSON from the new StockUploader component
  const itemsJsonStr = String(formData.get("itemsJson") ?? "").trim();
  if (itemsJsonStr) {
    try {
      const parsed = JSON.parse(itemsJsonStr);
      if (Array.isArray(parsed)) {
        items = parsed
          .map((it) => (typeof it === "string" ? it : serializeStockPayload(it)))
          .filter((s) => s.trim().length > 0);
      }
    } catch {
      // Fall through
    }
  }

  // 2. Fallback to raw lines from textarea / legacy form
  if (items.length === 0) {
    const raw = String(formData.get("links") ?? formData.get("raw") ?? "").trim();
    if (raw) {
      items = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((line) => {
          const parsed = parseStockPayload(line);
          return serializeStockPayload(parsed);
        });
    }
  }

  if (items.length === 0) return;

  // How many stock items to create per item.
  const copies = Math.min(Math.max(Math.trunc(Number(formData.get("copies")) || 1), 1), 5000);
  const allowDuplicates = formData.get("allowDuplicates") === "on" || copies > 1;

  let toInsert = items;
  let duplicates = 0;
  if (!allowDuplicates) {
    const existing = await botDb.stockItem.findMany({
      where: { variantId, payload: { in: items } },
      select: { payload: true },
    });
    const existingSet = new Set(existing.map((e) => e.payload));
    toInsert = items.filter((l) => !existingSet.has(l));
    duplicates = items.length - toInsert.length;
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
    metadata: { variantId, items: items.length, copies, created: rows.length, duplicates },
  });

  // Notify users who requested "notify me when back in stock" for this variant.
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken && rows.length > 0) {
    const variant = await botDb.variant.findUnique({
      where: { id: variantId },
      include: { plan: { include: { product: true } } },
    });
    if (variant) {
      const productLabel = `${variant.plan.product.titleRu} — ${variant.titleRu}`;
      const alerts = await botDb.$queryRawUnsafe<{ tgId: string }[]>(
        `SELECT "tgId" FROM "StockAlert" WHERE "variantId" = $1`, variantId,
      ).catch(() => [] as { tgId: string }[]);
      if (alerts.length > 0) {
        const shopUrl = `https://t.me/Aiobunabot?start=shop`;
        for (const a of alerts) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: a.tgId,
              text: `✅ Товар снова в наличии!\n\n<b>${productLabel}</b>\n\nЖмите кнопку чтобы купить:`,
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: [[{ text: "🛍 Перейти в магазин", url: shopUrl }]] },
            }),
          }).catch(() => {});
        }
        await botDb.$executeRawUnsafe(`DELETE FROM "StockAlert" WHERE "variantId" = $1`, variantId).catch(() => {});
      }
    }
  }

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
