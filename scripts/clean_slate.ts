import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MARKER = "clean_slate_2026_09_22_applied";

/**
 * Resets historical test orders and test ad expenses to provide a clean slate
 * for production sales analytics.
 * Preserves users, catalog products/plans/variants, and ad links.
 */
export async function runCleanSlate(force = false) {
  try {
    if (!force) {
      const already = await prisma.botSetting.findUnique({ where: { key: MARKER } });
      if (already) {
        console.log("[clean_slate] Already applied previously — skipping.");
        return;
      }
    }

    console.log("[clean_slate] Starting clean slate reset...");

    // 1. Unlink stock items from old orders
    await prisma.stockItem.updateMany({
      where: { orderId: { not: null } },
      data: { orderId: null },
    });

    // 2. Delete all orders
    const deletedOrders = await prisma.botOrder.deleteMany({});
    console.log(`✓ Deleted ${deletedOrders.count} historical test orders from BotOrder.`);

    // 3. Delete all test ad expenses
    const deletedExpenses = await prisma.adExpense.deleteMany({});
    console.log(`✓ Deleted ${deletedExpenses.count} test expenses from AdExpense.`);

    // 4. Record marker in BotSetting
    await prisma.botSetting.upsert({
      where: { key: MARKER },
      create: { key: MARKER, valueRu: new Date().toISOString(), type: "text" },
      update: { valueRu: new Date().toISOString() },
    });

    console.log("✓ Store analytics reset successfully. Ready for real production sales!");
  } catch (err) {
    console.error("[clean_slate] Error resetting data:", err);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes("clean_slate")) {
  const force = process.argv.includes("--force");
  runCleanSlate(force)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[clean_slate] Handled error in clean slate:", err);
      process.exit(0);
    });
}
