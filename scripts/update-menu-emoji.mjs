process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";
const db = new PrismaClient();

await db.setting.upsert({
  where: { key: "menu_premium_emoji" },
  create: { key: "menu_premium_emoji", valueRu: "5222444124698853913" },
  update: { valueRu: "5222444124698853913" },
});

console.log("✅ menu_premium_emoji updated to 5222444124698853913");
await db.$disconnect();
