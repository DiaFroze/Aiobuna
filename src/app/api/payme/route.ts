import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { handlePayme, PaymeError } from "@/lib/domain/payme";
import { prismaPaymeRepo } from "@/lib/services/payme-repo";

// Payme Merchant API endpoint. Payme's servers POST JSON-RPC 2.0 here; the
// browser redirect is NOT this route and never confirms a payment. See
// docs/PAYME_SETUP.md.
//
// Protocol notes:
//  - Always answer HTTP 200. Payme treats any non-200 as transport error
//    -32400 and keeps retrying, so business errors go in the JSON body.
//  - Auth is HTTP Basic: login "Paycom", password = the merchant KEY. On
//    mismatch (or while the feature is disabled) we return -32504.
//  - The KEY is never logged.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function passwordMatches(header: string | null, key: string): boolean {
  if (!header || !header.startsWith("Basic ") || !key) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  // "Paycom:<key>" — everything after the first colon is the password.
  const password = decoded.slice(decoded.indexOf(":") + 1);
  const a = Buffer.from(password, "utf8");
  const b = Buffer.from(key, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const authorized = env.paymeEnabled() && passwordMatches(req.headers.get("authorization"), env.paymeKey());

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
    // Still gate on auth first, so we never reveal parse behaviour to a caller
    // that hasn't authenticated.
    const code = authorized ? PaymeError.PARSE_ERROR : PaymeError.INSUFFICIENT_PRIVILEGE;
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code, message: "" } }, { status: 200 });
  }

  const response = await handlePayme(body, prismaPaymeRepo(), authorized);
  return NextResponse.json(response, { status: 200 });
}

// A stray GET (health check, someone opening the URL) should not 405-loop.
export async function GET() {
  return NextResponse.json({ ok: true, service: "payme-merchant-api" }, { status: 200 });
}
