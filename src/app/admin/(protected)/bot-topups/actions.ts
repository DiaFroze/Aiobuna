"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}

async function notifyUser(tgId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token || !tgId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: tgId, text }),
  }).catch(() => {});
}

export async function approveTopUpAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number(formData.get("id"));
  const topup = await botDb.topUp.findUnique({ where: { id }, include: { user: true } });
  if (!topup || topup.status !== "pending") return;

  await botDb.$transaction([
    botDb.topUp.update({ where: { id }, data: { status: "approved" } }),
    botDb.botUser.update({ where: { id: topup.userId }, data: { balance: { increment: topup.amount } } }),
  ]);
  await audit({
    adminId: admin.id,
    action: "bot.topup.approve",
    entityType: "BotTopUp",
    entityId: String(id),
    metadata: { amount: topup.amount },
  });
  await notifyUser(topup.user.tgId, `✅ Ваш баланс пополнен на ${topup.amount.toFixed(2)} USDT. Спасибо!`);
  revalidatePath("/admin/bot-topups");
}

export async function rejectTopUpAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number(formData.get("id"));
  const topup = await botDb.topUp.findUnique({ where: { id }, include: { user: true } });
  if (!topup || topup.status !== "pending") return;

  await botDb.topUp.update({ where: { id }, data: { status: "rejected" } });
  await audit({ adminId: admin.id, action: "bot.topup.reject", entityType: "BotTopUp", entityId: String(id) });
  await notifyUser(topup.user.tgId, `❌ Запрос на пополнение #${id} отклонён.`);
  revalidatePath("/admin/bot-topups");
}

/**
 * Create a pending Payme invoice for a chosen сум amount, for Payme sandbox
 * testing. Bypasses the bot's minimum-top-up rule so any amount can be used,
 * and prints the exact tiyin value to paste into the sandbox. Attached to the
 * admin's own bot user (or any user, as a fallback) so it has an owner.
 */
export async function createPaymeTestInvoiceAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const sum = Math.round(Number(str(formData.get("amountSum")).replace(",", ".")));
  if (!Number.isFinite(sum) || sum <= 0) return;

  const adminTgId = process.env.TELEGRAM_ADMIN_CHAT_ID ?? "";
  const user =
    (adminTgId ? await botDb.botUser.findUnique({ where: { tgId: adminTgId } }) : null) ??
    (await botDb.botUser.findFirst());
  if (!user) return;

  await botDb.topUp.create({
    data: {
      userId: user.id,
      amount: sum,
      method: "payme",
      status: "pending",
      note: `payme-test by ${admin.email}`,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  revalidatePath("/admin/bot-topups");
}

/**
 * Reset the Payme merchant key back to PAYME_KEY (env) by clearing any key set
 * via a ChangePassword sandbox test. The ChangePassword test rotates the key
 * and stores the new one; when you then run other test groups the sandbox
 * authenticates with the original cabinet key again, so auth fails with -32504
 * until this override is cleared.
 */
export async function resetPaymeKeyAction() {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  await botDb.setting.deleteMany({ where: { key: "payme_password" } });
  await audit({ adminId: admin.id, action: "bot.payme.keyreset", entityType: "BotSetting", entityId: "payme_password" });
  revalidatePath("/admin/bot-topups");
}

/** Manually credit (or debit with a negative amount) a user's balance by tgId. */
export async function manualCreditAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const tgId = str(formData.get("tgId"));
  const amount = Number(str(formData.get("amount")).replace(",", "."));
  if (!tgId || !Number.isFinite(amount) || amount === 0) return;

  const user = await botDb.botUser.findUnique({ where: { tgId } });
  if (!user) return;
  await botDb.botUser.update({ where: { id: user.id }, data: { balance: { increment: amount } } });
  await botDb.topUp.create({
    data: { userId: user.id, amount, status: "approved", note: `manual by ${admin.email}` },
  });
  await audit({
    adminId: admin.id,
    action: "bot.balance.manual",
    entityType: "BotUser",
    entityId: tgId,
    metadata: { amount },
  });
  await notifyUser(tgId, `💰 Баланс изменён администратором на ${amount > 0 ? "+" : ""}${amount.toFixed(2)} USDT.`);
  revalidatePath("/admin/bot-topups");
}
