// One-time deploy maintenance, run on Railway start AFTER `prisma db push` and
// BEFORE the bot. Guarded by a marker row in BotSetting so it runs exactly once
// even across restarts/redeploys. Never throws (always exits 0) so it can't keep
// the bot from starting.
//
// Current task: reset the admin panel — delete every admin, create ONE new
// superadmin with a strong random password, and DM the credentials to the admin
// Telegram chat (no secrets in the repo, no external DB access needed).
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const MARKER = "admin_reset_v1_done"; // bump to _v2 to run a fresh reset later

function genPassword(len = 20) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_";
  const buf = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

async function sendToAdmin(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chat) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
  });
  return res.ok;
}

const prisma = new PrismaClient();
try {
  const already = await prisma.botSetting.findUnique({ where: { key: MARKER } });
  if (already) {
    console.log("[deploy-once] admin reset already applied — skipping.");
  } else {
    const role = await prisma.role.findUnique({ where: { key: "superadmin" } });
    if (!role) {
      console.error("[deploy-once] superadmin role missing — skipping reset (no marker written).");
    } else {
      const email = `admin_${randomBytes(4).toString("hex")}@sb.eu`;
      const password = genPassword();
      const passwordHash = await bcrypt.hash(password, 12);

      const fresh = await prisma.admin.upsert({
        where: { email },
        create: { email, name: email.split("@")[0], passwordHash, roleId: role.id, isActive: true },
        update: { passwordHash, roleId: role.id, isActive: true },
      });
      const del = await prisma.admin.deleteMany({ where: { id: { not: fresh.id } } });

      // Mark as done only after the reset actually succeeded.
      await prisma.botSetting.upsert({
        where: { key: MARKER },
        create: { key: MARKER, valueRu: new Date().toISOString(), type: "text" },
        update: { valueRu: new Date().toISOString() },
      });

      const msg =
        `🔐 <b>Админ-панель обновлена</b>\n\n` +
        `Удалено прежних админов: <b>${del.count}</b>\n\n` +
        `Новый вход:\n` +
        `Логин: <code>${email}</code>\n` +
        `Пароль: <code>${password}</code>\n\n` +
        `⚠️ Сохраните это сообщение — пароль больше нигде не хранится.`;
      const sent = await sendToAdmin(msg);
      console.log(`[deploy-once] admin reset done: deleted ${del.count}, tg_sent=${sent}, login=${email}`);
      if (!sent) console.log(`[deploy-once] (Telegram not sent) login=${email} password=${password}`);
    }
  }
} catch (e) {
  console.error("[deploy-once] error (ignored):", e?.message ?? e);
} finally {
  await prisma.$disconnect();
}
