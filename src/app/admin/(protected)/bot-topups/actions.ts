"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";
import { APPROVABLE_STATUSES } from "@/lib/domain/topup-approval";

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
  if (!topup || ["payme", "click", "stars"].includes(topup.method)) return;
  const won = await botDb.$transaction(async (tx) => {
    const claimed = await tx.topUp.updateMany({
      where: { id, status: { in: [...APPROVABLE_STATUSES] }, method: { notIn: ["payme", "click", "stars"] } },
      data: { status: "approved", externalId: "admin-panel", deliveredAt: null },
    });
    if (claimed.count !== 1) return false;
    await tx.botUser.update({ where: { id: topup.userId }, data: { balance: { increment: topup.amount } } });
    return true;
  });
  if (!won) return;
  await audit({
    adminId: admin.id,
    action: "bot.topup.approve",
    entityType: "BotTopUp",
    entityId: String(id),
    metadata: { amount: topup.amount },
  });
  // The bot poller notifies the user and fulfils any attached purchase.
  revalidatePath("/admin/bot-topups");
}

export async function rejectTopUpAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number(formData.get("id"));
  const topup = await botDb.topUp.findUnique({ where: { id }, include: { user: true } });
  if (!topup || ["payme", "click", "stars"].includes(topup.method)) return;
  const changed = await botDb.topUp.updateMany({
    where: { id, status: { in: [...APPROVABLE_STATUSES] }, method: { notIn: ["payme", "click", "stars"] } },
    data: { status: "rejected" },
  });
  if (changed.count !== 1) return;
  await audit({ adminId: admin.id, action: "bot.topup.reject", entityType: "BotTopUp", entityId: String(id) });
  await notifyUser(topup.user.tgId, `❌ Запрос на пополнение #${id} отклонён.`);
  revalidatePath("/admin/bot-topups");
}

/**
 * Create a pending Payme invoice for a chosen сум amount, for Payme sandbox
 * testing. Bypasses the bot's minimum-top-up rule so any amount can be used,
 * and prints the exact tiyin value to paste into the sandbox. Attached to the
 * admin's own bot user so tests never credit an arbitrary customer.
 */
export async function createPaymeTestInvoiceAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const sum = Math.round(Number(str(formData.get("amountSum")).replace(",", ".")));
  if (!Number.isFinite(sum) || sum <= 0) return;

  const adminTgId = process.env.TELEGRAM_ADMIN_CHAT_ID ?? "";
  const user = adminTgId ? await botDb.botUser.findUnique({ where: { tgId: adminTgId } }) : null;
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

/**
 * Reset a Payme test top-up back to "pending" so the SAME topup_id can be
 * reused across sandbox runs without reconfiguring the sandbox. Deletes its
 * PaymeTransaction and clears deliveredAt. Only explicitly marked, uncredited
 * test invoices are eligible; create a fresh invoice after a successful payment.
 */
export async function resetTestTopupAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number(formData.get("id"));
  const t = await botDb.topUp.findUnique({ where: { id } });
  if (!t || t.method !== "payme" || !t.note?.startsWith("payme-test by ")) return;
  if (t.status === "approved") throw new Error("Создайте новый тестовый счёт: оплаченные счета не сбрасываются.");

  await botDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PaymeTransaction" WHERE "topUpId" = ${id} FOR UPDATE`;
    const claim = await tx.topUp.updateMany({
      where: { id, status: { in: ["pending", "rejected"] }, note: { startsWith: "payme-test by " } },
      data: { status: "pending", deliveredAt: null, expiresAt: new Date(Date.now() + 60 * 60_000) },
    });
    if (claim.count !== 1) return;
    await tx.paymeTransaction.deleteMany({ where: { topUpId: id } });
  });
  await audit({ adminId: admin.id, action: "bot.payme.resettopup", entityType: "BotTopUp", entityId: String(id) });
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
  await botDb.$transaction(async (tx) => {
    const changed = await tx.botUser.updateMany({
      where: { id: user.id, ...(amount < 0 ? { balance: { gte: -amount } } : {}) },
      data: { balance: { increment: amount } },
    });
    if (changed.count !== 1) throw new Error("Недостаточно средств для списания");
    await tx.topUp.create({ data: { userId: user.id, amount, status: "approved", deliveredAt: new Date(), note: `manual by ${admin.email}` } });
  });
  await audit({
    adminId: admin.id,
    action: "bot.balance.manual",
    entityType: "BotUser",
    entityId: tgId,
    metadata: { amount },
  });
  await notifyUser(tgId, `💰 Баланс изменён администратором на ${amount > 0 ? "+" : ""}${amount.toLocaleString("ru-RU")} сум.`);
  revalidatePath("/admin/bot-topups");
}
