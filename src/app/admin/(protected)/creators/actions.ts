"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { audit } from "@/lib/security/audit";
import {
  validateCreatorCode,
  approveCreatorPayout,
  rejectCreatorPayout,
} from "@/lib/domain/creators";

export async function createCreatorAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);

  const name = String(formData.get("name") || "").trim();
  const rawCode = String(formData.get("code") || "").trim();
  const username = String(formData.get("username") || "").trim().replace(/^@/, "");
  const tgId = String(formData.get("tgId") || "").trim() || null;
  const phone = String(formData.get("phone") || "").trim() || null;
  const cardNumber = String(formData.get("cardNumber") || "").replace(/\D/g, "") || null;
  const cardHolder = String(formData.get("cardHolder") || "").trim() || null;
  const defaultRateUzs = Math.max(0, Number.parseInt(String(formData.get("defaultRateUzs") || "10000"), 10) || 10000);

  if (!name) throw new Error("Укажите имя креатора");

  const codeValidation = validateCreatorCode(rawCode);
  if (!codeValidation.valid) {
    throw new Error(`Некорректный код ссылки: ${codeValidation.reason}`);
  }

  const existing = await prisma.creator.findUnique({
    where: { code: codeValidation.code },
  });
  if (existing) {
    throw new Error(`Креатор с кодом "${codeValidation.code}" уже существует.`);
  }

  const creator = await prisma.creator.create({
    data: {
      name,
      code: codeValidation.code,
      username: username || null,
      tgId,
      phone,
      cardNumber,
      cardHolder,
      defaultRateUzs,
      isActive: true,
    },
  });

  await audit({
    adminId: admin.id,
    action: "creator.create",
    entityType: "Creator",
    entityId: String(creator.id),
    metadata: { code: creator.code, name: creator.name },
  }).catch(() => {});

  revalidatePath("/admin/creators");
}

export async function updateCreatorAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);

  const id = Number.parseInt(String(formData.get("id")), 10);
  const name = String(formData.get("name") || "").trim();
  const rawCode = String(formData.get("code") || "").trim();
  const username = String(formData.get("username") || "").trim().replace(/^@/, "");
  const tgId = String(formData.get("tgId") || "").trim() || null;
  const phone = String(formData.get("phone") || "").trim() || null;
  const cardNumber = String(formData.get("cardNumber") || "").replace(/\D/g, "") || null;
  const cardHolder = String(formData.get("cardHolder") || "").trim() || null;
  const defaultRateUzs = Math.max(0, Number.parseInt(String(formData.get("defaultRateUzs") || "10000"), 10) || 10000);

  if (!id) throw new Error("Missing creator id");
  if (!name) throw new Error("Укажите имя креатора");

  const codeValidation = validateCreatorCode(rawCode);
  if (!codeValidation.valid) {
    throw new Error(`Некорректный код ссылки: ${codeValidation.reason}`);
  }

  // Check code uniqueness
  const conflict = await prisma.creator.findFirst({
    where: { code: codeValidation.code, NOT: { id } },
  });
  if (conflict) {
    throw new Error(`Код "${codeValidation.code}" уже занят другим креатором.`);
  }

  await prisma.creator.update({
    where: { id },
    data: {
      name,
      code: codeValidation.code,
      username: username || null,
      tgId,
      phone,
      cardNumber,
      cardHolder,
      defaultRateUzs,
    },
  });

  await audit({
    adminId: admin.id,
    action: "creator.update",
    entityType: "Creator",
    entityId: String(id),
    metadata: { code: codeValidation.code },
  }).catch(() => {});

  revalidatePath("/admin/creators");
}

export async function toggleCreatorActiveAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const id = Number.parseInt(String(formData.get("id")), 10);
  if (!id) throw new Error("Missing id");

  const creator = await prisma.creator.findUnique({ where: { id } });
  if (!creator) throw new Error("Creator not found");

  await prisma.creator.update({
    where: { id },
    data: { isActive: !creator.isActive },
  });

  await audit({
    adminId: admin.id,
    action: "creator.toggle_active",
    entityType: "Creator",
    entityId: String(id),
    metadata: { newStatus: !creator.isActive },
  }).catch(() => {});

  revalidatePath("/admin/creators");
}

export async function saveCreatorProductRatesAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const creatorId = Number.parseInt(String(formData.get("creatorId")), 10);
  if (!creatorId) throw new Error("Missing creatorId");

  const ratesJson = String(formData.get("ratesJson") || "[]");
  const rates: Array<{ variantId: number; rewardUzs: number }> = JSON.parse(ratesJson);

  // Update in transaction
  await prisma.$transaction(async (tx) => {
    // Delete existing custom rates
    await tx.creatorProductRate.deleteMany({
      where: { creatorId },
    });

    // Create new ones where rewardUzs > 0
    for (const r of rates) {
      if (r.rewardUzs > 0) {
        await tx.creatorProductRate.create({
          data: {
            creatorId,
            variantId: r.variantId,
            rewardUzs: r.rewardUzs,
          },
        });
      }
    }
  });

  await audit({
    adminId: admin.id,
    action: "creator.set_product_rates",
    entityType: "Creator",
    entityId: String(creatorId),
    metadata: { ratesCount: rates.length },
  }).catch(() => {});

  revalidatePath("/admin/creators");
}

export async function approvePayoutAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const payoutId = Number.parseInt(String(formData.get("payoutId")), 10);
  const note = String(formData.get("note") || "").trim() || "Выплачено";

  if (!payoutId) throw new Error("Missing payoutId");

  const res = await approveCreatorPayout(prisma, {
    payoutId,
    adminUser: admin.email,
    note,
  });

  if (!res.success) {
    throw new Error(`Ошибка подтверждения выплаты: ${res.error}`);
  }

  await audit({
    adminId: admin.id,
    action: "creator.payout_approved",
    entityType: "CreatorPayout",
    entityId: String(payoutId),
    metadata: { note, adminEmail: admin.email },
  }).catch(() => {});

  revalidatePath("/admin/creators");
}

export async function rejectPayoutAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const payoutId = Number.parseInt(String(formData.get("payoutId")), 10);
  const reason = String(formData.get("reason") || "").trim() || "Отклонено администратором";

  if (!payoutId) throw new Error("Missing payoutId");

  const res = await rejectCreatorPayout(prisma, {
    payoutId,
    adminUser: admin.email,
    reason,
  });

  if (!res.success) {
    throw new Error(`Ошибка отклонения выплаты: ${res.error}`);
  }

  await audit({
    adminId: admin.id,
    action: "creator.payout_rejected",
    entityType: "CreatorPayout",
    entityId: String(payoutId),
    metadata: { reason, adminEmail: admin.email },
  }).catch(() => {});

  revalidatePath("/admin/creators");
}
