process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";
const db = new PrismaClient();

// Update Product ID 8's premiumEmoji
await db.product.update({
  where: { id: 8 },
  data: {
    premiumEmoji: "5222444124698853913",
  },
});

console.log("✅ Updated premiumEmoji of Gemini AI Pro 18m to 5222444124698853913");
await db.$disconnect();
