/**
 * Sales Statistics domain logic & aggregation helpers for AI OBUNA admin panel.
 * Uses strict financial formulas and guarantees data integrity.
 */

export const SALE_STATUSES = [
  "delivered",
  "completed",
  "awaiting_delivery",
  "processing",
  "course_ready",
  "awaiting_course_link",
] as const;

/**
 * Calculates start and end timestamps for period filters in Asia/Tashkent timezone.
 */
export function computePeriodDateRange(
  period: string,
  now: Date = new Date(),
  customFrom?: string,
  customTo?: string
): { from?: Date; to?: Date } {
  const tashkentDateToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  if (period === "today") {
    return {
      from: new Date(`${tashkentDateToday}T00:00:00+05:00`),
      to: new Date(`${tashkentDateToday}T23:59:59.999+05:00`),
    };
  }
  if (period === "7d") {
    return {
      from: new Date(now.getTime() - 7 * 86_400_000),
    };
  }
  if (period === "30d") {
    return {
      from: new Date(now.getTime() - 30 * 86_400_000),
    };
  }
  if (period === "custom") {
    let from: Date | undefined;
    let to: Date | undefined;
    if (customFrom) {
      const parsed = new Date(`${customFrom}T00:00:00+05:00`);
      if (!Number.isNaN(parsed.getTime())) from = parsed;
    }
    if (customTo) {
      const parsed = new Date(`${customTo}T23:59:59.999+05:00`);
      if (!Number.isNaN(parsed.getTime())) to = parsed;
    }
    return { from, to };
  }
  // Default: "all" (all-time)
  return {};
}

export type RawSalesOrder = {
  id: number;
  titleRu: string;
  priceUsdt: number;
  priceUzs: number | null;
  costPriceUzs: number | null;
  status: string;
  createdAt: Date;
  firstAdCode?: string | null;
  attributedAdCode?: string | null;
  attributedAdId?: number | null;
  attributedAd?: {
    id: number;
    name: string;
    code: string;
  } | null;
};

export type SalesMetrics = {
  totalOrders: number;
  totalItems: number;
  totalRevenue: number;
  totalCost: number;
  incompleteCostOrders: number;
  grossProfit: number;
  netProfit: number;
  totalLoss: number;
  averageOrderValue: number;
  hasIncompleteData: boolean;
};

export type DailySalesRow = {
  dateKey: string;
  dateFormatted: string;
  ordersCount: number;
  itemsCount: number;
  revenue: number;
  cost: number;
  profit: number;
  loss: number;
  unknownCostOrders: number;
};

export type ProductSalesRow = {
  title: string;
  ordersCount: number;
  itemsCount: number;
  revenue: number;
  avgPrice: number;
  cost: number;
  profit: number;
  profitMarginPct: number;
  lossOrdersCount: number;
  unknownCostCount: number;
  isTopSeller?: boolean;
  isTopProfit?: boolean;
  isLossMaking?: boolean;
  isMissingCost?: boolean;
};

/**
 * Checks if an order qualifies as an actual paid sale.
 * Excludes cancelled, failed, and 0-price giveaway/gift orders.
 */
export function isSuccessfulSale(order: {
  status: string;
  priceUsdt: number;
  priceUzs?: number | null;
}): boolean {
  if (!SALE_STATUSES.includes(order.status as any)) return false;
  const effectivePrice =
    order.priceUzs !== null && order.priceUzs !== undefined && order.priceUzs > 0
      ? order.priceUzs
      : Math.round(order.priceUsdt);
  return effectivePrice > 0;
}

/**
 * Extracts quantity of items sold from order title (e.g. "Gemini Pro 1m ×2" -> 2).
 * Defaults to 1 if no quantity multiplier is found.
 */
export function extractItemQuantity(title: string): number {
  if (!title) return 1;
  const match = title.match(/[×x*]\s*(\d+)/i);
  if (match && match[1]) {
    const qty = parseInt(match[1], 10);
    if (!Number.isNaN(qty) && qty > 0) return qty;
  }
  return 1;
}

/**
 * Returns effective selling price in UZS for an order.
 */
export function orderRevenue(order: {
  priceUsdt: number;
  priceUzs?: number | null;
}): number {
  return order.priceUzs && order.priceUzs > 0
    ? order.priceUzs
    : Math.round(order.priceUsdt || 0);
}

/**
 * Formats monetary amounts in UZS with locale separators.
 */
export function formatUzs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Math.round(value).toLocaleString("ru-RU")} сум`;
}

/**
 * Calculates top-level KPI metrics across an array of qualifying orders.
 */
export function calculateSalesMetrics(orders: RawSalesOrder[]): SalesMetrics {
  let totalOrders = 0;
  let totalItems = 0;
  let totalRevenue = 0;
  let totalCost = 0;
  let incompleteCostOrders = 0;
  let totalLoss = 0;

  for (const order of orders) {
    if (!isSuccessfulSale(order)) continue;

    totalOrders++;
    const items = extractItemQuantity(order.titleRu);
    totalItems += items;

    const sale = orderRevenue(order);
    totalRevenue += sale;

    const hasCost =
      order.costPriceUzs !== null &&
      order.costPriceUzs !== undefined &&
      !Number.isNaN(order.costPriceUzs);

    if (hasCost) {
      const cost = order.costPriceUzs!;
      totalCost += cost;
      if (sale < cost) {
        totalLoss += cost - sale;
      }
    } else {
      incompleteCostOrders++;
    }
  }

  const grossProfit = totalRevenue - totalCost;
  // Stage 1: Net profit equals gross profit (ad expenses will be deducted in Stage 2)
  const netProfit = grossProfit;
  const averageOrderValue =
    totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
  const hasIncompleteData = incompleteCostOrders > 0;

  return {
    totalOrders,
    totalItems,
    totalRevenue,
    totalCost,
    incompleteCostOrders,
    grossProfit,
    netProfit,
    totalLoss,
    averageOrderValue,
    hasIncompleteData,
  };
}

/**
 * Tashkent time date key generator (YYYY-MM-DD).
 */
export function toTashkentDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Formats YYYY-MM-DD into DD.MM.YYYY.
 */
export function formatTashkentDate(dateKey: string): string {
  const parts = dateKey.split("-");
  if (parts.length === 3) {
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }
  return dateKey;
}

/**
 * Formats a Date object into DD.MM.YYYY HH:mm in Tashkent time.
 */
export function formatTashkentDateTime(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Tashkent",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Groups sales orders by day (Tashkent timezone), ordered newest to oldest.
 */
export function groupSalesByDay(orders: RawSalesOrder[]): DailySalesRow[] {
  const map = new Map<
    string,
    {
      ordersCount: number;
      itemsCount: number;
      revenue: number;
      cost: number;
      loss: number;
      unknownCostOrders: number;
    }
  >();

  for (const order of orders) {
    if (!isSuccessfulSale(order)) continue;

    const dateKey = toTashkentDateKey(new Date(order.createdAt));
    const sale = orderRevenue(order);
    const items = extractItemQuantity(order.titleRu);
    const hasCost =
      order.costPriceUzs !== null &&
      order.costPriceUzs !== undefined &&
      !Number.isNaN(order.costPriceUzs);
    const cost = hasCost ? order.costPriceUzs! : 0;
    const loss = hasCost && sale < cost ? cost - sale : 0;

    const existing = map.get(dateKey) ?? {
      ordersCount: 0,
      itemsCount: 0,
      revenue: 0,
      cost: 0,
      loss: 0,
      unknownCostOrders: 0,
    };

    existing.ordersCount++;
    existing.itemsCount += items;
    existing.revenue += sale;
    existing.cost += cost;
    existing.loss += loss;
    if (!hasCost) existing.unknownCostOrders++;

    map.set(dateKey, existing);
  }

  return [...map.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dateKey, row]) => ({
      dateKey,
      dateFormatted: formatTashkentDate(dateKey),
      ordersCount: row.ordersCount,
      itemsCount: row.itemsCount,
      revenue: row.revenue,
      cost: row.cost,
      profit: row.revenue - row.cost,
      loss: row.loss,
      unknownCostOrders: row.unknownCostOrders,
    }));
}

/**
 * Groups sales orders by product name and computes financial breakdown & badges.
 */
export function groupSalesByProduct(orders: RawSalesOrder[]): ProductSalesRow[] {
  const map = new Map<
    string,
    {
      ordersCount: number;
      itemsCount: number;
      revenue: number;
      cost: number;
      lossOrdersCount: number;
      unknownCostCount: number;
    }
  >();

  for (const order of orders) {
    if (!isSuccessfulSale(order)) continue;

    const title = order.titleRu.trim() || "Без названия";
    const sale = orderRevenue(order);
    const items = extractItemQuantity(order.titleRu);
    const hasCost =
      order.costPriceUzs !== null &&
      order.costPriceUzs !== undefined &&
      !Number.isNaN(order.costPriceUzs);
    const cost = hasCost ? order.costPriceUzs! : 0;
    const isLoss = hasCost && sale < cost;

    const existing = map.get(title) ?? {
      ordersCount: 0,
      itemsCount: 0,
      revenue: 0,
      cost: 0,
      lossOrdersCount: 0,
      unknownCostCount: 0,
    };

    existing.ordersCount++;
    existing.itemsCount += items;
    existing.revenue += sale;
    existing.cost += cost;
    if (isLoss) existing.lossOrdersCount++;
    if (!hasCost) existing.unknownCostCount++;

    map.set(title, existing);
  }

  const rows: ProductSalesRow[] = [...map.entries()].map(([title, row]) => {
    const profit = row.revenue - row.cost;
    const avgPrice =
      row.ordersCount > 0 ? Math.round(row.revenue / row.ordersCount) : 0;
    const profitMarginPct =
      row.revenue > 0 ? Math.round((profit / row.revenue) * 100) : 0;

    return {
      title,
      ordersCount: row.ordersCount,
      itemsCount: row.itemsCount,
      revenue: row.revenue,
      avgPrice,
      cost: row.cost,
      profit,
      profitMarginPct,
      lossOrdersCount: row.lossOrdersCount,
      unknownCostCount: row.unknownCostCount,
      isLossMaking: row.lossOrdersCount > 0,
      isMissingCost: row.unknownCostCount > 0,
    };
  });

  if (rows.length === 0) return [];

  // Find top seller by ordersCount
  let maxOrders = 0;
  for (const r of rows) {
    if (r.ordersCount > maxOrders) maxOrders = r.ordersCount;
  }
  if (maxOrders > 0) {
    for (const r of rows) {
      if (r.ordersCount === maxOrders) r.isTopSeller = true;
    }
  }

  // Find top profit (among products with complete cost data)
  let maxProfit = -Infinity;
  for (const r of rows) {
    if (r.unknownCostCount === 0 && r.profit > 0 && r.profit > maxProfit) {
      maxProfit = r.profit;
    }
  }
  if (maxProfit > 0) {
    for (const r of rows) {
      if (r.unknownCostCount === 0 && r.profit === maxProfit) {
        r.isTopProfit = true;
      }
    }
  }

  return rows;
}
