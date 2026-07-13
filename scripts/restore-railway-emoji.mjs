process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";
const db = new PrismaClient();

// Restore Railway (ID=10) premiumEmoji back to 5413879192267805083
await db.product.update({
  where: { id: 10 },
  data: {
    premiumEmoji: "5413879192267805083",
  },
});

console.log("✅ Restored Railway (ID=10) premiumEmoji to 5413879192267805083");
await db.$disconnect();
