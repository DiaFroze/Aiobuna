// Idempotent seed: RBAC roles/permissions + a superadmin. (The public storefront
// and supplier pipeline were removed — the catalog lives in the bot DB, seeded
// separately via scripts/bot-demo-seed.mjs.)

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { PERMISSIONS, ROLE_PRESETS } from "../src/lib/security/rbac";

const prisma = new PrismaClient();

async function main() {
  // Permissions
  for (const key of Object.values(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { key },
      create: { key, name: key },
      update: {},
    });
  }

  // Roles + role permissions
  for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
    const role = await prisma.role.upsert({
      where: { key },
      create: { key, name: preset.name },
      update: { name: preset.name },
    });
    for (const permKey of preset.permissions) {
      const perm = await prisma.permission.findUnique({ where: { key: permKey } });
      if (perm) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
          create: { roleId: role.id, permissionId: perm.id },
          update: {},
        });
      }
    }
  }

  // Seed admin
  const superRole = await prisma.role.findUniqueOrThrow({ where: { key: "superadmin" } });
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@sb.eu";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "admin12345";
  await prisma.admin.upsert({
    where: { email },
    create: { email, name: "Super Admin", passwordHash: await bcrypt.hash(password, 12), roleId: superRole.id },
    update: {},
  });
  console.info(`Seeded admin: ${email} / ${password}`);

  console.info("Seed complete. Manage the bot catalog at /admin/bot-products.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
