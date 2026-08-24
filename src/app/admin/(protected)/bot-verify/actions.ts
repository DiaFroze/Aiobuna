"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";
import { closeDeliveryPatch } from "@/lib/domain/premium-delivery";

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

  // Compare-and-set, not update-by-id: the check above can be passed by two
  // admins at once (or a double-submitted form), and only the caller whose
  // UPDATE actually changes a row may deliver.
  //
  // deliveryState is closed here too. Leaving it behind was a real double-
  // delivery path: an order delivered from this panel kept deliveryState =
  // "PAID", so it still counted as pending in /health AND /give would happily
  // hand the goods over a second time.
  const claimed = await botDb.botOrder.updateMany({
    where: { id: orderId, status: "awaiting_delivery" },
    data: { payload, ...closeDeliveryPatch(order) },
  });

  if (claimed.count !== 1) {
    throw new Error("Этот заказ уже выдан или отменен");
  }

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
