import { db } from "../src/bot/db";

async function run() {
  const deleted = await db.botOrder.deleteMany({});
  console.log(`Deleted ${deleted.count} orders.`);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
