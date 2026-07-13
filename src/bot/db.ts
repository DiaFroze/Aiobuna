// Prisma client for the bot's SQLite DB. Constructing it auto-loads `.env`
// (Prisma bundles dotenv), so BOT_DATABASE_URL / TELEGRAM_* become available.
import { PrismaClient } from "../generated/bot-client";

export const db = new PrismaClient();
