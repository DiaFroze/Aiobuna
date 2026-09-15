import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, sign, createHmac } from "node:crypto";
import { quoteBinanceAmount, matchesBinanceOrder, parseBinanceQuote, signBinanceRequest, verifyBinanceWebhook } from "../src/lib/domain/binance-pay";

vi.mock("server-only", () => ({}));
const database = vi.hoisted(() => ({
  topUp: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  botUser: { update: vi.fn() }, $transaction: vi.fn(),
}));
vi.mock("../src/lib/botDb", () => ({ botDb: database }));
import { binancePayReady } from "../src/lib/services/binance-pay-client";
import { createBinanceCheckout, reconcileBinancePayment } from "../src/lib/services/binance-pay";

const quote = { version: 1 as const, currency: "USDT", amount: "2.00000000", uzsPerUnit: "12500", prepayId: "p123" };
const order = { merchantTradeNo: "trade123", prepayId: "p123", status: "PAID", currency: "USDT", orderAmount: "2.0", transactionId: "tx123" };
const row = { id: 1, userId: 7, amount: 25000, method: "binance", status: "pending", externalId: "trade123", txnRef: JSON.stringify(quote), expiresAt: new Date(Date.now() - 120_000) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BINANCE_PAY_ENABLED", "1");
  vi.stubEnv("BINANCE_PAY_API_KEY", "test-key");
  vi.stubEnv("BINANCE_PAY_API_SECRET", "test-secret");
  vi.stubEnv("BINANCE_PAY_CURRENCY", "USDT");
  vi.stubEnv("BINANCE_PAY_UZS_PER_UNIT", "12500");
  vi.stubEnv("BINANCE_PAY_WEBHOOK_URL", "https://shop.example/api/binance-pay");
  database.$transaction.mockImplementation(async fn => fn(database));
  database.topUp.findFirst.mockResolvedValue({ ...row });
  database.topUp.updateMany.mockResolvedValue({ count: 1 });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ status: "SUCCESS", code: "000000", data: order })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Binance Pay protocol and amounts", () => {
  it("rounds the locked conversion upwards at eight decimal places", () => {
    expect(quoteBinanceAmount(25000, "12500")).toBe("2.00000000");
    expect(quoteBinanceAmount(1, "3")).toBe("0.33333334");
    expect(() => quoteBinanceAmount(-1, "3")).toThrow();
    expect(() => quoteBinanceAmount(100, "0")).toThrow();
    expect(() => quoteBinanceAmount(NaN, "3")).toThrow();
  });
  it("requires matching trade, prepay ID, amount and currency", () => {
    expect(matchesBinanceOrder("trade123", quote, order)).toBe(true);
    for (const patch of [{ currency: "USDC" }, { orderAmount: "1.99999999" }, { orderAmount: "NaN" }, { merchantTradeNo: "other" }, { prepayId: "other" }]) {
      expect(matchesBinanceOrder("trade123", quote, { ...order, ...patch })).toBe(false);
    }
    expect(() => parseBinanceQuote(null)).toThrow();
  });
  it("signs the exact request bytes including trailing newline", () => {
    const expected = createHmac("sha512", "secret").update('123\nnonce\n{"x":1}\n').digest("hex").toUpperCase();
    expect(signBinanceRequest('{"x":1}', "123", "nonce", "secret")).toBe(expected);
  });
  it("accepts RSA signatures but rejects tampered bodies, headers and keys", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const body = '{"bizType":"PAY"}';
    const timestamp = "1700000000000";
    const nonce = "a".repeat(32);
    const signature = sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), privateKey).toString("base64");
    const headers = new Headers({ "BinancePay-Timestamp": timestamp, "BinancePay-Nonce": nonce, "BinancePay-Signature": signature });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyBinanceWebhook(body, headers, pem)).toBe(true);
    expect(verifyBinanceWebhook(body + " ", headers, pem)).toBe(false);
    expect(verifyBinanceWebhook(body, headers, "bad key")).toBe(false);
    headers.set("BinancePay-Timestamp", "1700000000001");
    expect(verifyBinanceWebhook(body, headers, pem)).toBe(false);
  });
  it("hides checkout until credentials, HTTPS and rate are configured", () => {
    expect(binancePayReady()).toBe(true);
    vi.stubEnv("BINANCE_PAY_UZS_PER_UNIT", "");
    expect(binancePayReady()).toBe(false);
    vi.stubEnv("BINANCE_PAY_UZS_PER_UNIT", "12500");
    vi.stubEnv("BINANCE_PAY_API_SECRET", "");
    expect(binancePayReady()).toBe(false);
  });
});

describe("Binance checkout and settlement", () => {
  it("persists price and recipient before calling Binance and uses virtual goods", async () => {
    database.topUp.create.mockResolvedValue({ id: 1 });
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      expect(database.topUp.create).toHaveBeenCalledOnce();
      const payload = JSON.parse(String(init?.body));
      expect(payload.orderAmount).toBe("2.00000000");
      expect(payload.goodsDetails[0].goodsType).toBe("02");
      expect(payload.merchantTradeNo).toMatch(/^[a-f0-9]{32}$/);
      return Response.json({ status: "SUCCESS", code: "000000", data: { prepayId: "p123", checkoutUrl: "https://pay.binance.com/checkout/123", currency: "USDT", totalFee: "2" } });
    });
    const note = "buy:9:1:alice:12345";
    expect(await createBinanceCheckout({ userId: 7, amount: 25000, note, refSpend: 2, label: "Canva" })).toEqual({ url: "https://pay.binance.com/checkout/123", amount: "2", currency: "USDT" });
    expect(database.topUp.create.mock.calls[0][0].data).toMatchObject({ note, refSpend: 2, amount: 25000, method: "binance" });
  });
  it("retains pending state after an ambiguous create timeout", async () => {
    database.topUp.create.mockResolvedValue({ id: 1 });
    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));
    await expect(createBinanceCheckout({ userId: 7, amount: 25000, note: "buy:1:1", refSpend: 0, label: "Canva" })).rejects.toThrow();
    expect(database.topUp.updateMany).not.toHaveBeenCalled();
  });
  it("credits UZS only once when poller and webhook race, even after local expiry", async () => {
    let claimed = false;
    database.topUp.updateMany.mockImplementation(async args => {
      expect(args.where).toMatchObject({ id: 1, status: "pending", method: "binance", externalId: "trade123" });
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    await Promise.all([reconcileBinancePayment("trade123"), reconcileBinancePayment("trade123")]);
    expect(database.botUser.update).toHaveBeenCalledOnce();
    expect(database.botUser.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { balance: { increment: 25000 } } });
  });
  it.each(["PENDING", "EXPIRED", "CANCELED", "REFUNDED"])("does not credit %s orders", async status => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ status: "SUCCESS", code: "000000", data: { ...order, status } }));
    await reconcileBinancePayment("trade123");
    expect(database.botUser.update).not.toHaveBeenCalled();
  });
  it("rejects an amount mismatch and does not settle the top-up", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ status: "SUCCESS", code: "000000", data: { ...order, orderAmount: "1" } }));
    await expect(reconcileBinancePayment("trade123")).rejects.toThrow("mismatch");
    expect(database.topUp.updateMany).not.toHaveBeenCalled();
    expect(database.botUser.update).not.toHaveBeenCalled();
  });
  it("still settles existing payments when new checkouts are disabled", async () => {
    vi.stubEnv("BINANCE_PAY_ENABLED", "0");
    expect(await reconcileBinancePayment("trade123")).toBe("settled");
    expect(database.botUser.update).toHaveBeenCalledOnce();
  });
  it("does not credit a missing or already approved top-up", async () => {
    database.topUp.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...row, status: "approved" });
    expect(await reconcileBinancePayment("other")).toBe("missing");
    expect(await reconcileBinancePayment("trade123")).toBe("settled");
    expect(fetch).not.toHaveBeenCalled();
    expect(database.botUser.update).not.toHaveBeenCalled();
  });
});
