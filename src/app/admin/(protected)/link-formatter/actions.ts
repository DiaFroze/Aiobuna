"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

/** Add telegram user ID to list of allowed formatter users. */
export async function addFormatterUserAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const tgId = String(formData.get("tgId") ?? "").trim();
  if (!tgId) return;

  // Find user by tgId or create one so we can toggle the flag
  await botDb.botUser.upsert({
    where: { tgId },
    create: {
      tgId,
      firstName: "Добавлен вручную",
      isFormatterAllowed: true,
    },
    update: {
      isFormatterAllowed: true,
    },
  });

  await audit({
    adminId: admin.id,
    action: "bot.formatter.allow",
    entityType: "BotUser",
    entityId: tgId,
  });

  revalidatePath("/admin/link-formatter");
}

/** Remove telegram user ID from list of allowed formatter users. */
export async function removeFormatterUserAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const tgId = String(formData.get("tgId") ?? "").trim();
  if (!tgId) return;

  await botDb.botUser.update({
    where: { tgId },
    data: {
      isFormatterAllowed: false,
    },
  });

  await audit({
    adminId: admin.id,
    action: "bot.formatter.disallow",
    entityType: "BotUser",
    entityId: tgId,
  });

  revalidatePath("/admin/link-formatter");
}
