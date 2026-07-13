"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

/**
 * Deliver manual order from the admin panel.
 */
export async function deliverManualOrderAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const orderId = Number(formData.get("orderId"));
  const payload = String(formData.get("payload") ?? "").trim();

  if (!orderId || !payload) {
    throw new Error("Неверный ID заказа или пустое содержимое");
  }

  // Find the order and user
  const order = await botDb.botOrder.findUnique({
    where: { id: orderId },
    include: { user: true },
  });

  if (!order) {
    throw new Error("Заказ не найден");
  }

  if (order.status !== "awaiting_delivery") {
    throw new Error("Этот заказ уже выдан или отменен");
  }

  // Update order status and payload
  await botDb.botOrder.update({
    where: { id: orderId },
    data: {
      payload,
      status: "delivered",
    },
  });

  // Log audit
  await audit({
    adminId: admin.id,
    action: "bot.order.deliver",
    entityType: "BotOrder",
    entityId: String(orderId),
    metadata: { buyerTgId: order.user.tgId },
  });

  // Notify the user via Telegram Bot API
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    const text =
      `🎁 <b>Ваш товар выдан администратором!</b>\n\n` +
      `<b>Заказ:</b> #${orderId}\n` +
      `<b>Товар:</b> ${order.titleRu}\n\n` +
      `<b>Данные:</b>\n<code>${payload}</code>`;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Number(order.user.tgId),
        text,
        parse_mode: "HTML",
      }),
    }).catch((e) => console.error("[admin] failed to notify user:", e));
  }

  revalidatePath("/admin/bot-verify");
}
