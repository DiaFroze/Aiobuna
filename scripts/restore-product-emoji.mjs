process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";
const db = new PrismaClient();

// Restore Product ID 8's premiumEmoji
await db.product.update({
  where: { id: 8 },
  data: {
    premiumEmoji: "5255920066171537833",
  },
});

console.log("✅ Restored premiumEmoji of Gemini AI Pro 18m to 5255920066171537833");
await db.$disconnect();
