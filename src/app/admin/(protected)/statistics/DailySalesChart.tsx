"use client";

import { useState, useMemo } from "react";
import { DailySalesRow, formatUzs } from "@/lib/domain/sales-statistics";

interface DailySalesChartProps {
  days: DailySalesRow[];
}

function formatCompactUzs(val: number): string {
  if (val >= 1_000_000) {
    return `${(val / 1_000_000).toFixed(1)}M`;
  }
  if (val >= 1_000) {
    return `${Math.round(val / 1_000)}k`;
  }
  return String(val);
}

export function DailySalesChart({ days }: DailySalesChartProps) {
  // Default selected day: highest revenue day or latest
  const initialSelected = useMemo(() => {
    if (days.length === 0) return null;
    return [...days].sort((a, b) => b.revenue - a.revenue)[0];
  }, [days]);

  const [selectedDay, setSelectedDay] = useState<DailySalesRow | null>(initialSelected);

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
  const activeDay = selectedDay || days[0];

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
            Нажмите на любой столбец для просмотра подробной информации за день
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
        </div>
      </div>

      {/* Selected Day Inspector Box — Placed ABOVE the scroll area so it NEVER gets clipped */}
      {activeDay && (
        <div className="p-4 rounded-xl bg-surface-2/60 border border-border space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-border/60">
            <div className="font-semibold text-sm sm:text-base text-foreground flex items-center gap-2">
              <span>📅</span>
              <span>{activeDay.dateFormatted}</span>
              <span className="text-xs text-muted font-normal">
                ({activeDay.ordersCount} зак. • {activeDay.itemsCount} шт.)
              </span>
            </div>
            <span className="text-xs text-muted">
              (выберите день на графике или в таблице)
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
            <div className="bg-surface-1 p-2.5 rounded-lg border border-border">
              <span className="text-[11px] text-muted block">Продано на сумму</span>
              <strong className="text-sm sm:text-base font-mono text-brand block mt-0.5">
                {formatUzs(activeDay.revenue)}
              </strong>
            </div>

            <div className="bg-surface-1 p-2.5 rounded-lg border border-border">
              <span className="text-[11px] text-muted block">Затраты на закупку</span>
              <strong className="text-sm sm:text-base font-mono text-muted block mt-0.5">
                {formatUzs(activeDay.cost)}
              </strong>
            </div>

            <div className="bg-surface-1 p-2.5 rounded-lg border border-border">
              <span className="text-[11px] text-muted block">Заработано (доход)</span>
              <strong
                className={`text-sm sm:text-base font-mono block mt-0.5 ${
                  activeDay.profit >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {activeDay.profit >= 0 ? `+${formatUzs(activeDay.profit)}` : formatUzs(activeDay.profit)}
              </strong>
            </div>

            <div className="bg-surface-1 p-2.5 rounded-lg border border-border">
              <span className="text-[11px] text-muted block">Способы оплаты</span>
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                {activeDay.payments && activeDay.payments.length > 0 ? (
                  activeDay.payments.map((p) => (
                    <span
                      key={p.id}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono bg-surface-2 text-foreground"
                    >
                      <span>{p.emoji}</span>
                      <span>{p.name}: {p.count}</span>
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-muted">—</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Visual Bar Chart with ample headroom so labels are never cut off */}
      <div className="bg-surface-2/30 rounded-xl p-3 sm:p-4 border border-border">
        <div className="overflow-x-auto pb-2">
          <div
            className="flex items-end gap-3 sm:gap-4 min-w-max h-52 pt-10 px-2"
            style={{ minWidth: `${Math.max(100, chartDays.length * 56)}px` }}
          >
            {chartDays.map((d) => {
              const revHeight = Math.max(12, (d.revenue / maxRevenue) * 130);
              const profitHeight =
                d.profit > 0 ? Math.max(6, (d.profit / maxRevenue) * 130) : 6;
              const isSelected = activeDay?.dateKey === d.dateKey;

              return (
                <div
                  key={d.dateKey}
                  onClick={() => setSelectedDay(d)}
                  className={`flex flex-col items-center group cursor-pointer p-1 rounded-lg transition-all ${
                    isSelected ? "bg-brand/10 ring-2 ring-brand" : "hover:bg-surface-2"
                  }`}
                  title={`${d.dateFormatted}: Продажи ${formatUzs(d.revenue)}, Заработано ${formatUzs(d.profit)}`}
                >
                  {/* Revenue compact label directly on top of the bar */}
                  <span className="text-[10px] font-mono text-muted group-hover:text-brand font-semibold mb-1">
                    {formatCompactUzs(d.revenue)}
                  </span>

                  {/* Dual Bar */}
                  <div className="flex items-end gap-1 h-36">
                    {/* Revenue Bar */}
                    <div
                      className="w-3.5 sm:w-4 rounded-t bg-brand/80 group-hover:bg-brand transition-all"
                      style={{ height: `${revHeight}px` }}
                    />
                    {/* Profit Bar */}
                    <div
                      className={`w-3.5 sm:w-4 rounded-t transition-all ${
                        d.profit >= 0
                          ? "bg-emerald-500/80 group-hover:bg-emerald-500"
                          : "bg-rose-500/80 group-hover:bg-rose-500"
                      }`}
                      style={{ height: `${profitHeight}px` }}
                    />
                  </div>

                  {/* Day Label */}
                  <div className={`text-[10px] sm:text-xs mt-2 font-mono ${
                    isSelected ? "text-brand font-bold" : "text-muted group-hover:text-foreground"
                  }`}>
                    {d.dateFormatted.slice(0, 5)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Daily Table (Newest to Oldest) */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
              <th className="px-4 py-2.5">Дата</th>
              <th className="px-3 py-2.5 text-right">Заказов</th>
              <th className="px-4 py-2.5 text-right">Сумма продаж</th>
              <th className="px-4 py-2.5 text-right">Закупка</th>
              <th className="px-4 py-2.5 text-right">Заработано</th>
              <th className="px-4 py-2.5">Оплаты за день</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {days.map((row) => {
              const isProfitPositive = row.profit >= 0;
              const isSelected = activeDay?.dateKey === row.dateKey;

              return (
                <tr
                  key={row.dateKey}
                  onClick={() => setSelectedDay(row)}
                  className={`cursor-pointer transition-colors ${
                    isSelected ? "bg-brand/10 font-medium" : "hover:bg-surface-2/30"
                  }`}
                >
                  <td className="px-4 py-3 font-mono text-xs sm:text-sm whitespace-nowrap">
                    {row.dateFormatted}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-xs sm:text-sm">
                    <strong>{row.ordersCount}</strong> ({row.itemsCount} шт.)
                  </td>
                  <td className="px-4 py-3 text-right font-semibold font-mono text-xs sm:text-sm text-brand whitespace-nowrap">
                    {formatUzs(row.revenue)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs sm:text-sm text-muted whitespace-nowrap">
                    {formatUzs(row.cost)}
                  </td>
                  <td className="px-4 py-3 text-right font-bold font-mono text-xs sm:text-sm whitespace-nowrap">
                    <span className={isProfitPositive ? "text-emerald-400" : "text-rose-400"}>
                      {isProfitPositive ? `+${formatUzs(row.profit)}` : formatUzs(row.profit)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {row.payments && row.payments.length > 0 ? (
                        row.payments.map((p) => (
                          <span
                            key={p.id}
                            className="badge bg-surface-2 text-foreground font-mono text-[11px] px-2 py-0.5"
                            title={`${p.name}: ${formatUzs(p.sum)}`}
                          >
                            {p.emoji} {p.name}: {p.count}
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
