/**
 * Sales Statistics domain logic & aggregation helpers for AI OBUNA admin panel.
 * Uses real database records (PostgreSQL), supports payment method attribution
 * (Click, Payme, Stars, Binance, Balance, etc.) and API supplier procurement.
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
  if (period === "yesterday") {
    const yesterdayDate = new Date(now.getTime() - 86_400_000);
    const tashkentYesterday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tashkent",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(yesterdayDate);
    return {
      from: new Date(`${tashkentYesterday}T00:00:00+05:00`),
      to: new Date(`${tashkentYesterday}T23:59:59.999+05:00`),
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
  if (period === "month") {
    // Current calendar month in Tashkent
    const [year, month] = tashkentDateToday.split("-");
    return {
      from: new Date(`${year}-${month}-01T00:00:00+05:00`),
      to: new Date(`${tashkentDateToday}T23:59:59.999+05:00`),
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
  source?: string | null;
  paymentMethod?: string | null;
  paymentId?: string | null;
  status: string;
  createdAt: Date;
  variantId?: number | null;
  variant?: {
    id: number;
    titleRu?: string;
    costPriceUzs?: number | null;
    supplierPriceUsdt?: number;
    supplierKey?: string | null;
  } | null;
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
  profit: number;
  averageOrderValue: number;
  // Compatibility fields
  grossProfit: number;
  netProfit: number;
  totalLoss: number;
  incompleteCostOrders: number;
  hasIncompleteData: boolean;
};

export interface NormalizedPaymentMethod {
  id: string;
  name: string;
  emoji: string;
  color: string;
  bgColor: string;
}

export function normalizePaymentMethod(method: string | null | undefined): NormalizedPaymentMethod {
  const m = (method || "").toLowerCase().trim();
  if (m === "click") {
    return { id: "click", name: "Click", emoji: "🟢", color: "text-emerald-400", bgColor: "bg-emerald-500/15 border-emerald-500/30 text-emerald-400" };
  }
  if (m === "payme") {
    return { id: "payme", name: "Payme", emoji: "🔵", color: "text-cyan-400", bgColor: "bg-cyan-500/15 border-cyan-500/30 text-cyan-400" };
  }
  if (m === "stars" || m === "telegram_stars") {
    return { id: "stars", name: "Telegram Stars", emoji: "⭐", color: "text-amber-400", bgColor: "bg-amber-500/15 border-amber-500/30 text-amber-400" };
  }
  if (m === "binance" || m === "binance_pay") {
    return { id: "binance", name: "Binance Pay", emoji: "🪙", color: "text-yellow-400", bgColor: "bg-yellow-500/15 border-yellow-500/30 text-yellow-400" };
  }
  if (m === "receipt") {
    return { id: "receipt", name: "Чек / Перевод", emoji: "🧾", color: "text-purple-400", bgColor: "bg-purple-500/15 border-purple-500/30 text-purple-400" };
  }
  if (m === "admin") {
    return { id: "admin", name: "Администратор", emoji: "⚡", color: "text-orange-400", bgColor: "bg-orange-500/15 border-orange-500/30 text-orange-400" };
  }
  if (m === "course_bonus") {
    return { id: "course_bonus", name: "Бонус к курсу", emoji: "🎁", color: "text-pink-400", bgColor: "bg-pink-500/15 border-pink-500/30 text-pink-400" };
  }
  // Default: paid with user account balance
  return { id: "balance", name: "Баланс бота", emoji: "💳", color: "text-blue-400", bgColor: "bg-blue-500/15 border-blue-500/30 text-blue-400" };
}

export interface NormalizedSourceApi {
  id: string;
  name: string;
  badge: string;
}

export function normalizeSourceApi(source: string | null | undefined, supplierKey?: string | null): NormalizedSourceApi {
  const s = (source || "").toLowerCase().trim();
  const sk = (supplierKey || "").toLowerCase().trim();

  if (s === "vex" || sk === "vex") {
    return { id: "vex", name: "Vex Reseller API", badge: "🔌 Vex API" };
  }
  if (s === "qamify" || sk === "qamify") {
    return { id: "qamify", name: "Qamify API", badge: "🔌 Qamify API" };
  }
  if (s === "somadeth" || sk === "somadeth") {
    return { id: "somadeth", name: "Somadeth API", badge: "🔌 Somadeth API" };
  }
  if (s === "hybrid") {
    return { id: "hybrid", name: "Склад + Авто API", badge: "⚡ Склад + API" };
  }
  if (s === "stock") {
    return { id: "stock", name: "Склад (ключи)", badge: "📦 Со склада" };
  }
  if (s === "fragment") {
    return { id: "fragment", name: "Telegram Fragment", badge: "⭐ Fragment" };
  }
  if (s === "manual") {
    return { id: "manual", name: "Ручная выдача", badge: "👤 Вручную" };
  }
  if (s === "course") {
    return { id: "course", name: "Обучающий курс", badge: "🎓 Курс" };
  }
  if (s === "referral") {
    return { id: "referral", name: "Реферальный подарок", badge: "🎁 Реферал" };
  }
  if (s === "admin") {
    return { id: "admin", name: "Выдача админа", badge: "⚡ Админ" };
  }
  return { id: s || "direct", name: source || "Прямая выдача", badge: source || "Прямая" };
}

export interface PaymentMethodSummary {
  id: string;
  name: string;
  emoji: string;
  color: string;
  bgColor: string;
  ordersCount: number;
  totalRevenue: number;
  sharePct: number;
}

export interface SourceApiSummary {
  id: string;
  name: string;
  badge: string;
  ordersCount: number;
  totalRevenue: number;
  totalCost: number;
  profit: number;
}

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
  payments: { id: string; name: string; emoji: string; count: number; sum: number }[];
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
  topPaymentMethod: string;
  topSource: string;
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
 * Computes procurement cost spent for an order from DB records.
 */
export function orderCost(order: RawSalesOrder): number {
  if (order.costPriceUzs !== null && order.costPriceUzs !== undefined && !Number.isNaN(order.costPriceUzs)) {
    return order.costPriceUzs;
  }
  if (order.variant?.costPriceUzs) {
    return order.variant.costPriceUzs;
  }
  if (order.variant?.supplierPriceUsdt && order.variant.supplierPriceUsdt > 0) {
    return Math.round(order.variant.supplierPriceUsdt * 12800);
  }
  return 0;
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

    const cost = orderCost(order);
    totalCost += cost;

    const hasExplicitCost =
      order.costPriceUzs !== null &&
      order.costPriceUzs !== undefined &&
      !Number.isNaN(order.costPriceUzs);

    if (hasExplicitCost) {
      if (sale < cost) {
        totalLoss += cost - sale;
      }
    } else if (cost === 0) {
      incompleteCostOrders++;
    }
  }

  const profit = totalRevenue - totalCost;
  const averageOrderValue =
    totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

  return {
    totalOrders,
    totalItems,
    totalRevenue,
    totalCost,
    profit,
    averageOrderValue,
    grossProfit: profit,
    netProfit: profit,
    totalLoss,
    incompleteCostOrders,
    hasIncompleteData: incompleteCostOrders > 0,
  };
}

/**
 * Aggregates sales orders by payment method (Click, Payme, Stars, Balance, Binance, etc.).
 */
export function groupSalesByPaymentMethod(orders: RawSalesOrder[]): PaymentMethodSummary[] {
  const map = new Map<string, { norm: NormalizedPaymentMethod; count: number; sum: number }>();

  let grandTotal = 0;
  for (const order of orders) {
    if (!isSuccessfulSale(order)) continue;
    const sale = orderRevenue(order);
    grandTotal += sale;

    const norm = normalizePaymentMethod(order.paymentMethod);
    const existing = map.get(norm.id) ?? { norm, count: 0, sum: 0 };
    existing.count++;
    existing.sum += sale;
    map.set(norm.id, existing);
  }

  return [...map.values()]
    .sort((a, b) => b.sum - a.sum)
    .map(({ norm, count, sum }) => ({
      id: norm.id,
      name: norm.name,
      emoji: norm.emoji,
      color: norm.color,
      bgColor: norm.bgColor,
      ordersCount: count,
      totalRevenue: sum,
      sharePct: grandTotal > 0 ? Math.round((sum / grandTotal) * 100) : 0,
    }));
}

/**
 * Aggregates sales orders by API source / supplier procurement.
 */
export function groupSalesBySource(orders: RawSalesOrder[]): SourceApiSummary[] {
  const map = new Map<string, { norm: NormalizedSourceApi; count: number; revenue: number; cost: number }>();

  for (const order of orders) {
    if (!isSuccessfulSale(order)) continue;
    const sale = orderRevenue(order);
    const cost = orderCost(order);

    const norm = normalizeSourceApi(order.source, order.variant?.supplierKey);
    const existing = map.get(norm.id) ?? { norm, count: 0, revenue: 0, cost: 0 };
    existing.count++;
    existing.revenue += sale;
    existing.cost += cost;
    map.set(norm.id, existing);
  }

  return [...map.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .map(({ norm, count, revenue, cost }) => ({
      id: norm.id,
      name: norm.name,
      badge: norm.badge,
      ordersCount: count,
      totalRevenue: revenue,
      totalCost: cost,
      profit: revenue - cost,
    }));
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
      paymentsMap: Map<string, { id: string; name: string; emoji: string; count: number; sum: number }>;
    }
  >();

  for (const order of orders) {
    if (!isSuccessfulSale(order)) continue;

    const dateKey = toTashkentDateKey(new Date(order.createdAt));
    const sale = orderRevenue(order);
    const items = extractItemQuantity(order.titleRu);
    const cost = orderCost(order);
    const loss = cost > sale ? cost - sale : 0;
    const hasExplicitCost = order.costPriceUzs !== null && order.costPriceUzs !== undefined;

    const existing = map.get(dateKey) ?? {
      ordersCount: 0,
      itemsCount: 0,
      revenue: 0,
      cost: 0,
      loss: 0,
      unknownCostOrders: 0,
      paymentsMap: new Map(),
    };

    existing.ordersCount++;
    existing.itemsCount += items;
    existing.revenue += sale;
    existing.cost += cost;
    existing.loss += loss;
    if (!hasExplicitCost && cost === 0) existing.unknownCostOrders++;

    // Track payment method for day
    const norm = normalizePaymentMethod(order.paymentMethod);
    const pExisting = existing.paymentsMap.get(norm.id) ?? {
      id: norm.id,
      name: norm.name,
      emoji: norm.emoji,
      count: 0,
      sum: 0,
    };
    pExisting.count++;
    pExisting.sum += sale;
    existing.paymentsMap.set(norm.id, pExisting);

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
      payments: [...row.paymentsMap.values()].sort((a, b) => b.sum - a.sum),
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
      paymentCounts: Map<string, number>;
      sourceCounts: Map<string, number>;
    }
  >();

  for (const order of orders) {
    if (!isSuccessfulSale(order)) continue;

    const title = order.titleRu.trim() || "Без названия";
    const sale = orderRevenue(order);
    const items = extractItemQuantity(order.titleRu);
    const cost = orderCost(order);
    const isLoss = cost > sale;
    const hasExplicitCost = order.costPriceUzs !== null && order.costPriceUzs !== undefined;

    const existing = map.get(title) ?? {
      ordersCount: 0,
      itemsCount: 0,
      revenue: 0,
      cost: 0,
      lossOrdersCount: 0,
      unknownCostCount: 0,
      paymentCounts: new Map(),
      sourceCounts: new Map(),
    };

    existing.ordersCount++;
    existing.itemsCount += items;
    existing.revenue += sale;
    existing.cost += cost;
    if (isLoss) existing.lossOrdersCount++;
    if (!hasExplicitCost && cost === 0) existing.unknownCostCount++;

    const pm = normalizePaymentMethod(order.paymentMethod).name;
    existing.paymentCounts.set(pm, (existing.paymentCounts.get(pm) ?? 0) + 1);

    const src = normalizeSourceApi(order.source, order.variant?.supplierKey).name;
    existing.sourceCounts.set(src, (existing.sourceCounts.get(src) ?? 0) + 1);

    map.set(title, existing);
  }

  const rows: ProductSalesRow[] = [...map.entries()].map(([title, row]) => {
    const profit = row.revenue - row.cost;
    const avgPrice =
      row.ordersCount > 0 ? Math.round(row.revenue / row.ordersCount) : 0;
    const profitMarginPct =
      row.revenue > 0 ? Math.round((profit / row.revenue) * 100) : 0;

    // Determine top payment method
    let topPayment = "—";
    let maxPayCount = 0;
    for (const [p, c] of row.paymentCounts) {
      if (c > maxPayCount) {
        maxPayCount = c;
        topPayment = p;
      }
    }

    // Determine top source API
    let topSource = "—";
    let maxSrcCount = 0;
    for (const [s, c] of row.sourceCounts) {
      if (c > maxSrcCount) {
        maxSrcCount = c;
        topSource = s;
      }
    }

    return {
      title,
      ordersCount: row.ordersCount,
      itemsCount: row.itemsCount,
      revenue: row.revenue,
      avgPrice,
      cost: row.cost,
      profit,
      profitMarginPct,
      topPaymentMethod: topPayment,
      topSource,
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

  // Find top profit
  let maxProfit = -Infinity;
  for (const r of rows) {
    if (r.profit > 0 && r.profit > maxProfit) {
      maxProfit = r.profit;
    }
  }
  if (maxProfit > 0) {
    for (const r of rows) {
      if (r.profit === maxProfit) {
        r.isTopProfit = true;
      }
    }
  }

  return rows;
}
