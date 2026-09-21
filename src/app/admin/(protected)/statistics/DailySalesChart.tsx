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
        За выбранный период продаж не зафиксировано.
      </div>
    );
  }

  // Chronological order for visual chart (left to right)
  const chartDays = [...days].reverse();
  const maxRevenue = Math.max(...days.map((d) => d.revenue), 1);

  return (
    <div className="card p-4 sm:p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-base sm:text-lg flex items-center gap-2">
            📅 Продажи по дням
            <span className="badge bg-brand/10 text-brand text-xs font-normal">
              Дней с продажами: {days.length}
            </span>
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Динамика продаж, затрат на закупку и заработка по дням
          </p>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-brand inline-block" />
            <span>Продажи</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block" />
            <span>Заработано</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-amber-500/80 inline-block" />
            <span>Закупка</span>
          </div>
        </div>
      </div>

      {/* Visual Bar Chart */}
      <div className="bg-surface-2/30 rounded-xl p-3 sm:p-4 border border-border">
        <div className="overflow-x-auto pb-2">
          <div
            className="flex items-end gap-2 sm:gap-3 min-w-max h-48 pt-6 px-2"
            style={{ minWidth: `${Math.max(100, chartDays.length * 52)}px` }}
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
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-full mb-2 z-20 pointer-events-none bg-surface-1 border border-border shadow-xl rounded-lg p-2.5 text-xs whitespace-nowrap min-w-[180px]">
                    <div className="font-semibold text-foreground border-b border-border pb-1 mb-1.5 flex items-center justify-between">
                      <span>{d.dateFormatted}</span>
                      <span className="text-muted font-normal">{d.ordersCount} зак.</span>
                    </div>
                    <div className="space-y-1 font-mono text-[11px]">
                      <div className="flex justify-between gap-3 text-muted">
                        <span>Продажи:</span>
                        <span className="text-brand font-semibold">{formatUzs(d.revenue)}</span>
                      </div>
                      <div className="flex justify-between gap-3 text-muted">
                        <span>Закупка:</span>
                        <span className="text-foreground">{formatUzs(d.cost)}</span>
                      </div>
                      <div className="flex justify-between gap-3 text-muted">
                        <span>Заработано:</span>
                        <span
                          className={`font-semibold ${
                            d.profit >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {formatUzs(d.profit)}
                        </span>
                      </div>
                      {d.payments && d.payments.length > 0 && (
                        <div className="pt-1 mt-1 border-t border-border/60 text-[10px]">
                          <div className="text-muted mb-0.5">Оплаты:</div>
                          {d.payments.map((p) => (
                            <div key={p.id} className="flex justify-between text-muted">
                              <span>{p.emoji} {p.name}:</span>
                              <span className="text-foreground font-semibold">{p.count} зак.</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Dual Bar */}
                  <div className="flex items-end gap-1 h-36">
                    {/* Revenue Bar */}
                    <div
                      className="w-3 sm:w-4 rounded-t bg-brand/80 group-hover:bg-brand transition-all"
                      style={{ height: `${revHeight}px` }}
                      title={`Продажи: ${formatUzs(d.revenue)}`}
                    />
                    {/* Profit Bar */}
                    <div
                      className={`w-3 sm:w-4 rounded-t transition-all ${
                        isNegativeProfit
                          ? "bg-rose-500/80 group-hover:bg-rose-500"
                          : "bg-emerald-500/80 group-hover:bg-emerald-500"
                      }`}
                      style={{ height: `${profitHeight}px` }}
                      title={`Заработано: ${formatUzs(d.profit)}`}
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

      {/* Selected Day Bar details */}
      {hoveredDay && (
        <div className="p-3 rounded-lg bg-surface-2/40 border border-border flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="font-semibold text-foreground">
            Выбран день: <span className="font-mono">{hoveredDay.dateFormatted}</span>
          </div>
          <div className="flex flex-wrap items-center gap-4 font-mono">
            <span>Заказов: <strong>{hoveredDay.ordersCount}</strong></span>
            <span className="text-brand">Продажи: <strong>{formatUzs(hoveredDay.revenue)}</strong></span>
            <span>Закупка: <strong>{formatUzs(hoveredDay.cost)}</strong></span>
            <span className={hoveredDay.profit >= 0 ? "text-emerald-400" : "text-rose-400"}>
              Заработано: <strong>{formatUzs(hoveredDay.profit)}</strong>
            </span>
          </div>
        </div>
      )}

      {/* Daily Table (Newest to Oldest) */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
              <th className="px-4 py-2.5">Дата</th>
              <th className="px-3 py-2.5 text-right">Заказов</th>
              <th className="px-4 py-2.5 text-right">Продажи</th>
              <th className="px-4 py-2.5 text-right">Закупка</th>
              <th className="px-4 py-2.5 text-right">Заработано</th>
              <th className="px-4 py-2.5">Оплаты за день</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {days.map((row) => {
              const isProfitPositive = row.profit >= 0;

              return (
                <tr key={row.dateKey} className="hover:bg-surface-2/30 transition-colors">
                  <td className="px-4 py-2.5 font-medium font-mono text-xs sm:text-sm whitespace-nowrap">
                    {row.dateFormatted}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs sm:text-sm">
                    {row.ordersCount} ({row.itemsCount} шт.)
                  </td>
                  <td className="px-4 py-2.5 text-right font-medium font-mono text-xs sm:text-sm text-brand whitespace-nowrap">
                    {formatUzs(row.revenue)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs sm:text-sm text-muted whitespace-nowrap">
                    {formatUzs(row.cost)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold font-mono text-xs sm:text-sm whitespace-nowrap">
                    <span className={isProfitPositive ? "text-emerald-400" : "text-rose-400"}>
                      {formatUzs(row.profit)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {row.payments && row.payments.length > 0 ? (
                        row.payments.map((p) => (
                          <span
                            key={p.id}
                            className="badge bg-surface-2 text-foreground font-mono text-[11px] px-1.5 py-0.5"
                            title={`${p.name}: ${formatUzs(p.sum)}`}
                          >
                            {p.emoji} {p.name} ({p.count})
                          </span>
                        ))
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </div>
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
