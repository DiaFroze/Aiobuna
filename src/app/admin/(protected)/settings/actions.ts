"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { audit } from "@/lib/security/audit";
import { botDb } from "@/lib/botDb";
import { setGlobalSettings, type GlobalSettings } from "@/lib/services/settings";

export async function saveSettingsAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const patch: Partial<GlobalSettings> = {
    defaultRoundingMode: String(formData.get("defaultRoundingMode")) as GlobalSettings["defaultRoundingMode"],
  };
  await setGlobalSettings(patch);

  await audit({ adminId: admin.id, action: "settings.update", entityType: "Setting", metadata: patch });
  revalidatePath("/admin/settings");
}

const RESET_CONFIRM_PHRASE = "ОБНУЛИТЬ";

/**
 * Wipes all revenue/sales HISTORY (orders, method purchases, promo
 * redemptions, top-up requests) and the counters/flags derived from it.
 * Deliberately leaves untouched: BotUser.balance (users' own money),
 * StockItem/Product/Plan/Variant (catalog & stock), RequiredChannel,
 * PromoCode definitions (only the usedCount counter resets), admins.
 * Gated behind ADMINS_MANAGE (superadmin only) + a typed confirmation
 * phrase, since this is a one-way, irreversible bulk delete.
 */
export async function resetSalesStatsAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.ADMINS_MANAGE);
  const confirm = String(formData.get("confirm") ?? "").trim();
  if (confirm !== RESET_CONFIRM_PHRASE) {
    throw new Error(`Неверное слово подтверждения. Введите ровно: ${RESET_CONFIRM_PHRASE}`);
  }

  const [orders, purchases, redemptions, topups] = await Promise.all([
    botDb.botOrder.deleteMany({}),
    botDb.methodPurchase.deleteMany({}),
    botDb.promoRedemption.deleteMany({}),
    botDb.topUp.deleteMany({}),
  ]);
  await botDb.promoCode.updateMany({ data: { usedCount: 0 } });
  await botDb.botUser.updateMany({ data: { refRewardClaimed: false } });

  const counts = {
    orders: orders.count,
    methodPurchases: purchases.count,
    promoRedemptions: redemptions.count,
    topups: topups.count,
  };
  await audit({ adminId: admin.id, action: "bot.stats.reset", entityType: "BotOrder", metadata: counts });
  revalidatePath("/admin");
  revalidatePath("/admin/bot-users");
  revalidatePath("/admin/bot-topups");
  revalidatePath("/admin/settings");
}
