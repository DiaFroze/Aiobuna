import "server-only";
import { randomBytes } from "node:crypto";
import { botDb } from "../botDb";
import { binanceCredentialsReady, binancePayReady, binanceRequest, BinanceApiError } from "./binance-pay-client";
import { matchesBinanceOrder, parseBinanceQuote, quoteBinanceAmount, type BinanceOrder, type BinanceQuote } from "../domain/binance-pay";

// TopUp.amount remains UZS. txnRef stores the immutable, versioned crypto quote;
// externalId is the unique merchant trade number, never a browser return value.
export async function createBinanceCheckout(input: { userId: number; amount: number; note: string; refSpend: number; label: string }) {
  if (!binancePayReady()) throw new Error("Binance Pay is not configured");
  const currency = process.env.BINANCE_PAY_CURRENCY ?? "USDT";
  const uzsPerUnit = process.env.BINANCE_PAY_UZS_PER_UNIT!;
  const quote: BinanceQuote = { version: 1, currency, uzsPerUnit, amount: quoteBinanceAmount(input.amount, uzsPerUnit) };
  const externalId = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  const topup = await botDb.topUp.create({ data: {
    userId: input.userId, amount: input.amount, note: input.note, refSpend: input.refSpend,
    method: "binance", status: "pending", externalId, txnRef: JSON.stringify(quote), expiresAt,
  } });
  // Persist before the network request. A timeout may still have created an
  // order; reconciliation queries this same trade number after a restart.
  const description = input.label.replace(/[^\p{L}\p{N} .,+()\-]/gu, " ").trim().slice(0, 256) || "AI OBUNA subscription";
  const result = await binanceRequest<{ prepayId: string; checkoutUrl: string; currency: string; totalFee: string }>("/binancepay/openapi/v3/order", {
    env: { terminalType: "WAP" }, merchantTradeNo: externalId,
    orderAmount: quote.amount, currency, description, orderExpireTime: expiresAt.getTime(),
    webhookUrl: process.env.BINANCE_PAY_WEBHOOK_URL,
    goodsDetails: [{ goodsType: "02", goodsCategory: "Z000", referenceGoodsId: String(topup.id), goodsName: description }],
  });
  if (!matchesBinanceOrder(externalId, quote, { merchantTradeNo: externalId, prepayId: result.prepayId, status: "INITIAL", currency: result.currency, orderAmount: String(result.totalFee) })) throw new Error("Binance Pay checkout amount mismatch");
  const url = new URL(result.checkoutUrl);
  if (url.protocol !== "https:" || !(url.hostname === "binance.com" || url.hostname.endsWith(".binance.com")) || url.username || url.password) throw new Error("Invalid Binance Pay checkout URL");
  await botDb.topUp.updateMany({ where: { id: topup.id, method: "binance", status: "pending" }, data: { txnRef: JSON.stringify({ ...quote, prepayId: result.prepayId }) } });
  return { url: url.toString(), amount: quote.amount.replace(/\.?0+$/, ""), currency };
}

export async function reconcileBinancePayment(tradeNo: string): Promise<"missing" | "pending" | "settled"> {
  const topup = await botDb.topUp.findFirst({ where: { method: "binance", externalId: tradeNo } });
  if (!topup) return "missing";
  if (topup.status === "approved" || topup.status === "rejected") return "settled";
  const quote = parseBinanceQuote(topup.txnRef);
  let order: BinanceOrder;
  try {
    order = await binanceRequest<BinanceOrder>("/binancepay/openapi/v2/order/query", { merchantTradeNo: tradeNo });
  } catch (error) {
    if (error instanceof BinanceApiError && error.code === "400202" && topup.expiresAt && topup.expiresAt.getTime() < Date.now() - 60_000) {
      await botDb.topUp.updateMany({ where: { id: topup.id, method: "binance", status: "pending" }, data: { status: "rejected" } });
      return "settled";
    }
    throw error;
  }
  if (!matchesBinanceOrder(tradeNo, quote, order)) throw new Error("Binance Pay order mismatch");
  if (["CANCELED", "EXPIRED"].includes(order.status)) {
    await botDb.topUp.updateMany({ where: { id: topup.id, method: "binance", status: "pending" }, data: { status: "rejected" } });
    return "settled";
  }
  if (order.status !== "PAID") return "pending";
  if (!order.transactionId) throw new Error("Binance Pay transaction ID missing");
  await botDb.$transaction(async tx => {
    const claimed = await tx.topUp.updateMany({
      where: { id: topup.id, method: "binance", externalId: tradeNo, status: "pending" },
      data: { status: "approved", txnRef: JSON.stringify({ ...quote, prepayId: order.prepayId, transactionId: order.transactionId }) },
    });
    if (claimed.count !== 1) return;
    await tx.botUser.update({ where: { id: topup.userId }, data: { balance: { increment: topup.amount } } });
  });
  return "settled";
}

let polling = false;
let cursor = 0;
export async function reconcilePendingBinancePayments(): Promise<void> {
  // Disabling new checkouts must not abandon payments already in flight.
  if (polling || !binanceCredentialsReady()) return;
  polling = true;
  try {
    const rows = await botDb.topUp.findMany({ where: {
      method: "binance", status: "pending", id: { gt: cursor }, createdAt: { lt: new Date(Date.now() - 30_000) },
    }, orderBy: { id: "asc" }, take: 10 });
    if (!rows.length) { cursor = 0; return; }
    for (const row of rows) {
      cursor = row.id;
      if (row.externalId) await reconcileBinancePayment(row.externalId).catch(() => {
        console.error(`[binance] reconciliation failed for top-up ${row.id}; will retry`);
      });
    }
  } finally { polling = false; }
}
