import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const database = vi.hoisted(() => ({
  adLink: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  adExpense: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  botSetting: {
    upsert: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("@/lib/botDb", () => ({
  botDb: database,
  botConfigured: () => true,
}));

import React from "react";
import BotAdsPage from "../src/app/admin/(protected)/bot-ads/page";
import MetaSettingsPage from "../src/app/admin/(protected)/bot-ads/meta-settings/page";

import {
  getMetaConfig,
  checkMetaConnection,
  fetchMetaInsights,
  syncMetaExpenses,
  getLastSyncStatus,
} from "../src/lib/services/meta-ads";
import {
  rankCampaignsByProfitability,
  rankAdSetsByPerformance,
  rankAdsByPerformance,
  calculateAdMetrics,
  CampaignPerformanceRow,
  AdSetPerformanceRow,
  AdPerformanceRow,
} from "../src/lib/domain/ad-attribution";

describe("Meta Ads Service & Domain Logic", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("getMetaConfig", () => {
    it("returns configured: false when credentials are empty and defaults rate to 12800", () => {
      vi.stubEnv("META_ACCESS_TOKEN", "");
      vi.stubEnv("META_AD_ACCOUNT_ID", "");
      vi.stubEnv("USD_UZS_RATE", "");
      vi.stubEnv("USDT_UZS_RATE", "");
      const config = getMetaConfig();
      expect(config.configured).toBe(false);
      expect(config.usdUzsRate).toBe(12800);
    });

    it("normalizes account ID without act_ prefix and parses custom rate", () => {
      vi.stubEnv("META_ACCESS_TOKEN", "EAABtest123");
      vi.stubEnv("META_AD_ACCOUNT_ID", "1234567890");
      vi.stubEnv("META_API_VERSION", "v21.0");
      vi.stubEnv("USD_UZS_RATE", "13100");

      const config = getMetaConfig();
      expect(config.configured).toBe(true);
      expect(config.token).toBe("EAABtest123");
      expect(config.adAccountId).toBe("act_1234567890");
      expect(config.apiVersion).toBe("v21.0");
      expect(config.usdUzsRate).toBe(13100);
    });

    it("preserves account ID if already prefixed with act_", () => {
      vi.stubEnv("META_ACCESS_TOKEN", "token_xyz");
      vi.stubEnv("META_AD_ACCOUNT_ID", "act_998877");
      const config = getMetaConfig();
      expect(config.adAccountId).toBe("act_998877");
    });
  });

  describe("checkMetaConnection", () => {
    it("returns error if not configured", async () => {
      vi.stubEnv("META_ACCESS_TOKEN", "");
      const res = await checkMetaConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Не заданы переменные");
    });

    it("returns account info on successful connection", async () => {
      vi.stubEnv("META_ACCESS_TOKEN", "valid_token");
      vi.stubEnv("META_AD_ACCOUNT_ID", "act_1001");

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            id: "act_1001",
            name: "AI OBUNA Meta Ads",
            account_status: 1,
            currency: "USD",
            timezone_name: "Asia/Tashkent",
            amount_spent: "154000",
          }),
        }),
      );

      const res = await checkMetaConnection();
      expect(res.ok).toBe(true);
      expect(res.account?.name).toBe("AI OBUNA Meta Ads");
      expect(res.account?.currency).toBe("USD");
      expect(res.account?.timezone).toBe("Asia/Tashkent");
    });

    it("maps OAuthException 190 (expired token) to human-readable error", async () => {
      vi.stubEnv("META_ACCESS_TOKEN", "expired_token");
      vi.stubEnv("META_AD_ACCOUNT_ID", "act_1001");

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              message: "Error validating access token: Session has expired",
              code: 190,
            },
          }),
        }),
      );

      const res = await checkMetaConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toContain("OAuthException 190");
    });

    it("maps permission error code 200/294 to human-readable message", async () => {
      vi.stubEnv("META_ACCESS_TOKEN", "token_no_perm");
      vi.stubEnv("META_AD_ACCOUNT_ID", "act_1001");

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          json: async () => ({
            error: {
              message: "Permissions error",
              code: 200,
            },
          }),
        }),
      );

      const res = await checkMetaConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Недостаточно прав доступа");
    });

    it("maps rate limit error code 17/4 to friendly rate limit message", async () => {
      vi.stubEnv("META_ACCESS_TOKEN", "token_throttled");
      vi.stubEnv("META_AD_ACCOUNT_ID", "act_1001");

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              message: "User request limit reached",
              code: 17,
            },
          }),
        }),
      );

      const res = await checkMetaConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Превышен лимит запросов");
    });

    it("handles network failure cleanly", async () => {
      vi.stubEnv("META_ACCESS_TOKEN", "token");
      vi.stubEnv("META_AD_ACCOUNT_ID", "act_1001");

      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );

      const res = await checkMetaConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Ошибка сети при подключении к Meta API");
    });
  });

  describe("fetchMetaInsights", () => {
    it("paginates through next pages", async () => {
      vi.stubEnv("META_ACCESS_TOKEN", "token");
      vi.stubEnv("META_AD_ACCOUNT_ID", "act_1001");

      const page1 = {
        data: [
          {
            campaign_id: "c1",
            campaign_name: "Camp 1",
            adset_id: "s1",
            adset_name: "Set 1",
            ad_id: "a1",
            ad_name: "Ad 1",
            spend: "10.5",
            impressions: "1000",
            clicks: "50",
            date_start: "2026-09-01",
            date_stop: "2026-09-01",
            account_currency: "USD",
          },
        ],
        paging: {
          next: "https://graph.facebook.com/v20.0/act_1001/insights?page=2",
        },
      };

      const page2 = {
        data: [
          {
            campaign_id: "c1",
            campaign_name: "Camp 1",
            adset_id: "s1",
            adset_name: "Set 1",
            ad_id: "a2",
            ad_name: "Ad 2",
            spend: "15.0",
            impressions: "1500",
            clicks: "70",
            date_start: "2026-09-01",
            date_stop: "2026-09-01",
            account_currency: "USD",
          },
        ],
      };

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => page1,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => page2,
        });

      vi.stubGlobal("fetch", fetchMock);

      const res = await fetchMetaInsights();
      expect(res.ok).toBe(true);
      expect(res.items).toHaveLength(2);
      expect(res.items[0].ad_id).toBe("a1");
      expect(res.items[1].ad_id).toBe("a2");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("syncMetaExpenses (Idempotency & Mapping)", () => {
    it("creates new expense when metaSyncKey does not exist and auto-maps to AdLink", async () => {
      vi.stubEnv("META_ACCESS_TOKEN", "token");
      vi.stubEnv("META_AD_ACCOUNT_ID", "act_1001");
      vi.stubEnv("USD_UZS_RATE", "12800");

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: [
              {
                campaign_id: "c100",
                campaign_name: "Summer Sale Campaign",
                adset_id: "s200",
                adset_name: "Broad 18-35",
                ad_id: "a300",
                ad_name: "Reels Creative promo_summer",
                spend: "20.00",
                impressions: "2500",
                reach: "2000",
                clicks: "100",
                cpm: "8.00",
                cpc: "0.20",
                ctr: "4.0",
                date_start: "2026-09-20",
                date_stop: "2026-09-20",
                account_currency: "USD",
              },
            ],
          }),
        }),
      );

      // Existing AdLink with code matching substring in ad_name
      database.adLink.findMany.mockResolvedValue([
        {
          id: 42,
          code: "promo_summer",
          name: "Promo Summer Link",
          campaignName: null,
          adName: null,
          metaAdId: null,
          metaCampaignId: null,
          metaAdSetId: null,
        },
      ]);

      // Expense does not exist yet
      database.adExpense.findFirst.mockResolvedValue(null);
      database.adExpense.create.mockResolvedValue({ id: 99 });
      database.botSetting.upsert.mockResolvedValue({});

      const syncResult = await syncMetaExpenses();
      expect(syncResult.ok).toBe(true);
      expect(syncResult.syncedCount).toBe(1);
      expect(syncResult.createdCount).toBe(1);
      expect(syncResult.updatedCount).toBe(0);
      expect(syncResult.totalSpendUzs).toBe(20 * 12800); // 256000
      expect(syncResult.unmappedCount).toBe(0);

      expect(database.adExpense.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          adLinkId: 42,
          amount: 20,
          currency: "USD",
          amountUzs: 256000,
          metaSyncKey: "meta_a300_2026-09-20",
          metaCampaignId: "c100",
          metaAdId: "a300",
          source: "meta_api",
          clicks: 100,
          impressions: 2500,
        }),
      });
    });

    it("updates existing expense idempotently without duplicating", async () => {
      vi.stubEnv("META_ACCESS_TOKEN", "token");
      vi.stubEnv("META_AD_ACCOUNT_ID", "act_1001");
      vi.stubEnv("USD_UZS_RATE", "12800");

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: [
              {
                campaign_id: "c100",
                campaign_name: "Summer Sale Campaign",
                adset_id: "s200",
                adset_name: "Broad 18-35",
                ad_id: "a300",
                ad_name: "Reels Creative promo_summer",
                spend: "25.00", // Updated spend
                impressions: "3000",
                reach: "2500",
                clicks: "120",
                cpm: "8.33",
                cpc: "0.21",
                ctr: "4.0",
                date_start: "2026-09-20",
                date_stop: "2026-09-20",
                account_currency: "USD",
              },
            ],
          }),
        }),
      );

      database.adLink.findMany.mockResolvedValue([
        {
          id: 42,
          code: "promo_summer",
          metaAdId: "a300",
        },
      ]);

      // Existing record found by metaSyncKey
      database.adExpense.findFirst.mockResolvedValue({
        id: 99,
        adLinkId: 42,
        amount: 20,
        metaSyncKey: "meta_a300_2026-09-20",
      });
      database.adExpense.update.mockResolvedValue({ id: 99 });
      database.botSetting.upsert.mockResolvedValue({});

      const syncResult = await syncMetaExpenses();
      expect(syncResult.ok).toBe(true);
      expect(syncResult.syncedCount).toBe(1);
      expect(syncResult.createdCount).toBe(0);
      expect(syncResult.updatedCount).toBe(1);
      expect(syncResult.totalSpendUzs).toBe(25 * 12800); // 320000

      expect(database.adExpense.update).toHaveBeenCalledWith({
        where: { id: 99 },
        data: expect.objectContaining({
          adLinkId: 42,
          amount: 25,
          amountUzs: 320000,
          clicks: 120,
          impressions: 3000,
        }),
      });
      expect(database.adExpense.create).not.toHaveBeenCalled();
    });

    it("handles unmapped expenses cleanly when no matching AdLink exists", async () => {
      vi.stubEnv("META_ACCESS_TOKEN", "token");
      vi.stubEnv("META_AD_ACCOUNT_ID", "act_1001");

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: [
              {
                campaign_id: "c999",
                campaign_name: "Unrelated Campaign",
                adset_id: "s999",
                adset_name: "Unrelated Set",
                ad_id: "a999",
                ad_name: "Unrelated Ad",
                spend: "10.00",
                impressions: "100",
                clicks: "5",
                date_start: "2026-09-20",
                date_stop: "2026-09-20",
                account_currency: "UZS",
              },
            ],
          }),
        }),
      );

      database.adLink.findMany.mockResolvedValue([]);
      database.adExpense.findFirst.mockResolvedValue(null);
      database.adExpense.create.mockResolvedValue({ id: 101 });
      database.botSetting.upsert.mockResolvedValue({});

      const syncResult = await syncMetaExpenses();
      expect(syncResult.ok).toBe(true);
      expect(syncResult.unmappedCount).toBe(1);
      expect(database.adExpense.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          adLinkId: null,
          amount: 10,
          amountUzs: 10, // UZS taken 1:1
          metaSyncKey: "meta_a999_2026-09-20",
        }),
      });
    });
  });

  describe("getLastSyncStatus", () => {
    it("returns parsed settings from botSetting", async () => {
      const nowStr = new Date().toISOString();
      database.botSetting.findMany.mockResolvedValue([
        { key: "meta_last_sync_at", valueRu: nowStr },
        { key: "meta_last_sync_status", valueRu: "ok" },
        { key: "meta_last_sync_message", valueRu: "Синхронизировано: 3 создано, 2 обновлено" },
        { key: "meta_last_sync_count", valueRu: "5" },
        { key: "meta_last_sync_created", valueRu: "3" },
        { key: "meta_last_sync_updated", valueRu: "2" },
      ]);

      const status = await getLastSyncStatus();
      expect(status.status).toBe("ok");
      expect(status.message).toBe("Синхронизировано: 3 создано, 2 обновлено");
      expect(status.syncedCount).toBe(5);
      expect(status.createdCount).toBe(3);
      expect(status.updatedCount).toBe(2);
      expect(status.lastSyncAt?.toISOString()).toBe(nowStr);
    });

    it("falls back gracefully when settings are empty", async () => {
      database.botSetting.findMany.mockResolvedValue([]);
      const status = await getLastSyncStatus();
      expect(status.status).toBe("never");
      expect(status.lastSyncAt).toBeNull();
      expect(status.syncedCount).toBe(0);
    });
  });

  describe("Domain Rankings (rankCampaignsByProfitability & rankAdsByPerformance)", () => {
    it("ranks campaigns into profitable and loss-making correctly", () => {
      const campaigns: CampaignPerformanceRow[] = [
        {
          campaignName: "Profitable Camp A",
          spendUzs: 100000,
          revenueUzs: 300000,
          costPriceUzs: 100000,
          hasIncompleteCostPrice: false,
          profitBeforeAds: 200000,
          profitAfterAds: 100000, // profit > 0
          roas: 300,
          roi: 50,
          clicks: 50,
          starts: 30,
          buyers: 10,
          ordersCount: 15,
        },
        {
          campaignName: "Super Profitable Camp B",
          spendUzs: 200000,
          revenueUzs: 800000,
          costPriceUzs: 200000,
          hasIncompleteCostPrice: false,
          profitBeforeAds: 600000,
          profitAfterAds: 400000, // profit > 0, highest
          roas: 400,
          roi: 100,
          clicks: 100,
          starts: 80,
          buyers: 30,
          ordersCount: 40,
        },
        {
          campaignName: "Loss Making Camp C",
          spendUzs: 300000,
          revenueUzs: 150000,
          costPriceUzs: 50000,
          hasIncompleteCostPrice: false,
          profitBeforeAds: 100000,
          profitAfterAds: -200000, // loss
          roas: 50,
          roi: -57.1,
          clicks: 200,
          starts: 40,
          buyers: 2,
          ordersCount: 2,
        },
        {
          campaignName: "Zero Revenue Spend D",
          spendUzs: 50000,
          revenueUzs: 0,
          costPriceUzs: 0,
          hasIncompleteCostPrice: false,
          profitBeforeAds: 0,
          profitAfterAds: -50000, // loss
          roas: 0,
          roi: -100,
          clicks: 30,
          starts: 0,
          buyers: 0,
          ordersCount: 0,
        },
      ];

      const { profitable, lossMaking } = rankCampaignsByProfitability(campaigns);

      expect(profitable).toHaveLength(2);
      expect(profitable[0].campaignName).toBe("Super Profitable Camp B");
      expect(profitable[1].campaignName).toBe("Profitable Camp A");

      expect(lossMaking).toHaveLength(2);
      // Loss-making sorted ascending (most negative first)
      expect(lossMaking[0].campaignName).toBe("Loss Making Camp C");
      expect(lossMaking[1].campaignName).toBe("Zero Revenue Spend D");
    });

    it("ranks ads by performance (net profit desc, revenue desc, orders desc)", () => {
      const ads: AdPerformanceRow[] = [
        {
          adName: "Ad Low Profit",
          spendUzs: 50000,
          revenueUzs: 100000,
          costPriceUzs: 30000,
          hasIncompleteCostPrice: false,
          profitAfterAds: 20000,
          roas: 200,
          clicks: 40,
          buyers: 2,
          ordersCount: 2,
          conversionRate: 5.0,
        },
        {
          adName: "Ad High Profit",
          spendUzs: 100000,
          revenueUzs: 400000,
          costPriceUzs: 100000,
          hasIncompleteCostPrice: false,
          profitAfterAds: 200000,
          roas: 400,
          clicks: 80,
          buyers: 15,
          ordersCount: 20,
          conversionRate: 18.75,
        },
        {
          adName: "Ad Tied Profit More Revenue",
          spendUzs: 80000,
          revenueUzs: 150000,
          costPriceUzs: 50000,
          hasIncompleteCostPrice: false,
          profitAfterAds: 20000, // tied with Ad Low Profit
          roas: 187.5,
          clicks: 60,
          buyers: 5,
          ordersCount: 5,
          conversionRate: 8.33,
        },
      ];

      const ranked = rankAdsByPerformance(ads);
      expect(ranked[0].adName).toBe("Ad High Profit");
      expect(ranked[1].adName).toBe("Ad Tied Profit More Revenue");
      expect(ranked[2].adName).toBe("Ad Low Profit");
    });

    it("ranks ad sets (groups) by profit desc and revenue desc", () => {
      const adSets: AdSetPerformanceRow[] = [
        {
          adSetName: "Ad Set Low Profit",
          campaignName: "Camp 1",
          spendUzs: 40000,
          revenueUzs: 80000,
          costPriceUzs: 20000,
          hasIncompleteCostPrice: false,
          profitBeforeAds: 60000,
          profitAfterAds: 20000,
          roas: 2.0,
          roi: 50,
          clicks: 30,
          starts: 15,
          buyers: 4,
          ordersCount: 5,
        },
        {
          adSetName: "Ad Set High Profit",
          campaignName: "Camp 1",
          spendUzs: 100000,
          revenueUzs: 350000,
          costPriceUzs: 100000,
          hasIncompleteCostPrice: false,
          profitBeforeAds: 250000,
          profitAfterAds: 150000,
          roas: 3.5,
          roi: 150,
          clicks: 100,
          starts: 60,
          buyers: 20,
          ordersCount: 25,
        },
      ];

      const ranked = rankAdSetsByPerformance(adSets);
      expect(ranked[0].adSetName).toBe("Ad Set High Profit");
      expect(ranked[1].adSetName).toBe("Ad Set Low Profit");
    });
  });

  describe("Financial metrics calculations (ROAS, ROI, CAC, Cost Price)", () => {
    it("calculates accurate metrics when all cost prices are known", () => {
      const metrics = calculateAdMetrics({
        clicks: 200,
        uniqueClicks: 180,
        starts: 90,
        newUsers: 80,
        payingUsers: 20,
        paidOrdersCount: 25,
        repeatBuyers: 5,
        revenueUzs: 1_000_000,
        costPriceUzs: 400_000,
        hasIncompleteCostPrice: false,
        actualSpendUzs: 200_000,
      });

      // Profit before ads: 1_000_000 - 400_000 = 600_000
      expect(metrics.profitBeforeAds).toBe(600_000);
      // Profit after ads: 600_000 - 200_000 = 400_000
      expect(metrics.profitAfterAds).toBe(400_000);
      // ROAS: 1_000_000 / 200_000 = 5.0
      expect(metrics.roas).toBe(5.0);
      // ROI: (400_000 / 200_000) * 100 = 200.0%
      expect(metrics.roi).toBe(200.0);
      // CAC: 200_000 / 20 = 10_000
      expect(metrics.cacPayingUser).toBe(10_000);
      // CPC: 200_000 / 200 = 1000
      expect(metrics.cpc).toBe(1000);
    });

    it("does not report false profit when cost price is incomplete", () => {
      const metrics = calculateAdMetrics({
        clicks: 100,
        uniqueClicks: 100,
        starts: 50,
        newUsers: 40,
        payingUsers: 10,
        paidOrdersCount: 10,
        repeatBuyers: 0,
        revenueUzs: 500_000,
        costPriceUzs: 100_000,
        hasIncompleteCostPrice: true, // Marked as incomplete!
        actualSpendUzs: 100_000,
      });

      // Strict protection: profits must be null to avoid deceiving the admin
      expect(metrics.hasIncompleteCostPrice).toBe(true);
      expect(metrics.costPriceUzs).toBeNull();
      expect(metrics.profitBeforeAds).toBeNull();
      expect(metrics.profitAfterAds).toBeNull();
      expect(metrics.roi).toBeNull();
      // Revenue and ROAS remain computable from confirmed payments
      expect(metrics.revenueUzs).toBe(500_000);
      expect(metrics.roas).toBe(5.0);
    });

    it("handles zero spend cleanly without division-by-zero errors", () => {
      const metrics = calculateAdMetrics({
        clicks: 50,
        uniqueClicks: 45,
        starts: 20,
        newUsers: 15,
        payingUsers: 5,
        paidOrdersCount: 5,
        repeatBuyers: 0,
        revenueUzs: 200_000,
        costPriceUzs: 80_000,
        hasIncompleteCostPrice: false,
        actualSpendUzs: 0, // No ad spend recorded yet
      });

      expect(metrics.actualSpendUzs).toBe(0);
      expect(metrics.roas).toBeNull();
      expect(metrics.roi).toBeNull();
      expect(metrics.cpc).toBeNull();
      expect(metrics.cacPayingUser).toBeNull();
      expect(metrics.profitBeforeAds).toBe(120_000);
      expect(metrics.profitAfterAds).toBe(120_000);
    });
  });

  describe("Server Components Rendering", () => {
    it("renders BotAdsPage across all period filters", async () => {
      database.adLink.findMany.mockResolvedValue([]);
      database.adExpense.findMany.mockResolvedValue([]);
      database.botSetting.findMany.mockResolvedValue([]);

      const pageDefault = await BotAdsPage({ searchParams: {} });
      expect(pageDefault).toBeDefined();
      expect(React.isValidElement(pageDefault)).toBe(true);

      const pageToday = await BotAdsPage({ searchParams: { period: "today" } });
      expect(pageToday).toBeDefined();
      expect(React.isValidElement(pageToday)).toBe(true);

      const page7d = await BotAdsPage({ searchParams: { period: "7d" } });
      expect(page7d).toBeDefined();
      expect(React.isValidElement(page7d)).toBe(true);

      const page30d = await BotAdsPage({ searchParams: { period: "30d" } });
      expect(page30d).toBeDefined();
      expect(React.isValidElement(page30d)).toBe(true);

      const pageCustom = await BotAdsPage({
        searchParams: { period: "custom", from: "2026-09-01", to: "2026-09-21" },
      });
      expect(pageCustom).toBeDefined();
      expect(React.isValidElement(pageCustom)).toBe(true);

      const pageSynced = await BotAdsPage({
        searchParams: {
          ok: "synced",
          count: "5",
          created: "3",
          updated: "2",
          spend: "384000",
        },
      });
      expect(pageSynced).toBeDefined();
      expect(React.isValidElement(pageSynced)).toBe(true);
    });

    it("renders MetaSettingsPage without crashing", async () => {
      database.adLink.findMany.mockResolvedValue([]);
      database.adExpense.findMany.mockResolvedValue([]);
      database.botSetting.findMany.mockResolvedValue([]);

      const settingsPage = await MetaSettingsPage({ searchParams: {} });
      expect(settingsPage).toBeDefined();
      expect(React.isValidElement(settingsPage)).toBe(true);

      const settingsPageSynced = await MetaSettingsPage({
        searchParams: { ok: "synced", count: "5", spend: "384000" },
      });
      expect(settingsPageSynced).toBeDefined();
      expect(React.isValidElement(settingsPageSynced)).toBe(true);
    });
  });
});
