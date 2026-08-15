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

/** Create or update a bot Setting row (text shown in the Telegram bot). */
export async function upsertBotSettingAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const key = str(formData.get("key"));
  if (!key) redirect("/admin/bot-settings?error=missing");

  const data = {
    valueRu: str(formData.get("valueRu")),
    valueUz: str(formData.get("valueUz")),
    fileId: str(formData.get("fileId")) || null,
    type: str(formData.get("type")) || "text",
  };

  await botDb.setting.upsert({
    where: { key },
    create: { key, ...data },
    update: data,
  });

  await audit({
    adminId: admin.id,
    action: "bot.setting.upsert",
    entityType: "BotSetting",
    entityId: key,
  });
  revalidatePath("/admin/bot-settings");
}

/**
 * Save the bot's main-menu config in one form: store name, header emoji,
 * Premium Emoji code (custom_emoji_id, rendered in the header text), tagline and
 * support text. Stored as individual Setting rows the bot reads.
 */
export async function saveMenuConfigAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const map: Record<string, string> = {
    store_name: str(formData.get("store_name")),
    menu_emoji: str(formData.get("menu_emoji")) || "🛍",
    menu_premium_emoji: str(formData.get("menu_premium_emoji")),
    menu_tagline: str(formData.get("menu_tagline")),
    support: str(formData.get("support")),
  };
  for (const [key, valueRu] of Object.entries(map)) {
    await botDb.setting.upsert({
      where: { key },
      create: { key, valueRu, type: "text" },
      update: { valueRu },
    });
  }
  await audit({ adminId: admin.id, action: "bot.menu.config", entityType: "BotSetting", entityId: "menu" });
  revalidatePath("/admin/bot-settings");
}

export async function toggleMaintenanceModeAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const enable = formData.get("enable") === "1";
  await botDb.setting.upsert({
    where: { key: "maintenance_mode" },
    create: { key: "maintenance_mode", valueRu: enable ? "1" : "0", type: "text" },
    update: { valueRu: enable ? "1" : "0" },
  });
  await audit({
    adminId: admin.id,
    action: enable ? "bot.maintenance.on" : "bot.maintenance.off",
    entityType: "BotSetting",
    entityId: "maintenance_mode",
  });
  revalidatePath("/admin/bot-settings");
}

export async function deleteBotSettingAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const key = str(formData.get("key"));
  await botDb.setting.delete({ where: { key } });
  await audit({
    adminId: admin.id,
    action: "bot.setting.delete",
    entityType: "BotSetting",
    entityId: key,
  });
  revalidatePath("/admin/bot-settings");
}
