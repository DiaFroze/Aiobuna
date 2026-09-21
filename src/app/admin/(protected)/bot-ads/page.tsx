import React from "react";
import Link from "next/link";
import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, StatCard, EmptyState } from "@/components/admin/ui";
import { CopyLinkButton } from "./CopyLinkButton";
import {
  createAdLinkAction,
  toggleAdLinkAction,
  deleteAdLinkAction,
  syncMetaAdsAction,
} from "./actions";
import {
  calculateAdMetrics,
  buildAdWebUrl,
  prorateExpenseForRange,
  rankCampaignsByProfitability,
  rankAdSetsByPerformance,
  rankAdsByPerformance,
  CampaignPerformanceRow,
  AdSetPerformanceRow,
  AdPerformanceRow,
} from "@/lib/domain/ad-attribution";
import {
  toTashkentDateKey,
  formatTashkentDate,
} from "@/lib/domain/sales-statistics";
import { getMetaConfig, getLastSyncStatus } from "@/lib/services/meta-ads";
import { MetaBreakdownTabs } from "./MetaBreakdownTabs";

export const dynamic = "force-dynamic";

function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${Math.round(v).toLocaleString("ru-RU")} сум`;
}

function formatRoas(roas: number | null): string {
  if (roas === null || !Number.isFinite(roas)) return "—";
  return `${roas.toFixed(2)}x`;
}

const PLATFORMS = ["Meta", "Instagram", "Facebook", "Telegram Ads", "Other"] as const;

export default async function BotAdsPage({
  searchParams,
}: {
  searchParams: {
    q?: string;
    period?: string;
    from?: string;
    to?: string;
    status?: string;
    platform?: string;
    error?: string;
    ok?: string;
    code?: string;
    name?: string;
    clicks?: string;
    starts?: string;
    orders?: string;
    count?: string;
    created?: string;
    updated?: string;
    spend?: string;
    unmapped?: string;
  };
}) {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Рекламные ссылки и сквозная атрибуция" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const metaConfig = getMetaConfig();
  const syncStatus = await getLastSyncStatus();

  const q = (searchParams.q ?? "").trim().toLowerCase();
  const statusFilter = searchParams.status ?? "all";
  const platformFilter = searchParams.platform ?? "all";
  const period = searchParams.period ?? "all";

  // Date range filter in Tashkent time
  let dateGte: Date | undefined;
  let dateLte: Date | undefined;
  const now = new Date();

  const tashkentDateToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  if (period === "today") {
    dateGte = new Date(`${tashkentDateToday}T00:00:00+05:00`);
    dateLte = new Date(`${tashkentDateToday}T23:59:59.999+05:00`);
  } else if (period === "7d") {
    dateGte = new Date(now.getTime() - 7 * 86_400_000);
  } else if (period === "30d") {
    dateGte = new Date(now.getTime() - 30 * 86_400_000);
  } else if (period === "custom") {
    if (searchParams.from) {
      const parsedFrom = new Date(`${searchParams.from}T00:00:00+05:00`);
      if (!isNaN(parsedFrom.getTime())) dateGte = parsedFrom;
    }
    if (searchParams.to) {
      const parsedTo = new Date(`${searchParams.to}T23:59:59.999+05:00`);
      if (!isNaN(parsedTo.getTime())) dateLte = parsedTo;
    }
  }

  const dateWhere =
    dateGte || dateLte
      ? {
          createdAt: {
            ...(dateGte ? { gte: dateGte } : {}),
            ...(dateLte ? { lte: dateLte } : {}),
          },
        }
      : {};

  // Fetch all ad links with relations
  const allLinks = await botDb.adLink.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      clicks: {
        where: {
          ...dateWhere,
          isBot: false,
        },
        select: { id: true, isUnique: true, createdAt: true },
      },
      touches: {
        where: dateWhere,
        select: { id: true, isNewUser: true, userId: true, createdAt: true },
      },
      expenses: {
        select: {
          id: true,
          amount: true,
          currency: true,
          amountUzs: true,
          startDate: true,
          endDate: true,
          source: true,
          impressions: true,
          metaCampaignId: true,
          metaCampaignName: true,
          metaAdSetId: true,
          metaAdSetName: true,
          metaAdId: true,
          metaAdName: true,
        },
      },
      orders: {
        where: {
          ...dateWhere,
          status: {
            in: [
              "delivered",
              "completed",
              "awaiting_delivery",
              "processing",
              "course_ready",
              "awaiting_course_link",
            ],
          },
          priceUsdt: { gt: 0 },
        },
        select: {
          id: true,
          userId: true,
          priceUsdt: true,
          priceUzs: true,
          costPriceUzs: true,
          createdAt: true,
        },
      },
    },
  });

  // Also fetch all expenses in the database to catch unmapped Meta expenses
  const allExpenses = await botDb.adExpense.findMany({
    where: {
      ...(dateGte || dateLte
        ? {
            startDate: { ...(dateLte ? { lte: dateLte } : {}) },
            endDate: { ...(dateGte ? { gte: dateGte } : {}) },
          }
        : {}),
    },
    select: {
      id: true,
      adLinkId: true,
      amount: true,
      currency: true,
      amountUzs: true,
      startDate: true,
      endDate: true,
      source: true,
      impressions: true,
      metaCampaignId: true,
      metaCampaignName: true,
      metaAdSetId: true,
      metaAdSetName: true,
      metaAdId: true,
      metaAdName: true,
    },
  });

  // Calculate metrics for each link
  const linkRows = allLinks
    .filter((l) => {
      if (statusFilter === "active" && !l.isActive) return false;
      if (statusFilter === "disabled" && l.isActive) return false;
      if (platformFilter !== "all" && l.platform !== platformFilter) return false;
      if (q) {
        const matchName = l.name.toLowerCase().includes(q);
        const matchCode = l.code.toLowerCase().includes(q);
        const matchCampaign = (l.campaignName ?? "").toLowerCase().includes(q);
        const matchGroup = (l.adGroupName ?? "").toLowerCase().includes(q);
        const matchCreative = (l.creativeUrl ?? "").toLowerCase().includes(q);
        const matchAdId = (l.metaAdId ?? "").toLowerCase().includes(q);
        if (
          !matchName &&
          !matchCode &&
          !matchCampaign &&
          !matchGroup &&
          !matchCreative &&
          !matchAdId
        ) {
          return false;
        }
      }
      return true;
    })
    .map((l) => {
      const clicks = l.clicks.length;
      const uniqueClicks = l.clicks.filter((c) => c.isUnique).length;
      const starts = l.touches.length;
      const newUsers = l.touches.filter((t) => t.isNewUser).length;

      const payingUserIds = new Set(l.orders.map((o) => o.userId));
      const payingUsers = payingUserIds.size;
      const paidOrdersCount = l.orders.length;

      // Repeat buyers
      const userOrderCounts = new Map<number, number>();
      for (const o of l.orders) {
        userOrderCounts.set(o.userId, (userOrderCounts.get(o.userId) ?? 0) + 1);
      }
      let repeatBuyers = 0;
      for (const count of userOrderCounts.values()) {
        if (count >= 2) repeatBuyers++;
      }

      // Sum revenue in UZS
      const revenueUzs = l.orders.reduce(
        (sum, o) => sum + (o.priceUzs ?? Math.round(o.priceUsdt)),
        0,
      );

      // Sum cost price in UZS
      let costPriceUzs = 0;
      let hasIncompleteCostPrice = false;
      for (const o of l.orders) {
        if (o.costPriceUzs !== null && o.costPriceUzs !== undefined) {
          costPriceUzs += o.costPriceUzs;
        } else {
          hasIncompleteCostPrice = true;
        }
      }

      const actualSpendUzs = l.expenses.reduce(
        (sum, expense) =>
          sum +
          prorateExpenseForRange(
            expense.amountUzs ?? expense.amount,
            expense.startDate,
            expense.endDate,
            dateGte,
            dateLte,
          ),
        0,
      );

      const metrics = calculateAdMetrics({
        clicks,
        uniqueClicks,
        starts,
        newUsers,
        payingUsers,
        paidOrdersCount,
        repeatBuyers,
        revenueUzs,
        costPriceUzs,
        hasIncompleteCostPrice,
        actualSpendUzs,
      });

      const webUrl = buildAdWebUrl(appUrl, l.code);

      // Total Meta impressions
      const metaImpressions = l.expenses.reduce(
        (sum, e) => sum + (e.impressions || 0),
        0,
      );

      return {
        ...l,
        metrics,
        webUrl,
        metaImpressions,
      };
    });

  // Global aggregate metrics (matches filtered links if search/filters active, or full account if unfiltered)
  const isFilteredView = Boolean(q || platformFilter !== "all" || statusFilter !== "all");

  const totalSpend = isFilteredView
    ? linkRows.reduce((sum, r) => sum + r.metrics.actualSpendUzs, 0)
    : allExpenses.reduce(
        (sum, e) =>
          sum +
          prorateExpenseForRange(
            e.amountUzs ?? e.amount,
            e.startDate,
            e.endDate,
            dateGte,
            dateLte,
          ),
        0,
      );

  const totalImpressions = isFilteredView
    ? linkRows.reduce((sum, r) => sum + r.metaImpressions, 0)
    : allExpenses.reduce((sum, e) => sum + (e.impressions || 0), 0);

  const totalRevenue = linkRows.reduce((sum, r) => sum + r.metrics.revenueUzs, 0);
  const totalCostPrice = linkRows.reduce(
    (sum, r) => sum + (r.metrics.costPriceUzs ?? 0),
    0,
  );
  const anyIncompleteCost = linkRows.some((r) => r.metrics.hasIncompleteCostPrice);
  const totalProfitBeforeAds = anyIncompleteCost
    ? null
    : totalRevenue - totalCostPrice;
  const totalNetProfit =
    totalProfitBeforeAds !== null ? totalProfitBeforeAds - totalSpend : null;
  const overallRoas =
    totalSpend > 0 ? Number((totalRevenue / totalSpend).toFixed(2)) : null;
  const overallRoi =
    totalSpend > 0 && totalNetProfit !== null
      ? Number(((totalNetProfit / totalSpend) * 100).toFixed(1))
      : null;

  const totalClicks = linkRows.reduce((sum, r) => sum + r.metrics.clicks, 0);
  const totalStarts = linkRows.reduce((sum, r) => sum + r.metrics.starts, 0);
  const totalNewUsers = linkRows.reduce((sum, r) => sum + r.metrics.newUsers, 0);
  const totalBuyers = linkRows.reduce((sum, r) => sum + r.metrics.payingUsers, 0);
  const totalOrders = linkRows.reduce((sum, r) => sum + r.metrics.paidOrdersCount, 0);
  const overallCac =
    totalSpend > 0 && totalBuyers > 0 ? Math.round(totalSpend / totalBuyers) : null;
  const overallConversion =
    totalClicks > 0 ? Number(((totalBuyers / totalClicks) * 100).toFixed(1)) : 0;

  // Unmapped Meta expenses count
  const unmappedExpenses = allExpenses.filter((e) => !e.adLinkId && e.source === "meta_api");
  const unmappedSpend = unmappedExpenses.reduce((sum, e) => sum + (e.amountUzs || 0), 0);

  // Calculate total unknown cost orders across link rows
  let totalUnknownCostOrders = 0;
  for (const r of linkRows) {
    for (const o of r.orders) {
      if (o.costPriceUzs === null || o.costPriceUzs === undefined) {
        totalUnknownCostOrders++;
      }
    }
  }

  // Group Campaigns for Ranking
  const campaignMap = new Map<string, CampaignPerformanceRow>();
  for (const r of linkRows) {
    const cName = r.campaignName || "Без названия кампании";
    const existing = campaignMap.get(cName) ?? {
      campaignName: cName,
      metaCampaignId: r.metaCampaignId,
      spendUzs: 0,
      revenueUzs: 0,
      costPriceUzs: 0,
      hasIncompleteCostPrice: false,
      profitBeforeAds: 0,
      profitAfterAds: 0,
      roas: null,
      roi: null,
      clicks: 0,
      starts: 0,
      buyers: 0,
      ordersCount: 0,
    };
    existing.spendUzs += r.metrics.actualSpendUzs;
    existing.revenueUzs += r.metrics.revenueUzs;
    if (r.metrics.costPriceUzs !== null) {
      existing.costPriceUzs = (existing.costPriceUzs || 0) + r.metrics.costPriceUzs;
    }
    if (r.metrics.hasIncompleteCostPrice) {
      existing.hasIncompleteCostPrice = true;
    }
    existing.clicks += r.metrics.clicks;
    existing.starts += r.metrics.starts;
    existing.buyers += r.metrics.payingUsers;
    existing.ordersCount += r.metrics.paidOrdersCount;
    campaignMap.set(cName, existing);
  }

  // Group Ad Sets (Группы объявлений)
  const adSetMap = new Map<string, AdSetPerformanceRow>();
  for (const r of linkRows) {
    const sName = r.adGroupName || "Без названия группы";
    const existing = adSetMap.get(sName) ?? {
      adSetName: sName,
      metaAdSetId: r.metaAdSetId,
      campaignName: r.campaignName,
      spendUzs: 0,
      revenueUzs: 0,
      costPriceUzs: 0,
      hasIncompleteCostPrice: false,
      profitBeforeAds: 0,
      profitAfterAds: 0,
      roas: null,
      roi: null,
      clicks: 0,
      starts: 0,
      buyers: 0,
      ordersCount: 0,
    };
    existing.spendUzs += r.metrics.actualSpendUzs;
    existing.revenueUzs += r.metrics.revenueUzs;
    if (r.metrics.costPriceUzs !== null) {
      existing.costPriceUzs = (existing.costPriceUzs || 0) + r.metrics.costPriceUzs;
    }
    if (r.metrics.hasIncompleteCostPrice) {
      existing.hasIncompleteCostPrice = true;
    }
    existing.clicks += r.metrics.clicks;
    existing.starts += r.metrics.starts;
    existing.buyers += r.metrics.payingUsers;
    existing.ordersCount += r.metrics.paidOrdersCount;
    adSetMap.set(sName, existing);
  }

  // Group Ads (Объявления / Креативы)
  const adMap = new Map<string, AdPerformanceRow>();
  for (const r of linkRows) {
    const adName = r.adName || r.name;
    const existing = adMap.get(adName) ?? {
      adName,
      metaAdId: r.metaAdId,
      campaignName: r.campaignName,
      adSetName: r.adGroupName,
      spendUzs: 0,
      revenueUzs: 0,
      costPriceUzs: 0,
      hasIncompleteCostPrice: false,
      profitAfterAds: 0,
      roas: null,
      clicks: 0,
      starts: 0,
      buyers: 0,
      ordersCount: 0,
      conversionRate: 0,
    };
    existing.spendUzs += r.metrics.actualSpendUzs;
    existing.revenueUzs += r.metrics.revenueUzs;
    if (r.metrics.costPriceUzs !== null) {
      existing.costPriceUzs = (existing.costPriceUzs || 0) + r.metrics.costPriceUzs;
    }
    if (r.metrics.hasIncompleteCostPrice) {
      existing.hasIncompleteCostPrice = true;
    }
    existing.clicks += r.metrics.clicks;
    existing.starts = (existing.starts || 0) + r.metrics.starts;
    existing.buyers += r.metrics.payingUsers;
    existing.ordersCount += r.metrics.paidOrdersCount;
    adMap.set(adName, existing);
  }

  // Account for unmapped expenses across all 3 levels
  for (const exp of unmappedExpenses) {
    const proratedSpend = prorateExpenseForRange(
      exp.amountUzs ?? exp.amount,
      exp.startDate,
      exp.endDate,
      dateGte,
      dateLte,
    );
    if (proratedSpend <= 0) continue;

    const cName = exp.metaCampaignName || "Несопоставленные кампании";
    const cExisting = campaignMap.get(cName) ?? {
      campaignName: cName,
      metaCampaignId: exp.metaCampaignId,
      spendUzs: 0,
      revenueUzs: 0,
      costPriceUzs: 0,
      hasIncompleteCostPrice: false,
      profitBeforeAds: 0,
      profitAfterAds: 0,
      roas: null,
      roi: null,
      clicks: 0,
      starts: 0,
      buyers: 0,
      ordersCount: 0,
    };
    cExisting.spendUzs += proratedSpend;
    campaignMap.set(cName, cExisting);

    const sName = exp.metaAdSetName || "Несопоставленные группы";
    const sExisting = adSetMap.get(sName) ?? {
      adSetName: sName,
      metaAdSetId: exp.metaAdSetId,
      campaignName: exp.metaCampaignName,
      spendUzs: 0,
      revenueUzs: 0,
      costPriceUzs: 0,
      hasIncompleteCostPrice: false,
      profitBeforeAds: 0,
      profitAfterAds: 0,
      roas: null,
      roi: null,
      clicks: 0,
      starts: 0,
      buyers: 0,
      ordersCount: 0,
    };
    sExisting.spendUzs += proratedSpend;
    adSetMap.set(sName, sExisting);

    const aName = exp.metaAdName || "Несопоставленные объявления";
    const aExisting = adMap.get(aName) ?? {
      adName: aName,
      metaAdId: exp.metaAdId,
      campaignName: exp.metaCampaignName,
      adSetName: exp.metaAdSetName,
      spendUzs: 0,
      revenueUzs: 0,
      costPriceUzs: 0,
      hasIncompleteCostPrice: false,
      profitAfterAds: 0,
      roas: null,
      clicks: 0,
      starts: 0,
      buyers: 0,
      ordersCount: 0,
      conversionRate: 0,
    };
    aExisting.spendUzs += proratedSpend;
    adMap.set(aName, aExisting);
  }

  const campaignList: CampaignPerformanceRow[] = [...campaignMap.values()].map((c) => {
    const pBefore = c.hasIncompleteCostPrice ? null : c.revenueUzs - (c.costPriceUzs || 0);
    const pAfter = pBefore !== null ? pBefore - c.spendUzs : null;
    const roas = c.spendUzs > 0 ? Number((c.revenueUzs / c.spendUzs).toFixed(2)) : null;
    const roi = c.spendUzs > 0 && pAfter !== null ? Number(((pAfter / c.spendUzs) * 100).toFixed(1)) : null;
    return {
      ...c,
      profitBeforeAds: pBefore,
      profitAfterAds: pAfter,
      roas,
      roi,
    };
  });

  const adSetList: AdSetPerformanceRow[] = [...adSetMap.values()].map((s) => {
    const pBefore = s.hasIncompleteCostPrice ? null : s.revenueUzs - (s.costPriceUzs || 0);
    const pAfter = pBefore !== null ? pBefore - s.spendUzs : null;
    const roas = s.spendUzs > 0 ? Number((s.revenueUzs / s.spendUzs).toFixed(2)) : null;
    const roi = s.spendUzs > 0 && pAfter !== null ? Number(((pAfter / s.spendUzs) * 100).toFixed(1)) : null;
    return {
      ...s,
      profitBeforeAds: pBefore,
      profitAfterAds: pAfter,
      roas,
      roi,
    };
  });

  const adList: AdPerformanceRow[] = [...adMap.values()].map((a) => {
    const pBefore = a.hasIncompleteCostPrice ? null : a.revenueUzs - (a.costPriceUzs || 0);
    const pAfter = pBefore !== null ? pBefore - a.spendUzs : null;
    const roas = a.spendUzs > 0 ? Number((a.revenueUzs / a.spendUzs).toFixed(2)) : null;
    const roi = a.spendUzs > 0 && pAfter !== null ? Number(((pAfter / a.spendUzs) * 100).toFixed(1)) : null;
    const conversionRate = a.clicks > 0 ? Number(((a.buyers / a.clicks) * 100).toFixed(1)) : 0;
    return {
      ...a,
      profitBeforeAds: pBefore,
      profitAfterAds: pAfter,
      roas,
      roi,
      conversionRate,
    };
  });

  const { profitable: topCampaigns, lossMaking: lossCampaigns } =
    rankCampaignsByProfitability(campaignList);

  const topAds = rankAdsByPerformance(adList).slice(0, 8);

  // Group performance by day (Tashkent Timezone)
  const dailyMap = new Map<
    string,
    {
      spendUzs: number;
      clicks: number;
      starts: number;
      buyers: Set<number>;
      ordersCount: number;
      revenueUzs: number;
      costPriceUzs: number;
      unknownCostOrders: number;
    }
  >();

  // 1. Daily expenses
  for (const exp of allExpenses) {
    const dayKey = toTashkentDateKey(new Date(exp.startDate));
    const day = dailyMap.get(dayKey) ?? {
      spendUzs: 0,
      clicks: 0,
      starts: 0,
      buyers: new Set<number>(),
      ordersCount: 0,
      revenueUzs: 0,
      costPriceUzs: 0,
      unknownCostOrders: 0,
    };
    day.spendUzs += exp.amountUzs || 0;
    dailyMap.set(dayKey, day);
  }

  // 2. Daily clicks, starts, orders
  for (const l of allLinks) {
    for (const c of l.clicks) {
      const dayKey = toTashkentDateKey(new Date(c.createdAt));
      const day = dailyMap.get(dayKey) ?? {
        spendUzs: 0,
        clicks: 0,
        starts: 0,
        buyers: new Set<number>(),
        ordersCount: 0,
        revenueUzs: 0,
        costPriceUzs: 0,
        unknownCostOrders: 0,
      };
      day.clicks++;
      dailyMap.set(dayKey, day);
    }
    for (const t of l.touches) {
      const dayKey = toTashkentDateKey(new Date(t.createdAt));
      const day = dailyMap.get(dayKey) ?? {
        spendUzs: 0,
        clicks: 0,
        starts: 0,
        buyers: new Set<number>(),
        ordersCount: 0,
        revenueUzs: 0,
        costPriceUzs: 0,
        unknownCostOrders: 0,
      };
      day.starts++;
      dailyMap.set(dayKey, day);
    }
    for (const o of l.orders) {
      const dayKey = toTashkentDateKey(new Date(o.createdAt));
      const day = dailyMap.get(dayKey) ?? {
        spendUzs: 0,
        clicks: 0,
        starts: 0,
        buyers: new Set<number>(),
        ordersCount: 0,
        revenueUzs: 0,
        costPriceUzs: 0,
        unknownCostOrders: 0,
      };
      day.ordersCount++;
      day.buyers.add(o.userId);
      const sale = o.priceUzs ?? Math.round(o.priceUsdt);
      day.revenueUzs += sale;
      if (o.costPriceUzs !== null && o.costPriceUzs !== undefined) {
        day.costPriceUzs += o.costPriceUzs;
      } else {
        day.unknownCostOrders++;
      }
      dailyMap.set(dayKey, day);
    }
  }

  const dailyRows = [...dailyMap.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dateKey, d]) => {
      const hasUnknown = d.unknownCostOrders > 0;
      const profitBeforeAds = hasUnknown ? null : d.revenueUzs - d.costPriceUzs;
      const profitAfterAds = profitBeforeAds !== null ? profitBeforeAds - d.spendUzs : null;
      const roas = d.spendUzs > 0 ? Number((d.revenueUzs / d.spendUzs).toFixed(2)) : null;
      const roi =
        d.spendUzs > 0 && profitAfterAds !== null
          ? Number(((profitAfterAds / d.spendUzs) * 100).toFixed(1))
          : null;

      return {
        dateKey,
        dateFormatted: formatTashkentDate(dateKey),
        spendUzs: d.spendUzs,
        clicks: d.clicks,
        starts: d.starts,
        buyers: d.buyers.size,
        ordersCount: d.ordersCount,
        revenueUzs: d.revenueUzs,
        costPriceUzs: d.costPriceUzs,
        hasIncompleteCostPrice: hasUnknown,
        profitBeforeAds,
        profitAfterAds,
        roas,
        roi,
      };
    });

  return (
    <div className="space-y-6">
      <PageHeader
        title="📈 Рекламные ссылки и аналитика Meta Ads"
        subtitle="Сквозная аналитика трафика: расходы Meta Ads, переходы, регистрации, заказы, себестоимость, ROAS и чистая прибыль."
        action={
          <div className="flex items-center gap-2">
            <Link
              href="/admin/bot-ads/meta-settings"
              className="btn-secondary text-xs sm:text-sm inline-flex items-center gap-1.5"
            >
              ⚙️ Настройки Meta Ads
              {metaConfig.configured ? (
                <span className="w-2 h-2 rounded-full bg-success inline-block" />
              ) : (
                <span className="w-2 h-2 rounded-full bg-warning inline-block" />
              )}
            </Link>
          </div>
        }
      />

      {/* Meta API Sync Status Notification Bar */}
      <div className="card p-4 bg-surface-2/40 border border-border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-3">
          <span className="text-xl">📊</span>
          <div>
            <div className="flex items-center gap-2 font-semibold text-foreground">
              <span>Синхронизация расходов Meta Marketing API</span>
              {metaConfig.configured ? (
                <span className="badge bg-success/10 text-success text-[10px]">
                  Подключено ({metaConfig.adAccountId})
                </span>
              ) : (
                <span className="badge bg-warning/10 text-warning text-[10px]">
                  Не настроено в .env
                </span>
              )}
            </div>
            <div className="text-muted text-[11px] mt-0.5">
              {syncStatus.lastSyncAt ? (
                <>
                  Последняя синхронизация:{" "}
                  <strong className="text-foreground">
                    {new Intl.DateTimeFormat("ru-RU", {
                      timeZone: "Asia/Tashkent",
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(syncStatus.lastSyncAt)}
                  </strong>
                  {syncStatus.message && (
                    <span className="ml-2 opacity-80">({syncStatus.message})</span>
                  )}
                </>
              ) : (
                "Синхронизация ещё не запускалась. Нажмите кнопку справа."
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          {unmappedExpenses.length > 0 && (
            <Link
              href="/admin/bot-ads/meta-settings"
              className="badge bg-warning/20 text-warning text-[11px] hover:underline"
            >
              ⚠️ {unmappedExpenses.length} несопоставленных ({money(unmappedSpend)})
            </Link>
          )}

          {metaConfig.configured && (
            <form action={syncMetaAdsAction} className="inline">
              <input type="hidden" name="datePreset" value="last_30d" />
              <input type="hidden" name="returnTo" value="/admin/bot-ads" />
              <button
                type="submit"
                className="btn-primary text-xs py-1.5 px-3 whitespace-nowrap"
              >
                🔄 Синхронизировать
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Notifications from actions */}
      {searchParams.ok === "created" && (
        <div className="card p-3 border-success/30 bg-success/10 text-success text-sm flex items-center justify-between">
          <span>✅ Рекламная ссылка успешно создана! Скопируйте ссылку ниже и используйте в рекламе.</span>
        </div>
      )}
      {searchParams.ok === "toggled" && (
        <div className="card p-3 border-success/30 bg-success/10 text-success text-sm">
          Статус рекламной ссылки успешно изменён.
        </div>
      )}
      {searchParams.ok === "deleted" && (
        <div className="card p-3 border-success/30 bg-success/10 text-success text-sm">
          Рекламная ссылка удалена.
        </div>
      )}
      {searchParams.ok === "synced" && (
        <div className="card p-3 border-success/30 bg-success/10 text-success text-sm flex items-center justify-between">
          <span>
            ✅ Расходы Meta Ads успешно синхронизированы:{" "}
            <strong>{searchParams.created ?? searchParams.count ?? 0}</strong> создано,{" "}
            <strong>{searchParams.updated ?? 0}</strong> обновлено{" "}
            {searchParams.spend ? `(расход: ${money(Number(searchParams.spend))})` : ""}.
          </span>
        </div>
      )}
      {searchParams.error === "collision" && (
        <div className="card p-3 border-danger/30 bg-danger/10 text-danger text-sm">
          ❌ Ошибка: Рекламный код <code>{searchParams.code}</code> уже существует!
        </div>
      )}

      {/* 10 Global KPI StatCards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard
          label="Расход на рекламу"
          value={money(totalSpend)}
          hint={totalSpend > 0 ? "Всего внесено/синхронизировано" : "Расход = 0 сум"}
          tone={totalSpend > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Подтверждённая выручка"
          value={money(totalRevenue)}
          hint={`${totalOrders} оплаченных заказов`}
          tone="success"
        />
        <StatCard
          label="Себестоимость товаров"
          value={anyIncompleteCost ? "Неполная" : money(totalCostPrice)}
          hint={anyIncompleteCost ? `${totalUnknownCostOrders} заказов без себестоимости` : "Все заказы учтены"}
          tone={anyIncompleteCost ? "warning" : "default"}
        />
        <StatCard
          label="Прибыль до рекламы"
          value={totalProfitBeforeAds !== null ? money(totalProfitBeforeAds) : "Неполные данные"}
          hint="Выручка − себестоимость"
          tone={totalProfitBeforeAds !== null && totalProfitBeforeAds >= 0 ? "success" : "danger"}
        />
        <StatCard
          label="Чистая прибыль после рекламы"
          value={totalNetProfit !== null ? money(totalNetProfit) : "Неполные данные"}
          hint="Прибыль до рекламы − расход"
          tone={totalNetProfit !== null && totalNetProfit >= 0 ? "success" : "danger"}
        />
        <StatCard
          label="ROAS (Окупаемость)"
          value={formatRoas(overallRoas)}
          hint={overallRoas !== null ? (overallRoas >= 1 ? "Кампании окупаются" : "Ниже расходов") : "Расход = 0 сум"}
          tone={overallRoas !== null && overallRoas >= 1 ? "success" : "danger"}
        />
        <StatCard
          label="Рентабельность (ROI)"
          value={overallRoi !== null ? `${overallRoi}%` : "—"}
          hint="Чистая прибыль / Расход"
          tone={overallRoi !== null && overallRoi >= 0 ? "success" : "danger"}
        />
        <StatCard
          label="Стоимость покупателя (CAC)"
          value={overallCac !== null ? money(overallCac) : "—"}
          hint="Расход / Покупатели"
        />
        <StatCard
          label="Конверсия в покупателя"
          value={`${overallConversion}%`}
          hint={`${totalBuyers} из ${totalClicks} кликов`}
          tone={overallConversion > 5 ? "success" : "default"}
        />
        <StatCard
          label="Покупатели и заказы"
          value={`${totalBuyers} чел.`}
          hint={`${totalOrders} заказов всего`}
        />
      </div>

      {/* Warning banner if incomplete cost */}
      {anyIncompleteCost && (
        <div className="card p-4 border-warning/40 bg-warning/10 text-xs text-warning flex items-start gap-2">
          <span>⚠️</span>
          <div>
            <strong>Неполные финансовые данные:</strong> У {totalUnknownCostOrders} {totalUnknownCostOrders === 1 ? "заказа" : "заказов"} не была зафиксирована себестоимость в момент покупки.
            Для абсолютно точного расчёта чистой прибыли укажите себестоимость в разделе{" "}
            <Link href="/admin/bot-products" className="underline font-semibold">«Товары бота»</Link>.
          </div>
        </div>
      )}

      {/* Marketing Funnel */}
      <div className="card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm sm:text-base flex items-center gap-2">
            🎯 Сквозная воронка маркетинга
            <span className="badge bg-brand/10 text-brand text-xs font-normal">
              Все каналы
            </span>
          </h2>
          <span className="text-xs text-muted">Конверсия каждого этапа</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-center text-xs">
          <div className="p-3 rounded-lg bg-surface-2 border border-border">
            <div className="text-muted text-[11px] mb-1">1. Показы Meta</div>
            <div className="text-lg font-bold font-mono">{totalImpressions.toLocaleString("ru-RU")}</div>
            <div className="text-[10px] text-muted mt-1">Охват аудитории</div>
          </div>

          <div className="p-3 rounded-lg bg-surface-2 border border-border">
            <div className="text-muted text-[11px] mb-1">2. Клики (Web)</div>
            <div className="text-lg font-bold font-mono text-brand">{totalClicks}</div>
            <div className="text-[10px] text-muted mt-1">
              {totalImpressions > 0 ? `${((totalClicks / totalImpressions) * 100).toFixed(2)}% CTR` : "—"}
            </div>
          </div>

          <div className="p-3 rounded-lg bg-surface-2 border border-border">
            <div className="text-muted text-[11px] mb-1">3. Запуски бота</div>
            <div className="text-lg font-bold font-mono">{totalStarts}</div>
            <div className="text-[10px] text-muted mt-1">
              {totalClicks > 0 ? `${((totalStarts / totalClicks) * 100).toFixed(1)}% конв.` : "—"}
            </div>
          </div>

          <div className="p-3 rounded-lg bg-surface-2 border border-border">
            <div className="text-muted text-[11px] mb-1">4. Новые клиенты</div>
            <div className="text-lg font-bold font-mono">{totalNewUsers}</div>
            <div className="text-[10px] text-muted mt-1">
              {totalStarts > 0 ? `${((totalNewUsers / totalStarts) * 100).toFixed(1)}% новых` : "—"}
            </div>
          </div>

          <div className="p-3 rounded-lg bg-surface-2 border border-border">
            <div className="text-muted text-[11px] mb-1">5. Покупатели</div>
            <div className="text-lg font-bold font-mono text-success">{totalBuyers}</div>
            <div className="text-[10px] text-muted mt-1">
              {totalStarts > 0 ? `${((totalBuyers / totalStarts) * 100).toFixed(1)}% конв.` : "—"}
            </div>
          </div>

          <div className="p-3 rounded-lg bg-surface-2 border border-border">
            <div className="text-muted text-[11px] mb-1">6. Заказы</div>
            <div className="text-lg font-bold font-mono text-success">{totalOrders}</div>
            <div className="text-[10px] text-muted mt-1">
              {totalBuyers > 0 ? `${(totalOrders / totalBuyers).toFixed(1)} зак./клиент` : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* Best & Loss-Making Campaigns */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Top Profitable Campaigns */}
        <div className="card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-sm sm:text-base flex items-center gap-1.5 text-success">
              🏆 Лучшие прибыльные кампании
            </h2>
            <span className="badge bg-success/10 text-success text-xs">
              {topCampaigns.length}
            </span>
          </div>

          {topCampaigns.length === 0 ? (
            <div className="p-6 text-center text-muted text-xs">
              Пока нет кампаний с подтверждённой чистой прибылью.
            </div>
          ) : (
            <div className="space-y-2">
              {topCampaigns.slice(0, 5).map((c) => (
                <div
                  key={c.campaignName}
                  className="p-3 rounded-lg bg-surface-2/40 border border-border flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate">{c.campaignName}</div>
                    <div className="text-muted text-[11px] mt-0.5">
                      Расход: {money(c.spendUzs)} · Выручка: {money(c.revenueUzs)} · {c.ordersCount} заказов
                    </div>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <div className="font-semibold font-mono text-success">
                      +{money(c.profitAfterAds)}
                    </div>
                    <div className="text-[10px] text-muted">
                      ROAS: <strong className="text-foreground">{formatRoas(c.roas)}</strong>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Loss-Making Campaigns */}
        <div className="card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-sm sm:text-base flex items-center gap-1.5 text-danger">
              🔻 Убыточные кампании
            </h2>
            <span className="badge bg-danger/10 text-danger text-xs">
              {lossCampaigns.length}
            </span>
          </div>

          {lossCampaigns.length === 0 ? (
            <div className="p-6 text-center text-muted text-xs">
              Убыточных рекламных кампаний нет. Все расходы окупаются!
            </div>
          ) : (
            <div className="space-y-2">
              {lossCampaigns.slice(0, 5).map((c) => (
                <div
                  key={c.campaignName}
                  className="p-3 rounded-lg bg-surface-2/40 border border-border flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate">{c.campaignName}</div>
                    <div className="text-muted text-[11px] mt-0.5">
                      Расход: {money(c.spendUzs)} · Выручка: {money(c.revenueUzs)}
                    </div>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <div className="font-semibold font-mono text-danger">
                      {money(c.profitAfterAds)}
                    </div>
                    <div className="text-[10px] text-muted">
                      ROAS: <strong className="text-foreground">{formatRoas(c.roas)}</strong>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Top Ads Ranking */}
      {topAds.length > 0 && (
        <div className="card p-5 space-y-3">
          <h2 className="font-semibold text-sm sm:text-base flex items-center gap-2">
            🎬 Лучшие объявления (креативы)
            <span className="badge bg-brand/10 text-brand text-xs font-normal">
              По продажам и конверсии
            </span>
          </h2>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {topAds.map((ad, idx) => (
              <div
                key={ad.adName + idx}
                className="p-3.5 rounded-lg bg-surface-2/40 border border-border space-y-1.5 text-xs"
              >
                <div className="font-semibold text-foreground truncate">{ad.adName}</div>
                <div className="text-[11px] text-muted truncate">
                  Кампания: {ad.campaignName || "—"}
                </div>
                <div className="pt-1 border-t border-border flex justify-between font-mono">
                  <span className="text-muted">Выручка:</span>
                  <span className="text-brand font-semibold">{money(ad.revenueUzs)}</span>
                </div>
                <div className="flex justify-between font-mono text-[11px]">
                  <span className="text-muted">Заказов / Конв.:</span>
                  <span>
                    <strong>{ad.ordersCount}</strong> ({ad.conversionRate}%)
                  </span>
                </div>
                <div className="flex justify-between font-mono text-[11px]">
                  <span className="text-muted">Чистая прибыль:</span>
                  <span
                    className={
                      (ad.profitAfterAds ?? 0) >= 0 ? "text-success font-semibold" : "text-danger"
                    }
                  >
                    {money(ad.profitAfterAds)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section: Detailed Breakdown Tabs (Campaigns, Ad Sets, Ads) */}
      <MetaBreakdownTabs
        campaigns={campaignList}
        adSets={adSetList}
        ads={adList}
      />

      {/* Section: Daily Performance Table */}
      <div className="card overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-base sm:text-lg">
              📅 Расходы и продажи по дням
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Ежедневная динамика рекламного бюджета, кликов, покупателей, выручки, прибыли и ROAS
            </p>
          </div>
          <span className="badge bg-surface-2 text-muted text-xs">
            {dailyRows.length} дней
          </span>
        </div>

        {dailyRows.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">
            За выбранный период данных нет.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
                  <th className="px-4 py-3">Дата</th>
                  <th className="px-3 py-3 text-right">Расход</th>
                  <th className="px-3 py-3 text-right">Клики</th>
                  <th className="px-3 py-3 text-right">Запуски</th>
                  <th className="px-3 py-3 text-right">Покупатели</th>
                  <th className="px-3 py-3 text-right">Заказы</th>
                  <th className="px-3 py-3 text-right">Выручка</th>
                  <th className="px-3 py-3 text-right">Себестоимость</th>
                  <th className="px-4 py-3 text-right">Чистая прибыль</th>
                  <th className="px-3 py-3 text-center">ROAS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {dailyRows.map((d) => (
                  <tr key={d.dateKey} className="hover:bg-surface-2/30 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-xs sm:text-sm font-medium">
                      {d.dateFormatted}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap text-warning">
                      {money(d.spendUzs)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">
                      {d.clicks}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">
                      {d.starts}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-success font-medium">
                      {d.buyers}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">
                      {d.ordersCount}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-brand font-medium whitespace-nowrap">
                      {money(d.revenueUzs)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap">
                      {d.hasIncompleteCostPrice ? (
                        <span className="text-warning">Неполная</span>
                      ) : (
                        money(d.costPriceUzs)
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold whitespace-nowrap">
                      {d.profitAfterAds !== null ? (
                        <span className={d.profitAfterAds >= 0 ? "text-success" : "text-danger"}>
                          {money(d.profitAfterAds)}
                        </span>
                      ) : (
                        <span className="text-warning">Неполные</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center font-mono text-xs font-medium">
                      {d.roas !== null ? (
                        <span className={d.roas >= 1 ? "text-success" : "text-danger"}>
                          {formatRoas(d.roas)}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Filter and Search Bar */}
      <div className="card p-4 space-y-3">
        <form method="GET" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="lg:col-span-2">
            <label className="text-xs text-muted font-medium">Поиск по ссылкам и Meta</label>
            <input
              type="text"
              name="q"
              defaultValue={searchParams.q ?? ""}
              placeholder="Поиск по названию, коду, кампании, объявлению..."
              className="input mt-1 w-full text-sm"
            />
          </div>

          <div>
            <label className="text-xs text-muted font-medium">Период</label>
            <select name="period" defaultValue={period} className="input mt-1 w-full text-sm">
              <option value="all">За всё время</option>
              <option value="today">Сегодня</option>
              <option value="7d">Последние 7 дней</option>
              <option value="30d">Последние 30 дней</option>
              <option value="custom">Указать даты</option>
            </select>
          </div>

          <div>
            <label className="text-xs text-muted font-medium">Статус</label>
            <select name="status" defaultValue={statusFilter} className="input mt-1 w-full text-sm">
              <option value="all">Все статусы</option>
              <option value="active">Только активные</option>
              <option value="disabled">Только отключённые</option>
            </select>
          </div>

          <div>
            <label className="text-xs text-muted font-medium">Площадка</label>
            <select name="platform" defaultValue={platformFilter} className="input mt-1 w-full text-sm">
              <option value="all">Все площадки</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {period === "custom" && (
            <>
              <div>
                <label className="text-xs text-muted font-medium">С даты</label>
                <input
                  type="date"
                  name="from"
                  defaultValue={searchParams.from ?? ""}
                  className="input mt-1 w-full text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted font-medium">По дату</label>
                <input
                  type="date"
                  name="to"
                  defaultValue={searchParams.to ?? ""}
                  className="input mt-1 w-full text-sm"
                />
              </div>
            </>
          )}

          <div className="sm:col-span-2 lg:col-span-5 flex items-center gap-2 justify-end pt-1">
            <Link href="/admin/bot-ads" className="btn-secondary text-xs py-1.5 px-3">
              Сбросить фильтры
            </Link>
            <button type="submit" className="btn-primary text-xs py-1.5 px-4">
              Применить фильтры
            </button>
          </div>
        </form>
      </div>

      {/* Creation form */}
      <details className="card p-4 group">
        <summary className="font-semibold text-sm cursor-pointer list-none flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="text-brand font-bold text-base">＋</span> Создать новую рекламную ссылку
          </span>
          <span className="text-xs text-muted group-open:rotate-180 transition-transform">▼</span>
        </summary>
        <form action={createAdLinkAction} className="mt-4 pt-4 border-t border-border space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="text-xs font-semibold text-muted">
                Понятное название <span className="text-danger">*</span>
              </label>
              <input
                name="name"
                required
                placeholder="напр. Reels 5 — AI Bot — Meta — широкая аудитория"
                className="input mt-1 w-full text-sm"
              />
              <p className="text-[11px] text-muted mt-0.5">Отображается в админ-панели и отчётах.</p>
            </div>

            <div>
              <label className="text-xs font-semibold text-muted">
                Уникальный код ссылки <span className="text-danger">*</span>
              </label>
              <input
                name="code"
                required
                pattern="[A-Za-z0-9_-]{2,64}"
                placeholder="напр. meta_reels5_broad"
                className="input mt-1 w-full text-sm font-mono"
              />
              <p className="text-[11px] text-muted mt-0.5">
                Будет в URL: <code>{appUrl}/go/ваш_код</code>
              </p>
            </div>

            <div>
              <label className="text-xs font-semibold text-muted">Площадка</label>
              <select name="platform" defaultValue="Meta" className="input mt-1 w-full text-sm">
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-muted">Кампания (Campaign)</label>
              <input
                name="campaignName"
                placeholder="напр. AI Obuna Subscriptions"
                className="input mt-1 w-full text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-muted">Группа объявлений (Ad Set)</label>
              <input
                name="adGroupName"
                placeholder="напр. Broad UZ 18-35"
                className="input mt-1 w-full text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-muted">Объявление (Ad)</label>
              <input
                name="adName"
                placeholder="напр. Reel 5 Hook Problem"
                className="input mt-1 w-full text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-muted">Креатив / URL ролика</label>
              <input
                name="creativeUrl"
                placeholder="напр. https://instagram.com/reel/... или Ролик №5"
                className="input mt-1 w-full text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-muted">Плановый бюджет (USD)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                name="budget"
                defaultValue="0"
                className="input mt-1 w-full text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-muted">Дата начала</label>
              <input
                type="date"
                name="startDate"
                defaultValue={new Date().toISOString().slice(0, 10)}
                className="input mt-1 w-full text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-muted">Дата окончания (опционально)</label>
              <input
                type="date"
                name="endDate"
                className="input mt-1 w-full text-sm"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="text-xs font-semibold text-muted">Заметка / Описание</label>
              <input
                name="note"
                placeholder="Заметка об аудитории, связке, тест гипотезы..."
                className="input mt-1 w-full text-sm"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input type="checkbox" name="isActive" defaultChecked className="rounded border-border" />
              <span>Ссылка активна сразу после создания</span>
            </label>
            <button type="submit" className="btn-primary text-sm py-2 px-5">
              Создать рекламную ссылку
            </button>
          </div>
        </form>
      </details>

      {/* Main Table: Ad Links */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="border-b border-border text-muted text-xs uppercase tracking-wider bg-surface-2/40">
              <th className="p-3">Название / Площадка</th>
              <th className="p-3">Код и Ссылка</th>
              <th className="p-3">Meta ID</th>
              <th className="p-3 text-center">Статус</th>
              <th className="p-3 text-center">Воронка (К → С → Н → П)</th>
              <th className="p-3 text-right">Выручка</th>
              <th className="p-3 text-right">Расход</th>
              <th className="p-3 text-right">Чистая прибыль</th>
              <th className="p-3 text-center">ROAS</th>
              <th className="p-3 text-right">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {linkRows.map((row) => {
              const m = row.metrics;
              const hasProfit = m.profitAfterAds !== null;
              const isProfitable = hasProfit && m.profitAfterAds! > 0;

              return (
                <tr key={row.id} className="hover:bg-surface-2/30 transition-colors">
                  <td className="p-3">
                    <div className="font-semibold text-foreground">{row.name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand/10 text-brand font-medium">
                        {row.platform}
                      </span>
                      {row.campaignName && (
                        <span className="text-[11px] text-muted truncate max-w-[150px]">
                          {row.campaignName}
                        </span>
                      )}
                    </div>
                  </td>

                  <td className="p-3">
                    <div className="font-mono text-xs font-semibold">{row.code}</div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <CopyLinkButton
                        url={row.webUrl}
                        label="Копировать"
                        className="btn-secondary text-[10px] py-0.5 px-2"
                      />
                    </div>
                  </td>

                  <td className="p-3 text-xs">
                    {row.metaAdId ? (
                      <span className="badge bg-brand/10 text-brand font-mono text-[10px]" title={`Campaign: ${row.metaCampaignId || "—"}`}>
                        🎯 Meta: {row.metaAdId.slice(0, 10)}…
                      </span>
                    ) : (
                      <span className="text-muted text-[11px]">—</span>
                    )}
                  </td>

                  <td className="p-3 text-center">
                    <form action={toggleAdLinkAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <button
                        type="submit"
                        title={row.isActive ? "Нажмите, чтобы отключить" : "Нажмите, чтобы включить"}
                        className={`text-xs px-2 py-0.5 rounded-full font-medium transition cursor-pointer ${
                          row.isActive
                            ? "bg-success/10 text-success border border-success/30 hover:bg-success/20"
                            : "bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20"
                        }`}
                      >
                        {row.isActive ? "● Активна" : "○ Отключена"}
                      </button>
                    </form>
                  </td>

                  <td className="p-3 text-center text-xs">
                    <div className="flex items-center justify-center gap-1 font-mono">
                      <span title="Клики">{m.clicks}</span>
                      <span className="text-muted">→</span>
                      <span title="Запуски бота" className="font-semibold">{m.starts}</span>
                      <span className="text-muted">→</span>
                      <span title="Новые">{m.newUsers}</span>
                      <span className="text-muted">→</span>
                      <span title="Покупатели" className="text-success font-bold">{m.payingUsers}</span>
                    </div>
                    <div className="text-[10px] text-muted mt-0.5">
                      {m.conversionStartToBuyer}% в покупку
                    </div>
                  </td>

                  <td className="p-3 text-right font-mono font-medium text-foreground whitespace-nowrap">
                    {money(m.revenueUzs)}
                  </td>

                  <td className="p-3 text-right font-mono text-warning whitespace-nowrap">
                    {money(m.actualSpendUzs)}
                  </td>

                  <td className="p-3 text-right font-mono font-semibold whitespace-nowrap">
                    {hasProfit ? (
                      <span className={isProfitable ? "text-success" : "text-danger"}>
                        {money(m.profitAfterAds)}
                      </span>
                    ) : (
                      <span className="text-warning text-xs">Неполные</span>
                    )}
                  </td>

                  <td className="p-3 text-center font-mono font-semibold whitespace-nowrap">
                    {m.roas !== null ? (
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          m.roas >= 1
                            ? "bg-success/10 text-success"
                            : "bg-danger/10 text-danger"
                        }`}
                      >
                        {formatRoas(m.roas)}
                      </span>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </td>

                  <td className="p-3 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-1.5">
                      <Link
                        href={`/admin/bot-ads/${row.id}`}
                        className="btn-secondary text-[11px] py-1 px-2.5"
                      >
                        Анализ →
                      </Link>
                      <form action={deleteAdLinkAction} className="inline">
                        <input type="hidden" name="id" value={row.id} />
                        <button
                          type="submit"
                          className="btn-ghost text-danger hover:bg-danger/10 text-[11px] py-1 px-1.5 rounded"
                          title="Удалить ссылку (только при отсутствии истории)"
                        >
                          🗑
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {linkRows.length === 0 && (
          <div className="p-8 text-center text-muted text-sm">
            Рекламных ссылок по заданным фильтрам не найдено.
          </div>
        )}
      </div>
    </div>
  );
}
