import React from "react";
import Link from "next/link";
import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { getMetaConfig, getLastSyncStatus } from "@/lib/services/meta-ads";
import { MetaConnectionTester } from "./MetaConnectionTester";
import {
  syncMetaAdsAction,
  mapMetaAdToLinkAction,
  unlinkMetaAdAction,
} from "../actions";

export const dynamic = "force-dynamic";

function formatMoney(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "0 сум";
  return `${Math.round(amount).toLocaleString("ru-RU")} сум`;
}

export default async function MetaSettingsPage({
  searchParams,
}: {
  searchParams: {
    ok?: string;
    error?: string;
    count?: string;
    spend?: string;
    unmapped?: string;
    adCode?: string;
  };
}) {
  if (!botConfigured()) {
    return (
      <div className="space-y-4">
        <PageHeader title="⚙️ Настройки Meta Ads" />
        <EmptyState>База данных бота недоступна.</EmptyState>
      </div>
    );
  }

  const config = getMetaConfig();
  const syncStatus = await getLastSyncStatus();

  // Load all AdLinks for manual mapping
  const adLinks = await botDb.adLink.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      code: true,
      platform: true,
      metaAdId: true,
      metaCampaignId: true,
      campaignName: true,
      adName: true,
    },
  });

  // Group Meta Ads present in AdExpense to show mapping overview
  const metaExpenses = await botDb.adExpense.findMany({
    where: { source: "meta_api" },
    orderBy: { startDate: "desc" },
    select: {
      id: true,
      adLinkId: true,
      metaAdId: true,
      metaAdName: true,
      metaCampaignId: true,
      metaCampaignName: true,
      metaAdSetId: true,
      metaAdSetName: true,
      amountUzs: true,
      amount: true,
      currency: true,
      adLink: {
        select: {
          id: true,
          name: true,
          code: true,
        },
      },
    },
  });

  // Aggregate by metaAdId
  const metaAdsMap = new Map<
    string,
    {
      metaAdId: string;
      metaAdName: string;
      metaCampaignId?: string | null;
      metaCampaignName?: string | null;
      metaAdSetId?: string | null;
      metaAdSetName?: string | null;
      totalSpendUzs: number;
      adLinkId?: number | null;
      adLinkName?: string | null;
      adLinkCode?: string | null;
    }
  >();

  for (const exp of metaExpenses) {
    if (!exp.metaAdId) continue;
    const existing = metaAdsMap.get(exp.metaAdId) ?? {
      metaAdId: exp.metaAdId,
      metaAdName: exp.metaAdName || exp.metaAdId,
      metaCampaignId: exp.metaCampaignId,
      metaCampaignName: exp.metaCampaignName,
      metaAdSetId: exp.metaAdSetId,
      metaAdSetName: exp.metaAdSetName,
      totalSpendUzs: 0,
      adLinkId: exp.adLinkId,
      adLinkName: exp.adLink?.name,
      adLinkCode: exp.adLink?.code,
    };
    existing.totalSpendUzs += exp.amountUzs || 0;
    if (exp.adLinkId && !existing.adLinkId) {
      existing.adLinkId = exp.adLinkId;
      existing.adLinkName = exp.adLink?.name;
      existing.adLinkCode = exp.adLink?.code;
    }
    metaAdsMap.set(exp.metaAdId, existing);
  }

  const distinctMetaAds = [...metaAdsMap.values()];

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="⚙️ Настройки и синхронизация Meta Ads"
        subtitle="Управление интеграцией с Meta Marketing API, учет расходов и сопоставление объявлений"
        action={
          <Link href="/admin/bot-ads" className="btn-secondary text-xs sm:text-sm">
            ← Вернуться к аналитике рекламы
          </Link>
        }
      />

      {/* Notifications */}
      {searchParams.ok === "synced" && (
        <div className="card p-4 bg-success/10 border-success/30 text-success text-sm flex items-start gap-2">
          <span>✅</span>
          <div>
            <strong>Синхронизация успешно завершена!</strong>
            <div className="text-xs mt-0.5 opacity-90">
              Загружено записей: {searchParams.count || 0}. Общая сумма расходов:{" "}
              {formatMoney(Number(searchParams.spend || 0))}.
              {searchParams.unmapped && Number(searchParams.unmapped) > 0 && (
                <span className="block mt-0.5 text-warning font-semibold">
                  ⚠️ Есть несопоставленные объявления ({searchParams.unmapped} шт.).
                  Привяжите их к рекламным ссылкам ниже.
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {searchParams.ok === "mapped" && (
        <div className="card p-4 bg-success/10 border-success/30 text-success text-sm flex items-center gap-2">
          <span>✅</span>
          <span>
            Объявление успешно сопоставлено со ссылкой{" "}
            <strong>{searchParams.adCode || ""}</strong>! Все связанные расходы обновлены.
          </span>
        </div>
      )}

      {searchParams.ok === "unlinked" && (
        <div className="card p-4 bg-surface-2 border-border text-foreground text-sm flex items-center gap-2">
          <span>ℹ️</span>
          <span>Привязка объявления удалена. Исторические расходы сохранены.</span>
        </div>
      )}

      {searchParams.error && (
        <div className="card p-4 bg-danger/10 border-danger/30 text-danger text-sm flex items-start gap-2">
          <span>❌</span>
          <div>
            <strong>Ошибка синхронизации или подключения:</strong>
            <div className="text-xs mt-0.5 font-mono">{searchParams.error}</div>
          </div>
        </div>
      )}

      {/* Grid: Credentials & Diagnostics */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Status & Diagnostics Card */}
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-base">Статус подключения Meta API</h2>
            {config.configured ? (
              <span className="badge bg-success/10 text-success text-xs font-semibold">
                ● Настроено в .env
              </span>
            ) : (
              <span className="badge bg-warning/10 text-warning text-xs font-semibold">
                ⚠️ Не настроено
              </span>
            )}
          </div>

          <div className="space-y-2 text-xs">
            <div className="flex justify-between py-1 border-b border-border">
              <span className="text-muted">Рекламный аккаунт:</span>
              <span className="font-mono font-medium">
                {config.adAccountId || "Не задан (META_AD_ACCOUNT_ID)"}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-border">
              <span className="text-muted">Версия Graph API:</span>
              <span className="font-mono font-medium">{config.apiVersion}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border">
              <span className="text-muted">Маркер доступа (Token):</span>
              <span className="font-mono font-medium">
                {config.token
                  ? `••••••••••••••••${config.token.slice(-6)}`
                  : "Не задан (META_ACCESS_TOKEN)"}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-border">
              <span className="text-muted">Курс валюты (USD → UZS):</span>
              <span className="font-mono font-medium">
                1 USD = {config.usdUzsRate.toLocaleString("ru-RU")} сум
              </span>
            </div>
          </div>

          <div className="pt-2">
            <MetaConnectionTester />
          </div>
        </div>

        {/* Sync Controls Card */}
        <div className="card p-5 space-y-4">
          <h2 className="font-semibold text-base">Синхронизация расходов</h2>
          <p className="text-xs text-muted">
            Загрузка фактических расходов, показов, кликов и CPM/CPC из Meta Ads в базу
            данных. Повторные синхронизации обновляют данные без создания дубликатов.
          </p>

          <form action={syncMetaAdsAction} className="space-y-3">
            <div>
              <label className="text-xs text-muted font-medium block mb-1">
                Период для синхронизации
              </label>
              <select
                name="datePreset"
                defaultValue="last_30d"
                className="input text-xs py-2 w-full"
              >
                <option value="today">Сегодня</option>
                <option value="last_7d">Последние 7 дней</option>
                <option value="last_30d">Последние 30 дней (рекомендуется)</option>
                <option value="last_90d">Последние 90 дней</option>
                <option value="maximum">За всё время кампаний</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={!config.configured}
              className="btn-primary w-full text-xs sm:text-sm py-2"
            >
              🔄 Синхронизировать сейчас
            </button>
          </form>

          {/* Sync History / Status */}
          <div className="p-3 rounded-lg bg-surface-2/40 border border-border text-xs space-y-1">
            <div className="flex justify-between text-muted">
              <span>Последняя синхронизация:</span>
              <span className="font-medium text-foreground font-mono">
                {syncStatus.lastSyncAt
                  ? new Intl.DateTimeFormat("ru-RU", {
                      timeZone: "Asia/Tashkent",
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(syncStatus.lastSyncAt)
                  : "Ещё не проводилась"}
              </span>
            </div>
            <div className="flex justify-between text-muted">
              <span>Статус:</span>
              <span
                className={`font-semibold ${
                  syncStatus.status === "ok"
                    ? "text-success"
                    : syncStatus.status === "error"
                    ? "text-danger"
                    : "text-muted"
                }`}
              >
                {syncStatus.status === "ok"
                  ? "Успешно"
                  : syncStatus.status === "error"
                  ? "Ошибка"
                  : "Не запускалась"}
              </span>
            </div>
            {syncStatus.message && (
              <div className="text-[11px] text-muted pt-1 border-t border-border mt-1">
                {syncStatus.message}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Section: Ad Mapping Table */}
      <div className="card overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-base sm:text-lg flex items-center gap-2">
              🔗 Сопоставление Meta Ads с рекламными ссылками
              <span className="badge bg-brand/10 text-brand text-xs font-normal">
                Объявлений: {distinctMetaAds.length}
              </span>
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Привязка синхронизированных объявлений Meta к ссылкам магазина для расчёта ROAS и чистой прибыли
            </p>
          </div>
        </div>

        {distinctMetaAds.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm space-y-2">
            <p>Синхронизированных объявлений пока нет.</p>
            <p className="text-xs">
              Нажмите «Синхронизировать сейчас» выше, чтобы загрузить данные из рекламного аккаунта Meta.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
                  <th className="px-4 py-3">Объявление Meta</th>
                  <th className="px-4 py-3">Кампания и Ad Set</th>
                  <th className="px-3 py-3 text-right">Расход Meta</th>
                  <th className="px-4 py-3">Связанная ссылка AdLink</th>
                  <th className="px-4 py-3 text-right">Действие</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {distinctMetaAds.map((ad) => {
                  const isMapped = Boolean(ad.adLinkId);

                  return (
                    <tr key={ad.metaAdId} className="hover:bg-surface-2/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">{ad.metaAdName}</div>
                        <div className="text-[11px] text-muted font-mono mt-0.5">
                          ID: {ad.metaAdId}
                        </div>
                      </td>

                      <td className="px-4 py-3 text-xs">
                        <div className="font-medium">{ad.metaCampaignName || "—"}</div>
                        <div className="text-muted text-[11px]">
                          {ad.metaAdSetName || "—"}
                        </div>
                      </td>

                      <td className="px-3 py-3 text-right font-mono font-medium text-foreground whitespace-nowrap">
                        {formatMoney(ad.totalSpendUzs)}
                      </td>

                      <td className="px-4 py-3 text-xs">
                        {isMapped ? (
                          <div className="flex items-center gap-1.5">
                            <span className="badge bg-success/10 text-success font-medium">
                              ✅ Связано: {ad.adLinkName || ad.adLinkCode}
                            </span>
                            <Link
                              href={`/admin/bot-ads/${ad.adLinkId}`}
                              className="text-brand hover:underline font-mono text-[11px]"
                            >
                              ({ad.adLinkCode}) →
                            </Link>
                          </div>
                        ) : (
                          <span className="badge bg-warning/10 text-warning font-medium">
                            ⚠️ Не сопоставлено
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {isMapped ? (
                          <form action={unlinkMetaAdAction} className="inline">
                            <input type="hidden" name="adLinkId" value={ad.adLinkId!} />
                            <button
                              type="submit"
                              className="text-xs text-danger hover:underline font-medium"
                            >
                              Отвязать
                            </button>
                          </form>
                        ) : (
                          <form
                            action={mapMetaAdToLinkAction}
                            className="inline-flex items-center gap-1.5"
                          >
                            <input type="hidden" name="metaAdId" value={ad.metaAdId} />
                            <input
                              type="hidden"
                              name="metaCampaignId"
                              value={ad.metaCampaignId || ""}
                            />
                            <input
                              type="hidden"
                              name="metaAdSetId"
                              value={ad.metaAdSetId || ""}
                            />
                            <select
                              name="adLinkId"
                              required
                              className="input text-xs py-1 px-2 w-44"
                            >
                              <option value="">Выберите ссылку...</option>
                              {adLinks.map((link) => (
                                <option key={link.id} value={link.id}>
                                  {link.name} ({link.code})
                                </option>
                              ))}
                            </select>
                            <button type="submit" className="btn-primary text-xs py-1 px-2.5">
                              Привязать
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
