"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { botDb } from "@/lib/botDb";
import { audit } from "@/lib/security/audit";

function num(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}

export async function addVariantSupplierAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const variantId = Number(formData.get("variantId"));
  const supplierKey = String(formData.get("supplierKey") ?? "").trim();
  const supplierExternalId = String(formData.get("supplierExternalId") ?? "").trim();
  const supplierPriceUsdt = num(formData.get("supplierPriceUsdt"));
  const supplierStock = Math.round(num(formData.get("supplierStock")));
  const priority = Math.max(1, Math.round(num(formData.get("priority"))) || 1);
  const name = String(formData.get("name") ?? "").trim() || null;
  const isActive = formData.get("isActive") === "on" || formData.get("isActive") === "true";

  if (!variantId || !supplierKey || !supplierExternalId) {
    return;
  }

  await botDb.variantSupplier.upsert({
    where: {
      variantId_supplierKey_supplierExternalId: {
        variantId,
        supplierKey,
        supplierExternalId,
      },
    },
    create: {
      variantId,
      supplierKey,
      supplierExternalId,
      supplierPriceUsdt,
      supplierStock,
      priority,
      name,
      isActive,
    },
    update: {
      supplierPriceUsdt,
      supplierStock,
      priority,
      name,
      isActive,
    },
  });

  // Enable autoSupplier on the variant
  await botDb.variant.update({
    where: { id: variantId },
    data: { autoSupplier: true },
  });

  await audit({
    adminId: admin.id,
    action: "bot.variant_supplier.add",
    entityType: "VariantSupplier",
    entityId: `${variantId}:${supplierKey}:${supplierExternalId}`,
    metadata: { supplierKey, supplierExternalId, supplierPriceUsdt, priority },
  });

  revalidatePath("/admin/bot-suppliers");
  revalidatePath("/admin/bot-products");
}

export async function updateVariantSupplierAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  if (!id) return;

  const supplierPriceUsdt = num(formData.get("supplierPriceUsdt"));
  const supplierStock = Math.round(num(formData.get("supplierStock")));
  const priority = Math.max(1, Math.round(num(formData.get("priority"))) || 1);
  const supplierExternalId = String(formData.get("supplierExternalId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim() || null;
  const isActive = formData.get("isActive") === "on" || formData.get("isActive") === "true";

  const data: Record<string, any> = {
    supplierPriceUsdt,
    supplierStock,
    priority,
    isActive,
  };
  if (supplierExternalId) data.supplierExternalId = supplierExternalId;
  if (name !== undefined) data.name = name;

  await botDb.variantSupplier.update({
    where: { id },
    data,
  });

  await audit({
    adminId: admin.id,
    action: "bot.variant_supplier.update",
    entityType: "VariantSupplier",
    entityId: String(id),
    metadata: data,
  });

  revalidatePath("/admin/bot-suppliers");
  revalidatePath("/admin/bot-products");
}

export async function deleteVariantSupplierAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const id = Number(formData.get("id"));
  if (!id) return;

  await botDb.variantSupplier.delete({
    where: { id },
  });

  await audit({
    adminId: admin.id,
    action: "bot.variant_supplier.delete",
    entityType: "VariantSupplier",
    entityId: String(id),
    metadata: {},
  });

  revalidatePath("/admin/bot-suppliers");
  revalidatePath("/admin/bot-products");
}

export async function setVariantRoutingStrategyAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const variantId = Number(formData.get("variantId"));
  const strategy = String(formData.get("routingStrategy") ?? "priority").trim();

  if (!variantId || !["priority", "cheapest", "balance"].includes(strategy)) {
    return;
  }

  await botDb.variant.update({
    where: { id: variantId },
    data: { routingStrategy: strategy },
  });

  await audit({
    adminId: admin.id,
    action: "bot.variant.set_routing_strategy",
    entityType: "Variant",
    entityId: String(variantId),
    metadata: { strategy },
  });

  revalidatePath("/admin/bot-suppliers");
  revalidatePath("/admin/bot-products");
}

export async function toggleVariantAutoSupplierAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const variantId = Number(formData.get("variantId"));
  const autoSupplier = formData.get("autoSupplier") === "1" || formData.get("autoSupplier") === "on";

  if (!variantId) return;

  await botDb.variant.update({
    where: { id: variantId },
    data: { autoSupplier },
  });

  await audit({
    adminId: admin.id,
    action: "bot.variant.toggle_auto_supplier",
    entityType: "Variant",
    entityId: String(variantId),
    metadata: { autoSupplier },
  });

  revalidatePath("/admin/bot-suppliers");
  revalidatePath("/admin/bot-products");
}

export async function migrateLegacySupplierAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.PRODUCTS_WRITE);
  const variantId = Number(formData.get("variantId"));
  if (!variantId) return;

  const v = await botDb.variant.findUnique({
    where: { id: variantId },
  });

  if (!v || !v.supplierKey || !v.supplierExternalId) return;

  await botDb.variantSupplier.upsert({
    where: {
      variantId_supplierKey_supplierExternalId: {
        variantId: v.id,
        supplierKey: v.supplierKey,
        supplierExternalId: v.supplierExternalId,
      },
    },
    create: {
      variantId: v.id,
      supplierKey: v.supplierKey,
      supplierExternalId: v.supplierExternalId,
      supplierPriceUsdt: v.supplierPriceUsdt,
      supplierStock: v.supplierStock,
      priority: 1,
      name: `${v.titleRu} (${v.supplierKey})`,
      isActive: true,
    },
    update: {
      supplierPriceUsdt: v.supplierPriceUsdt,
      supplierStock: v.supplierStock,
      priority: 1,
      isActive: true,
    },
  });

  await botDb.variant.update({
    where: { id: v.id },
    data: { autoSupplier: true },
  });

  await audit({
    adminId: admin.id,
    action: "bot.variant.migrate_legacy_supplier",
    entityType: "Variant",
    entityId: String(variantId),
    metadata: { supplierKey: v.supplierKey, supplierExternalId: v.supplierExternalId },
  });

  revalidatePath("/admin/bot-suppliers");
  revalidatePath("/admin/bot-products");
}
