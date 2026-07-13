// Upload product card images to Telegram and save file_ids to the bot database.
// Usage: node scripts/upload-cards.mjs
process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";
import fs from "fs";
import path from "path";

const db = new PrismaClient();
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8651675673:AAH558ilrigq11K7wPI8ejPWB5ntXnsh0To";
const ADMIN_CHAT = process.env.TELEGRAM_ADMIN_CHAT_ID || "7797972248";

const CARDS = [
  { productId: 8, file: "C:/Users/user/.gemini/antigravity/brain/c2b12eae-7bf0-4893-a6bc-2c9da200fb51/gemini_pro_card_1783920854651.jpg" },
  { productId: 9, file: "C:/Users/user/.gemini/antigravity/brain/c2b12eae-7bf0-4893-a6bc-2c9da200fb51/google_ai_pro_card_1783920892742.jpg" },
];

async function uploadPhoto(filePath) {
  const form = new FormData();
  form.append("chat_id", ADMIN_CHAT);
  form.append("photo", new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  form.append("caption", "📷 Product card upload");

  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram error: ${JSON.stringify(json)}`);
  // Get the largest photo size (last one)
  const photos = json.result.photo;
  const fileId = photos[photos.length - 1].file_id;

  // Delete the message to keep admin chat clean
  await fetch(`https://api.telegram.org/bot${TOKEN}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: ADMIN_CHAT, message_id: json.result.message_id }),
  }).catch(() => {});

  return fileId;
}

async function main() {
  for (const card of CARDS) {
    if (!fs.existsSync(card.file)) {
      console.log(`⚠️ File not found: ${card.file}`);
      continue;
    }
    console.log(`Uploading card for product #${card.productId}...`);
    const fileId = await uploadPhoto(card.file);
    await db.product.update({
      where: { id: card.productId },
      data: { bannerFileId: fileId },
    });
    console.log(`✅ Product #${card.productId} → fileId: ${fileId.slice(0, 40)}...`);
  }
  console.log("\n✅ All cards uploaded!");
}

main().catch(console.error).finally(() => db.$disconnect());
