import "server-only";
import { PrismaClient as BotPrismaClient } from "@/generated/bot-client";

// Second Prisma client: the SubHub BOT's SQLite database. Lets the admin panel
// read/write the bot's catalog (products, variants, settings, premium emoji).
const globalForBotDb = globalThis as unknown as { botDb?: BotPrismaClient };

export const botDb =
  globalForBotDb.botDb ??
  new BotPrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForBotDb.botDb = botDb;

export function botConfigured(): boolean {
  return Boolean(process.env.BOT_DATABASE_URL);
}
