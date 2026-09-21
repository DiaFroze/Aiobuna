"use client";

import { useState, useMemo } from "react";
import { ProductSalesRow, formatUzs } from "@/lib/domain/sales-statistics";

interface ProductRatingTableProps {
  products: ProductSalesRow[];
}

type SortField = "sales" | "revenue" | "profit" | "cost" | "title";
type SortDirection = "desc" | "asc";

export function ProductRatingTable({ products }: ProductRatingTableProps) {
  const [sortField, setSortField] = useState<SortField>("revenue");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [search, setSearch] = useState("");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

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
      let diff = 0;
      if (sortField === "sales") {
        diff = b.ordersCount - a.ordersCount || b.revenue - a.revenue;
      } else if (sortField === "revenue") {
        diff = b.revenue - a.revenue;
      } else if (sortField === "profit") {
        diff = b.profit - a.profit;
      } else if (sortField === "cost") {
        diff = b.cost - a.cost;
      } else if (sortField === "title") {
        diff = a.title.localeCompare(b.title);
      }
      return sortDirection === "desc" ? diff : -diff;
    });

    return list;
  }, [products, sortField, sortDirection, search]);

  if (products.length === 0) {
    return (
      <div className="card p-8 text-center text-muted text-sm">
        Нет проданных товаров за выбранный период.
      </div>
    );
  }

  const sortLabels: Record<SortField, string> = {
    revenue: "по сумме продаж",
    profit: "по заработку (доходу)",
    sales: "по количеству заказов",
    cost: "по затратам на закупку",
    title: "по названию товара",
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return "↕";
    return sortDirection === "desc" ? "↓" : "↑";
  };

  return (
    <div className="card overflow-hidden">
      {/* Header with Search & Sort Buttons */}
      <div className="p-4 sm:p-5 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-base sm:text-lg flex items-center gap-2">
            🏆 Рейтинг товаров
            <span className="badge bg-brand/10 text-brand text-xs font-normal">
              Всего товаров: {products.length}
            </span>
          </h2>
          <p className="text-xs text-muted mt-1">
            Сортировка: <strong className="text-foreground">{sortLabels[sortField]}</strong>{" "}
            ({sortDirection === "desc" ? "по убыванию ↓" : "по возрастанию ↑"})
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Поиск по названию или API..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input text-xs py-1.5 px-2.5 w-44 sm:w-52"
          />

          {/* Interactive prominent sort buttons */}
          <div className="inline-flex rounded-xl bg-surface-2 p-1 gap-1 text-xs">
            <button
              type="button"
              onClick={() => handleSort("revenue")}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer flex items-center gap-1 ${
                sortField === "revenue"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "text-muted hover:text-foreground hover:bg-surface-1"
              }`}
            >
              <span>💰 По продажам</span>
              {sortField === "revenue" && <span>{sortDirection === "desc" ? "↓" : "↑"}</span>}
            </button>

            <button
              type="button"
              onClick={() => handleSort("profit")}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer flex items-center gap-1 ${
                sortField === "profit"
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "text-muted hover:text-foreground hover:bg-surface-1"
              }`}
            >
              <span>📈 По доходу</span>
              {sortField === "profit" && <span>{sortDirection === "desc" ? "↓" : "↑"}</span>}
            </button>

            <button
              type="button"
              onClick={() => handleSort("sales")}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer flex items-center gap-1 ${
                sortField === "sales"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-muted hover:text-foreground hover:bg-surface-1"
              }`}
            >
              <span>📦 По заказам</span>
              {sortField === "sales" && <span>{sortDirection === "desc" ? "↓" : "↑"}</span>}
            </button>
          </div>
        </div>
      </div>

      {/* Products Table with CLICKABLE headers */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider select-none">
              <th className="px-4 py-3">№</th>
              <th
                onClick={() => handleSort("title")}
                className="px-4 py-3 cursor-pointer hover:text-foreground transition-colors"
                title="Нажмите для сортировки по названию"
              >
                Товар {getSortIcon("title")}
              </th>
              <th
                onClick={() => handleSort("sales")}
                className="px-3 py-3 text-right cursor-pointer hover:text-foreground transition-colors"
                title="Нажмите для сортировки по количеству заказов"
              >
                Продано {getSortIcon("sales")}
              </th>
              <th
                onClick={() => handleSort("revenue")}
                className="px-4 py-3 text-right cursor-pointer hover:text-foreground transition-colors"
                title="Нажмите для сортировки по сумме продаж"
              >
                Сумма продаж {getSortIcon("revenue")}
              </th>
              <th
                onClick={() => handleSort("cost")}
                className="px-4 py-3 text-right cursor-pointer hover:text-foreground transition-colors"
                title="Нажмите для сортировки по закупке"
              >
                Закупка {getSortIcon("cost")}
              </th>
              <th
                onClick={() => handleSort("profit")}
                className="px-4 py-3 text-right cursor-pointer hover:text-foreground transition-colors"
                title="Нажмите для сортировки по доходу"
              >
                Заработано {getSortIcon("profit")}
              </th>
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
                      {isProfitPositive ? `+${formatUzs(product.profit)}` : formatUzs(product.profit)}
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
