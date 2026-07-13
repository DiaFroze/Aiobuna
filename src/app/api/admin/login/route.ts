import { NextResponse } from "next/server";
import { z } from "zod";
import { headers } from "next/headers";
import { login } from "@/lib/auth/session";
import { audit } from "@/lib/security/audit";

// Accept a username OR email as the login identifier.
const schema = z.object({ email: z.string().min(1), password: z.string().min(1) });

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const h = headers();
  const ip = h.get("x-forwarded-for") ?? undefined;
  const admin = await login(parsed.data.email, parsed.data.password, {
    ip,
    userAgent: h.get("user-agent") ?? undefined,
  });

  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  await audit({ adminId: admin.id, action: "admin.login", entityType: "Admin", entityId: admin.id, ip });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const { logout } = await import("@/lib/auth/session");
  await logout();
  return NextResponse.json({ ok: true });
}
