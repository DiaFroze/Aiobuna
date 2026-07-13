import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { redactSecrets } from "../security/crypto";

// Telegram admin notifications. If no token configured -> no-op (logged only).
// Every notification is also persisted to the Notification table.

export type NotificationType =
  | "order.paid"
  | "order.delivered"
  | "order.failed"
  | "price.changed"
  | "content.changed"
  | "supplier.down"
  | "supplier.low_balance"
  | "candidate.new"
  | "product.out_of_stock"
  | "profit.daily";

export async function notifyAdmin(params: {
  type: NotificationType;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const token = env.telegramToken();
  const chatId = env.telegramChatId();

  await prisma.notification.create({
    data: {
      channel: token && chatId ? "TELEGRAM" : "INTERNAL",
      type: params.type,
      title: params.title,
      body: params.body,
      payload: (params.payload ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });

  if (!token || !chatId) {
    // No-op transport in dev; never throws.
    console.info(`[notify:${params.type}] ${params.title} — ${params.body}`);
    return;
  }

  try {
    const text = `*${params.title}*\n${params.body}`;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (e) {
    console.error("[notify] telegram failed:", redactSecrets(String(e)));
  }
}
