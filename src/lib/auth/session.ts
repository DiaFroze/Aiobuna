import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "../db";
import { verifyPassword } from "../security/password";
import type { PermissionKey } from "../security/rbac";

const COOKIE = "admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8h

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface AdminIdentity {
  id: string;
  email: string;
  name: string | null;
  roleKey: string;
  permissions: PermissionKey[];
}

/** Verify credentials and create a server session; sets the cookie. */
export async function login(
  email: string,
  password: string,
  meta: { ip?: string; userAgent?: string },
): Promise<AdminIdentity | null> {
  const admin = await prisma.admin.findUnique({
    where: { email },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  if (!admin || !admin.isActive) return null;
  if (!(await verifyPassword(password, admin.passwordHash))) return null;

  const token = crypto.randomBytes(32).toString("hex");
  await prisma.adminSession.create({
    data: {
      adminId: admin.id,
      tokenHash: hashToken(token),
      ip: meta.ip,
      userAgent: meta.userAgent,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });

  cookies().set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });

  return toIdentity(admin);
}

export async function logout(): Promise<void> {
  const token = cookies().get(COOKIE)?.value;
  if (token) {
    await prisma.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
    cookies().delete(COOKIE);
  }
}

/** Returns the current admin identity or null. Use in server components/actions. */
export async function getCurrentAdmin(): Promise<AdminIdentity | null> {
  const token = cookies().get(COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      admin: {
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      },
    },
  });
  if (!session || session.expiresAt < new Date() || !session.admin.isActive) return null;
  return toIdentity(session.admin);
}

export async function requirePermission(perm: PermissionKey): Promise<AdminIdentity> {
  const admin = await getCurrentAdmin();
  if (!admin) throw new Error("UNAUTHORIZED");
  if (!admin.permissions.includes(perm)) throw new Error("FORBIDDEN");
  return admin;
}

type AdminWithRole = {
  id: string;
  email: string;
  name: string | null;
  role: { key: string; permissions: { permission: { key: string } }[] };
};

function toIdentity(admin: AdminWithRole): AdminIdentity {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    roleKey: admin.role.key,
    permissions: admin.role.permissions.map((p) => p.permission.key as PermissionKey),
  };
}
