"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/security/audit";
import { setGlobalSettings, type GlobalSettings } from "@/lib/services/settings";

export async function saveSettingsAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const patch: Partial<GlobalSettings> = {
    globalMarkupPercent: Number(formData.get("globalMarkupPercent")),
    defaultRoundingMode: String(formData.get("defaultRoundingMode")) as GlobalSettings["defaultRoundingMode"],
    sellCurrency: String(formData.get("sellCurrency")),
  };
  await setGlobalSettings(patch);

  const rate = Number(formData.get("usdtUzsRate"));
  if (Number.isFinite(rate) && rate > 0) {
    await prisma.currencyRate.upsert({
      where: { base_quote: { base: "USDT", quote: "UZS" } },
      create: { base: "USDT", quote: "UZS", rate },
      update: { rate },
    });
  }

  await audit({ adminId: admin.id, action: "settings.update", entityType: "Setting", metadata: patch });
  revalidatePath("/admin/settings");
}
