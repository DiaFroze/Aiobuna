process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";
const db = new PrismaClient();

// Update Product ID 10's premiumEmoji
await db.product.update({
  where: { id: 10 },
  data: {
    premiumEmoji: "5416081784641168838",
  },
});

console.log("✅ Updated premiumEmoji of Railway (ID=10) to 5416081784641168838");
await db.$disconnect();
