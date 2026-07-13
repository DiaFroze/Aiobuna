process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";
const db = new PrismaClient();
const settings = await db.setting.findMany();
console.log(settings);
await db.$disconnect();
