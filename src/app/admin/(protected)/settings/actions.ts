"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { audit } from "@/lib/security/audit";
import { setGlobalSettings, type GlobalSettings } from "@/lib/services/settings";

export async function saveSettingsAction(formData: FormData) {
  const admin = await requirePermission(PERMISSIONS.SETTINGS_WRITE);
  const patch: Partial<GlobalSettings> = {
    defaultRoundingMode: String(formData.get("defaultRoundingMode")) as GlobalSettings["defaultRoundingMode"],
  };
  await setGlobalSettings(patch);

  await audit({ adminId: admin.id, action: "settings.update", entityType: "Setting", metadata: patch });
  revalidatePath("/admin/settings");
}
