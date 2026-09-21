import "server-only";
import { botDb } from "@/lib/botDb";

export interface MetaConfig {
  configured: boolean;
  token?: string;
  adAccountId?: string;
  apiVersion: string;
  appId?: string;
  appSecret?: string;
  usdUzsRate: number;
}

export interface MetaAccountInfo {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  accountStatus: number;
  amountSpent?: string;
}

export interface MetaInsightItem {
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  adset_name: string;
  ad_id: string;
  ad_name: string;
  spend: string;
  impressions: string;
  reach?: string;
  clicks: string;
  cpm?: string;
  cpc?: string;
  ctr?: string;
  date_start: string;
  date_stop: string;
  account_currency: string;
}

export interface MetaConnectionResult {
  ok: boolean;
  account?: MetaAccountInfo;
  error?: string;
  apiVersion?: string;
}

export interface MetaSyncResult {
  ok: boolean;
  syncedCount: number;
  createdCount: number;
  updatedCount: number;
  totalSpendUzs: number;
  unmappedCount: number;
  error?: string;
  timestamp: Date;
}

/**
 * Reads Meta Marketing API configuration safely from process.env.
 * Tokens are kept on the server and never exposed to the client.
 */
export function getMetaConfig(): MetaConfig {
  const token = (process.env.META_ACCESS_TOKEN ?? "").trim();
  let rawAccountId = (process.env.META_AD_ACCOUNT_ID ?? "").trim();
  const apiVersion = (process.env.META_API_VERSION ?? "v20.0").trim();
  const appId = (process.env.META_APP_ID ?? "").trim() || undefined;
  const appSecret = (process.env.META_APP_SECRET ?? "").trim() || undefined;

  const rateEnv = process.env.USD_UZS_RATE || process.env.USDT_UZS_RATE || "12800";
  const parsedRate = Number(rateEnv);
  const usdUzsRate = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 12800;

  if (!token || !rawAccountId) {
    return {
      configured: false,
      apiVersion,
      usdUzsRate,
    };
  }

  // Format ad account ID to standard Meta format (act_<numeric_id>)
  let adAccountId = rawAccountId;
  if (!adAccountId.startsWith("act_")) {
    adAccountId = `act_${adAccountId}`;
  }

  return {
    configured: true,
    token,
    adAccountId,
    apiVersion,
    appId,
    appSecret,
    usdUzsRate,
  };
}

/**
 * Checks connectivity and token validity against Meta Graph API.
 */
export async function checkMetaConnection(): Promise<MetaConnectionResult> {
  const config = getMetaConfig();
  if (!config.configured || !config.token || !config.adAccountId) {
    return {
      ok: false,
      error:
        "Не заданы переменные META_ACCESS_TOKEN или META_AD_ACCOUNT_ID в конфигурации окружения (.env).",
      apiVersion: config.apiVersion,
    };
  }

  const url = `https://graph.facebook.com/${config.apiVersion}/${config.adAccountId}?fields=id,name,account_status,currency,timezone_name,amount_spent&access_token=${encodeURIComponent(
    config.token,
  )}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      const err = data.error || {};
      const code = err.code;
      const subcode = err.error_subcode;
      let message = err.message || `Meta API Error (${res.status})`;

      if (code === 190) {
        message = "Срок действия токена Meta истёк или токен отозван (OAuthException 190). Требуется обновить META_ACCESS_TOKEN.";
      } else if (code === 200 || code === 294) {
        message = `Недостаточно прав доступа к рекламному аккаунту Meta (${code}). Убедитесь, что токен имеет разрешения ads_read и read_insights.`;
      } else if (code === 4 || code === 17 || code === 32 || code === 613) {
        message = "Превышен лимит запросов к Meta API (Rate limit). Повторите попытку через несколько минут.";
      } else if (code === 100) {
        message = `Неверный идентификатор рекламного аккаунта Meta (${config.adAccountId}). Проверьте META_AD_ACCOUNT_ID.`;
      }

      return {
        ok: false,
        error: message,
        apiVersion: config.apiVersion,
      };
    }

    return {
      ok: true,
      account: {
        id: data.id,
        name: data.name || data.id,
        currency: data.currency || "USD",
        timezone: data.timezone_name || "UTC",
        accountStatus: data.account_status ?? 1,
        amountSpent: data.amount_spent,
      },
      apiVersion: config.apiVersion,
    };
  } catch (e: any) {
    return {
      ok: false,
      error: `Ошибка сети при подключении к Meta API: ${e.message || String(e)}`,
      apiVersion: config.apiVersion,
    };
  }
}

/**
 * Fetches ad-level daily insights from Meta Marketing API.
 */
export async function fetchMetaInsights(params?: {
  datePreset?: string;
  timeRange?: { since: string; until: string };
}): Promise<{ ok: boolean; items: MetaInsightItem[]; error?: string }> {
  const config = getMetaConfig();
  if (!config.configured || !config.token || !config.adAccountId) {
    return {
      ok: false,
      items: [],
      error: "Meta API не настроен в .env.",
    };
  }

  const fields = [
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    "spend",
    "impressions",
    "reach",
    "clicks",
    "cpm",
    "cpc",
    "ctr",
    "date_start",
    "date_stop",
    "account_currency",
  ].join(",");

  let url = `https://graph.facebook.com/${config.apiVersion}/${config.adAccountId}/insights?level=ad&fields=${fields}&time_increment=1&limit=500&access_token=${encodeURIComponent(
    config.token,
  )}`;

  if (params?.timeRange) {
    url += `&time_range=${encodeURIComponent(JSON.stringify(params.timeRange))}`;
  } else {
    url += `&date_preset=${encodeURIComponent(params?.datePreset || "last_30d")}`;
  }

  const items: MetaInsightItem[] = [];

  try {
    let nextUrl: string | null = url;
    let pageCount = 0;

    while (nextUrl && pageCount < 10) {
      pageCount++;
      const currentUrl: string = nextUrl;
      const res: Response = await fetch(currentUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      const data: any = await res.json();
      if (!res.ok || data.error) {
        return {
          ok: false,
          items,
          error: data.error?.message || `Ошибка Meta Insights API (${res.status})`,
        };
      }

      if (Array.isArray(data.data)) {
        items.push(...data.data);
      }

      nextUrl = data.paging?.next || null;
    }

    return { ok: true, items };
  } catch (e: any) {
    return {
      ok: false,
      items,
      error: `Сетевая ошибка при загрузке Insights: ${e.message || String(e)}`,
    };
  }
}

/**
 * Synchronizes Meta Ads spend and performance into AdExpense model idempotently.
 */
export async function syncMetaExpenses(options?: {
  datePreset?: string;
  timeRange?: { since: string; until: string };
}): Promise<MetaSyncResult> {
  const config = getMetaConfig();
  const now = new Date();

  if (!config.configured) {
    const res: MetaSyncResult = {
      ok: false,
      syncedCount: 0,
      createdCount: 0,
      updatedCount: 0,
      totalSpendUzs: 0,
      unmappedCount: 0,
      error: "Интеграция Meta не настроена (отсутствуют META_ACCESS_TOKEN или META_AD_ACCOUNT_ID).",
      timestamp: now,
    };
    await recordSyncStatus(res);
    return res;
  }

  const insightsRes = await fetchMetaInsights(options);
  if (!insightsRes.ok) {
    const res: MetaSyncResult = {
      ok: false,
      syncedCount: 0,
      createdCount: 0,
      updatedCount: 0,
      totalSpendUzs: 0,
      unmappedCount: 0,
      error: insightsRes.error || "Не удалось загрузить данные из Meta API.",
      timestamp: now,
    };
    await recordSyncStatus(res);
    return res;
  }

  const items = insightsRes.items;
  if (items.length === 0) {
    const res: MetaSyncResult = {
      ok: true,
      syncedCount: 0,
      createdCount: 0,
      updatedCount: 0,
      totalSpendUzs: 0,
      unmappedCount: 0,
      timestamp: now,
    };
    await recordSyncStatus(res);
    return res;
  }

  // Load all existing AdLinks for mapping
  const adLinks = await botDb.adLink.findMany({
    select: {
      id: true,
      code: true,
      name: true,
      campaignName: true,
      adName: true,
      metaAdId: true,
      metaCampaignId: true,
      metaAdSetId: true,
    },
  });

  let syncedCount = 0;
  let createdCount = 0;
  let updatedCount = 0;
  let totalSpendUzs = 0;
  let unmappedCount = 0;

  for (const item of items) {
    const spend = Number(item.spend || 0);
    const impressions = parseInt(item.impressions || "0", 10) || 0;
    const reach = parseInt(item.reach || "0", 10) || 0;
    const clicks = parseInt(item.clicks || "0", 10) || 0;
    const cpm = item.cpm ? Number(item.cpm) : null;
    const cpc = item.cpc ? Number(item.cpc) : null;
    const ctr = item.ctr ? Number(item.ctr) : null;

    // Currency calculation
    const currency = (item.account_currency || "USD").toUpperCase();
    const amountUzs =
      currency === "UZS"
        ? Math.round(spend)
        : Math.round(spend * config.usdUzsRate);

    totalSpendUzs += amountUzs;

    const startDate = new Date(`${item.date_start}T00:00:00+05:00`);
    const endDate = new Date(`${item.date_stop}T23:59:59.999+05:00`);
    const metaSyncKey = `meta_${item.ad_id}_${item.date_start}`;

    // Find mapped AdLink:
    // 1. Exact metaAdId match
    let matchedLink = adLinks.find((l) => l.metaAdId === item.ad_id);

    // 2. Exact metaCampaignId match
    if (!matchedLink && item.campaign_id) {
      matchedLink = adLinks.find((l) => l.metaCampaignId === item.campaign_id);
    }

    // 3. Match by code or name inside ad_name or campaign_name
    if (!matchedLink) {
      matchedLink = adLinks.find((l) => {
        const c = l.code.toLowerCase();
        const adN = item.ad_name.toLowerCase();
        const campN = item.campaign_name.toLowerCase();
        return adN.includes(c) || campN.includes(c);
      });
    }

    const adLinkId = matchedLink ? matchedLink.id : null;
    if (!adLinkId) {
      unmappedCount++;
    }

    // Idempotent upsert: check existing record by metaSyncKey
    const existing = await botDb.adExpense.findFirst({
      where: { metaSyncKey },
    });

    if (existing) {
      await botDb.adExpense.update({
        where: { id: existing.id },
        data: {
          adLinkId: adLinkId || existing.adLinkId, // preserve link if already assigned
          amount: spend,
          currency,
          amountUzs,
          startDate,
          endDate,
          metaCampaignId: item.campaign_id,
          metaCampaignName: item.campaign_name,
          metaAdSetId: item.adset_id,
          metaAdSetName: item.adset_name,
          metaAdId: item.ad_id,
          metaAdName: item.ad_name,
          source: "meta_api",
          impressions,
          reach,
          clicks,
          cpm,
          cpc,
          ctr,
          syncedAt: now,
        },
      });
      updatedCount++;
    } else {
      await botDb.adExpense.create({
        data: {
          adLinkId,
          amount: spend,
          currency,
          amountUzs,
          startDate,
          endDate,
          comment: `Meta Ads: ${item.campaign_name} / ${item.ad_name}`,
          metaCampaignId: item.campaign_id,
          metaCampaignName: item.campaign_name,
          metaAdSetId: item.adset_id,
          metaAdSetName: item.adset_name,
          metaAdId: item.ad_id,
          metaAdName: item.ad_name,
          metaSyncKey,
          source: "meta_api",
          impressions,
          reach,
          clicks,
          cpm,
          cpc,
          ctr,
          syncedAt: now,
        },
      });
      createdCount++;
    }

    syncedCount++;
  }

  const result: MetaSyncResult = {
    ok: true,
    syncedCount,
    createdCount,
    updatedCount,
    totalSpendUzs,
    unmappedCount,
    timestamp: now,
  };

  await recordSyncStatus(result);
  return result;
}

/**
 * Records the last sync attempt status in the bot database.
 */
async function recordSyncStatus(result: MetaSyncResult) {
  try {
    const keys = [
      { key: "meta_last_sync_at", value: result.timestamp.toISOString() },
      { key: "meta_last_sync_status", value: result.ok ? "ok" : "error" },
      {
        key: "meta_last_sync_message",
        value: result.ok
          ? `Синхронизировано: ${result.createdCount} создано, ${result.updatedCount} обновлено (всего: ${result.syncedCount}, расход: ${result.totalSpendUzs.toLocaleString("ru-RU")} сум).`
          : result.error || "Неизвестная ошибка синхронизации.",
      },
      { key: "meta_last_sync_count", value: String(result.syncedCount) },
      { key: "meta_last_sync_created", value: String(result.createdCount) },
      { key: "meta_last_sync_updated", value: String(result.updatedCount) },
    ];

    for (const item of keys) {
      await botDb.botSetting.upsert({
        where: { key: item.key },
        update: { valueRu: item.value },
        create: { key: item.key, valueRu: item.value },
      });
    }
  } catch (e) {
    // Non-fatal if setting table cannot be written
    console.error("[meta-ads] Failed to record sync status:", e);
  }
}

/**
 * Retrieves the last sync status from database settings.
 */
export async function getLastSyncStatus(): Promise<{
  lastSyncAt: Date | null;
  status: "ok" | "error" | "never";
  message: string | null;
  syncedCount: number;
  createdCount: number;
  updatedCount: number;
}> {
  try {
    const settings = await botDb.botSetting.findMany({
      where: {
        key: {
          in: [
            "meta_last_sync_at",
            "meta_last_sync_status",
            "meta_last_sync_message",
            "meta_last_sync_count",
            "meta_last_sync_created",
            "meta_last_sync_updated",
          ],
        },
      },
    });

    const map = new Map(settings.map((s) => [s.key, s.valueRu]));
    const lastSyncAtStr = map.get("meta_last_sync_at");
    const statusStr = map.get("meta_last_sync_status");
    const message = map.get("meta_last_sync_message") || null;
    const countStr = map.get("meta_last_sync_count");
    const createdStr = map.get("meta_last_sync_created");
    const updatedStr = map.get("meta_last_sync_updated");

    return {
      lastSyncAt: lastSyncAtStr ? new Date(lastSyncAtStr) : null,
      status:
        statusStr === "ok" ? "ok" : statusStr === "error" ? "error" : "never",
      message,
      syncedCount: countStr ? parseInt(countStr, 10) || 0 : 0,
      createdCount: createdStr ? parseInt(createdStr, 10) || 0 : 0,
      updatedCount: updatedStr ? parseInt(updatedStr, 10) || 0 : 0,
    };
  } catch {
    return {
      lastSyncAt: null,
      status: "never",
      message: null,
      syncedCount: 0,
      createdCount: 0,
      updatedCount: 0,
    };
  }
}
