"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

const VERIFIED = { channelVerifiedAt: { not: null } } as const;

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim().replace(/^@/, "");
}
function int(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Resolve a user by numeric tgId or by @username, the way the bot commands do. */
async function findUser(ref: string) {
  if (!ref) return null;
  return botDb.botUser.findFirst({
    where: isNaN(Number(ref)) ? { username: ref } : { tgId: ref },
  });
}

async function setFlag(key: string, value: string) {
  await botDb.setting.upsert({
    where: { key },
    create: { key, valueRu: value, type: "text" },
    update: { valueRu: value },
  });
}

/** Master switch: pauses earning AND spending of referral points. */
export async function toggleReferralsAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const on = formData.get("enabled") === "on";
  await setFlag("referrals_enabled", on ? "1" : "0");
  await audit({ adminId: admin.id, action: "bot.referrals.toggle", entityType: "BotSetting", entityId: "referrals_enabled", metadata: { enabled: on } });
  revalidatePath("/admin/bot-referrals");
}

/** Public sales feed: group id + its own on/off switch. */
export async function saveSalesFeedAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const on = formData.get("feedEnabled") === "on";
  let group = String(formData.get("groupId") ?? "").trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "");
  if (group && !/^-?\d+$/.test(group)) group = `@${group}`;
  await setFlag("sales_feed_enabled", on ? "1" : "0");
  await setFlag("sales_group_id", group);
  await audit({ adminId: admin.id, action: "bot.salesfeed.save", entityType: "BotSetting", entityId: "sales_group_id", metadata: { enabled: on, group } });
  revalidatePath("/admin/bot-referrals");
}

/** Block a user from inviting AND from spending points. Mirrors /refban. */
export async function setRefBanAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const banned = formData.get("banned") === "1";
  const u = await findUser(str(formData.get("user")));
  if (!u) return;
  await botDb.botUser.update({ where: { id: u.id }, data: { refBanned: banned } });
  await audit({ adminId: admin.id, action: banned ? "bot.referrals.ban" : "bot.referrals.unban", entityType: "BotUser", entityId: u.tgId, metadata: {} });
  revalidatePath("/admin/bot-referrals");
}

/** Freeze all available points. Mirrors /refzero. */
export async function zeroPointsAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const u = await findUser(str(formData.get("user")));
  if (!u) return;
  const realRefs = await botDb.botUser.count({ where: { referredBy: u.tgId, ...VERIFIED } });
  const total = realRefs + (u.bonusReferrals ?? 0);
  await botDb.botUser.update({ where: { id: u.id }, data: { spentReferrals: total } });
  await audit({ adminId: admin.id, action: "bot.referrals.zero", entityType: "BotUser", entityId: u.tgId, metadata: { total } });
  revalidatePath("/admin/bot-referrals");
}

/** Manually credit or debit points. Mirrors /refgive. */
export async function giveePointsAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const u = await findUser(str(formData.get("user")));
  const n = int(formData.get("amount"));
  if (!u || n === 0) return;
  await botDb.botUser.update({
    where: { id: u.id },
    data: { bonusReferrals: Math.max(0, (u.bonusReferrals ?? 0) + n) },
  });
  await audit({ adminId: admin.id, action: "bot.referrals.give", entityType: "BotUser", entityId: u.tgId, metadata: { amount: n } });
  revalidatePath("/admin/bot-referrals");
}

/** Drop a user's referral link. Mirrors /unref. */
export async function unlinkReferralAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const u = await findUser(str(formData.get("user")));
  if (!u || !u.referredBy) return;
  await botDb.botUser.update({ where: { id: u.id }, data: { referredBy: null } });
  await audit({ adminId: admin.id, action: "bot.referrals.unlink", entityType: "BotUser", entityId: u.tgId, metadata: {} });
  revalidatePath("/admin/bot-referrals");
}

/**
 * Return points that were debited without a gift ever being delivered, by
 * resetting spentReferrals to what the user's gift orders actually justify.
 * Mirrors /refrepair. Cannot tell a lost debit from a deliberate /refzero —
 * both look like spend with no order behind it — so re-zero fraudsters after.
 */
export async function repairPointsAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const scope = String(formData.get("scope") ?? "one");

  const tierRow = await botDb.setting.findUnique({ where: { key: "ref_reward_tiers" } });
  const tierMap = new Map<number, number>();
  for (const p of (tierRow?.valueRu ?? "").split(/[,\n]/)) {
    const [th, vid] = p.split(":").map((x) => Number(String(x).trim()));
    if (Number.isFinite(th) && th > 0 && Number.isFinite(vid) && vid > 0) tierMap.set(vid, th);
  }
  const costOf = async (variantId: number | null) => {
    if (variantId == null) return 0;
    const v = await botDb.variant.findUnique({ where: { id: variantId }, select: { pointsCost: true } }).catch(() => null);
    return tierMap.get(variantId) ?? v?.pointsCost ?? 0;
  };
  const justifiedFor = async (userId: number) => {
    const orders = await botDb.botOrder.findMany({
      where: { userId, source: "referral", status: { not: "failed" } },
      select: { variantId: true },
    });
    let sum = 0;
    for (const o of orders) sum += await costOf(o.variantId);
    return sum;
  };

  const targets = scope === "all"
    ? await botDb.botUser.findMany({ where: { spentReferrals: { gt: 0 } }, select: { id: true, tgId: true, spentReferrals: true } })
    : await (async () => {
        const u = await findUser(str(formData.get("user")));
        return u ? [{ id: u.id, tgId: u.tgId, spentReferrals: u.spentReferrals }] : [];
      })();

  let fixed = 0;
  for (const u of targets) {
    const justified = await justifiedFor(u.id);
    if ((u.spentReferrals ?? 0) > justified) {
      await botDb.botUser.update({ where: { id: u.id }, data: { spentReferrals: justified } });
      fixed++;
    }
  }
  await audit({ adminId: admin.id, action: "bot.referrals.repair", entityType: "BotUser", entityId: scope, metadata: { scope, fixed } });
  revalidatePath("/admin/bot-referrals");
}
