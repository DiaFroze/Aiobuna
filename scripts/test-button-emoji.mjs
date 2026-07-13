const token = "7369389279:AAH7YwF9r-Gg9V_5YpW93gXk10w4yU3n-58"; // We can load it from .env
process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";

import { PrismaClient } from "../src/generated/bot-client/index.js";
const db = new PrismaClient();

// Let's get the token from setting or env
const envToken = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.TELEGRAM_ADMIN_CHAT_ID || "7797972248";

if (!envToken) {
  console.error("TELEGRAM_BOT_TOKEN is not set in env");
  process.exit(1);
}

const payload = {
  chat_id: Number(adminId),
  text: "Тест отображения premium emoji на кнопке ниже:",
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "<tg-emoji emoji-id=\"5222444124698853913\">🔖</tg-emoji> 1490 шт.",
          callback_data: "test_btn"
        }
      ]
    ]
  }
};

const res = await fetch(`https://api.telegram.org/bot${envToken}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const data = await res.json();
console.log(data);
await db.$disconnect();
