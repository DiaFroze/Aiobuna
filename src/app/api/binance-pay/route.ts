import { NextResponse } from "next/server";
import { authenticateBinanceWebhook } from "@/lib/services/binance-pay-client";
import { reconcileBinancePayment } from "@/lib/services/binance-pay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const reply = (success: boolean) => NextResponse.json({ returnCode: success ? "SUCCESS" : "FAIL", returnMessage: null });
  try {
    const body = await req.text();
    if (Buffer.byteLength(body) > 64_000 || !await authenticateBinanceWebhook(body, req.headers)) return reply(false);
    const event = JSON.parse(body);
    if (event.bizType !== "PAY" || !["PAY_SUCCESS", "PAY_CLOSED"].includes(event.bizStatus)) return reply(true);
    const data = JSON.parse(event.data);
    if (typeof data.merchantTradeNo !== "string" || !/^[a-zA-Z0-9]{1,32}$/.test(data.merchantTradeNo)) return reply(false);
    // Query our merchant account for authoritative amount/currency/status.
    // The webhook and reconciliation poller share one atomic credit path.
    const result = await reconcileBinancePayment(data.merchantTradeNo);
    return reply(result === "settled");
  } catch {
    console.error("[binance] webhook processing failed; provider should retry");
    return reply(false);
  }
}
