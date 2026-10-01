// A single amount registry for AI OBUNA and T STARS. Fail closed on outages.
import { randomUUID } from "node:crypto";

export function effectiveOperationTime(text: string, parsed: Date, messageDate: Date): Date {
  // Some bank texts omit seconds. Use the original Telegram timestamp only
  // within the same minute, never a later retry or catch-up time.
  const precise = /\b\d{2}:\d{2}:\d{2}\b/.test(text);
  return !precise && Math.floor(parsed.getTime() / 60000) === Math.floor(messageDate.getTime() / 60000)
    ? messageDate : parsed;
}

function configuration() {
  const url = (process.env.CARD_COORDINATOR_URL || "").replace(/\/$/, "");
  const secret = process.env.CARD_COORDINATOR_SECRET || "";
  if (!url) return null;
  if (!url.startsWith("https://") || secret.length < 32) {
    throw new Error("Shared card coordinator requires HTTPS and a 32-character secret");
  }
  return { url, secret };
}

async function call(path: string, body: unknown) {
  const config = configuration();
  if (!config) return null;
  const response = await fetch(config.url + "/api/card-bridge" + path, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.secret },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Shared card coordinator unavailable (" + response.status + ")");
  return response.json();
}

export async function reserveSharedAmount(baseAmount: number, cardLast4: string, ttlSeconds: number) {
  const data = await call("/reservations", { reference: randomUUID(), base_amount: baseAmount,
    card_last4: cardLast4, ttl_seconds: ttlSeconds });
  if (!data) return null;
  if (!Number.isSafeInteger(data.total_amount) || data.total_amount <= baseAmount) {
    throw new Error("Invalid shared card amount");
  }
  return { extraAmount: data.total_amount - baseAmount, totalAmount: data.total_amount };
}

export async function forwardSharedDeposit(chatId: string, messageId: number, amount: number, cardLast4: string, operationTime: Date) {
  return call("/deposits", {notification_id: `${chatId}:${messageId}`, amount,
    card_last4: cardLast4, operation_at: operationTime.toISOString()});
}
