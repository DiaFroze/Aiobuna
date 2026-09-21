"use client";

import { useState, useMemo } from "react";
import { ProductSalesRow, formatUzs } from "@/lib/domain/sales-statistics";

interface ProductRatingTableProps {
  products: ProductSalesRow[];
}

type SortField = "sales" | "revenue" | "profit" | "cost";

export function ProductRatingTable({ products }: ProductRatingTableProps) {
  const [sortField, setSortField] = useState<SortField>("sales");
  const [search, setSearch] = useState("");

  const filteredAndSorted = useMemo(() => {
    let list = [...products];

    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.topPaymentMethod.toLowerCase().includes(q) ||
          p.topSource.toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => {
      if (sortField === "sales") {
        return b.ordersCount - a.ordersCount || b.revenue - a.revenue;
      }
      if (sortField === "revenue") {
        return b.revenue - a.revenue;
      }
      if (sortField === "profit") {
        return b.profit - a.profit;
      }
      if (sortField === "cost") {
        return b.cost - a.cost;
      }
      return 0;
    });

    return list;
  }, [products, sortField, search]);

  if (products.length === 0) {
    return (
      <div className="card p-8 text-center text-muted text-sm">
        Нет проданных товаров за выбранный период.
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      {/* Header with Search & Sorting */}
      <div className="p-4 sm:p-5 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-base sm:text-lg flex items-center gap-2">
            🏆 Товары: продажи, закупки и доход
            <span className="badge bg-brand/10 text-brand text-xs font-normal">
              Всего товаров: {products.length}
            </span>
          </h2>
          <p className="text-xs text-muted mt-1">
            Сравнение объёма продаж, закупочных расходов и заработка по каждому товару
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Поиск по названию или API..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input text-xs py-1.5 px-2.5 w-48 sm:w-56"
          />

          <div className="inline-flex rounded-lg bg-surface-2 p-0.5 text-xs">
            <button
              onClick={() => setSortField("sales")}
              className={`px-2.5 py-1 rounded-md font-medium transition-all ${
                sortField === "sales"
                  ? "bg-surface-1 text-foreground shadow-sm"
                  : "text-muted hover:text-foreground"
              }`}
            >
              По заказам
            </button>
            <button
              onClick={() => setSortField("revenue")}
              className={`px-2.5 py-1 rounded-md font-medium transition-all ${
                sortField === "revenue"
                  ? "bg-surface-1 text-foreground shadow-sm"
                  : "text-muted hover:text-foreground"
              }`}
            >
              По продажам
            </button>
            <button
              onClick={() => setSortField("profit")}
              className={`px-2.5 py-1 rounded-md font-medium transition-all ${
                sortField === "profit"
                  ? "bg-surface-1 text-foreground shadow-sm"
                  : "text-muted hover:text-foreground"
              }`}
            >
              По доходу
            </button>
          </div>
        </div>
      </div>

      {/* Products Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
              <th className="px-4 py-3">№</th>
              <th className="px-4 py-3">Товар</th>
              <th className="px-3 py-3 text-right">Продано</th>
              <th className="px-4 py-3 text-right">Сумма продаж</th>
              <th className="px-4 py-3 text-right">Закупка</th>
              <th className="px-4 py-3 text-right">Заработано</th>
              <th className="px-4 py-3">Оплата</th>
              <th className="px-4 py-3">API / Поставщик</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredAndSorted.map((product, idx) => {
              const isProfitPositive = product.profit >= 0;

              return (
                <tr
                  key={product.title}
                  className="hover:bg-surface-2/30 transition-colors"
                >
                  <td className="px-4 py-3 font-mono text-xs text-muted">
                    #{idx + 1}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{product.title}</span>
                      {product.isTopSeller && (
                        <span className="badge bg-amber-500/15 text-amber-400 text-[10px] font-semibold border border-amber-500/30">
                          🔥 Лидер
                        </span>
                      )}
                      {product.isTopProfit && (
                        <span className="badge bg-emerald-500/15 text-emerald-400 text-[10px] font-semibold border border-emerald-500/30">
                          💎 Топ доход
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-xs sm:text-sm whitespace-nowrap">
                    <strong>{product.ordersCount}</strong> зак. ({product.itemsCount} шт.)
                  </td>
                  <td className="px-4 py-3 text-right font-medium font-mono text-xs sm:text-sm text-brand whitespace-nowrap">
                    {formatUzs(product.revenue)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs sm:text-sm text-muted whitespace-nowrap">
                    {formatUzs(product.cost)}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold font-mono text-xs sm:text-sm whitespace-nowrap">
                    <span className={isProfitPositive ? "text-emerald-400" : "text-rose-400"}>
                      {formatUzs(product.profit)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap">
                    <span className="badge bg-surface-2 text-foreground font-mono text-[11px]">
                      {product.topPaymentMethod}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap">
                    <span className="badge bg-surface-2 text-muted font-mono text-[11px]">
                      {product.topSource}
                    </span>
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
