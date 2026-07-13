"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}

/**
 * Add a new required Telegram channel for mandatory subscription.
 */
export async function addRequiredChannelAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const name = str(formData.get("name"));
  const url = str(formData.get("url"));
  const chatId = str(formData.get("chatId"));

  if (!name || !url || !chatId) {
    throw new Error("Все поля обязательны для заполнения");
  }

  // Ensure chatId starts with -100 (which is required for Telegram channels)
  let formattedChatId = chatId;
  if (!formattedChatId.startsWith("-")) {
    formattedChatId = `-100${formattedChatId}`;
  } else if (formattedChatId.startsWith("-") && !formattedChatId.startsWith("-100")) {
    // If it starts with - but not -100, and is not a supergroup, keep as is or auto-prefix
    if (formattedChatId.length < 10) {
      formattedChatId = `-100${formattedChatId.slice(1)}`;
    }
  }

  const channel = await botDb.requiredChannel.create({
    data: {
      name,
      url,
      chatId: formattedChatId,
      isActive: true,
    },
  });

  await audit({
    adminId: admin.id,
    action: "bot.channel.create",
    entityType: "RequiredChannel",
    entityId: String(channel.id),
    metadata: { name, chatId: formattedChatId },
  });

  revalidatePath("/admin/bot-channels");
}

/**
 * Toggle active status of a required channel.
 */
export async function toggleRequiredChannelAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number(formData.get("id"));
  if (!id) return;

  const channel = await botDb.requiredChannel.findUnique({ where: { id } });
  if (channel) {
    await botDb.requiredChannel.update({
      where: { id },
      data: { isActive: !channel.isActive },
    });

    await audit({
      adminId: admin.id,
      action: "bot.channel.toggle",
      entityType: "RequiredChannel",
      entityId: String(id),
      metadata: { isActive: !channel.isActive },
    });
  }

  revalidatePath("/admin/bot-channels");
}

/**
 * Delete a required channel from config.
 */
export async function deleteRequiredChannelAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number(formData.get("id"));
  if (!id) return;

  await botDb.requiredChannel.delete({ where: { id } });

  await audit({
    adminId: admin.id,
    action: "bot.channel.delete",
    entityType: "RequiredChannel",
    entityId: String(id),
  });

  revalidatePath("/admin/bot-channels");
}
