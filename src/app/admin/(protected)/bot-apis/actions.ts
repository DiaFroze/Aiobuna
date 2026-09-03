"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "api";
}

/** Create or update a supplier API source (add new reseller APIs from the panel). */
export async function saveApiSourceAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number(formData.get("id")) || 0;
  const name = str(formData.get("name"));
  const baseUrl = str(formData.get("baseUrl"));
  const apiKey = str(formData.get("apiKey"));
  const format = str(formData.get("format")) || "vex";
  const isActive = formData.get("isActive") === "on";
  if (!name || !baseUrl) return;

  if (id) {
    const data: { name: string; baseUrl: string; format: string; isActive: boolean; apiKey?: string } = {
      name,
      baseUrl,
      format,
      isActive,
    };
    if (apiKey) data.apiKey = apiKey; // blank = keep existing key
    await botDb.apiSource.update({ where: { id }, data });
  } else {
    let slug = slugify(str(formData.get("slug")) || name);
    const base = slug;
    let i = 1;
    while (await botDb.apiSource.findUnique({ where: { slug } })) slug = `${base}_${i++}`;
    await botDb.apiSource.create({ data: { slug, name, baseUrl, apiKey, format, isActive } });
  }
  await audit({ adminId: admin.id, action: "bot.apisource.save", entityType: "ApiSource", entityId: String(id || name) });
  revalidatePath("/admin/bot-apis");
  revalidatePath("/admin/bot-import");
}

export async function toggleApiSourceAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number(formData.get("id"));
  const active = formData.get("active") === "1";
  await botDb.apiSource.update({ where: { id }, data: { isActive: active } });
  await audit({ adminId: admin.id, action: "bot.apisource.toggle", entityType: "ApiSource", entityId: String(id) });
  revalidatePath("/admin/bot-apis");
  revalidatePath("/admin/bot-import");
}

export async function deleteApiSourceAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number(formData.get("id"));
  await botDb.apiSource.delete({ where: { id } });
  await audit({ adminId: admin.id, action: "bot.apisource.delete", entityType: "ApiSource", entityId: String(id) });
  revalidatePath("/admin/bot-apis");
  revalidatePath("/admin/bot-import");
}

/**
 * Migrate all products/variants that point to fromSlug → toSlug.
 * This lets you swap API keys without re-importing everything:
 * 1. Add new source (new key)
 * 2. Click "Мигрировать товары" on the old source → pick the new one
 * 3. Delete the old source (optional)
 * All existing products keep their prices, settings, and sold stats.
 */
export async function migrateSourceAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const fromSlug = str(formData.get("fromSlug"));
  const toSlug = str(formData.get("toSlug"));
  if (!fromSlug || !toSlug || fromSlug === toSlug) return;

  // Verify target exists
  const target = await botDb.apiSource.findUnique({ where: { slug: toSlug } });
  if (!target) return;

  const { count } = await botDb.variant.updateMany({
    where: { supplierKey: fromSlug },
    data: { supplierKey: toSlug },
  });

  await audit({
    adminId: admin.id,
    action: "bot.apisource.migrate",
    entityType: "ApiSource",
    entityId: `${fromSlug}→${toSlug}`,
    metadata: { count },
  });
  revalidatePath("/admin/bot-apis");
  revalidatePath("/admin/bot-import");
  revalidatePath("/admin/bot-products");
}
