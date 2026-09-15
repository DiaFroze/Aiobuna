import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), reconcile: vi.fn() }));
vi.mock("../src/lib/services/binance-pay-client", () => ({ authenticateBinanceWebhook: mocks.authenticate }));
vi.mock("../src/lib/services/binance-pay", () => ({ reconcileBinancePayment: mocks.reconcile }));
import { POST } from "../src/app/api/binance-pay/route";

const event = { bizType: "PAY", bizStatus: "PAY_SUCCESS", data: JSON.stringify({ merchantTradeNo: "trade123" }) };
const request = (data: unknown) => new Request("https://shop.example/api/binance-pay", { method: "POST", body: JSON.stringify(data) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue(true);
  mocks.reconcile.mockResolvedValue("settled");
});
describe("Binance webhook", () => {
  it("acknowledges a settled payment with Binance's response format", async () => {
    const response = await POST(request(event));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ returnCode: "SUCCESS", returnMessage: null });
    expect(mocks.reconcile).toHaveBeenCalledWith("trade123");
    expect(mocks.authenticate.mock.calls[0][0]).toBe(JSON.stringify(event));
  });
  it("never processes an unverified notification", async () => {
    mocks.authenticate.mockResolvedValue(false);
    expect((await (await POST(request(event))).json()).returnCode).toBe("FAIL");
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it.each(["pending", "missing"])("asks Binance to retry when the order is %s", async result => {
    mocks.reconcile.mockResolvedValue(result);
    expect((await (await POST(request(event))).json()).returnCode).toBe("FAIL");
  });
  it("uses authoritative reconciliation even for a close notification", async () => {
    expect((await (await POST(request({ ...event, bizStatus: "PAY_CLOSED" }))).json()).returnCode).toBe("SUCCESS");
    expect(mocks.reconcile).toHaveBeenCalledOnce();
  });
  it("ignores other event types and rejects invalid order IDs", async () => {
    await POST(request({ ...event, bizType: "REFUND" }));
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect((await (await POST(request({ ...event, data: '{"merchantTradeNo":"bad/id"}' }))).json()).returnCode).toBe("FAIL");
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
