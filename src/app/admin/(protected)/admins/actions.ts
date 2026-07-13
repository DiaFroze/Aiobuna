"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/session";
import { PERMISSIONS } from "@/lib/security/rbac";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/security/password";
import { audit } from "@/lib/security/audit";

const schema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  password: z.string().min(8),
  roleId: z.string().min(1),
});

export async function createAdminAction(formData: FormData) {
  const actor = await requirePermission(PERMISSIONS.ADMINS_MANAGE);
  const parsed = schema.safeParse({
    email: formData.get("email"),
    name: formData.get("name") || undefined,
    password: formData.get("password"),
    roleId: formData.get("roleId"),
  });
  if (!parsed.success) return;

  const admin = await prisma.admin.create({
    data: {
      email: parsed.data.email,
      name: parsed.data.name,
      passwordHash: await hashPassword(parsed.data.password),
      roleId: parsed.data.roleId,
    },
  });
  // NOTE: password never logged.
  await audit({ adminId: actor.id, action: "admin.create", entityType: "Admin", entityId: admin.id, metadata: { email: admin.email } });
  revalidatePath("/admin/admins");
}
