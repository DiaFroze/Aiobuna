import { createHmac, verify } from "node:crypto";
import { Prisma } from "@prisma/client";

export function signBinanceRequest(body: string, timestamp: string, nonce: string, secret: string): string {
  return createHmac("sha512", secret).update(`${timestamp}\n${nonce}\n${body}\n`).digest("hex").toUpperCase();
}

export function verifyBinanceWebhook(body: string, headers: Headers, publicKey: string): boolean {
  const timestamp = headers.get("BinancePay-Timestamp") ?? "";
  const nonce = headers.get("BinancePay-Nonce") ?? "";
  const signature = headers.get("BinancePay-Signature") ?? "";
  if (!/^\d{13}$/.test(timestamp) || !/^[a-zA-Z0-9]{32}$/.test(nonce) || !signature) return false;
  // Delayed provider retries remain valid; database CAS prevents replay credits.
  try {
    return verify("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), publicKey, Buffer.from(signature, "base64"));
  } catch { return false; }
}

export function quoteBinanceAmount(amountUzs: number, uzsPerUnit: string): string {
  const rate = new Prisma.Decimal(uzsPerUnit);
  if (!Number.isFinite(amountUzs) || amountUzs <= 0 || !rate.isFinite() || rate.lte(0)) throw new Error("Invalid Binance Pay quote");
  return new Prisma.Decimal(amountUzs).div(rate).toDecimalPlaces(8, Prisma.Decimal.ROUND_UP).toFixed(8);
}

export type BinanceQuote = { version: 1; currency: string; amount: string; uzsPerUnit: string; prepayId?: string };

export function parseBinanceQuote(value: string | null): BinanceQuote {
  const q = JSON.parse(value ?? "null") as BinanceQuote | null;
  if (!q || q.version !== 1 || !/^[A-Z0-9]{2,12}$/.test(q.currency) || !/^\d+\.\d{8}$/.test(q.amount) || new Prisma.Decimal(q.amount).lte(0)) {
    throw new Error("Invalid stored Binance Pay quote");
  }
  return q;
}

export type BinanceOrder = {
  merchantTradeNo: string; prepayId: string; status: string;
  currency: string; orderAmount: string; transactionId?: string;
};

export function matchesBinanceOrder(tradeNo: string, quote: BinanceQuote, order: BinanceOrder): boolean {
  try {
    return order.merchantTradeNo === tradeNo && typeof order.prepayId === "string" && !!order.prepayId &&
      (!quote.prepayId || quote.prepayId === order.prepayId) && order.currency === quote.currency &&
      typeof order.orderAmount === "string" && new Prisma.Decimal(order.orderAmount).eq(quote.amount);
  } catch { return false; }
}
