process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";

const db = new PrismaClient();

async function main() {
  // 1. Clear all stock items
  const deleted1 = await db.stockItem.deleteMany({});
  console.log(`Deleted ${deleted1.count} stock items`);

  // 2. Clear all orders
  const deleted2 = await db.botOrder.deleteMany({});
  console.log(`Deleted ${deleted2.count} orders`);

  // 3. Reset user balances
  const updated = await db.botUser.updateMany({ data: { balance: 0, refRewardClaimed: false } });
  console.log(`Reset ${updated.count} user balances`);

  // 4. Set referral reward settings
  const settings = [
    { key: "ref_reward_enabled", valueRu: "1" },
    { key: "ref_reward_threshold", valueRu: "17" },
    { key: "ref_reward_variant", valueRu: "8" },
  ];

  for (const s of settings) {
    await db.setting.upsert({
      where: { key: s.key },
      create: { key: s.key, valueRu: s.valueRu },
      update: { valueRu: s.valueRu },
    });
    console.log(`Setting ${s.key} = ${s.valueRu}`);
  }

  console.log("\n✅ Done! Database reset + referral deal configured (17 invites = free Gemini Pro 18m)");
}

main().catch(console.error).finally(() => db.$disconnect());
