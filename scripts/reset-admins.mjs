// Reset the admin panel: create ONE new superadmin (strong login + password),
// then delete every other admin. Safe order — the new admin is created and
// verified BEFORE the others are removed, so you can never be locked out.
//
// Usage:
//   node --env-file=.env scripts/reset-admins.mjs                 # generate login + password
//   node --env-file=.env scripts/reset-admins.mjs <email> <pass>  # use your own
//
// Point DATABASE_URL at the target DB (local or prod) before running.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

function genPassword(len = 20) {
  // URL-safe, no ambiguous chars; ~ strong entropy.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_";
  const buf = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

const email = process.argv[2] || `admin_${randomBytes(4).toString("hex")}@sb.eu`;
const password = process.argv[3] || genPassword();

const prisma = new PrismaClient();
try {
  const role = await prisma.role.findUnique({ where: { key: "superadmin" } });
  if (!role) {
    console.error('Role "superadmin" not found. Run "npm run db:seed" first.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // 1. Create/refresh the new admin FIRST.
  const fresh = await prisma.admin.upsert({
    where: { email },
    create: { email, name: email.split("@")[0], passwordHash, roleId: role.id, isActive: true },
    update: { passwordHash, roleId: role.id, isActive: true },
  });

  // 2. Verify it exists, then remove all others (their sessions cascade).
  const check = await prisma.admin.findUnique({ where: { id: fresh.id } });
  if (!check) {
    console.error("New admin was not created — aborting without deleting anyone.");
    process.exit(1);
  }
  const del = await prisma.admin.deleteMany({ where: { id: { not: fresh.id } } });

  console.log("=== Admin reset complete ===");
  console.log(`Deleted admins: ${del.count}`);
  console.log("New admin credentials (save them — the password is not stored anywhere else):");
  console.log(`  Login (email): ${email}`);
  console.log(`  Password:      ${password}`);
} finally {
  await prisma.$disconnect();
}
