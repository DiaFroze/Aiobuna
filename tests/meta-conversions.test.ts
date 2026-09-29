import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  metaConversionEvent: {
    createMany: vi.fn(),
    count: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/botDb", () => ({ botDb: mocks }));

import { dispatchMetaConversions, enqueueMetaLead, enqueueMetaPurchase } from "@/lib/services/meta-conversions";

describe("Meta Conversions API outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.META_CAPI_ACCESS_TOKEN;
    delete process.env.META_DATASET_ID;
    process.env.META_API_VERSION = "v21.0";
  });

  it("queues one pseudonymous, idempotent Lead event per user and ad code", async () => {
    const eventTime = new Date("2026-09-30T10:00:00Z");
    await enqueueMetaLead({ userId: 42, telegramId: "123456789", adCode: "reel_a", eventTime });

    const row = mocks.metaConversionEvent.createMany.mock.calls[0][0].data[0];
    expect(row.eventId).toBe("lead_42_reel_a");
    expect(row.eventName).toBe("Lead");
    expect(row.payload.event_time).toBe(Math.floor(eventTime.getTime() / 1000));
    expect(row.payload.user_data.external_id).toEqual([
      createHash("sha256").update("123456789").digest("hex"),
    ]);
    expect(JSON.stringify(row.payload)).not.toContain("123456789");
    expect(mocks.metaConversionEvent.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it("queues purchases only when they have ad attribution and positive value", async () => {
    await enqueueMetaPurchase({ orderId: 9, telegramId: "123", adCode: null, valueUzs: 50_000 });
    await enqueueMetaPurchase({ orderId: 10, telegramId: "123", adCode: "reel_a", valueUzs: 0 });
    expect(mocks.metaConversionEvent.createMany).not.toHaveBeenCalled();

    await enqueueMetaPurchase({ orderId: 11, telegramId: "123", adCode: "reel_a", valueUzs: 50_000 });
    const row = mocks.metaConversionEvent.createMany.mock.calls[0][0].data[0];
    expect(row.eventId).toBe("purchase_11");
    expect(row.payload.event_name).toBe("Purchase");
    expect(row.payload.custom_data).toMatchObject({ currency: "UZS", value: 50_000, order_id: "11", ad_code: "reel_a" });
  });

  it("keeps events pending until the dataset token is configured", async () => {
    await expect(dispatchMetaConversions()).resolves.toEqual({ sent: 0, configured: false });
    expect(mocks.metaConversionEvent.findMany).not.toHaveBeenCalled();
  });
});
