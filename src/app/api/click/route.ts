import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { handleClick, type ClickParams } from "@/lib/domain/click";
import { prismaClickRepo } from "@/lib/services/click-repo";

// Click SHOP-API callbacks. Click POSTs application/x-www-form-urlencoded to this
// one URL for both Prepare (action=0) and Complete (action=1); set it as BOTH
// the Prepare and Complete URL in the merchant cabinet. See docs/CLICK_SETUP.md.
// The response is JSON. The secret key is never logged.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readParams(req: Request): Promise<ClickParams> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return (await req.json().catch(() => ({}))) as ClickParams;
  }
  // form-urlencoded (Click's default) or multipart
  const form = await req.formData().catch(() => null);
  if (!form) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) out[k] = String(v);
  return out as ClickParams;
}

export async function POST(req: Request) {
  const params = await readParams(req);
  const response = await handleClick(params, env.clickSecretKey(), prismaClickRepo());
  console.log(`[click] action=${params.action ?? "?"} order=${params.merchant_trans_id ?? "?"} → error ${response.error}`);
  return NextResponse.json(response, { status: 200 });
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "click-merchant-api" }, { status: 200 });
}
