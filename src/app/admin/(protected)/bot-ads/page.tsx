import Link from "next/link";
import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, StatCard, EmptyState } from "@/components/admin/ui";
import { CopyLinkButton } from "./CopyLinkButton";
import {
  createAdLinkAction,
  toggleAdLinkAction,
  deleteAdLinkAction,
} from "./actions";
import {
  calculateAdMetrics,
  buildAdWebUrl,
} from "@/lib/domain/ad-attribution";

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
  const botUsername =
    process.env.NEXT_PUBLIC_BOT_USERNAME ||
    process.env.BOT_USERNAME ||
    "Aiobunabot";

  const q = (searchParams.q ?? "").trim().toLowerCase();
  const statusFilter = searchParams.status ?? "all";
  const platformFilter = searchParams.platform ?? "all";
  const period = searchParams.period ?? "all";

  // Date range filter
  let dateGte: Date | undefined;
  let dateLte: Date | undefined;
  const now = new Date();

  if (period === "today") {
    dateGte = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === "7d") {
    dateGte = new Date(now.getTime() - 7 * 86_400_000);
  } else if (period === "30d") {
    dateGte = new Date(now.getTime() - 30 * 86_400_000);
  } else if (period === "custom") {
    if (searchParams.from) {
      const parsedFrom = new Date(searchParams.from);
      if (!isNaN(parsedFrom.getTime())) dateGte = parsedFrom;
    }
    if (searchParams.to) {
      const parsedTo = new Date(searchParams.to);
      if (!isNaN(parsedTo.getTime())) {
        parsedTo.setHours(23, 59, 59, 999);
        dateLte = parsedTo;
      }
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

  // Fetch all ad links
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
        select: { id: true, amount: true, currency: true, amountUzs: true, startDate: true, endDate: true },
      },
      orders: {
        where: {
          ...dateWhere,
          status: { in: ["delivered", "completed", "awaiting_delivery", "processing", "course_ready", "awaiting_course_link"] },
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
        if (!matchName && !matchCode && !matchCampaign && !matchGroup && !matchCreative) {
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

      // Repeat buyers: distinct users with >= 2 paid orders
      const userOrderCounts = new Map<number, number>();
      for (const o of l.orders) {
        userOrderCounts.set(o.userId, (userOrderCounts.get(o.userId) ?? 0) + 1);
      }
      let repeatBuyers = 0;
      for (const count of userOrderCounts.values()) {
        if (count >= 2) repeatBuyers++;
      }

      // Sum revenue in UZS
      const revenueUzs = l.orders.reduce((sum, o) => sum + (o.priceUzs ?? Math.round(o.priceUsdt)), 0);

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

      // Filter expenses if date range applies
      const relevantExpenses = l.expenses.filter((exp) => {
        if (!dateGte && !dateLte) return true;
        if (dateGte && exp.endDate < dateGte) return false;
        if (dateLte && exp.startDate > dateLte) return false;
        return true;
      });
      const actualSpendUzs = relevantExpenses.reduce((sum, e) => sum + (e.amountUzs ?? e.amount), 0);

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

      return {
        ...l,
        metrics,
        webUrl,
      };
    });

  // Global aggregate metrics
  const totalSpend = linkRows.reduce((sum, r) => sum + r.metrics.actualSpendUzs, 0);
  const totalRevenue = linkRows.reduce((sum, r) => sum + r.metrics.revenueUzs, 0);
  const totalCostPrice = linkRows.reduce((sum, r) => sum + (r.metrics.costPriceUzs ?? 0), 0);
  const anyIncompleteCost = linkRows.some((r) => r.metrics.hasIncompleteCostPrice);
  const totalProfit = anyIncompleteCost ? null : totalRevenue - totalCostPrice;
  const totalNetProfit = totalProfit !== null ? totalProfit - totalSpend : null;
  const overallRoas = totalSpend > 0 ? Number((totalRevenue / totalSpend).toFixed(2)) : null;

  const totalClicks = linkRows.reduce((sum, r) => sum + r.metrics.clicks, 0);
  const totalStarts = linkRows.reduce((sum, r) => sum + r.metrics.starts, 0);
  const totalNewUsers = linkRows.reduce((sum, r) => sum + r.metrics.newUsers, 0);
  const totalBuyers = linkRows.reduce((sum, r) => sum + r.metrics.payingUsers, 0);
  const totalOrders = linkRows.reduce((sum, r) => sum + r.metrics.paidOrdersCount, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="📈 Рекламные ссылки и сквозная атрибуция"
        subtitle="Отслеживание трафика из Meta Ads, Instagram Reels, Telegram Ads: переходы, регистрации, заказы, выручка, себестоимость и ROAS."
      />

      {/* Notifications */}
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
      {searchParams.error === "collision" && (
        <div className="card p-3 border-danger/30 bg-danger/10 text-danger text-sm">
          ❌ Ошибка: Рекламный код <code>{searchParams.code}</code> уже существует! Код должен быть уникальным.
        </div>
      )}
      {searchParams.error === "invalid_code" && (
        <div className="card p-3 border-danger/30 bg-danger/10 text-danger text-sm">
          ❌ Некорректный код ссылки. Код может содержать только латинские буквы, цифры, дефис и подчеркивание (от 2 до 64 символов) и не должен совпадать с системными префиксами (ref, p_, deal_).
        </div>
      )}
      {searchParams.error === "has_history" && (
        <div className="card p-3 border-warning/30 bg-warning/10 text-warning text-sm space-y-1">
          <p className="font-semibold">⚠️ Удаление запрещено для сохранения точности аналитики!</p>
          <p>
            К ссылке «{searchParams.name}» уже привязаны переходы ({searchParams.clicks}), запуски бота ({searchParams.starts}) или заказы ({searchParams.orders}).
          </p>
          <p>Вы можете <strong>отключить</strong> ссылку, чтобы новые переходы не учитывались, не ломая финансовые отчёты прошлых периодов.</p>
        </div>
      )}

      {/* Global StatCards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Подтверждённая выручка"
          value={money(totalRevenue)}
          hint={`${totalOrders} оплаченных заказов`}
          tone="success"
        />
        <StatCard
          label="Фактический расход на рекламу"
          value={money(totalSpend)}
          hint={totalSpend === 0 ? "Расход не указан" : "Всего внесено расходов"}
          tone={totalSpend > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Чистая прибыль (после рекламы)"
          value={totalNetProfit !== null ? money(totalNetProfit) : "Себестоимость не заполнена"}
          hint={totalProfit !== null ? `Прибыль до рекламы: ${money(totalProfit)}` : "Укажите себестоимость в тарифах"}
          tone={totalNetProfit !== null && totalNetProfit > 0 ? "success" : "default"}
        />
        <StatCard
          label="Общий ROAS"
          value={formatRoas(overallRoas)}
          hint={overallRoas !== null ? `${overallRoas >= 1 ? "Окупается" : "Ниже расхода"}` : "Расход = 0 сум"}
          tone={overallRoas !== null && overallRoas >= 1 ? "success" : "default"}
        />
      </div>

      {/* Funnel quick overview */}
      <div className="card p-4">
        <div className="text-xs font-semibold text-muted mb-2 uppercase tracking-wide">
          Воронка по всем кампаниям за выбранный период
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
          <div className="p-2 rounded bg-surface-2">
            <div className="text-xs text-muted">1. Клики (Web)</div>
            <div className="text-lg font-bold">{totalClicks}</div>
          </div>
          <div className="p-2 rounded bg-surface-2">
            <div className="text-xs text-muted">2. Запуски (/start)</div>
            <div className="text-lg font-bold">{totalStarts}</div>
            <div className="text-[10px] text-muted">
              {totalClicks > 0 ? `${((totalStarts / totalClicks) * 100).toFixed(1)}% конв.` : "—"}
            </div>
          </div>
          <div className="p-2 rounded bg-surface-2">
            <div className="text-xs text-muted">3. Новые юзеры</div>
            <div className="text-lg font-bold">{totalNewUsers}</div>
          </div>
          <div className="p-2 rounded bg-surface-2">
            <div className="text-xs text-muted">4. Покупатели</div>
            <div className="text-lg font-bold text-success">{totalBuyers}</div>
            <div className="text-[10px] text-muted">
              {totalStarts > 0 ? `${((totalBuyers / totalStarts) * 100).toFixed(1)}% конв.` : "—"}
            </div>
          </div>
          <div className="p-2 rounded bg-surface-2">
            <div className="text-xs text-muted">5. Заказы</div>
            <div className="text-lg font-bold text-success">{totalOrders}</div>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="card p-4 space-y-3">
        <form method="GET" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="lg:col-span-2">
            <label className="text-xs text-muted font-medium">Поиск</label>
            <input
              type="text"
              name="q"
              defaultValue={searchParams.q ?? ""}
              placeholder="Поиск по названию, коду, кампании или креативу…"
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

      {/* Main Table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="border-b border-border text-muted text-xs uppercase tracking-wider bg-surface-2/40">
              <th className="p-3">Название / Площадка</th>
              <th className="p-3">Код и Готовая ссылка</th>
              <th className="p-3">Креатив</th>
              <th className="p-3 text-center">Статус</th>
              <th className="p-3 text-center">Воронка (К → С → Н → П)</th>
              <th className="p-3 text-right">Выручка</th>
              <th className="p-3 text-right">Расход</th>
              <th className="p-3 text-right">Прибыль</th>
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
                    <div className="font-semibold text-text">{row.name}</div>
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
                      <CopyLinkButton url={row.webUrl} label="Копировать" className="btn-secondary text-[10px] py-0.5 px-2" />
                    </div>
                  </td>

                  <td className="p-3 text-xs text-muted max-w-[140px] truncate">
                    {row.creativeUrl ? (
                      row.creativeUrl.startsWith("http") ? (
                        <a
                          href={row.creativeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand hover:underline truncate inline-block max-w-[130px]"
                        >
                          🔗 {row.creativeUrl.replace(/^https?:\/\//, "").slice(0, 20)}…
                        </a>
                      ) : (
                        <span>🎬 {row.creativeUrl}</span>
                      )
                    ) : (
                      "—"
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
                      <span title="Новые пользователи">{m.newUsers}</span>
                      <span className="text-muted">→</span>
                      <span title="Покупатели" className="font-bold text-success">{m.payingUsers}</span>
                    </div>
                    <div className="text-[10px] text-muted mt-0.5">
                      {m.conversionClickToStart}% старт • {m.conversionStartToBuyer}% покупка
                    </div>
                  </td>

                  <td className="p-3 text-right">
                    <div className="font-semibold text-success">{money(m.revenueUzs)}</div>
                    <div className="text-[10px] text-muted">{m.paidOrdersCount} зак.</div>
                  </td>

                  <td className="p-3 text-right">
                    <div className="font-semibold text-text">{money(m.actualSpendUzs)}</div>
                    <div className="text-[10px] text-muted">
                      {m.cacPayingUser ? `CAC: ${money(m.cacPayingUser)}` : "—"}
                    </div>
                  </td>

                  <td className="p-3 text-right">
                    {hasProfit ? (
                      <div className={`font-semibold ${isProfitable ? "text-success" : "text-danger"}`}>
                        {money(m.profitAfterAds)}
                      </div>
                    ) : (
                      <div className="text-xs text-muted" title="Себестоимость не заполнена">
                        —
                      </div>
                    )}
                    {m.roi !== null && (
                      <div className={`text-[10px] ${m.roi >= 0 ? "text-success" : "text-danger"}`}>
                        ROI: {m.roi}%
                      </div>
                    )}
                  </td>

                  <td className="p-3 text-center">
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-mono font-bold ${
                        m.roas === null
                          ? "text-muted"
                          : m.roas >= 2
                          ? "bg-success/15 text-success"
                          : m.roas >= 1
                          ? "bg-warning/15 text-warning"
                          : "bg-danger/15 text-danger"
                      }`}
                    >
                      {formatRoas(m.roas)}
                    </span>
                  </td>

                  <td className="p-3 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        href={`/admin/bot-ads/${row.id}`}
                        className="btn-secondary text-xs py-1 px-2.5"
                      >
                        Воронка и анализ 📊
                      </Link>

                      <form action={deleteAdLinkAction} className="inline">
                        <input type="hidden" name="id" value={row.id} />
                        <button
                          type="submit"
                          className="btn-ghost text-danger text-xs py-1 px-2 hover:bg-danger/10"
                          title="Удалить (только если нет истории)"
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
            Рекламных ссылок не найдено. Нажмите «Создать новую рекламную ссылку» выше, чтобы сгенерировать первую ссылку для Meta или Instagram.
          </div>
        )}
      </div>
    </div>
  );
}
