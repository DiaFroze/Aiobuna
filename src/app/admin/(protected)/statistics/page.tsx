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
  groupSalesByPaymentMethod,
  groupSalesBySource,
  normalizePaymentMethod,
  normalizeSourceApi,
  orderCost,
  orderRevenue,
  formatUzs,
  formatTashkentDateTime,
  computePeriodDateRange,
} from "@/lib/domain/sales-statistics";
import { DailySalesChart } from "./DailySalesChart";
import { ProductRatingTable } from "./ProductRatingTable";

export const dynamic = "force-dynamic";

function renderOrderStatusBadge(status: string) {
  switch (status) {
    case "delivered":
      return (
        <span className="badge bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[11px] font-medium">
          Доставлен
        </span>
      );
    case "completed":
      return (
        <span className="badge bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[11px] font-medium">
          Выполнен
        </span>
      );
    case "awaiting_delivery":
      return (
        <span className="badge bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[11px] font-medium">
          Ожидает выдачи
        </span>
      );
    case "processing":
      return (
        <span className="badge bg-brand/15 text-brand border border-brand/30 text-[11px] font-medium">
          В обработке
        </span>
      );
    case "course_ready":
      return (
        <span className="badge bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[11px] font-medium">
          Курс готов
        </span>
      );
    case "awaiting_course_link":
      return (
        <span className="badge bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[11px] font-medium">
          Ожидает ссылку
        </span>
      );
    default:
      return (
        <span className="badge bg-surface-2 text-muted text-[11px]">
          {status}
        </span>
      );
  }
}

export default async function StatisticsPage({
  searchParams,
}: {
  searchParams: { period?: string; from?: string; to?: string; payment?: string };
}) {
  if (!botConfigured()) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="📊 Статистика продаж"
          subtitle="Реальные продажи, оплаты и закупки магазина"
        />
        <EmptyState>База данных бота недоступна.</EmptyState>
      </div>
    );
  }

  // Default period: all-time ("all") as requested by the user
  const period = searchParams.period ?? "all";
  const selectedPayment = searchParams.payment;
  const now = new Date();
  const { from, to } = computePeriodDateRange(
    period,
    now,
    searchParams.from,
    searchParams.to
  );

  // Fetch real PostgreSQL orders with variant, supplier and ad relations
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
      source: true,
      paymentMethod: true,
      paymentId: true,
      status: true,
      createdAt: true,
      variantId: true,
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

  // Attach variant details (costPriceUzs, supplierKey) if variantId exists
  const variantIds = Array.from(
    new Set(
      rawOrders
        .map((o) => o.variantId)
        .filter((id): id is number => typeof id === "number" && id > 0)
    )
  );

  if (variantIds.length > 0) {
    const variants = await botDb.variant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true,
        titleRu: true,
        costPriceUzs: true,
        supplierPriceUsdt: true,
        supplierKey: true,
      },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));
    for (const o of rawOrders) {
      if (o.variantId && variantMap.has(o.variantId)) {
        o.variant = variantMap.get(o.variantId);
      }
    }
  }

  // Calculate metrics and aggregations
  const metrics = calculateSalesMetrics(rawOrders);
  const paymentSummaries = groupSalesByPaymentMethod(rawOrders);
  const sourceSummaries = groupSalesBySource(rawOrders);
  const dailyData = groupSalesByDay(rawOrders);
  const productsData = groupSalesByProduct(rawOrders);

  // Filter orders by payment method if clicked by user
  const filteredOrders = selectedPayment
    ? rawOrders.filter(
        (o) => normalizePaymentMethod(o.paymentMethod).id === selectedPayment
      )
    : rawOrders;

  // Recent 50 orders in selected filter
  const recentOrders = filteredOrders.slice(0, 50);

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="📊 Статистика продаж"
        subtitle="Продажи по дням, способы оплаты (Click, Payme и др.) и закупки через API"
        action={
          <div className="flex items-center gap-2">
            <Link href="/admin/bot-products" className="btn-secondary text-xs sm:text-sm">
              Товары и закупка
            </Link>
            <Link href="/admin/bot-ads" className="btn-primary text-xs sm:text-sm">
              Реклама и Meta Ads →
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
                { id: "yesterday", label: "Вчера" },
                { id: "7d", label: "7 дней" },
                { id: "30d", label: "30 дней" },
                { id: "month", label: "Этот месяц" },
                { id: "custom", label: "Свои даты" },
              ].map((p) => {
                const active = period === p.id;
                const targetUrl = new URLSearchParams();
                if (p.id !== "all") targetUrl.set("period", p.id);
                if (selectedPayment) targetUrl.set("payment", selectedPayment);
                const queryStr = targetUrl.toString();

                return (
                  <Link
                    key={p.id}
                    href={queryStr ? `/admin/statistics?${queryStr}` : "/admin/statistics"}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      active
                        ? "bg-brand text-brand-foreground shadow-sm"
                        : "bg-surface-2/70 text-muted hover:text-foreground hover:bg-surface-2"
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
              className="text-xs text-brand hover:underline whitespace-nowrap"
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
            {selectedPayment && <input type="hidden" name="payment" value={selectedPayment} />}
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

      {/* 4 Main KPI Cards: Clear, Simple, Zero Jargon */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {/* 1. Количество продаж */}
        <StatCard
          label="Всего продаж"
          value={`${metrics.totalOrders} заказов`}
          hint={`Всего продано ${metrics.totalItems} шт. товаров`}
        />

        {/* 2. Общая сумма продаж */}
        <StatCard
          label="Продано на сумму"
          value={formatUzs(metrics.totalRevenue)}
          tone="success"
          hint="Сумма всех реальных оплат"
        />

        {/* 3. Затраты на закупку */}
        <StatCard
          label="Потрачено на закупку"
          value={formatUzs(metrics.totalCost)}
          tone="default"
          hint="За сколько куплено через API и склад"
        />

        {/* 4. Заработано (чистая разница) */}
        <StatCard
          label="Заработано (доход)"
          value={formatUzs(metrics.profit)}
          tone={metrics.profit >= 0 ? "success" : "danger"}
          hint="Продажи минус закупка"
        />
      </div>

      {/* Section: Способы оплаты (Click, Payme, Stars, Баланс и др.) */}
      <div className="card p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-base sm:text-lg flex items-center gap-2">
              💳 Способы оплаты
              <span className="badge bg-surface-2 text-muted text-xs font-normal">
                {paymentSummaries.length} способа
              </span>
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Через что оплачивали клиенты (нажмите на способ, чтобы отфильтровать заказы)
            </p>
          </div>

          {selectedPayment && (
            <Link
              href={period === "all" ? "/admin/statistics" : `/admin/statistics?period=${period}`}
              className="text-xs text-brand hover:underline"
            >
              Сбросить фильтр оплат ✕
            </Link>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 pt-1">
          {paymentSummaries.map((p) => {
            const isSelected = selectedPayment === p.id;
            const searchParamsObj = new URLSearchParams();
            if (period !== "all") searchParamsObj.set("period", period);
            if (!isSelected) searchParamsObj.set("payment", p.id);
            const href = searchParamsObj.toString()
              ? `/admin/statistics?${searchParamsObj.toString()}`
              : "/admin/statistics";

            return (
              <Link
                key={p.id}
                href={href}
                className={`p-3 rounded-xl border transition-all cursor-pointer ${
                  isSelected
                    ? "bg-brand/10 border-brand shadow-sm ring-1 ring-brand"
                    : "bg-surface-2/40 hover:bg-surface-2 border-border"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-lg">{p.emoji}</span>
                  <span className="text-[11px] font-mono text-muted">
                    {p.sharePct}%
                  </span>
                </div>
                <div className="font-semibold text-sm mt-1.5 text-foreground">
                  {p.name}
                </div>
                <div className="text-xs font-mono font-medium text-brand mt-0.5">
                  {formatUzs(p.totalRevenue)}
                </div>
                <div className="text-[11px] text-muted mt-0.5">
                  {p.ordersCount} зак.
                </div>
              </Link>
            );
          })}

          {paymentSummaries.length === 0 && (
            <div className="col-span-full text-center py-4 text-muted text-xs">
              Нет оплат за выбранный период.
            </div>
          )}
        </div>
      </div>

      {/* Section: Закупки и продажи через API / Поставщиков */}
      <div className="card overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-base sm:text-lg flex items-center gap-2">
              🔌 Закупки через API и поставщиков
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Через какие каналы проданы товары, за сколько куплено и сколько заработано
            </p>
          </div>
          <span className="badge bg-surface-2 text-muted text-xs">
            {sourceSummaries.length} каналов
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
                <th className="px-4 py-3">API / Источник</th>
                <th className="px-3 py-3 text-right">Заказов</th>
                <th className="px-4 py-3 text-right">Сумма продаж</th>
                <th className="px-4 py-3 text-right">Потрачено на закупку</th>
                <th className="px-4 py-3 text-right">Заработано</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sourceSummaries.map((src) => {
                const isProfitPositive = src.profit >= 0;

                return (
                  <tr key={src.id} className="hover:bg-surface-2/30 transition-colors">
                    <td className="px-4 py-3 font-medium">
                      <span className="badge bg-surface-2 text-foreground font-mono text-xs px-2 py-0.5">
                        {src.badge}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs sm:text-sm">
                      {src.ordersCount}
                    </td>
                    <td className="px-4 py-3 text-right font-medium font-mono text-brand text-xs sm:text-sm whitespace-nowrap">
                      {formatUzs(src.totalRevenue)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-muted text-xs sm:text-sm whitespace-nowrap">
                      {formatUzs(src.totalCost)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold font-mono text-xs sm:text-sm whitespace-nowrap">
                      <span className={isProfitPositive ? "text-emerald-400" : "text-rose-400"}>
                        {formatUzs(src.profit)}
                      </span>
                    </td>
                  </tr>
                );
              })}

              {sourceSummaries.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted text-xs">
                    Нет данных по API закупкам за выбранный период.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 1: Sales by day (Visual Chart + Table) */}
      <DailySalesChart days={dailyData} />

      {/* Section 2: Products rating table */}
      <ProductRatingTable products={productsData} />

      {/* Section 3: Recent orders table */}
      <div className="card overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-base sm:text-lg flex items-center gap-2">
              ⏱️ Последние продажи
              {selectedPayment && (
                <span className="badge bg-brand/10 text-brand text-xs font-normal">
                  Фильтр: {normalizePaymentMethod(selectedPayment).name}
                </span>
              )}
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Показывает товар, способ оплаты, закупку через API и чистый доход
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="badge bg-surface-2 text-muted text-xs">
              {recentOrders.length} из {filteredOrders.length} зак.
            </span>
          </div>
        </div>

        {recentOrders.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">
            Заказов по заданным фильтрам не найдено.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
                  <th className="px-4 py-3">№</th>
                  <th className="px-4 py-3">Дата</th>
                  <th className="px-4 py-3">Товар</th>
                  <th className="px-4 py-3">Оплата</th>
                  <th className="px-3 py-3 text-right">Продажа</th>
                  <th className="px-3 py-3 text-right">Закупка</th>
                  <th className="px-4 py-3">Канал / API</th>
                  <th className="px-3 py-3 text-right">Заработано</th>
                  <th className="px-3 py-3 text-center">Статус</th>
                  <th className="px-4 py-3">Реклама</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recentOrders.map((order) => {
                  const sale = orderRevenue(order);
                  const cost = orderCost(order);
                  const profit = sale - cost;
                  const pay = normalizePaymentMethod(order.paymentMethod);
                  const src = normalizeSourceApi(order.source, order.variant?.supplierKey);
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
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium border ${pay.bgColor}`}>
                          <span>{pay.emoji}</span>
                          <span>{pay.name}</span>
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-medium font-mono text-brand whitespace-nowrap">
                        {formatUzs(sale)}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-muted whitespace-nowrap">
                        {cost > 0 ? formatUzs(cost) : "0 сум"}
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">
                        <span className="badge bg-surface-2 text-foreground font-mono text-[11px]">
                          {src.badge}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-semibold font-mono text-xs whitespace-nowrap">
                        <span className={profit >= 0 ? "text-emerald-400" : "text-rose-400"}>
                          {profit >= 0 ? `+${formatUzs(profit)}` : formatUzs(profit)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center whitespace-nowrap">
                        {renderOrderStatusBadge(order.status)}
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">
                        {order.attributedAd ? (
                          <Link
                            href={`/admin/bot-ads/${order.attributedAd.id}`}
                            className="badge bg-brand/10 text-brand hover:underline font-mono inline-flex items-center gap-1 text-[11px]"
                          >
                            🎯 {order.attributedAd.name || order.attributedAd.code}
                          </Link>
                        ) : adCode ? (
                          <span className="badge bg-surface-2 text-muted font-mono text-[11px]">
                            🎯 {adCode}
                          </span>
                        ) : (
                          <span className="text-muted text-xs">—</span>
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
