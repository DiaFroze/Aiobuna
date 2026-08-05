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

/** Create a promo code (balance top-up coupon). Code is stored UPPERCASE. */
export async function createPromoAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const code = str(formData.get("code")).toUpperCase();
  const amountUzs = Math.round(num(formData.get("amountUzs")));
  if (!code || amountUzs <= 0) redirect("/admin/bot-promo-codes?error=missing");

  const existing = await botDb.promoCode.findUnique({ where: { code } });
  if (existing) redirect("/admin/bot-promo-codes?error=duplicate");

  const expiresRaw = str(formData.get("expiresAt"));
  const expiresAt = expiresRaw ? new Date(expiresRaw) : null;

  await botDb.promoCode.create({
    data: {
      code,
      amountUzs,
      maxUses: Math.max(0, Math.round(num(formData.get("maxUses")))),
      perUserLimit: Math.max(0, Math.round(num(formData.get("perUserLimit")))),
      expiresAt: expiresAt && !isNaN(expiresAt.getTime()) ? expiresAt : null,
      note: str(formData.get("note")),
      isActive: true,
    },
  });

  await audit({
    adminId: admin.id,
    action: "bot.promo.create",
    entityType: "PromoCode",
    entityId: code,
    metadata: { amountUzs },
  });
  revalidatePath("/admin/bot-promo-codes");
  redirect("/admin/bot-promo-codes?ok=1");
}

/** Toggle a promo code active/inactive. */
export async function togglePromoAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number(formData.get("id"));
  const p = await botDb.promoCode.findUnique({ where: { id } });
  if (!p) return;
  await botDb.promoCode.update({ where: { id }, data: { isActive: !p.isActive } });
  await audit({
    adminId: admin.id,
    action: "bot.promo.toggle",
    entityType: "PromoCode",
    entityId: p.code,
    metadata: { isActive: !p.isActive },
  });
  revalidatePath("/admin/bot-promo-codes");
}

/** Delete a promo code (its redemption history cascades). */
export async function deletePromoAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number(formData.get("id"));
  const p = await botDb.promoCode.findUnique({ where: { id } });
  if (!p) return;
  await botDb.promoCode.delete({ where: { id } });
  await audit({
    adminId: admin.id,
    action: "bot.promo.delete",
    entityType: "PromoCode",
    entityId: p.code,
  });
  revalidatePath("/admin/bot-promo-codes");
}
