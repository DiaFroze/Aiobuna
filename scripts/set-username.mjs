process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";
const db = new PrismaClient();
await db.setting.upsert({
  where: { key: "support_username" },
  create: { key: "support_username", valueRu: "Aiobuna_support" },
  update: { valueRu: "Aiobuna_support" },
});
console.log("✅ support_username → Aiobuna_support");
await db.$disconnect();
