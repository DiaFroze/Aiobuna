// Create or update an admin account (bcrypt-hashed password).
// Usage:  node --env-file=.env scripts/create-admin.mjs <email> <password> [roleKey]
//   roleKey defaults to "superadmin" (also: manager, viewer).
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const [, , email, password, roleKey = "superadmin"] = process.argv;

if (!email || !password) {
  console.error('Usage: npm run admin:create -- "<email>" "<password>" [superadmin|manager|viewer]');
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const role = await prisma.role.findUnique({ where: { key: roleKey } });
  if (!role) {
    console.error(`Role "${roleKey}" not found. Run "npm run db:seed" first.`);
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.admin.upsert({
    where: { email },
    create: { email, name: email.split("@")[0], passwordHash, roleId: role.id, isActive: true },
    update: { passwordHash, roleId: role.id, isActive: true },
  });
  console.log(`✅ Admin ready: ${admin.email}  (role: ${roleKey})`);
} finally {
  await prisma.$disconnect();
}
