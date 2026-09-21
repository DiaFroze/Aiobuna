"use client";

import React, { useState, useMemo } from "react";
import {
  CampaignPerformanceRow,
  AdSetPerformanceRow,
  AdPerformanceRow,
} from "@/lib/domain/ad-attribution";

interface MetaBreakdownTabsProps {
  campaigns: CampaignPerformanceRow[];
  adSets: AdSetPerformanceRow[];
  ads: AdPerformanceRow[];
}

type TabType = "campaigns" | "adsets" | "ads";
type SortOption = "spend" | "revenue" | "profit" | "roas" | "orders";

function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${Math.round(v).toLocaleString("ru-RU")} сум`;
}

function formatRoas(roas: number | null): string {
  if (roas === null || !Number.isFinite(roas)) return "—";
  return `${roas.toFixed(2)}x`;
}

export function MetaBreakdownTabs({
  campaigns,
  adSets,
  ads,
}: MetaBreakdownTabsProps) {
  const [activeTab, setActiveTab] = useState<TabType>("campaigns");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("spend");

  const q = searchQuery.trim().toLowerCase();

  // Filtered & Sorted Campaigns
  const filteredCampaigns = useMemo(() => {
    return campaigns
      .filter((c) => {
        if (!q) return true;
        return (
          c.campaignName.toLowerCase().includes(q) ||
          (c.metaCampaignId ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (sortBy === "spend") return b.spendUzs - a.spendUzs;
        if (sortBy === "revenue") return b.revenueUzs - a.revenueUzs;
        if (sortBy === "profit") return (b.profitAfterAds ?? -Infinity) - (a.profitAfterAds ?? -Infinity);
        if (sortBy === "roas") return (b.roas ?? -Infinity) - (a.roas ?? -Infinity);
        if (sortBy === "orders") return b.ordersCount - a.ordersCount;
        return 0;
      });
  }, [campaigns, q, sortBy]);

  // Filtered & Sorted Ad Sets
  const filteredAdSets = useMemo(() => {
    return adSets
      .filter((s) => {
        if (!q) return true;
        return (
          s.adSetName.toLowerCase().includes(q) ||
          (s.metaAdSetId ?? "").toLowerCase().includes(q) ||
          (s.campaignName ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (sortBy === "spend") return b.spendUzs - a.spendUzs;
        if (sortBy === "revenue") return b.revenueUzs - a.revenueUzs;
        if (sortBy === "profit") return (b.profitAfterAds ?? -Infinity) - (a.profitAfterAds ?? -Infinity);
        if (sortBy === "roas") return (b.roas ?? -Infinity) - (a.roas ?? -Infinity);
        if (sortBy === "orders") return b.ordersCount - a.ordersCount;
        return 0;
      });
  }, [adSets, q, sortBy]);

  // Filtered & Sorted Ads
  const filteredAds = useMemo(() => {
    return ads
      .filter((a) => {
        if (!q) return true;
        return (
          a.adName.toLowerCase().includes(q) ||
          (a.metaAdId ?? "").toLowerCase().includes(q) ||
          (a.campaignName ?? "").toLowerCase().includes(q) ||
          (a.adSetName ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (sortBy === "spend") return b.spendUzs - a.spendUzs;
        if (sortBy === "revenue") return b.revenueUzs - a.revenueUzs;
        if (sortBy === "profit") return (b.profitAfterAds ?? -Infinity) - (a.profitAfterAds ?? -Infinity);
        if (sortBy === "roas") return (b.roas ?? -Infinity) - (a.roas ?? -Infinity);
        if (sortBy === "orders") return b.ordersCount - a.ordersCount;
        return 0;
      });
  }, [ads, q, sortBy]);

  return (
    <div className="card overflow-hidden">
      {/* Header & Tabs */}
      <div className="p-4 sm:p-5 border-b border-border space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-base sm:text-lg flex items-center gap-2">
              <span>🎯</span>
              <span>Детализация расходов: Кампании · Группы · Объявления</span>
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Сквозная разбивка расходов, кликов, продаж, себестоимости и окупаемости по уровням рекламы Meta Ads
            </p>
          </div>

          {/* Sorter */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted whitespace-nowrap">Сортировка:</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="input text-xs py-1 px-2.5 bg-surface-2 border-border"
            >
              <option value="spend">По расходу ↓</option>
              <option value="revenue">По выручке ↓</option>
              <option value="profit">По чистой прибыли ↓</option>
              <option value="roas">По ROAS (окупаемости) ↓</option>
              <option value="orders">По числу заказов ↓</option>
            </select>
          </div>
        </div>

        {/* Tab Switcher & Search Bar */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-1">
          <div className="inline-flex rounded-lg bg-surface-2/60 p-1 border border-border">
            <button
              type="button"
              onClick={() => setActiveTab("campaigns")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeTab === "campaigns"
                  ? "bg-brand text-white shadow-sm font-semibold"
                  : "text-muted hover:text-foreground"
              }`}
            >
              📁 Кампании ({campaigns.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("adsets")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeTab === "adsets"
                  ? "bg-brand text-white shadow-sm font-semibold"
                  : "text-muted hover:text-foreground"
              }`}
            >
              📂 Группы объявлений ({adSets.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("ads")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeTab === "ads"
                  ? "bg-brand text-white shadow-sm font-semibold"
                  : "text-muted hover:text-foreground"
              }`}
            >
              🎬 Объявления ({ads.length})
            </button>
          </div>

          <div className="relative w-full sm:w-72">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Фильтр по названию или ID..."
              className="input text-xs py-1.5 pl-8 pr-3 w-full bg-surface-2/60 border-border"
            />
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-xs">
              🔍
            </span>
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground text-xs"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 1. Campaigns Table */}
      {activeTab === "campaigns" && (
        <div className="overflow-x-auto">
          {filteredCampaigns.length === 0 ? (
            <div className="p-8 text-center text-muted text-sm">
              {q ? "Кампаний по запросу не найдено." : "Пока нет данных о рекламных кампаниях."}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Кампания</th>
                  <th className="px-3 py-3 text-right">Расход</th>
                  <th className="px-3 py-3 text-right">Клики</th>
                  <th className="px-3 py-3 text-right">Запуски</th>
                  <th className="px-3 py-3 text-right">Покупатели</th>
                  <th className="px-3 py-3 text-right">Заказы</th>
                  <th className="px-3 py-3 text-right">Выручка</th>
                  <th className="px-3 py-3 text-right">Себестоимость</th>
                  <th className="px-3 py-3 text-right">Прибыль до рекл.</th>
                  <th className="px-4 py-3 text-right">Чистая прибыль</th>
                  <th className="px-3 py-3 text-center">ROAS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredCampaigns.map((c, idx) => (
                  <tr key={c.campaignName + idx} className="hover:bg-surface-2/30 transition-colors">
                    <td className="px-4 py-3 text-xs text-muted font-mono">{idx + 1}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-foreground text-xs sm:text-sm">
                        {c.campaignName}
                      </div>
                      {c.metaCampaignId && (
                        <div className="text-[10px] text-muted font-mono mt-0.5">
                          ID: {c.metaCampaignId}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs font-semibold text-warning whitespace-nowrap">
                      {money(c.spendUzs)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs">{c.clicks}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs">{c.starts}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-success font-medium">
                      {c.buyers}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs">{c.ordersCount}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-brand font-medium whitespace-nowrap">
                      {money(c.revenueUzs)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs whitespace-nowrap">
                      {c.hasIncompleteCostPrice ? (
                        <span className="text-warning">Неполная</span>
                      ) : (
                        money(c.costPriceUzs)
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs whitespace-nowrap">
                      {c.profitBeforeAds !== null ? (
                        <span className={c.profitBeforeAds >= 0 ? "text-foreground" : "text-danger"}>
                          {money(c.profitBeforeAds)}
                        </span>
                      ) : (
                        <span className="text-warning">Неполные</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-semibold whitespace-nowrap">
                      {c.profitAfterAds !== null ? (
                        <span className={c.profitAfterAds >= 0 ? "text-success" : "text-danger"}>
                          {c.profitAfterAds >= 0 ? `+${money(c.profitAfterAds)}` : money(c.profitAfterAds)}
                        </span>
                      ) : (
                        <span className="text-warning">Неполные</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center font-mono text-xs font-medium">
                      {c.roas !== null ? (
                        <span
                          className={`badge text-[11px] font-mono ${
                            c.roas >= 1
                              ? "bg-success/15 text-success font-bold"
                              : "bg-danger/15 text-danger font-bold"
                          }`}
                        >
                          {formatRoas(c.roas)}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 2. Ad Sets Table */}
      {activeTab === "adsets" && (
        <div className="overflow-x-auto">
          {filteredAdSets.length === 0 ? (
            <div className="p-8 text-center text-muted text-sm">
              {q ? "Групп объявлений по запросу не найдено." : "Пока нет данных о группах объявлений."}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Группа объявлений (Ad Set)</th>
                  <th className="px-4 py-3">Кампания</th>
                  <th className="px-3 py-3 text-right">Расход</th>
                  <th className="px-3 py-3 text-right">Клики</th>
                  <th className="px-3 py-3 text-right">Покупатели</th>
                  <th className="px-3 py-3 text-right">Заказы</th>
                  <th className="px-3 py-3 text-right">Выручка</th>
                  <th className="px-3 py-3 text-right">Себестоимость</th>
                  <th className="px-4 py-3 text-right">Чистая прибыль</th>
                  <th className="px-3 py-3 text-center">ROAS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredAdSets.map((s, idx) => (
                  <tr key={s.adSetName + idx} className="hover:bg-surface-2/30 transition-colors">
                    <td className="px-4 py-3 text-xs text-muted font-mono">{idx + 1}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-foreground text-xs sm:text-sm">
                        {s.adSetName}
                      </div>
                      {s.metaAdSetId && (
                        <div className="text-[10px] text-muted font-mono mt-0.5">
                          ID: {s.metaAdSetId}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted truncate max-w-[160px]">
                      {s.campaignName || "—"}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs font-semibold text-warning whitespace-nowrap">
                      {money(s.spendUzs)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs">{s.clicks}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-success font-medium">
                      {s.buyers}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs">{s.ordersCount}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-brand font-medium whitespace-nowrap">
                      {money(s.revenueUzs)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs whitespace-nowrap">
                      {s.hasIncompleteCostPrice ? (
                        <span className="text-warning">Неполная</span>
                      ) : (
                        money(s.costPriceUzs)
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-semibold whitespace-nowrap">
                      {s.profitAfterAds !== null ? (
                        <span className={s.profitAfterAds >= 0 ? "text-success" : "text-danger"}>
                          {s.profitAfterAds >= 0 ? `+${money(s.profitAfterAds)}` : money(s.profitAfterAds)}
                        </span>
                      ) : (
                        <span className="text-warning">Неполные</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center font-mono text-xs font-medium">
                      {s.roas !== null ? (
                        <span
                          className={`badge text-[11px] font-mono ${
                            s.roas >= 1
                              ? "bg-success/15 text-success font-bold"
                              : "bg-danger/15 text-danger font-bold"
                          }`}
                        >
                          {formatRoas(s.roas)}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 3. Ads Table */}
      {activeTab === "ads" && (
        <div className="overflow-x-auto">
          {filteredAds.length === 0 ? (
            <div className="p-8 text-center text-muted text-sm">
              {q ? "Объявлений по запросу не найдено." : "Пока нет данных об объявлениях."}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Объявление (Креатив)</th>
                  <th className="px-4 py-3">Кампания / Группа</th>
                  <th className="px-3 py-3 text-right">Расход</th>
                  <th className="px-3 py-3 text-right">Клики</th>
                  <th className="px-3 py-3 text-right">Покупатели</th>
                  <th className="px-3 py-3 text-right">Конверсия</th>
                  <th className="px-3 py-3 text-right">Заказы</th>
                  <th className="px-3 py-3 text-right">Выручка</th>
                  <th className="px-4 py-3 text-right">Чистая прибыль</th>
                  <th className="px-3 py-3 text-center">ROAS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredAds.map((a, idx) => (
                  <tr key={a.adName + idx} className="hover:bg-surface-2/30 transition-colors">
                    <td className="px-4 py-3 text-xs text-muted font-mono">{idx + 1}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-foreground text-xs sm:text-sm">
                        {a.adName}
                      </div>
                      {a.metaAdId && (
                        <div className="text-[10px] text-muted font-mono mt-0.5">
                          ID: {a.metaAdId}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted truncate max-w-[160px]">
                      <div>{a.campaignName || "—"}</div>
                      {a.adSetName && (
                        <div className="text-[10px] opacity-75">{a.adSetName}</div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs font-semibold text-warning whitespace-nowrap">
                      {money(a.spendUzs)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs">{a.clicks}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-success font-medium">
                      {a.buyers}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs">
                      <span className={a.conversionRate > 5 ? "text-success font-bold" : "text-muted"}>
                        {a.conversionRate}%
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs">{a.ordersCount}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-brand font-medium whitespace-nowrap">
                      {money(a.revenueUzs)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-semibold whitespace-nowrap">
                      {a.profitAfterAds !== null ? (
                        <span className={a.profitAfterAds >= 0 ? "text-success" : "text-danger"}>
                          {a.profitAfterAds >= 0 ? `+${money(a.profitAfterAds)}` : money(a.profitAfterAds)}
                        </span>
                      ) : (
                        <span className="text-warning">Неполные</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center font-mono text-xs font-medium">
                      {a.roas !== null ? (
                        <span
                          className={`badge text-[11px] font-mono ${
                            a.roas >= 1
                              ? "bg-success/15 text-success font-bold"
                              : "bg-danger/15 text-danger font-bold"
                          }`}
                        >
                          {formatRoas(a.roas)}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
