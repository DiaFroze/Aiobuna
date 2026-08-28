// One-time audit: find referral/gift orders for suspected fraud accounts
// Usage: npx tsx --env-file=.env scripts/audit_free_orders.ts
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
} catch { /* .env optional */ }

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const USERNAMES = process.argv.slice(2);

async function sendTg(text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).then((r) => r.json()).then((r: unknown) => {
    if (!(r as { ok: boolean }).ok) console.error("Telegram error:", r);
  });
  // small delay to avoid flood
  await new Promise((r) => setTimeout(r, 500));
}

async function run() {
  if (!BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN not set in .env");
    process.exit(1);
  }

  for (const username of USERNAMES) {
    const user = await prisma.botUser.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
    });

    if (!user) {
      await sendTg(`❌ Пользователь @${username} не найден в базе.`);
      continue;
    }

    // Count ALL referrals this user claimed
    const totalRefs = await prisma.botUser.count({ where: { referredBy: user.tgId } });

    // All free (referral) orders
    const freeOrders = await prisma.botOrder.findMany({
      where: {
        userId: user.id,
        OR: [{ source: "referral" }, { priceUsdt: 0 }],
        status: { in: ["delivered", "awaiting_delivery"] },
      },
      orderBy: { id: "asc" },
    });

    const header =
      `👤 <b>${user.firstName ?? "—"}</b> @${user.username ?? "—"}\n` +
      `ID: <code>${user.tgId}</code>\n` +
      `Приглашённых: <b>${totalRefs}</b>   Бонус: <b>${user.bonusReferrals ?? 0}</b>   Потрачено: <b>${user.spentReferrals ?? 0}</b>\n` +
      `Бесплатных заказов: <b>${freeOrders.length}</b>\n`;

    if (freeOrders.length === 0) {
      await sendTg(header + "\nБесплатных заказов нет.");
      continue;
    }

    await sendTg(header);

    // Send orders in chunks of 5
    const CHUNK = 5;
    for (let i = 0; i < freeOrders.length; i += CHUNK) {
      const chunk = freeOrders.slice(i, i + CHUNK);
      const lines = chunk.map((o) =>
        `#${o.id} · ${o.titleRu}\n<code>${o.payload}</code>`
      ).join("\n\n");
      await sendTg(lines);
    }
  }

  console.log("Done. Check your Telegram.");
  await prisma.$disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
