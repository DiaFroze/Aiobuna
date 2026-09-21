"use server";

import { revalidatePath } from "next/cache";
import { botDb } from "@/lib/botDb";

export async function resetSalesDataAction() {
  try {
    // 1. Unlink stock items from old orders
    await botDb.stockItem.updateMany({
      where: { orderId: { not: null } },
      data: { orderId: null },
    });

    // 2. Delete all orders
    await botDb.botOrder.deleteMany({});

    // 3. Delete all test ad expenses
    await botDb.adExpense.deleteMany({});

    // 4. Update marker in BotSetting
    await botDb.botSetting.upsert({
      where: { key: "clean_slate_2026_09_22_applied" },
      create: {
        key: "clean_slate_2026_09_22_applied",
        valueRu: new Date().toISOString(),
        type: "text",
      },
      update: { valueRu: new Date().toISOString() },
    });

    revalidatePath("/admin/statistics");
    revalidatePath("/admin/bot-ads");
    revalidatePath("/admin");
    return { success: true };
  } catch (error) {
    console.error("[resetSalesDataAction] Failed:", error);
    return { success: false, error: String(error) };
  }
}
