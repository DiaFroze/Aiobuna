"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}
function num(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Set (create or update) a per-user custom price for a variant.
 * The user can be picked from the dropdown (userId) OR entered by Telegram ID
 * (tgId) — handy when the buyer isn't in the list yet. An unknown tgId creates a
 * placeholder BotUser so the price applies the moment they open the bot.
 */
export async function setUserPriceAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const selectedUserId = Number(formData.get("userId"));
  const tgIdRaw = str(formData.get("tgId")).replace(/[^\d]/g, "");
  const variantId = Number(formData.get("variantId"));
  const priceUzs = Math.round(num(formData.get("priceUzs")));
  const label = str(formData.get("label"));
  if (!variantId || priceUzs < 0) redirect("/admin/bot-vip-prices?error=missing");

  const variant = await botDb.variant.findUnique({ where: { id: variantId } });
  if (!variant) redirect("/admin/bot-vip-prices?error=missing");

  // Resolve the target user. Typed Telegram ID wins over the dropdown selection.
  let user;
  if (tgIdRaw) {
    user = await botDb.botUser.upsert({
      where: { tgId: tgIdRaw },
      create: { tgId: tgIdRaw },
      update: {},
    });
  } else if (selectedUserId) {
    user = await botDb.botUser.findUnique({ where: { id: selectedUserId } });
  }
  if (!user) redirect("/admin/bot-vip-prices?error=nouser");

  await botDb.userVariantPrice.upsert({
    where: { userId_variantId: { userId: user.id, variantId } },
    create: { userId: user.id, variantId, priceUzs, label },
    update: { priceUzs, label },
  });

  await audit({
    adminId: admin.id,
    action: "bot.userprice.set",
    entityType: "UserVariantPrice",
    entityId: `${user.id}:${variantId}`,
    metadata: { priceUzs, label, tgId: user.tgId },
  });
  revalidatePath("/admin/bot-vip-prices");
  redirect("/admin/bot-vip-prices?ok=1");
}

/** Remove a per-user custom price (falls back to the normal variant price). */
export async function deleteUserPriceAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  const row = await botDb.userVariantPrice.findUnique({ where: { id } });
  if (!row) return;
  await botDb.userVariantPrice.delete({ where: { id } });
  await audit({
    adminId: admin.id,
    action: "bot.userprice.delete",
    entityType: "UserVariantPrice",
    entityId: `${row.userId}:${row.variantId}`,
  });
  revalidatePath("/admin/bot-vip-prices");
}
