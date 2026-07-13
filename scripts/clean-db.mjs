import { PrismaClient as BotClient } from "../src/generated/bot-client/index.js";
import { PrismaClient as MainClient } from "@prisma/client";

// Ensure DB URLs are set
process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";

const botDb = new BotClient();
const mainDb = new MainClient();

async function cleanHistory() {
  console.log("🧹 Wiping transaction logs and history tables...");

  // 1. Wipe SQLite Bot database history
  // Delete all orders
  const orders = await botDb.botOrder.deleteMany({});
  console.log(`- Deleted ${orders.count} bot orders`);

  // Delete all topups
  const topups = await botDb.topUp.deleteMany({});
  console.log(`- Deleted ${topups.count} topups`);

  // Reset all user balances to 0
  const users = await botDb.botUser.updateMany({
    data: {
      balance: 0,
    },
  });
  console.log(`- Reset balances for ${users.count} bot users`);

  // 2. Wipe main Postgres/SQLite database history
  // Delete audit logs
  const audits = await mainDb.auditLog.deleteMany({});
  console.log(`- Deleted ${audits.count} audit logs`);

  console.log("✅ Wiped transaction history. Admins, API sources, Products, Plans, and Variants are preserved.");
}

cleanHistory()
  .catch(console.error)
  .finally(async () => {
    await botDb.$disconnect();
    await mainDb.$disconnect();
  });
