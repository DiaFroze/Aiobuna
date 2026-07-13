process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";
const db = new PrismaClient();
const products = await db.product.findMany({});
for (const p of products) {
  console.log(`Product: ID=${p.id}, titleRu=${p.titleRu}, emoji=${p.emoji}, premiumEmoji=${p.premiumEmoji}`);
}
await db.$disconnect();
