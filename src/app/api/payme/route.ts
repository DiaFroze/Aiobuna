import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { botDb } from "@/lib/botDb";
import { handlePayme, PaymeError, paymeMessage } from "@/lib/domain/payme";
import { prismaPaymeRepo } from "@/lib/services/payme-repo";

// Payme Merchant API endpoint. Payme's servers POST JSON-RPC 2.0 here; the
// browser redirect is NOT this route and never confirms a payment. See
// docs/PAYME_SETUP.md.
//
// Protocol notes:
//  - Always answer HTTP 200. Payme treats any non-200 as transport error, so
//    business errors and even internal throws go in the JSON body.
//  - Auth is HTTP Basic: login "Paycom", password = the merchant KEY.
//  - Payme rotates the key via ChangePassword; the current key is then kept in
//    BotSetting("payme_password") and takes precedence over PAYME_KEY. If a
//    normal request later arrives with the original PAYME_KEY (the sandbox
//    reverts to the cabinet key between test groups), the stored key is stale
//    and is cleared automatically. The key is never logged.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PW_KEY = "payme_password";

async function storedKey(): Promise<string | null> {
  const row = await botDb.setting.findUnique({ where: { key: PW_KEY } }).catch(() => null);
  const v = row?.valueRu?.trim();
  return v && v.length > 0 ? v : null;
}
async function clearStoredKey(): Promise<void> {
  await botDb.setting.deleteMany({ where: { key: PW_KEY } }).catch(() => {});
}

function extractPassword(header: string | null): string | null {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    return decoded.slice(decoded.indexOf(":") + 1); // "Paycom:<key>"
  } catch {
    return null;
  }
}
function matches(password: string | null, key: string): boolean {
  if (password === null || !key) return false;
  const a = Buffer.from(password, "utf8");
  const b = Buffer.from(key, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function jsonRpc(id: unknown, payload: object) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, ...payload }, { status: 200 });
}

export async function POST(req: Request) {
  const enabled = env.paymeEnabled();
  const password = extractPassword(req.headers.get("authorization"));

  // Parse the body first so auth can be method-aware (the ChangePassword
  // old-key-rejection must stay strict). A malformed body is a clean -32700.
  let body: unknown = null;
  let parseFailed = false;
  try {
    body = await req.json();
  } catch {
    parseFailed = true;
  }
  const id = (body as { id?: unknown })?.id ?? null;
  const method = (body as { method?: string })?.method ?? "?";

  // Effective key = rotated override if present, else the env PAYME_KEY.
  const override = await storedKey();
  const effectiveKey = override ?? env.paymeKey();
  let keyOk = matches(password, effectiveKey);

  // Auto-heal a stale rotated key: a non-ChangePassword request carrying the
  // original PAYME_KEY means the sandbox went back to the cabinet key, so the
  // stored override is stale. Clear it and accept. ChangePassword is exempt so
  // its "old key is rejected" case still returns -32504.
  if (!keyOk && override && method !== "ChangePassword" && matches(password, env.paymeKey())) {
    await clearStoredKey();
    keyOk = true;
  }

  const authorized = enabled && keyOk;
  const why = !enabled ? "DISABLED: set PAYME_ENABLED=1" : !keyOk ? "BAD KEY: PAYME_KEY != sandbox/prod key" : "ok";

  if (parseFailed) {
    const code = authorized ? PaymeError.PARSE_ERROR : PaymeError.INSUFFICIENT_PRIVILEGE;
    return jsonRpc(null, { error: { code, message: paymeMessage(code) } });
  }

  // ChangePassword rotates the merchant key (auth-layer concern, handled here).
  if (method === "ChangePassword") {
    if (!authorized) {
      console.log(`[payme] ChangePassword → error -32504 | auth=${why}`);
      return jsonRpc(id, { error: { code: PaymeError.INSUFFICIENT_PRIVILEGE, message: paymeMessage(PaymeError.INSUFFICIENT_PRIVILEGE) } });
    }
    const newPw = (body as { params?: { password?: unknown } })?.params?.password;
    if (typeof newPw !== "string" || newPw.trim().length === 0) {
      return jsonRpc(id, { error: { code: PaymeError.CANT_PERFORM, message: paymeMessage(PaymeError.CANT_PERFORM) } });
    }
    await botDb.setting.upsert({
      where: { key: PW_KEY },
      create: { key: PW_KEY, valueRu: newPw },
      update: { valueRu: newPw },
    }).catch((e) => console.error("[payme] ChangePassword store failed:", (e as Error).message));
    console.log(`[payme] ChangePassword → key rotated | auth=ok`);
    return jsonRpc(id, { result: { success: true } });
  }

  // Any unexpected throw still comes back as JSON-RPC + HTTP 200, never a 500
  // HTML page (which Payme's client renders as "[object Object]").
  try {
    const response = await handlePayme(body, prismaPaymeRepo(), authorized);
    const outcome = "error" in response ? `error ${response.error.code}` : "result";
    console.log(`[payme] ${method} → ${outcome} | auth=${authorized ? "ok" : why}`);
    return NextResponse.json(response, { status: 200 });
  } catch (e) {
    console.error(`[payme] ${method} threw:`, (e as Error).stack ?? (e as Error).message);
    return jsonRpc(id, { error: { code: PaymeError.SYSTEM_ERROR, message: paymeMessage(PaymeError.SYSTEM_ERROR) } });
  }
}

// A stray GET (health check, someone opening the URL) should not 405-loop.
export async function GET() {
  return NextResponse.json({ ok: true, service: "payme-merchant-api" }, { status: 200 });
}
