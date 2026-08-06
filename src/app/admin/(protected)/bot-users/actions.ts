"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

/**
 * Adjust the balance of a bot user (add or subtract money).
 */
export async function creditUserBalanceAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const userId = Number(formData.get("userId"));
  const amount = Math.abs(Number(formData.get("amount")));
  
  if (!userId || isNaN(amount) || amount === 0) {
    throw new Error("Неверные параметры начисления");
  }

  const user = await botDb.botUser.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error("Пользователь бота не найден");
  }

  const newBalance = user.balance + amount;

  await botDb.botUser.update({
    where: { id: userId },
    data: { balance: newBalance },
  });

  await audit({
    adminId: admin.id,
    action: "bot.user.balance.credit",
    entityType: "BotUser",
    entityId: user.tgId,
    metadata: {
      adjustment: amount,
      oldBalance: user.balance,
      newBalance,
    },
  });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    const text = `👛 <b>Баланс пополнен администратором на +${amount.toLocaleString()} сум!</b>\n\nТекущий баланс: <b>${newBalance.toLocaleString()} сум</b>`;
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

export async function debitUserBalanceAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const userId = Number(formData.get("userId"));
  const amount = Math.abs(Number(formData.get("amount")));
  
  if (!userId || isNaN(amount) || amount === 0) {
    throw new Error("Неверные параметры списания");
  }

  const user = await botDb.botUser.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error("Пользователь бота не найден");
  }

  const newBalance = Math.max(0, user.balance - amount);

  await botDb.botUser.update({
    where: { id: userId },
    data: { balance: newBalance },
  });

  await audit({
    adminId: admin.id,
    action: "bot.user.balance.debit",
    entityType: "BotUser",
    entityId: user.tgId,
    metadata: {
      adjustment: -amount,
      oldBalance: user.balance,
      newBalance,
    },
  });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    const text = `👛 <b>Баланс изменен администратором на -${amount.toLocaleString()} сум.</b>\n\nТекущий баланс: <b>${newBalance.toLocaleString()} сум</b>`;
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

/**
 * Add (or subtract) manual referrals to a bot user. Counts toward the referral
 * reward the same as real invited users. Negative amount subtracts.
 */
export async function addReferralsAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const userId = Number(formData.get("userId"));
  const amount = Math.trunc(Number(formData.get("amount")));

  if (!userId || !Number.isFinite(amount) || amount === 0) {
    throw new Error("Неверные параметры начисления рефералов");
  }

  const user = await botDb.botUser.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error("Пользователь бота не найден");
  }

  const newBonus = Math.max(0, (user.bonusReferrals ?? 0) + amount);

  await botDb.botUser.update({
    where: { id: userId },
    data: { bonusReferrals: newBonus },
  });

  await audit({
    adminId: admin.id,
    action: "bot.user.referrals.add",
    entityType: "BotUser",
    entityId: user.tgId,
    metadata: { adjustment: amount, oldBonus: user.bonusReferrals ?? 0, newBonus },
  });

  revalidatePath("/admin/bot-users");
}
