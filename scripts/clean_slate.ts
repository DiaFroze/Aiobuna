import { db } from "../src/bot/db";

/**
 * Resets historical test orders and test ad expenses to provide a clean slate
 * for production sales analytics.
 * Preserves users, catalog products/plans/variants, and ad links.
 */
async function main() {
  console.log("Starting clean slate reset...");

  const orders = await db.botOrder.deleteMany({});
  console.log(`✓ Deleted ${orders.count} historical test orders from BotOrder.`);

  const expenses = await db.adExpense.deleteMany({});
  console.log(`✓ Deleted ${expenses.count} test expenses from AdExpense.`);

  console.log("✓ Store analytics reset successfully. Ready for real production sales!");
}

main()
  .catch((err) => {
    console.error("Failed to reset sales data:", err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
