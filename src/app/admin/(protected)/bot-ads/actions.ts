"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";
import { validateAdCode } from "@/lib/domain/ad-attribution";

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}

function num(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").replace(",", ".").replace(/\s/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

const DEFAULT_USD_UZS_RATE = Number(process.env.USDT_UZS_RATE ?? 12600);

/**
 * Creates a new advertising tracking link.
 */
export async function createAdLinkAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.LINKS_MANAGE);

  const name = str(formData.get("name"));
  const rawCode = str(formData.get("code"));
  const platform = str(formData.get("platform")) || "Meta";
  const campaignName = str(formData.get("campaignName")) || null;
  const adGroupName = str(formData.get("adGroupName")) || null;
  const adName = str(formData.get("adName")) || null;
  const creativeUrl = str(formData.get("creativeUrl")) || null;
  const note = str(formData.get("note")) || null;
  const budget = Math.max(0, num(formData.get("budget")));
  const rawStart = str(formData.get("startDate"));
  const rawEnd = str(formData.get("endDate"));
  const isActive = formData.get("isActive") !== "off";

  if (!name || !rawCode) {
    redirect("/admin/bot-ads?error=missing_fields");
  }

  const validation = validateAdCode(rawCode);
  if (!validation.valid) {
    redirect(`/admin/bot-ads?error=invalid_code&reason=${validation.reason ?? "invalid"}`);
  }

  const code = validation.code;

  // Collision check: prevent duplicate codes
  const existing = await botDb.adLink.findUnique({ where: { code } });
  if (existing) {
    redirect(`/admin/bot-ads?error=collision&code=${encodeURIComponent(code)}`);
  }

  const startDate = rawStart ? new Date(rawStart) : new Date();
  const endDate = rawEnd ? new Date(rawEnd) : null;

  const created = await botDb.adLink.create({
    data: {
      name,
      code,
      platform,
      campaignName,
      adGroupName,
      adName,
      creativeUrl,
      note,
      budget,
      startDate: !isNaN(startDate.getTime()) ? startDate : new Date(),
      endDate: endDate && !isNaN(endDate.getTime()) ? endDate : null,
      isActive,
    },
  });

  await audit({
    adminId: admin.id,
    action: "bot.ad_link.create",
    entityType: "AdLink",
    entityId: String(created.id),
    metadata: { code, name, platform },
  });

  revalidatePath("/admin/bot-ads");
  redirect("/admin/bot-ads?ok=created");
}

/**
 * Toggles an advertising link active/disabled state without deleting history.
 */
export async function toggleAdLinkAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.LINKS_MANAGE);
  const id = Number(formData.get("id"));
  const returnTo = str(formData.get("returnTo")) || "/admin/bot-ads";

  const link = await botDb.adLink.findUnique({ where: { id } });
  if (!link) {
    redirect(`${returnTo}?error=not_found`);
  }

  const updated = await botDb.adLink.update({
    where: { id },
    data: { isActive: !link.isActive },
  });

  await audit({
    adminId: admin.id,
    action: "bot.ad_link.toggle",
    entityType: "AdLink",
    entityId: String(id),
    metadata: { isActive: updated.isActive, code: updated.code },
  });

  revalidatePath("/admin/bot-ads");
  revalidatePath(`/admin/bot-ads/${id}`);
  redirect(`${returnTo}?ok=toggled`);
}

/**
 * Safely deletes an advertising link ONLY if it has zero associated clicks, touches, users or orders.
 * Otherwise refuses deletion to preserve historical marketing analytics.
 */
export async function deleteAdLinkAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.LINKS_MANAGE);
  const id = Number(formData.get("id"));

  const link = await botDb.adLink.findUnique({ where: { id } });
  if (!link) {
    redirect("/admin/bot-ads?error=not_found");
  }

  const [clicksCount, touchesCount, ordersCount, firstUsersCount, lastUsersCount] =
    await Promise.all([
      botDb.adClick.count({ where: { adLinkId: id } }),
      botDb.adStartEvent.count({ where: { adLinkId: id } }),
      botDb.botOrder.count({ where: { attributedAdId: id } }),
      botDb.botUser.count({ where: { firstAdId: id } }),
      botDb.botUser.count({ where: { lastAdId: id } }),
    ]);

  const totalActivity =
    clicksCount + touchesCount + ordersCount + firstUsersCount + lastUsersCount;

  if (totalActivity > 0) {
    // Prevent deletion of active history
    redirect(
      `/admin/bot-ads?error=has_history&name=${encodeURIComponent(link.name)}&clicks=${clicksCount}&starts=${touchesCount}&orders=${ordersCount}`,
    );
  }

  await botDb.adExpense.deleteMany({ where: { adLinkId: id } }).catch(() => {});
  await botDb.adLink.delete({ where: { id } });

  await audit({
    adminId: admin.id,
    action: "bot.ad_link.delete",
    entityType: "AdLink",
    entityId: String(id),
    metadata: { code: link.code, name: link.name },
  });

  revalidatePath("/admin/bot-ads");
  redirect("/admin/bot-ads?ok=deleted");
}

/**
 * Records an actual advertising expense for a given ad link and period.
 */
export async function createAdExpenseAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.LINKS_MANAGE);

  const adLinkId = Number(formData.get("adLinkId"));
  const amount = Math.max(0, num(formData.get("amount")));
  const currency = str(formData.get("currency")) === "UZS" ? "UZS" : "USD";
  const customRate = num(formData.get("exchangeRate"));
  const rate = customRate > 0 ? customRate : DEFAULT_USD_UZS_RATE;
  const rawStart = str(formData.get("startDate"));
  const rawEnd = str(formData.get("endDate"));
  const comment = str(formData.get("comment")) || null;
  const returnTo = str(formData.get("returnTo")) || `/admin/bot-ads/${adLinkId}`;

  if (!adLinkId || amount <= 0 || !rawStart || !rawEnd) {
    redirect(`${returnTo}?error=missing_expense_fields`);
  }

  const startDate = new Date(rawStart);
  const endDate = new Date(rawEnd);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate < startDate) {
    redirect(`${returnTo}?error=invalid_dates`);
  }

  const adLinkExists = await botDb.adLink.count({ where: { id: adLinkId } });
  if (!adLinkExists) {
    redirect(`${returnTo}?error=ad_link_not_found`);
  }

  const amountUzs = currency === "USD" ? Math.round(amount * rate) : amount;

  const expense = await botDb.adExpense.create({
    data: {
      adLinkId,
      amount,
      currency,
      amountUzs,
      startDate,
      endDate,
      comment,
    },
  });

  await audit({
    adminId: admin.id,
    action: "bot.ad_expense.create",
    entityType: "AdExpense",
    entityId: String(expense.id),
    metadata: { adLinkId, amount, currency, amountUzs },
  });

  revalidatePath("/admin/bot-ads");
  revalidatePath(`/admin/bot-ads/${adLinkId}`);
  redirect(`${returnTo}?ok=expense_added`);
}

/**
 * Deletes an advertising expense entry.
 */
export async function deleteAdExpenseAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.LINKS_MANAGE);
  const id = Number(formData.get("id"));
  const adLinkId = Number(formData.get("adLinkId"));
  const returnTo = str(formData.get("returnTo")) || (adLinkId ? `/admin/bot-ads/${adLinkId}` : "/admin/bot-ads");

  const expense = await botDb.adExpense.findUnique({ where: { id } });
  if (!expense) {
    redirect(`${returnTo}?error=expense_not_found`);
  }

  await botDb.adExpense.delete({ where: { id } });

  await audit({
    adminId: admin.id,
    action: "bot.ad_expense.delete",
    entityType: "AdExpense",
    entityId: String(id),
    metadata: { amount: expense.amount, currency: expense.currency },
  });

  revalidatePath("/admin/bot-ads");
  if (adLinkId) revalidatePath(`/admin/bot-ads/${adLinkId}`);
  redirect(`${returnTo}?ok=expense_deleted`);
}
