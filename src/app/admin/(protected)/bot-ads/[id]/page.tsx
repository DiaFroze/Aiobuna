import Link from "next/link";
import { notFound } from "next/navigation";
import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, StatCard, EmptyState } from "@/components/admin/ui";
import { CopyLinkButton } from "../CopyLinkButton";
import {
  toggleAdLinkAction,
  createAdExpenseAction,
  deleteAdExpenseAction,
} from "../actions";
import {
  calculateAdMetrics,
  buildFunnelSteps,
  buildAdWebUrl,
  buildAdRedirectUrl,
} from "@/lib/domain/ad-attribution";

export const dynamic = "force-dynamic";

function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${Math.round(v).toLocaleString("ru-RU")} сум`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} сек`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  const days = Math.floor(hours / 24);
  return `${days} дн ${hours % 24} ч`;
}

export default async function AdLinkDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { ok?: string; error?: string };
}) {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Анализ рекламной кампании" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const id = Number(params.id);
  if (!id || isNaN(id)) notFound();

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const botUsername =
    process.env.NEXT_PUBLIC_BOT_USERNAME ||
    process.env.BOT_USERNAME ||
    "Aiobunabot";

  const adLink = await botDb.adLink.findUnique({
    where: { id },
    include: {
      clicks: {
        where: { isBot: false },
        orderBy: { createdAt: "desc" },
      },
      touches: {
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: {
              id: true,
              tgId: true,
              username: true,
              firstName: true,
              createdAt: true,
            },
          },
        },
      },
      expenses: {
        orderBy: { startDate: "desc" },
      },
      orders: {
        where: {
          status: { in: ["delivered", "completed", "awaiting_delivery", "processing", "course_ready", "awaiting_course_link"] },
          priceUsdt: { gt: 0 },
        },
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: {
              id: true,
              tgId: true,
              username: true,
              firstName: true,
            },
          },
        },
      },
    },
  });

  if (!adLink) notFound();

  // Metrics calculation
  const clicks = adLink.clicks.length;
  const uniqueClicks = adLink.clicks.filter((c) => c.isUnique).length;
  const starts = adLink.touches.length;
  const newUsers = adLink.touches.filter((t) => t.isNewUser).length;

  const payingUserIds = new Set(adLink.orders.map((o) => o.userId));
  const payingUsers = payingUserIds.size;
  const paidOrdersCount = adLink.orders.length;

  const userOrderCounts = new Map<number, number>();
  for (const o of adLink.orders) {
    userOrderCounts.set(o.userId, (userOrderCounts.get(o.userId) ?? 0) + 1);
  }
  let repeatBuyers = 0;
  for (const count of userOrderCounts.values()) {
    if (count >= 2) repeatBuyers++;
  }

  const revenueUzs = adLink.orders.reduce(
    (sum, o) => sum + (o.priceUzs ?? Math.round(o.priceUsdt)),
    0,
  );

  let costPriceUzs = 0;
  let hasIncompleteCostPrice = false;
  for (const o of adLink.orders) {
    if (o.costPriceUzs !== null && o.costPriceUzs !== undefined) {
      costPriceUzs += o.costPriceUzs;
    } else {
      hasIncompleteCostPrice = true;
    }
  }

  const actualSpendUzs = adLink.expenses.reduce(
    (sum, e) => sum + (e.amountUzs ?? e.amount),
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

  const funnelSteps = buildFunnelSteps({
    clicks,
    starts,
    newUsers,
    payingUsers,
    repeatBuyers,
  });

  // Calculate average time to first purchase
  const userFirstStartMap = new Map<number, Date>();
  for (const t of adLink.touches) {
    if (!userFirstStartMap.has(t.userId)) {
      userFirstStartMap.set(t.userId, t.createdAt);
    }
  }

  const purchaseDurations: number[] = [];
  for (const o of adLink.orders) {
    const startTime = userFirstStartMap.get(o.userId);
    if (startTime && o.createdAt >= startTime) {
      purchaseDurations.push(o.createdAt.getTime() - startTime.getTime());
    }
  }
  const avgTimeToPurchaseMs =
    purchaseDurations.length > 0
      ? purchaseDurations.reduce((a, b) => a + b, 0) / purchaseDurations.length
      : null;

  const webUrl = buildAdWebUrl(appUrl, adLink.code);
  const directTgUrl = buildAdRedirectUrl(botUsername, adLink.code);

  return (
    <div className="space-y-6">
      {/* Top Bar with Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <Link
            href="/admin/bot-ads"
            className="text-xs text-muted hover:text-brand inline-flex items-center gap-1 mb-1 transition-colors"
          >
            ← Вернуться к списку рекламных ссылок
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{adLink.name}</h1>
            <span className="text-xs px-2 py-0.5 rounded bg-brand/10 text-brand font-medium">
              {adLink.platform}
            </span>
          </div>
          <div className="text-xs text-muted mt-1 flex flex-wrap items-center gap-3">
            <span>Код: <code className="font-mono text-text">{adLink.code}</code></span>
            {adLink.campaignName && <span>Кампания: <strong>{adLink.campaignName}</strong></span>}
            {adLink.adGroupName && <span>Группа: <strong>{adLink.adGroupName}</strong></span>}
            {adLink.adName && <span>Объявление: <strong>{adLink.adName}</strong></span>}
            {adLink.creativeUrl && (
              <span>
                Креатив:{" "}
                {adLink.creativeUrl.startsWith("http") ? (
                  <a href={adLink.creativeUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                    Смотреть ролик ↗
                  </a>
                ) : (
                  <strong>{adLink.creativeUrl}</strong>
                )}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <CopyLinkButton url={webUrl} label="Копировать рекламную ссылку" className="btn-primary text-xs py-2 px-3" />
          <form action={toggleAdLinkAction}>
            <input type="hidden" name="id" value={adLink.id} />
            <input type="hidden" name="returnTo" value={`/admin/bot-ads/${adLink.id}`} />
            <button
              type="submit"
              className={`text-xs px-3 py-2 rounded font-medium transition ${
                adLink.isActive
                  ? "bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20"
                  : "bg-success/10 text-success border border-success/30 hover:bg-success/20"
              }`}
            >
              {adLink.isActive ? "Отключить ссылку" : "Включить ссылку"}
            </button>
          </form>
        </div>
      </div>

      {/* Notifications */}
      {searchParams.ok === "expense_added" && (
        <div className="card p-3 border-success/30 bg-success/10 text-success text-sm">
          ✅ Фактический расход успешно добавлен! Показатели прибыли и ROAS пересчитаны.
        </div>
      )}
      {searchParams.ok === "expense_deleted" && (
        <div className="card p-3 border-success/30 bg-success/10 text-success text-sm">
          Запись расхода удалена.
        </div>
      )}
      {searchParams.error === "missing_expense_fields" && (
        <div className="card p-3 border-danger/30 bg-danger/10 text-danger text-sm">
          Заполните сумму и даты периода расхода.
        </div>
      )}

      {/* Link URLs Info Card */}
      <div className="card p-4 bg-surface-2/30 space-y-2">
        <div className="text-xs font-semibold text-muted uppercase tracking-wider">
          Ссылки для рекламного кабинета Meta Ads / Facebook / Instagram Reels:
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-2.5 rounded bg-surface border border-border">
            <div className="text-muted mb-1">Основная ссылка (с защитой от ботов и дедупликацией кликов):</div>
            <div className="flex items-center justify-between gap-2 font-mono break-all text-brand font-medium">
              <span>{webUrl}</span>
              <CopyLinkButton url={webUrl} label="Копировать" className="btn-secondary text-[11px] py-0.5 px-2 shrink-0" />
            </div>
          </div>
          <div className="p-2.5 rounded bg-surface border border-border">
            <div className="text-muted mb-1">Прямой Telegram deep link:</div>
            <div className="flex items-center justify-between gap-2 font-mono break-all text-text">
              <span>{directTgUrl}</span>
              <CopyLinkButton url={directTgUrl} label="Копировать" className="btn-secondary text-[11px] py-0.5 px-2 shrink-0" />
            </div>
          </div>
        </div>
      </div>

      {/* Visual Conversion Funnel */}
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold flex items-center gap-2">
            <span>🎯</span> Воронка конверсии рекламной кампании
          </h2>
          <span className="text-xs text-muted">
            Конверсия из клика в покупателя:{" "}
            <strong className="text-success text-sm font-mono">
              {metrics.uniqueClicks > 0
                ? `${((metrics.payingUsers / metrics.uniqueClicks) * 100).toFixed(1)}%`
                : "—"}
            </strong>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
          {funnelSteps.map((step, idx) => (
            <div
              key={step.name}
              className="relative p-3 rounded-lg border border-border bg-surface flex flex-col justify-between"
            >
              <div>
                <div className="text-xs text-muted font-medium flex items-center justify-between">
                  <span>{step.name}</span>
                  <span className="text-[10px] text-muted">Этап {idx + 1}</span>
                </div>
                <div className="text-2xl font-bold mt-2 font-mono text-text">
                  {step.count.toLocaleString("ru-RU")}
                </div>
              </div>

              <div className="mt-3 pt-2 border-t border-border/60 flex items-center justify-between text-[11px]">
                <span className="text-muted">От пред. шага:</span>
                <span className={`font-semibold font-mono ${step.conversionFromPrev >= 50 ? "text-success" : step.conversionFromPrev >= 20 ? "text-warning" : "text-text"}`}>
                  {idx === 0 ? "100%" : `${step.conversionFromPrev}%`}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Financial & Efficiency KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label="Подтверждённая выручка"
          value={money(metrics.revenueUzs)}
          hint={`${metrics.paidOrdersCount} оплаченных заказов`}
          tone="success"
        />
        <StatCard
          label="Фактический расход"
          value={money(metrics.actualSpendUzs)}
          hint={metrics.actualSpendUzs === 0 ? "Расход не внесён" : "Всего потрачено на рекламу"}
          tone={metrics.actualSpendUzs > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Себестоимость товаров"
          value={hasIncompleteCostPrice ? "Неполная себестоимость" : money(metrics.costPriceUzs)}
          hint={hasIncompleteCostPrice ? "Заполните себестоимость в тарифах" : `Прибыль до рекламы: ${money(metrics.profitBeforeAds)}`}
          tone="default"
        />
        <StatCard
          label="Чистая прибыль"
          value={hasIncompleteCostPrice ? "—" : money(metrics.profitAfterAds)}
          hint={metrics.roi !== null ? `ROI: ${metrics.roi}%` : "Требуется себестоимость и расход"}
          tone={metrics.profitAfterAds !== null && metrics.profitAfterAds > 0 ? "success" : "default"}
        />
      </div>

      {/* Secondary Performance Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="card p-3">
          <div className="text-xs text-muted">ROAS (Окупаемость)</div>
          <div className="text-xl font-bold font-mono mt-1 text-brand">
            {metrics.roas !== null ? `${metrics.roas}x` : "—"}
          </div>
          <div className="text-[10px] text-muted mt-0.5">Выручка / Расход</div>
        </div>

        <div className="card p-3">
          <div className="text-xs text-muted">Средний чек (AOV)</div>
          <div className="text-xl font-bold font-mono mt-1">
            {money(metrics.aov)}
          </div>
          <div className="text-[10px] text-muted mt-0.5">На 1 оплаченный заказ</div>
        </div>

        <div className="card p-3">
          <div className="text-xs text-muted">Стоимость покупателя (CAC)</div>
          <div className="text-xl font-bold font-mono mt-1 text-text">
            {metrics.cacPayingUser !== null ? money(metrics.cacPayingUser) : "—"}
          </div>
          <div className="text-[10px] text-muted mt-0.5">Расход / Покупатели</div>
        </div>

        <div className="card p-3">
          <div className="text-xs text-muted">Стоимость клика (CPC)</div>
          <div className="text-xl font-bold font-mono mt-1">
            {metrics.cpc !== null ? money(metrics.cpc) : "—"}
          </div>
          <div className="text-[10px] text-muted mt-0.5">Расход / Клики</div>
        </div>

        <div className="card p-3">
          <div className="text-xs text-muted">Время до покупки</div>
          <div className="text-xl font-bold font-mono mt-1">
            {formatDuration(avgTimeToPurchaseMs)}
          </div>
          <div className="text-[10px] text-muted mt-0.5">От /start до оплаты</div>
        </div>
      </div>

      {/* Ad Expense Management */}
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold flex items-center gap-2">
              <span>💳</span> Фактические расходы на рекламу
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Вносите реальные траты из рекламного кабинета Meta Ads за выбранные периоды для точного расчёта прибыли и ROAS.
            </p>
          </div>
        </div>

        {/* Add expense form */}
        <form action={createAdExpenseAction} className="p-4 rounded-lg bg-surface-2/40 border border-border space-y-3">
          <input type="hidden" name="adLinkId" value={adLink.id} />
          <div className="text-xs font-semibold text-text">Добавить фактический расход:</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
            <div>
              <label className="text-xs text-muted">Сумма <span className="text-danger">*</span></label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                name="amount"
                required
                placeholder="напр. 25"
                className="input mt-1 w-full text-sm font-mono"
              />
            </div>

            <div>
              <label className="text-xs text-muted">Валюта</label>
              <select name="currency" defaultValue="USD" className="input mt-1 w-full text-sm">
                <option value="USD">USD ($)</option>
                <option value="UZS">UZS (сум)</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-muted">Период С <span className="text-danger">*</span></label>
              <input
                type="date"
                name="startDate"
                required
                defaultValue={new Date().toISOString().slice(0, 10)}
                className="input mt-1 w-full text-sm"
              />
            </div>

            <div>
              <label className="text-xs text-muted">Период По <span className="text-danger">*</span></label>
              <input
                type="date"
                name="endDate"
                required
                defaultValue={new Date().toISOString().slice(0, 10)}
                className="input mt-1 w-full text-sm"
              />
            </div>

            <div className="flex items-end">
              <button type="submit" className="btn-primary text-xs py-2 px-4 w-full">
                + Сохранить расход
              </button>
            </div>

            <div className="sm:col-span-2 md:col-span-4">
              <label className="text-xs text-muted">Комментарий (необязательно)</label>
              <input
                name="comment"
                placeholder="напр. Списание Meta за 3 дня показов Reels..."
                className="input mt-1 w-full text-sm"
              />
            </div>

            <div className="md:col-span-1">
              <label className="text-xs text-muted" title="Курс пересчёта USD в сумы">Курс USD/UZS</label>
              <input
                type="number"
                name="exchangeRate"
                placeholder="12600"
                defaultValue={12600}
                className="input mt-1 w-full text-sm font-mono"
              />
            </div>
          </div>
        </form>

        {/* Expenses Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="border-b border-border text-muted text-xs uppercase bg-surface-2/30">
                <th className="p-2.5">Период расхода</th>
                <th className="p-2.5 text-right">Сумма в валюте</th>
                <th className="p-2.5 text-right">Сумма в сумах</th>
                <th className="p-2.5">Комментарий</th>
                <th className="p-2.5">Внесено</th>
                <th className="p-2.5 text-right">Действие</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {adLink.expenses.map((exp) => (
                <tr key={exp.id} className="hover:bg-surface-2/20">
                  <td className="p-2.5 font-mono text-xs">
                    {exp.startDate.toISOString().slice(0, 10)} — {exp.endDate.toISOString().slice(0, 10)}
                  </td>
                  <td className="p-2.5 text-right font-mono font-semibold">
                    {exp.amount.toLocaleString("ru-RU")} {exp.currency}
                  </td>
                  <td className="p-2.5 text-right font-mono text-text">
                    {money(exp.amountUzs ?? exp.amount)}
                  </td>
                  <td className="p-2.5 text-xs text-muted">
                    {exp.comment || "—"}
                  </td>
                  <td className="p-2.5 text-xs text-muted">
                    {exp.createdAt.toISOString().slice(0, 10)}
                  </td>
                  <td className="p-2.5 text-right">
                    <form action={deleteAdExpenseAction} className="inline">
                      <input type="hidden" name="id" value={exp.id} />
                      <input type="hidden" name="adLinkId" value={adLink.id} />
                      <button
                        type="submit"
                        className="text-xs text-danger hover:underline"
                      >
                        Удалить
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {adLink.expenses.length === 0 && (
            <div className="p-4 text-center text-xs text-muted">
              Расходов пока не внесено. Добавьте сумму фактических трат в форме выше.
            </div>
          )}
        </div>
      </div>

      {/* Attributed Orders Table */}
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold flex items-center gap-2">
            <span>📦</span> Оплаченные заказы по этой рекламе ({adLink.orders.length})
          </h2>
          <span className="text-xs font-semibold text-success font-mono">
            Всего: {money(revenueUzs)}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="border-b border-border text-muted text-xs uppercase bg-surface-2/30">
                <th className="p-2.5">Заказ #</th>
                <th className="p-2.5">Покупатель</th>
                <th className="p-2.5">Товар</th>
                <th className="p-2.5 text-right">Выручка (сум)</th>
                <th className="p-2.5 text-right">Себестоимость</th>
                <th className="p-2.5 text-center">Статус</th>
                <th className="p-2.5 text-right">Дата</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {adLink.orders.map((ord) => (
                <tr key={ord.id} className="hover:bg-surface-2/20">
                  <td className="p-2.5 font-mono font-semibold">#{ord.id}</td>
                  <td className="p-2.5 text-xs">
                    <div>{ord.user.firstName || "Пользователь"}</div>
                    <div className="text-muted font-mono">
                      {ord.user.username ? `@${ord.user.username}` : `TG: ${ord.user.tgId}`}
                    </div>
                  </td>
                  <td className="p-2.5 font-medium">{ord.titleRu}</td>
                  <td className="p-2.5 text-right font-mono font-semibold text-success">
                    {money(ord.priceUzs ?? Math.round(ord.priceUsdt))}
                  </td>
                  <td className="p-2.5 text-right font-mono text-muted text-xs">
                    {ord.costPriceUzs !== null && ord.costPriceUzs !== undefined ? money(ord.costPriceUzs) : "—"}
                  </td>
                  <td className="p-2.5 text-center">
                    <span className="text-[10px] px-2 py-0.5 rounded bg-success/10 text-success font-medium">
                      {ord.status}
                    </span>
                  </td>
                  <td className="p-2.5 text-right text-xs text-muted">
                    {ord.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {adLink.orders.length === 0 && (
            <div className="p-6 text-center text-xs text-muted">
              По этой рекламной ссылке пока нет завершённых покупок.
            </div>
          )}
        </div>
      </div>

      {/* Attributed Users Table */}
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold flex items-center gap-2">
            <span>👥</span> Привлечённые пользователи ({adLink.touches.length})
          </h2>
          <span className="text-xs text-muted">
            Новых: <strong>{newUsers}</strong> • Покупателей: <strong>{payingUsers}</strong>
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="border-b border-border text-muted text-xs uppercase bg-surface-2/30">
                <th className="p-2.5">Пользователь</th>
                <th className="p-2.5">Telegram ID</th>
                <th className="p-2.5 text-center">Тип запуска</th>
                <th className="p-2.5 text-center">Заказов</th>
                <th className="p-2.5 text-right">Покупок на сумму</th>
                <th className="p-2.5 text-right">Время старта</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {adLink.touches.map((touch) => {
                const userOrders = adLink.orders.filter((o) => o.userId === touch.userId);
                const totalSpent = userOrders.reduce(
                  (sum, o) => sum + (o.priceUzs ?? Math.round(o.priceUsdt)),
                  0,
                );

                return (
                  <tr key={touch.id} className="hover:bg-surface-2/20">
                    <td className="p-2.5 text-xs font-medium">
                      <div>{touch.user.firstName || "—"}</div>
                      {touch.user.username && (
                        <div className="text-brand">@{touch.user.username}</div>
                      )}
                    </td>
                    <td className="p-2.5 font-mono text-xs">{touch.user.tgId}</td>
                    <td className="p-2.5 text-center">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          touch.isNewUser
                            ? "bg-brand/10 text-brand"
                            : "bg-surface-2 text-muted"
                        }`}
                      >
                        {touch.isNewUser ? "✨ Новый" : "Повторный"}
                      </span>
                    </td>
                    <td className="p-2.5 text-center font-mono">
                      {userOrders.length}
                    </td>
                    <td className="p-2.5 text-right font-mono font-semibold text-success">
                      {totalSpent > 0 ? money(totalSpent) : "—"}
                    </td>
                    <td className="p-2.5 text-right text-xs text-muted">
                      {touch.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {adLink.touches.length === 0 && (
            <div className="p-6 text-center text-xs text-muted">
              Пользователей по этой рекламной ссылке пока не зафиксировано.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
