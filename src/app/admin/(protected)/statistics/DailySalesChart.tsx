"use client";

import { useState } from "react";
import { DailySalesRow, formatUzs } from "@/lib/domain/sales-statistics";

interface DailySalesChartProps {
  days: DailySalesRow[];
}

export function DailySalesChart({ days }: DailySalesChartProps) {
  const [hoveredDay, setHoveredDay] = useState<DailySalesRow | null>(null);

  if (days.length === 0) {
    return (
      <div className="card p-8 text-center text-muted text-sm">
        За выбранный период продаж нет.
      </div>
    );
  }

  // Days for chart display: chronological order (oldest to newest left-to-right)
  const chartDays = [...days].reverse();
  const maxRevenue = Math.max(...days.map((d) => d.revenue), 1);
  const maxProfit = Math.max(...days.map((d) => Math.max(0, d.profit)), 1);

  return (
    <div className="card p-4 sm:p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-base sm:text-lg flex items-center gap-2">
            📅 Продажи по дням
            <span className="badge bg-brand/10 text-brand text-xs font-normal">
              Дней с продажами: {days.length}
            </span>
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Динамика выручки и прибыли (от старых к новым слева направо)
          </p>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-brand inline-block" />
            <span>Выручка</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-success inline-block" />
            <span>Прибыль</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-danger inline-block" />
            <span>Убыток</span>
          </div>
        </div>
      </div>

      {/* Visual Bar Chart */}
      <div className="bg-surface-2/30 rounded-xl p-3 sm:p-4 border border-border">
        <div className="overflow-x-auto pb-2">
          <div
            className="flex items-end gap-2 sm:gap-3 min-w-max h-48 pt-6 px-2"
            style={{ minWidth: `${Math.max(100, chartDays.length * 48)}px` }}
          >
            {chartDays.map((d) => {
              const revHeight = Math.max(8, (d.revenue / maxRevenue) * 140);
              const profitHeight =
                d.profit > 0 ? Math.max(4, (d.profit / maxRevenue) * 140) : 4;
              const isNegativeProfit = d.profit < 0;

              return (
                <div
                  key={d.dateKey}
                  className="flex flex-col items-center group cursor-pointer relative"
                  onMouseEnter={() => setHoveredDay(d)}
                  onMouseLeave={() => setHoveredDay(null)}
                >
                  {/* Tooltip on hover */}
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-full mb-2 z-20 pointer-events-none bg-surface-1 border border-border shadow-xl rounded-lg p-2.5 text-xs whitespace-nowrap min-w-[160px]">
                    <div className="font-semibold text-foreground border-b border-border pb-1 mb-1.5">
                      {d.dateFormatted}
                    </div>
                    <div className="space-y-1 font-mono text-[11px]">
                      <div className="flex justify-between gap-3 text-muted">
                        <span>Заказов:</span>
                        <span className="text-foreground font-semibold">
                          {d.ordersCount} ({d.itemsCount} шт.)
                        </span>
                      </div>
                      <div className="flex justify-between gap-3 text-muted">
                        <span>Выручка:</span>
                        <span className="text-brand font-semibold">{formatUzs(d.revenue)}</span>
                      </div>
                      <div className="flex justify-between gap-3 text-muted">
                        <span>Себестоимость:</span>
                        <span className="text-foreground">
                          {d.unknownCostOrders > 0 ? "Неполная" : formatUzs(d.cost)}
                        </span>
                      </div>
                      <div className="flex justify-between gap-3 text-muted">
                        <span>Прибыль:</span>
                        <span
                          className={`font-semibold ${
                            d.unknownCostOrders > 0
                              ? "text-warning"
                              : d.profit >= 0
                              ? "text-success"
                              : "text-danger"
                          }`}
                        >
                          {d.unknownCostOrders > 0 ? "Неполные данные" : formatUzs(d.profit)}
                        </span>
                      </div>
                      {d.loss > 0 && (
                        <div className="flex justify-between gap-3 text-danger font-semibold">
                          <span>Убыток:</span>
                          <span>{formatUzs(d.loss)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Dual Bar Representation */}
                  <div className="flex items-end gap-1 h-36">
                    {/* Revenue Bar */}
                    <div
                      className="w-3 sm:w-4 rounded-t bg-brand/80 group-hover:bg-brand transition-all"
                      style={{ height: `${revHeight}px` }}
                      title={`Выручка: ${formatUzs(d.revenue)}`}
                    />
                    {/* Profit Bar */}
                    <div
                      className={`w-3 sm:w-4 rounded-t transition-all ${
                        isNegativeProfit
                          ? "bg-danger/80 group-hover:bg-danger"
                          : d.unknownCostOrders > 0
                          ? "bg-warning/80 group-hover:bg-warning"
                          : "bg-success/80 group-hover:bg-success"
                      }`}
                      style={{ height: `${profitHeight}px` }}
                      title={`Прибыль: ${formatUzs(d.profit)}`}
                    />
                  </div>

                  {/* Day Label */}
                  <div className="text-[10px] sm:text-xs text-muted mt-2 font-mono group-hover:text-foreground">
                    {d.dateFormatted.slice(0, 5)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Selected/Hovered Day Quick Card */}
      {hoveredDay && (
        <div className="p-3 rounded-lg bg-surface-2/40 border border-border flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="font-semibold text-foreground">
            Выбран день: <span className="font-mono">{hoveredDay.dateFormatted}</span>
          </div>
          <div className="flex flex-wrap items-center gap-4 font-mono">
            <span>Заказов: <strong>{hoveredDay.ordersCount}</strong></span>
            <span>Товаров: <strong>{hoveredDay.itemsCount}</strong></span>
            <span className="text-brand">Выручка: <strong>{formatUzs(hoveredDay.revenue)}</strong></span>
            <span>Себестоимость: <strong>{hoveredDay.unknownCostOrders > 0 ? "Неполная" : formatUzs(hoveredDay.cost)}</strong></span>
            <span className={hoveredDay.unknownCostOrders > 0 ? "text-warning" : hoveredDay.profit >= 0 ? "text-success" : "text-danger"}>
              Прибыль: <strong>{hoveredDay.unknownCostOrders > 0 ? "Неполная" : formatUzs(hoveredDay.profit)}</strong>
            </span>
          </div>
        </div>
      )}

      {/* Daily Breakdown Table (Newest to Oldest) */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
              <th className="px-4 py-2.5">Дата</th>
              <th className="px-3 py-2.5 text-right">Заказов</th>
              <th className="px-3 py-2.5 text-right">Единиц</th>
              <th className="px-3 py-2.5 text-right">Выручка</th>
              <th className="px-3 py-2.5 text-right">Себестоимость</th>
              <th className="px-4 py-2.5 text-right">Прибыль</th>
              <th className="px-3 py-2.5 text-right">Убыток</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {days.map((row) => {
              const hasUnknown = row.unknownCostOrders > 0;
              const isProfitPositive = row.profit >= 0;

              return (
                <tr key={row.dateKey} className="hover:bg-surface-2/30 transition-colors">
                  <td className="px-4 py-2.5 font-medium font-mono text-xs sm:text-sm">
                    {row.dateFormatted}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs sm:text-sm">
                    {row.ordersCount}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs sm:text-sm">
                    {row.itemsCount}
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium font-mono text-xs sm:text-sm text-brand">
                    {formatUzs(row.revenue)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs sm:text-sm">
                    {hasUnknown ? (
                      <span className="text-warning text-xs">
                        {row.cost > 0 ? formatUzs(row.cost) : "Не указана"} ({row.unknownCostOrders} без с/с)
                      </span>
                    ) : (
                      formatUzs(row.cost)
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold font-mono text-xs sm:text-sm">
                    {hasUnknown ? (
                      <span className="text-warning text-xs">Неполные данные</span>
                    ) : (
                      <span className={isProfitPositive ? "text-success" : "text-danger"}>
                        {formatUzs(row.profit)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs sm:text-sm">
                    {row.loss > 0 ? (
                      <span className="text-danger font-semibold">{formatUzs(row.loss)}</span>
                    ) : (
                      <span className="text-muted">0 сум</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
