import { afterEach, describe, expect, it, vi } from "vitest";
import { reserveSharedAmount, effectiveOperationTime } from "../src/lib/services/shared-card-bridge";
import { processBankMessage } from "../src/lib/services/humo-monitor";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function bridge() {
  vi.stubEnv("CARD_COORDINATOR_URL", "https://coordinator.example");
  vi.stubEnv("CARD_COORDINATOR_SECRET", "x".repeat(32));
}
function existingNotification() {
  const notification: any = {id: 1, status: "unmatched", matchedRequestId: null};
  const request: any = {id: 2, status: "pending", totalAmount: 13012};
  const db: any = {
    bankNotification: {
      findUnique: vi.fn(async () => notification),
      create: vi.fn(),
      updateMany: vi.fn(async ({where, data}: any) => {
        if (notification.status !== where.status) return {count: 0};
        Object.assign(notification, data); return {count: 1};
      }),
    },
    cardPaymentRequest: {
      findFirst: vi.fn(async () => request),
      updateMany: vi.fn(async ({where, data}: any) => {
        if (request.status !== where.status) return {count: 0};
        Object.assign(request, data); return {count: 1};
      }),
    },
  };
  db.$transaction = async (callback: any) => callback(db);
  return {db, notification, request};
}
describe("Shared card coordination", () => {
  it("uses original transport seconds only inside the bank operation minute", () => {
    const bank = new Date("2026-10-01T01:00:00Z");
    const received = new Date("2026-10-01T01:00:42Z");
    expect(effectiveOperationTime("01:00", bank, received)).toBe(received);
    expect(effectiveOperationTime("01:00:00", bank, received)).toBe(bank);
    expect(effectiveOperationTime("01:00", bank, new Date("2026-10-01T01:02:42Z"))).toBe(bank);
  });
  it("fails closed instead of falling back to random local amounts", async () => {
    bridge(); vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {status: 503})));
    await expect(reserveSharedAmount(13000, "3456", 900)).rejects.toThrow("unavailable");
  });
  it("sends authenticated reservation requests and validates returned amounts", async () => {
    bridge();const fetcher = vi.fn(async () => new Response(JSON.stringify({total_amount: 13012})));
    vi.stubGlobal("fetch", fetcher);
    expect(await reserveSharedAmount(13000, "3456", 900)).toEqual({totalAmount: 13012, extraAmount: 12});
    const call = fetcher.mock.calls[0] as any;
    expect(call[0]).toBe("https://coordinator.example/api/card-bridge/reservations");
    expect(call[1].headers.Authorization).toBe("Bearer " + "x".repeat(32));
    expect(JSON.parse(call[1].body).card_last4).toBe("3456");
  });
  it("retries an interrupted local confirmation without creating another notification", async () => {
    bridge();vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({status: "matched", project: "sb.eu"}))));
    const {db, request} = existingNotification();
    const text = "HUMO *3456: Kirim +13 012.00 UZS";
    expect((await processBankMessage(db, "123", 5, text, new Date())).matched).toBe(true);
    expect((await processBankMessage(db, "123", 5, text, new Date())).matched).toBe(true);
    expect(request.status).toBe("confirmed");
    expect(db.bankNotification.create).not.toHaveBeenCalled();
    expect(db.cardPaymentRequest.updateMany).toHaveBeenCalledTimes(1);
  });
  it("does not approve a payment assigned to the other shop", async () => {
    bridge();vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({status: "matched", project: "tstars"}))));
    const {db, request} = existingNotification();
    expect((await processBankMessage(db, "123", 5, "HUMO *3456: Kirim +13 012 UZS", new Date())).matched).toBe(false);
    expect(request.status).toBe("pending");
    expect(db.cardPaymentRequest.updateMany).not.toHaveBeenCalled();
  });
  it("does not assign an incoming transfer to an assumed receiving card", async () => {
    bridge();vi.stubEnv("HUMO_CARD_LAST4", "3456");
    const fetcher=vi.fn();vi.stubGlobal("fetch", fetcher);
    const {db, request} = existingNotification();
    expect((await processBankMessage(db, "123", 5, "Kirim +13 012 UZS", new Date())).matched).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();expect(request.status).toBe("pending");
  });
});
