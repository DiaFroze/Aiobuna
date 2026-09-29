import { createHash } from "node:crypto";
import { botDb } from "@/lib/botDb";

type MetaEventName = "Lead" | "Purchase";

function conversionConfig() {
  const token = (process.env.META_CAPI_ACCESS_TOKEN ?? "").trim();
  const datasetId = (process.env.META_DATASET_ID ?? "").trim();
  const apiVersion = (process.env.META_API_VERSION ?? "v20.0").trim();
  return { token, datasetId, apiVersion, configured: Boolean(token && datasetId) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function userData(tgId: string) {
  // Telegram IDs are pseudonymous personal data: never send the raw ID, name,
  // username, phone number, IP address, or message contents to Meta.
  return { external_id: [sha256(tgId.trim())] };
}

async function enqueue(eventId: string, eventName: MetaEventName, event: Record<string, unknown>) {
  await botDb.metaConversionEvent.createMany({
    data: [{ eventId, eventName, payload: event as object }],
    skipDuplicates: true,
  });
  void dispatchMetaConversions().catch((error) => {
    console.error("[meta-capi] dispatch failed:", error instanceof Error ? error.message : "unknown error");
  });
}

export async function enqueueMetaLead(input: {
  userId: number;
  telegramId: string;
  adCode: string;
  eventTime?: Date;
}) {
  const eventTime = input.eventTime ?? new Date();
  await enqueue(`lead_${input.userId}_${input.adCode}`, "Lead", {
    event_name: "Lead",
    event_time: Math.floor(eventTime.getTime() / 1000),
    event_id: `lead_${input.userId}_${input.adCode}`,
    action_source: "chat",
    user_data: userData(input.telegramId),
    custom_data: { ad_code: input.adCode },
  });
}

export async function enqueueMetaPurchase(input: {
  orderId: number;
  telegramId: string;
  adCode: string | null;
  valueUzs: number;
  eventTime?: Date;
}) {
  if (!input.adCode || !Number.isFinite(input.valueUzs) || input.valueUzs <= 0) return;
  const eventTime = input.eventTime ?? new Date();
  const eventId = `purchase_${input.orderId}`;
  await enqueue(eventId, "Purchase", {
    event_name: "Purchase",
    event_time: Math.floor(eventTime.getTime() / 1000),
    event_id: eventId,
    action_source: "chat",
    user_data: userData(input.telegramId),
    custom_data: {
      currency: "UZS",
      value: input.valueUzs,
      order_id: String(input.orderId),
      ad_code: input.adCode,
    },
  });
}

/** Sends queued events with stable event_id values; Meta deduplicates retries. */
export async function dispatchMetaConversions(limit = 25): Promise<{ sent: number; configured: boolean }> {
  const config = conversionConfig();
  if (!config.configured) return { sent: 0, configured: false };

  const rows = await botDb.metaConversionEvent.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
  });
  let sent = 0;

  for (const row of rows) {
    await botDb.metaConversionEvent.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    try {
      const response = await fetch(
        `https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(config.datasetId)}/events?access_token=${encodeURIComponent(config.token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ data: [row.payload] }),
          cache: "no-store",
        },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.error || (typeof result.events_received === "number" && result.events_received < 1)) {
        const message = typeof result.error?.message === "string" ? result.error.message : `Meta API HTTP ${response.status}`;
        await botDb.metaConversionEvent.update({
          where: { id: row.id },
          data: { status: "pending", lastError: message.slice(0, 500) },
        });
        continue;
      }
      await botDb.metaConversionEvent.update({
        where: { id: row.id },
        data: { status: "sent", sentAt: new Date(), lastError: null },
      });
      sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network error";
      await botDb.metaConversionEvent.update({
        where: { id: row.id },
        data: { status: "pending", lastError: message.slice(0, 500) },
      }).catch(() => {});
    }
  }
  return { sent, configured: true };
}

export function isMetaConversionsConfigured(): boolean {
  return conversionConfig().configured;
}

export async function getMetaConversionsStatus() {
  const model = botDb.metaConversionEvent;
  if (!model) return { configured: isMetaConversionsConfigured(), pending: 0, sent: 0, failed: 0 };
  const [pending, sent, failed] = await Promise.all([
    model.count({ where: { status: "pending" } }).catch(() => 0),
    model.count({ where: { status: "sent" } }).catch(() => 0),
    model.count({ where: { status: "failed" } }).catch(() => 0),
  ]);
  return { configured: isMetaConversionsConfigured(), pending, sent, failed };
}
