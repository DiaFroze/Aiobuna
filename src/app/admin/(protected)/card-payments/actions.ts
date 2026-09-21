"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { audit } from "@/lib/security/audit";
import { claimManualReview, claimPaymentConfirmation } from "@/lib/domain/card-payment";

export async function manualConfirmAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);

  const requestId = Number.parseInt(String(formData.get("requestId")), 10);
  const note = String(formData.get("note") || "").trim() || `Ручное подтверждение админом ${admin.email}`;

  if (!requestId) throw new Error("Missing requestId");

  const success = await claimManualReview(prisma, requestId, "confirm", note);
  if (!success) {
    throw new Error("Не удалось подтвердить заявку: возможно, она уже обработана или отменена.");
  }

  await audit({
    adminId: admin.id,
    action: "card_payment.manual_confirm",
    entityType: "CardPaymentRequest",
    entityId: String(requestId),
    metadata: { note, adminEmail: admin.email },
  }).catch(() => {});

  revalidatePath("/admin/card-payments");
}

export async function manualRejectAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);

  const requestId = Number.parseInt(String(formData.get("requestId")), 10);
  const note = String(formData.get("note") || "").trim() || `Отклонено админом ${admin.email}`;

  if (!requestId) throw new Error("Missing requestId");

  const success = await claimManualReview(prisma, requestId, "reject", note);
  if (!success) {
    throw new Error("Не удалось отклонить заявку: возможно, она уже обработана.");
  }

  await audit({
    adminId: admin.id,
    action: "card_payment.manual_reject",
    entityType: "CardPaymentRequest",
    entityId: String(requestId),
    metadata: { note, adminEmail: admin.email },
  }).catch(() => {});

  revalidatePath("/admin/card-payments");
}

export async function linkNotificationAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);

  const requestId = Number.parseInt(String(formData.get("requestId")), 10);
  const notificationId = Number.parseInt(String(formData.get("notificationId")), 10);

  if (!requestId || !notificationId) throw new Error("Missing requestId or notificationId");

  const success = await claimPaymentConfirmation(prisma, requestId, notificationId);
  if (!success) {
    throw new Error("Не удалось связать заявку и банковское уведомление.");
  }

  await audit({
    adminId: admin.id,
    action: "card_payment.link_notification",
    entityType: "CardPaymentRequest",
    entityId: String(requestId),
    metadata: { notificationId, adminEmail: admin.email },
  }).catch(() => {});

  revalidatePath("/admin/card-payments");
}
