"use client";

import { useState, useMemo } from "react";
import { ProductSalesRow, formatUzs } from "@/lib/domain/sales-statistics";

interface ProductRatingTableProps {
  products: ProductSalesRow[];
}

type SortField = "sales" | "revenue" | "profit" | "loss";

export function ProductRatingTable({ products }: ProductRatingTableProps) {
  const [sortField, setSortField] = useState<SortField>("sales");
  const [filterMode, setFilterMode] = useState<"all" | "loss" | "missing">("all");
  const [search, setSearch] = useState("");

  const filteredAndSorted = useMemo(() => {
    let list = [...products];

    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter((p) => p.title.toLowerCase().includes(q));
    }

    if (filterMode === "loss") {
      list = list.filter((p) => p.isLossMaking);
    } else if (filterMode === "missing") {
      list = list.filter((p) => p.isMissingCost);
    }

    list.sort((a, b) => {
      if (sortField === "sales") {
        return b.ordersCount - a.ordersCount || b.itemsCount - a.itemsCount || b.revenue - a.revenue;
      }
      if (sortField === "revenue") {
        return b.revenue - a.revenue;
      }
      if (sortField === "profit") {
        return b.profit - a.profit;
      }
      if (sortField === "loss") {
        return b.lossOrdersCount - a.lossOrdersCount || b.cost - a.cost;
      }
      return 0;
    });

    return list;
  }, [products, sortField, filterMode, search]);

  if (products.length === 0) {
    return (
      <div className="card p-8 text-center text-muted text-sm">
        Нет проданных товаров за выбранный период.
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="p-4 sm:p-5 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-base sm:text-lg flex items-center gap-2">
            🏆 Рейтинг товаров
            <span className="badge bg-brand/10 text-brand text-xs font-normal">
              Всего товаров: {products.length}
            </span>
          </h2>
          <p className="text-xs text-muted mt-1">
            Сравнение продаж, количества единиц, себестоимости, прибыли и маржинальности
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Поиск товара..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input text-xs py-1.5 px-2.5 w-36 sm:w-48"
          />

          <div className="inline-flex rounded-lg border border-border p-0.5 bg-surface-2/40 text-xs">
            <button
              type="button"
              onClick={() => setSortField("sales")}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                sortField === "sales"
                  ? "bg-brand text-brand-foreground font-medium"
                  : "text-muted hover:text-foreground"
              }`}
            >
              По продажам
            </button>
            <button
              type="button"
              onClick={() => setSortField("revenue")}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                sortField === "revenue"
                  ? "bg-brand text-brand-foreground font-medium"
                  : "text-muted hover:text-foreground"
              }`}
            >
              По выручке
            </button>
            <button
              type="button"
              onClick={() => setSortField("profit")}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                sortField === "profit"
                  ? "bg-brand text-brand-foreground font-medium"
                  : "text-muted hover:text-foreground"
              }`}
            >
              По прибыли
            </button>
            <button
              type="button"
              onClick={() => setSortField("loss")}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                sortField === "loss"
                  ? "bg-danger text-white font-medium"
                  : "text-muted hover:text-foreground"
              }`}
            >
              По убыткам
            </button>
          </div>
        </div>
      </div>

      <div className="px-4 py-2 bg-surface-2/20 border-b border-border flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={() => setFilterMode("all")}
          className={`px-2 py-0.5 rounded ${
            filterMode === "all" ? "bg-surface-2 font-semibold" : "text-muted hover:text-foreground"
          }`}
        >
          Все ({products.length})
        </button>
        <button
          type="button"
          onClick={() => setFilterMode("loss")}
          className={`px-2 py-0.5 rounded flex items-center gap-1 ${
            filterMode === "loss" ? "bg-danger/20 text-danger font-semibold" : "text-muted hover:text-danger"
          }`}
        >
          🔻 Есть убытки ({products.filter((p) => p.isLossMaking).length})
        </button>
        <button
          type="button"
          onClick={() => setFilterMode("missing")}
          className={`px-2 py-0.5 rounded flex items-center gap-1 ${
            filterMode === "missing" ? "bg-warning/20 text-warning font-semibold" : "text-muted hover:text-warning"
          }`}
        >
          ⚠️ Нет себестоимости ({products.filter((p) => p.isMissingCost).length})
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs font-semibold text-muted bg-surface-2/40 uppercase tracking-wider">
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Товар</th>
              <th className="px-3 py-3 text-right">Продаж</th>
              <th className="px-3 py-3 text-right">Единиц</th>
              <th className="px-3 py-3 text-right">Выручка</th>
              <th className="px-3 py-3 text-right">Средняя цена</th>
              <th className="px-3 py-3 text-right">Себестоимость</th>
              <th className="px-4 py-3 text-right">Прибыль</th>
              <th className="px-3 py-3 text-right">Маржинальность</th>
              <th className="px-3 py-3 text-right">Убыточных</th>
              <th className="px-3 py-3 text-center">Статус</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredAndSorted.map((product, idx) => {
              const hasUnknown = product.unknownCostCount > 0;
              const isProfitPositive = product.profit >= 0;

              return (
                <tr key={product.title} className="hover:bg-surface-2/30 transition-colors">
                  <td className="px-4 py-3 text-xs text-muted font-mono">{idx + 1}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{product.title}</div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {product.isTopSeller && (
                        <span className="badge bg-brand/10 text-brand text-[10px] px-1.5 py-0.5 font-medium">
                          🏆 Хит продаж
                        </span>
                      )}
                      {product.isTopProfit && (
                        <span className="badge bg-success/10 text-success text-[10px] px-1.5 py-0.5 font-medium">
                          💰 Самый прибыльный
                        </span>
                      )}
                      {product.isLossMaking && (
                        <span className="badge bg-danger/10 text-danger text-[10px] px-1.5 py-0.5 font-medium">
                          🔻 Есть убытки ({product.lossOrdersCount})
                        </span>
                      )}
                      {product.isMissingCost && (
                        <span className="badge bg-warning/10 text-warning text-[10px] px-1.5 py-0.5 font-medium">
                          ⚠️ Нет себестоимости ({product.unknownCostCount})
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {product.ordersCount}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-muted">
                    {product.itemsCount} шт.
                  </td>
                  <td className="px-3 py-3 text-right font-medium font-mono text-brand">
                    {formatUzs(product.revenue)}
                  </td>
                  <td className="px-3 py-3 text-right text-muted font-mono">
                    {formatUzs(product.avgPrice)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {hasUnknown ? (
                      <span className="text-warning text-xs">
                        {product.cost > 0 ? formatUzs(product.cost) : "Не указана"} ({product.unknownCostCount} без с/с)
                      </span>
                    ) : (
                      formatUzs(product.cost)
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold font-mono">
                    {hasUnknown ? (
                      <span className="text-warning text-xs">Неполные данные</span>
                    ) : (
                      <span className={isProfitPositive ? "text-success" : "text-danger"}>
                        {formatUzs(product.profit)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-xs">
                    {hasUnknown ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span className={product.profitMarginPct >= 0 ? "text-success" : "text-danger"}>
                        {product.profitMarginPct}%
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-xs">
                    {product.lossOrdersCount > 0 ? (
                      <span className="text-danger font-semibold">{product.lossOrdersCount}</span>
                    ) : (
                      <span className="text-muted">0</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-center">
                    {product.isLossMaking ? (
                      <span className="badge bg-danger/10 text-danger text-xs font-medium">
                        Убыточный
                      </span>
                    ) : hasUnknown ? (
                      <span className="badge bg-warning/10 text-warning text-xs font-medium">
                        Неполные данные
                      </span>
                    ) : (
                      <span className="badge bg-success/10 text-success text-xs font-medium">
                        Прибыльный
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filteredAndSorted.length === 0 && (
        <div className="p-8 text-center text-muted text-sm">
          По заданным критериям товаров не найдено.
        </div>
      )}
    </div>
  );
}
