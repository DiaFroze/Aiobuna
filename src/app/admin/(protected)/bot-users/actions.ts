"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

/**
 * Adjust the balance of a bot user (add or subtract money).
 */
export async function adjustUserBalanceAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const userId = Number(formData.get("userId"));
  const amount = Number(formData.get("amount")); // positive to add, negative to subtract
  
  if (!userId || isNaN(amount) || amount === 0) {
    throw new Error("Неверные параметры начисления");
  }

  const user = await botDb.botUser.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error("Пользователь бота не найден");
  }

  // Calculate new balance, preventing negative balance
  const newBalance = Math.max(0, user.balance + amount);

  await botDb.botUser.update({
    where: { id: userId },
    data: {
      balance: newBalance,
    },
  });

  // Log audit
  await audit({
    adminId: admin.id,
    action: amount > 0 ? "bot.user.balance.credit" : "bot.user.balance.debit",
    entityType: "BotUser",
    entityId: user.tgId,
    metadata: {
      adjustment: amount,
      oldBalance: user.balance,
      newBalance,
    },
  });

  // Notify the user via Telegram if possible
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    const text = amount > 0
      ? `👛 <b>Баланс пополнен администратором на +${amount.toLocaleString()} сум!</b>\n\nТекущий баланс: <b>${newBalance.toLocaleString()} сум</b>`
      : `👛 <b>Баланс изменен администратором на ${amount.toLocaleString()} сум.</b>\n\nТекущий баланс: <b>${newBalance.toLocaleString()} сум</b>`;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Number(user.tgId),
        text,
        parse_mode: "HTML",
      }),
    }).catch(() => {});
  }

  revalidatePath("/admin/bot-users");
}
