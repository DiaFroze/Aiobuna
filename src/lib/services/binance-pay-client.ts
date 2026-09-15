import "server-only";
import { randomBytes } from "node:crypto";
import { signBinanceRequest, verifyBinanceWebhook } from "../domain/binance-pay";

export function binanceCredentialsReady(): boolean {
  return !!(process.env.BINANCE_PAY_API_KEY?.trim() && process.env.BINANCE_PAY_API_SECRET?.trim());
}

export function binancePayReady(): boolean {
  try {
    const rate = Number(process.env.BINANCE_PAY_UZS_PER_UNIT);
    const url = new URL(process.env.BINANCE_PAY_WEBHOOK_URL ?? "");
    return process.env.BINANCE_PAY_ENABLED === "1" && binanceCredentialsReady() &&
      Number.isFinite(rate) && rate > 0 && url.protocol === "https:" &&
      /^(USDT|USDC)$/.test(process.env.BINANCE_PAY_CURRENCY ?? "USDT");
  } catch { return false; }
}

export class BinanceApiError extends Error {
  constructor(public readonly code: string) { super(`Binance Pay API error (${code})`); }
}

export async function binanceRequest<T>(path: string, data: object): Promise<T> {
  if (!binanceCredentialsReady()) throw new Error("Binance Pay credentials missing");
  const body = JSON.stringify(data);
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const response = await fetch(`https://bpay.binanceapi.com${path}`, {
    method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: {
      "Content-Type": "application/json", "BinancePay-Timestamp": timestamp,
      "BinancePay-Nonce": nonce, "BinancePay-Certificate-SN": process.env.BINANCE_PAY_API_KEY!.trim(),
      "BinancePay-Signature": signBinanceRequest(body, timestamp, nonce, process.env.BINANCE_PAY_API_SECRET!.trim()),
    }, body,
  });
  if (!response.ok) throw new BinanceApiError(`HTTP_${response.status}`);
  const result = await response.json() as { status?: string; code?: string; data?: T };
  if (result.status !== "SUCCESS" || result.code !== "000000" || !result.data) throw new BinanceApiError(result.code ?? "INVALID_RESPONSE");
  return result.data;
}

let certificates: { expires: number; values: Array<{ certSerial: string; certPublic: string }> } | undefined;
let refreshing: Promise<void> | undefined;
export async function authenticateBinanceWebhook(body: string, headers: Headers): Promise<boolean> {
  const serial = headers.get("BinancePay-Certificate-SN");
  if (!serial || !headers.get("BinancePay-Signature") || !headers.get("BinancePay-Timestamp") || !headers.get("BinancePay-Nonce")) return false;
  if (!certificates || certificates.expires < Date.now()) {
    refreshing ??= binanceRequest<Array<{ certSerial: string; certPublic: string }>>("/binancepay/openapi/certificates", {})
      .then(values => { certificates = { values, expires: Date.now() + 60_000 }; })
      .finally(() => { refreshing = undefined; });
    await refreshing;
  }
  const certificate = certificates?.values.find(c => c.certSerial === serial);
  return !!certificate && verifyBinanceWebhook(body, headers, certificate.certPublic);
}
