import React from "react";
import Link from "next/link";
import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, StatCard, EmptyState } from "@/components/admin/ui";
import {
  SALE_STATUSES,
  RawSalesOrder,
  calculateSalesMetrics,
  groupSalesByDay,
  groupSalesByProduct,
  formatUzs,
  formatTashkentDateTime,
  orderRevenue,
  computePeriodDateRange,
} from "@/lib/domain/sales-statistics";
import { DailySalesChart } from "./DailySalesChart";
import { ProductRatingTable } from "./ProductRatingTable";

export const dynamic = "force-dynamic";

function renderOrderStatusBadge(status: string) {
  switch (status) {
    case "delivered":
      return (
        <span className="badge bg-success/10 text-success text-xs font-medium">
          Доставлен
        </span>
      );
    case "completed":
      return (
        <span className="badge bg-success/10 text-success text-xs font-medium">
          Выполнен
        </span>
      );
    case "awaiting_delivery":
      return (
        <span className="badge bg-warning/10 text-warning text-xs font-medium">
          Ожидает выдачи
        </span>
      );
    case "processing":
      return (
        <span className="badge bg-brand/10 text-brand text-xs font-medium">
          В обработке
        </span>
      );
    case "course_ready":
      return (
        <span className="badge bg-success/10 text-success text-xs font-medium">
          Курс готов
        </span>
      );
    case "awaiting_course_link":
      return (
        <span className="badge bg-warning/10 text-warning text-xs font-medium">
          Ожидает ссылку
        </span>
      );
    default:
      return (
        <span className="badge bg-surface-2 text-muted text-xs">
          {status}
        </span>
      );
  }
}

export default async function StatisticsPage({
  searchParams,
}: {
  searchParams: { period?: string; from?: string; to?: string };
}) {
  if (!botConfigured()) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="📊 Статистика продаж"
          subtitle="Продажи, выручка, себестоимость и прибыль магазина"
        />
        <EmptyState>База данных бота недоступна.</EmptyState>
      </div>
    );
  }

  // Default period: all-time ("all") as requested by the user
  const period = searchParams.period ?? "all";
  const now = new Date();
  const { from, to } = computePeriodDateRange(
    period,
    now,
    searchParams.from,
    searchParams.to
  );

  // Fetch real PostgreSQL orders with ad relation
  const rawOrders = (await botDb.botOrder.findMany({
    where: {
      status: { in: SALE_STATUSES as unknown as string[] },
      priceUsdt: { gt: 0 },
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      titleRu: true,
      priceUsdt: true,
      priceUzs: true,
      costPriceUzs: true,
      status: true,
      createdAt: true,
      attributedAdId: true,
      attributedAdCode: true,
      firstAdCode: true,
      attributedAd: {
        select: {
          id: true,
          name: true,
          code: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  })) as RawSalesOrder[];

  // Calculate metrics and aggregations
  const metrics = calculateSalesMetrics(rawOrders);
  const dailyData = groupSalesByDay(rawOrders);
  const productsData = groupSalesByProduct(rawOrders);

  // Orders for the recent orders table (latest 50 in selected period)
  const recentOrders = rawOrders.slice(0, 50);

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="📊 Статистика продаж"
        subtitle="Продажи, выручка, себестоимость и прибыль магазина"
        action={
          <div className="flex items-center gap-2">
            <Link href="/admin/bot-products" className="btn-secondary text-xs sm:text-sm">
              Товары и себестоимость
            </Link>
            <Link href="/admin/bot-ads" className="btn-primary text-xs sm:text-sm">
              Рекламные ссылки →
            </Link>
          </div>
        }
      />

      {/* Period Filter Card */}
      <div className="card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="text-xs text-muted font-medium mr-2 block sm:inline mb-1 sm:mb-0">
              Период отчёта:
            </span>
            <div className="inline-flex flex-wrap items-center gap-1.5">
              {[
                { id: "all", label: "За всё время" },
                { id: "today", label: "Сегодня" },
                { id: "7d", label: "Последние 7 дней" },
                { id: "30d", label: "Последние 30 дней" },
                { id: "custom", label: "Произвольный период" },
              ].map((p) => {
                const active = period === p.id;
                return (
                  <Link
                    key={p.id}
                    href={
                      p.id === "all"
                        ? "/admin/statistics"
                        : `/admin/statistics?period=${p.id}`
                    }
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      active
                        ? "bg-brand text-brand-foreground shadow-sm"
                        : "bg-surface-2/60 text-muted hover:text-foreground hover:bg-surface-2"
                    }`}
                  >
                    {p.label}
                  </Link>
                );
              })}
            </div>
          </div>

          {period !== "all" && (
            <Link
              href="/admin/statistics"
              className="text-xs text-muted hover:text-foreground underline whitespace-nowrap"
            >
              Сбросить на «За всё время»
            </Link>
          )}
        </div>

        {period === "custom" && (
          <form
            method="GET"
            className="pt-3 border-t border-border flex flex-wrap items-end gap-3"
          >
            <input type="hidden" name="period" value="custom" />
            <div>
              <label className="text-xs text-muted font-medium block mb-1">
                С даты
              </label>
              <input
                type="date"
                name="from"
                defaultValue={searchParams.from ?? ""}
                className="input text-xs py-1.5 px-2.5"
                required
              />
            </div>
            <div>
              <label className="text-xs text-muted font-medium block mb-1">
                По дату
              </label>
              <input
                type="date"
                name="to"
                defaultValue={searchParams.to ?? ""}
                className="input text-xs py-1.5 px-2.5"
                required
              />
            </div>
            <button type="submit" className="btn-primary text-xs py-1.5 px-3">
              Показать
            </button>
          </form>
        )}
      </div>

      {/* Warning banner for missing cost prices */}
      {metrics.incompleteCostOrders > 0 && (
        <div className="card p-4 border-warning/40 bg-warning/10 flex items-start gap-3 text-sm text-warning">
          <span className="text-xl">⚠️</span>
          <div>
            <div className="font-semibold text-warning">
              Себестоимость заполнена не для всех заказов
            </div>
            <div className="text-xs mt-0.5 opacity-90 leading-relaxed">
              У <strong>{metrics.incompleteCostOrders}</strong> из{" "}
              {metrics.totalOrders} заказов не была зафиксирована себестоимость в
              момент продажи. Чтобы показатели валовой и чистой прибыли были на
              100% точными, укажите себестоимость в разделе{" "}
              <Link
                href="/admin/bot-products"
                className="underline font-semibold hover:text-warning"
              >
                «Товары бота»
              </Link>
              . Текущие расчёты учитывают только фактически сохранённые данные.
            </div>
          </div>
        </div>
      )}

      {/* 8 KPI Main Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {/* 1. Количество продаж */}
        <StatCard
          label="Количество продаж"
          value={String(metrics.totalOrders)}
          hint="Подтверждённые оплаченные заказы"
        />

        {/* 2. Количество проданных товаров */}
        <StatCard
          label="Продано товаров"
          value={String(metrics.totalItems)}
          hint={
            metrics.totalItems > metrics.totalOrders
              ? `С учётом количества в чеке (${metrics.totalItems} шт.)`
              : "Единиц товара"
          }
        />

        {/* 3. Общая выручка */}
        <StatCard
          label="Общая выручка"
          value={formatUzs(metrics.totalRevenue)}
          tone="success"
          hint="Сумма реальных оплат"
        />

        {/* 4. Общая себестоимость */}
        <StatCard
          label="Общая себестоимость"
          value={
            metrics.hasIncompleteData ? "Неполная" : formatUzs(metrics.totalCost)
          }
          hint={
            metrics.hasIncompleteData
              ? `${metrics.incompleteCostOrders} зак. без себестоимости`
              : "Все продажи учтены"
          }
          tone={metrics.hasIncompleteData ? "warning" : "default"}
        />

        {/* 5. Валовая прибыль */}
        <StatCard
          label="Валовая прибыль"
          value={
            metrics.hasIncompleteData
              ? "Неполные данные"
              : formatUzs(metrics.grossProfit)
          }
          hint="Выручка − себестоимость"
          tone={
            metrics.hasIncompleteData
              ? "warning"
              : metrics.grossProfit >= 0
              ? "success"
              : "danger"
          }
        />

        {/* 6. Чистая прибыль */}
        <StatCard
          label="Чистая прибыль"
          value={
            metrics.hasIncompleteData
              ? "Неполные данные"
              : formatUzs(metrics.netProfit)
          }
          hint="До вычета рекламы (этап 1)"
          tone={
            metrics.hasIncompleteData
              ? "warning"
              : metrics.netProfit >= 0
              ? "success"
              : "danger"
          }
        />

        {/* 7. Общая сумма убытков */}
        <StatCard
          label="Общая сумма убытков"
          value={formatUzs(metrics.totalLoss)}
          hint="Продажи ниже себестоимости"
          tone={metrics.totalLoss > 0 ? "danger" : "default"}
        />

        {/* 8. Средний чек */}
        <StatCard
          label="Средний чек"
          value={formatUzs(metrics.averageOrderValue)}
          hint="Выручка / количество продаж"
        />
      </div>

      {/* Explanatory Hints Accordion / Cards */}
      <div className="card p-4 sm:p-5 bg-surface-2/20">
        <details className="group cursor-pointer">
          <summary className="flex items-center justify-between text-sm font-semibold text-foreground list-none">
            <span className="flex items-center gap-2">
              💡 Пояснения к финансовым показателям
            </span>
            <span className="text-xs text-muted group-open:rotate-180 transition-transform">
              ▼
            </span>
          </summary>
          <div className="mt-4 pt-3 border-t border-border grid sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs leading-relaxed text-muted">
            <div className="p-2.5 rounded bg-surface-1 border border-border">
              <strong className="text-foreground block mb-1">
                Что такое выручка?
              </strong>
              Фактическая сумма платежей в сумах, полученная от клиентов за
              успешные заказы за выбранный период.
            </div>
            <div className="p-2.5 rounded bg-surface-1 border border-border">
              <strong className="text-foreground block mb-1">
                Что такое себестоимость?
              </strong>
              Сумма исторических затрат на приобретение аккаунтов, ключей или
              подписок у поставщиков на момент продажи.
            </div>
            <div className="p-2.5 rounded bg-surface-1 border border-border">
              <strong className="text-foreground block mb-1">
                Как считается прибыль?
              </strong>
              Выручка минус сохранённая себестоимость товаров. На первом этапе
              чистая прибыль равна валовой (до вычета будущих расходов на рекламу).
            </div>
            <div className="p-2.5 rounded bg-surface-1 border border-border">
              <strong className="text-foreground block mb-1">
                Почему данные могут быть неполными?
              </strong>
              Если у старых тарифов в каталоге не была задана себестоимость,
              система честно предупреждает об этом и не подменяет цифры.
            </div>
            <div className="p-2.5 rounded bg-surface-1 border border-border">
              <strong className="text-foreground block mb-1">
                Выручка vs Прибыль
              </strong>
              Выручка показывает весь оборот денег в кассе, а прибыль — то, что
              остаётся магазину «чистыми» после покрытия затрат на товар.
            </div>
            <div className="p-2.5 rounded bg-surface-1 border border-border">
              <strong className="text-foreground block mb-1">
                Убыточные продажи
              </strong>
              Сумма разницы, если товар по ошибке или специальной скидке был
              продан дешевле его закупочной себестоимости.
            </div>
          </div>
        </details>
      </div>

      {/* Section 1: Sales by day (Visual Chart + Table) */}
      <DailySalesChart days={dailyData} />

      {/* Section 2: Products rating table */}
      <ProductRatingTable products={productsData} />

      {/* Section 3: Recent orders table */}
      <div className="card overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-base sm:text-lg">
              ⏱️ Последние продажи
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Недавние заказы за выбранный период (до 50 последних)
            </p>
          </div>
          <span className="badge bg-surface-2 text-muted text-xs">
            {recentOrders.length} заказов
          </span>
        </div>

        {recentOrders.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">
            За выбранный период продаж нет.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
                  <th className="px-4 py-3">№</th>
                  <th className="px-4 py-3">Дата и время</th>
                  <th className="px-4 py-3">Товар</th>
                  <th className="px-3 py-3 text-right">Цена продажи</th>
                  <th className="px-3 py-3 text-right">Себестоимость</th>
                  <th className="px-3 py-3 text-right">Прибыль</th>
                  <th className="px-3 py-3 text-center">Статус</th>
                  <th className="px-4 py-3">Реклама</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recentOrders.map((order) => {
                  const sale = orderRevenue(order);
                  const hasCost =
                    order.costPriceUzs !== null &&
                    order.costPriceUzs !== undefined;
                  const cost = hasCost ? order.costPriceUzs! : null;
                  const profit = hasCost ? sale - cost! : null;
                  const adCode =
                    order.attributedAd?.code ||
                    order.attributedAdCode ||
                    order.firstAdCode;

                  return (
                    <tr
                      key={order.id}
                      className="hover:bg-surface-2/30 transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-muted">
                        #{order.id}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted whitespace-nowrap font-mono">
                        {formatTashkentDateTime(new Date(order.createdAt))}
                      </td>
                      <td className="px-4 py-3 font-medium">
                        {order.titleRu}
                      </td>
                      <td className="px-3 py-3 text-right font-medium font-mono text-brand whitespace-nowrap">
                        {formatUzs(sale)}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs whitespace-nowrap">
                        {hasCost ? (
                          formatUzs(cost)
                        ) : (
                          <span className="text-warning">Не указана</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right font-semibold font-mono text-xs whitespace-nowrap">
                        {hasCost ? (
                          <span
                            className={
                              profit! >= 0 ? "text-success" : "text-danger"
                            }
                          >
                            {formatUzs(profit)}
                          </span>
                        ) : (
                          <span className="text-warning">Неполные данные</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-center whitespace-nowrap">
                        {renderOrderStatusBadge(order.status)}
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">
                        {order.attributedAd ? (
                          <Link
                            href={`/admin/bot-ads/${order.attributedAd.id}`}
                            className="badge bg-brand/10 text-brand hover:underline font-mono inline-flex items-center gap-1"
                          >
                            🎯 {order.attributedAd.name || order.attributedAd.code}
                          </Link>
                        ) : adCode ? (
                          <span className="badge bg-surface-2 text-muted font-mono">
                            🎯 {adCode}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
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

      {/* Meta Ads note */}
      <div className="p-4 rounded-xl border border-dashed border-border bg-surface-2/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-muted">
        <div>
          <strong className="text-foreground">
            Следующий этап: Интеграция Meta Ads
          </strong>
          <p className="mt-0.5">
            Расходы на рекламу по кампаниям, объявлениям и автоматический расчёт
            чистой прибыли после маркетинга (ROAS/ROI) будут подключены на
            следующем шаге.
          </p>
        </div>
        <Link
          href="/admin/bot-ads"
          className="btn-ghost text-xs text-brand hover:underline whitespace-nowrap"
        >
          Управление рекламными ссылками →
        </Link>
      </div>
    </div>
  );
}
