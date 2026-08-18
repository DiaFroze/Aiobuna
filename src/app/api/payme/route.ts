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
//  - Always answer HTTP 200. Payme treats any non-200 as transport error
//    -32400 and keeps retrying, so business errors go in the JSON body.
//  - Auth is HTTP Basic: login "Paycom", password = the merchant KEY.
//  - Payme can rotate the key via ChangePassword; the current key is then kept
//    in BotSetting("payme_password") and takes precedence over PAYME_KEY, so
//    the old key stops working. The key is never logged.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PW_KEY = "payme_password"; // DB-stored current key after a ChangePassword

async function currentKey(): Promise<string> {
  const row = await botDb.setting.findUnique({ where: { key: PW_KEY } }).catch(() => null);
  const override = row?.valueRu?.trim();
  return override && override.length > 0 ? override : env.paymeKey();
}

function extractPassword(header: string | null): string | null {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    // "Paycom:<key>" — everything after the first colon is the password.
    return decoded.slice(decoded.indexOf(":") + 1);
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
  const key = await currentKey();
  const keyOk = matches(password, key);
  const authorized = enabled && keyOk;
  const why = !enabled ? "DISABLED: set PAYME_ENABLED=1" : !keyOk ? "BAD KEY: PAYME_KEY != sandbox/prod key" : "ok";

  // Parse the body ourselves so a malformed payload is a clean -32700 rather
  // than a thrown 500 (which Payme would read as a transport failure).
  let body: unknown = null;
  let parseFailed = false;
  try {
    body = await req.json();
  } catch {
    parseFailed = true;
  }
  if (parseFailed) {
    const code = authorized ? PaymeError.PARSE_ERROR : PaymeError.INSUFFICIENT_PRIVILEGE;
    return jsonRpc(null, { error: { code, message: paymeMessage(code) } });
  }

  const id = (body as { id?: unknown })?.id ?? null;
  const method = (body as { method?: string })?.method ?? "?";

  // ChangePassword rotates the merchant key. Handled here (not in the pure
  // protocol core) because it is an auth-layer concern: on success the new key
  // is stored and immediately becomes the only accepted key.
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

  // Any unexpected throw must still come back as JSON-RPC + HTTP 200, never a
  // 500 HTML page (which Payme's client shows as "[object Object]"). Also
  // guards NextResponse.json against a stray BigInt.
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
