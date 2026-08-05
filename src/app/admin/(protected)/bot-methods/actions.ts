"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";
import { geminiLocalize } from "@/lib/gemini";

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}
function num(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}
function resolveEmoji(emojiInput: string, premiumInput: string): { emoji: string; premium: string | null } {
  const emoji = emojiInput.trim();
  const premium = premiumInput.trim();
  if (!premium && /^\d{6,}$/.test(emoji)) return { emoji: "📘", premium: emoji };
  return { emoji: emoji || "📘", premium: premium || null };
}

/** Создать метод/гайд. RU-заголовок обязателен, UZ/EN подтягиваются через Gemini. */
export async function createMethodAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const code = str(formData.get("code"));
  const titleRu = str(formData.get("titleRu"));
  if (!code || !titleRu) redirect("/admin/bot-methods?error=missing");

  const existing = await botDb.method.findUnique({ where: { code } });
  if (existing) redirect("/admin/bot-methods?error=duplicate");

  const last = await botDb.method.findFirst({ orderBy: { sortOrder: "desc" } });
  const em = resolveEmoji(str(formData.get("emoji")), str(formData.get("premiumEmoji")));

  let tRu = titleRu;
  let tUz = str(formData.get("titleUz")) || titleRu;
  let tEn = titleRu;
  let dRu = str(formData.get("descRu"));
  let dUz = str(formData.get("descUz"));
  let dEn = "";
  try {
    const loc = await geminiLocalize(titleRu, dRu || dUz || "");
    if (loc) {
      tRu = loc.titleRu || tRu;
      tUz = loc.titleUz || tUz;
      tEn = loc.titleEn || tEn;
      dRu = loc.descRu || dRu;
      dUz = loc.descUz || dUz;
      dEn = loc.descEn || dEn;
    }
  } catch (err) {
    console.error("Gemini localization failed (method create):", err);
  }

  const method = await botDb.method.create({
    data: {
      code,
      titleRu: tRu,
      titleUz: tUz,
      titleEn: tEn,
      emoji: em.emoji,
      premiumEmoji: em.premium,
      descRu: dRu,
      descUz: dUz,
      descEn: dEn,
      url: str(formData.get("url")) || null,
      priceUzs: Math.max(0, Math.round(num(formData.get("priceUzs")))),
      priceStars: Math.max(0, Math.round(num(formData.get("priceStars")))),
      sortOrder: (last?.sortOrder ?? 0) + 1,
      isActive: true,
    },
  });
  await audit({
    adminId: admin.id,
    action: "bot.method.create",
    entityType: "BotMethod",
    entityId: String(method.id),
    metadata: { code },
  });
  revalidatePath("/admin/bot-methods");
  redirect("/admin/bot-methods");
}

/** Обновить метод: заголовки/текст/ссылку/цену/активность. */
export async function updateMethodAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  const em = resolveEmoji(str(formData.get("emoji")), str(formData.get("premiumEmoji")));

  const titleRu = str(formData.get("titleRu"));
  let tRu = titleRu;
  let tUz = str(formData.get("titleUz")) || titleRu;
  let tEn = titleRu;
  let dRu = str(formData.get("descRu"));
  let dUz = str(formData.get("descUz"));
  let dEn = "";
  try {
    const loc = await geminiLocalize(titleRu, dRu || dUz || "");
    if (loc) {
      tRu = loc.titleRu || tRu;
      tUz = loc.titleUz || tUz;
      tEn = loc.titleEn || tEn;
      dRu = loc.descRu || dRu;
      dUz = loc.descUz || dUz;
      dEn = loc.descEn || dEn;
    }
  } catch (err) {
    console.error("Gemini localization failed (method update):", err);
  }

  await botDb.method.update({
    where: { id },
    data: {
      titleRu: tRu,
      titleUz: tUz,
      titleEn: tEn,
      emoji: em.emoji,
      premiumEmoji: em.premium,
      descRu: dRu,
      descUz: dUz,
      descEn: dEn,
      url: str(formData.get("url")) || null,
      priceUzs: Math.max(0, Math.round(num(formData.get("priceUzs")))),
      priceStars: Math.max(0, Math.round(num(formData.get("priceStars")))),
      isActive: formData.get("isActive") === "on",
    },
  });
  await audit({
    adminId: admin.id,
    action: "bot.method.update",
    entityType: "BotMethod",
    entityId: String(id),
  });
  revalidatePath("/admin/bot-methods");
}

/** Быстрый тумблер вкл/выкл кнопки метода в боте. */
export async function toggleMethodAction(formData: FormData) {
  await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  const m = await botDb.method.findUnique({ where: { id } });
  if (m) await botDb.method.update({ where: { id }, data: { isActive: !m.isActive } });
  revalidatePath("/admin/bot-methods");
}

export async function deleteMethodAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  await botDb.method.delete({ where: { id } });
  await audit({
    adminId: admin.id,
    action: "bot.method.delete",
    entityType: "BotMethod",
    entityId: String(id),
  });
  revalidatePath("/admin/bot-methods");
  redirect("/admin/bot-methods");
}
