/**
 * Multi-supplier routing & cascading domain logic.
 *
 * Pure, unit-tested functions — no DB, no network, no grammY.
 * Used by the Telegram bot to decide which supplier to order from when a variant
 * has multiple suppliers connected (e.g. Supplier 1: Qamify, Supplier 2: Vexoran).
 */

export type RoutingStrategy = "priority" | "cheapest" | "balance";

export interface SupplierCandidate {
  id?: number;
  supplierKey: string;
  supplierExternalId: string;
  supplierPriceUsdt: number;
  supplierStock: number;
  priority: number; // 1 = Level 1 (primary), 2 = Level 2 (fallback), etc.
  isActive: boolean;
  name?: string | null;
}

export interface RoutingDecision {
  selectedCandidate: SupplierCandidate | null;
  sortedCandidates: SupplierCandidate[];
  logs: string[];
}

/**
 * Calculates a balance score:
 * 2 = Has sufficient funds to cover the full order cost (balance >= cost && balance > 0)
 * 1 = Has some funds (balance > 0, but less than cost) or balance is unknown
 * 0 = Zero or negative balance
 */
function getBalanceScore(
  cand: SupplierCandidate,
  balances?: Record<string, number>,
  quantity: number = 1,
): number {
  if (!balances) return 1; // unknown / not checked
  const bal = balances[cand.supplierKey];
  if (bal === undefined || bal === null) return 1;
  const neededCost = Math.max(0, cand.supplierPriceUsdt) * Math.max(1, quantity);
  if (bal >= neededCost && bal > 0) return 2;
  if (bal > 0) return 1;
  return 0;
}

/**
 * Sort candidate suppliers according to the configured routing strategy,
 * taking into account verified live balances and order quantity.
 */
export function sortSuppliersByStrategy(
  candidates: SupplierCandidate[],
  strategy: RoutingStrategy = "priority",
  balances?: Record<string, number>,
  quantity: number = 1,
): SupplierCandidate[] {
  const active = candidates.filter((c) => c.isActive);
  if (active.length <= 1) return [...active];

  const qty = Math.max(1, quantity);

  return [...active].sort((a, b) => {
    const scoreA = getBalanceScore(a, balances, qty);
    const scoreB = getBalanceScore(b, balances, qty);

    if (strategy === "cheapest") {
      // 1. Prioritize suppliers that actually have sufficient balance over empty/insufficient ones
      if (balances && scoreA !== scoreB) {
        return scoreB - scoreA;
      }

      // 2. Prioritize suppliers with stock
      const hasStockA = a.supplierStock > 0 || a.supplierStock === -1 ? 1 : 0;
      const hasStockB = b.supplierStock > 0 || b.supplierStock === -1 ? 1 : 0;
      if (hasStockA !== hasStockB) return hasStockB - hasStockA;

      // 3. Lowest purchase price (USDT) wins!
      if (a.supplierPriceUsdt !== b.supplierPriceUsdt) {
        return a.supplierPriceUsdt - b.supplierPriceUsdt;
      }

      return a.priority - b.priority;
    }

    if (strategy === "balance") {
      const balA = balances ? (balances[a.supplierKey] ?? 0) : 0;
      const balB = balances ? (balances[b.supplierKey] ?? 0) : 0;
      if (balA !== balB) {
        return balB - balA;
      }

      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      return a.supplierPriceUsdt - b.supplierPriceUsdt;
    }

    // Default: "priority" (strict cascade by level, but skipping/deprioritizing confirmed 0-balance suppliers)
    if (balances) {
      // If one candidate has confirmed 0 balance and another has sufficient balance,
      // cascade to the one with balance!
      const isZeroA = scoreA === 0 ? 1 : 0;
      const isZeroB = scoreB === 0 ? 1 : 0;
      if (isZeroA !== isZeroB) {
        return isZeroA - isZeroB;
      }
    }

    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }

    return a.supplierPriceUsdt - b.supplierPriceUsdt;
  });
}

/**
 * Simulate supplier routing for a variant and produce human-readable decision logs.
 */
export function simulateSupplierRouting(
  candidates: SupplierCandidate[],
  strategy: RoutingStrategy = "priority",
  balances?: Record<string, number>,
  quantity: number = 1,
): RoutingDecision {
  const logs: string[] = [];
  const active = candidates.filter((c) => c.isActive);

  if (active.length === 0) {
    logs.push("❌ Нет активных подключенных поставщиков.");
    return { selectedCandidate: null, sortedCandidates: [], logs };
  }

  logs.push(`Стратегия: ${strategy.toUpperCase()}, количество: ${quantity} шт.`);

  for (const c of active) {
    const needed = (c.supplierPriceUsdt * quantity).toFixed(2);
    const bal = balances ? balances[c.supplierKey] : undefined;
    const balStr = bal !== undefined ? `$${bal.toFixed(2)}` : "не запрошен";
    const score = getBalanceScore(c, balances, quantity);
    const statusStr = score === 2 ? "✅ Достаточно средств" : score === 1 ? "⚠️ Недостаточно средств" : "❌ Баланс 0$";
    logs.push(
      `• [${c.supplierKey}] ${c.name || c.supplierExternalId} (Приоритет ${c.priority}): цена $${c.supplierPriceUsdt.toFixed(2)}, нужно $${needed}, баланс API: ${balStr} → ${statusStr}`,
    );
  }

  const sorted = sortSuppliersByStrategy(candidates, strategy, balances, quantity);
  const selected = sorted[0] ?? null;

  if (selected) {
    logs.push(
      `🎯 ИТОГ: Выбран поставщик [${selected.supplierKey}] (ID: ${selected.supplierExternalId}, закупка: $${selected.supplierPriceUsdt.toFixed(2)})`,
    );
  }

  return { selectedCandidate: selected, sortedCandidates: sorted, logs };
}

/**
 * Calculate total available supplier stock across all active suppliers for a variant.
 */
export function totalSupplierStock(candidates: SupplierCandidate[]): number {
  return candidates
    .filter((c) => c.isActive)
    .reduce((sum, c) => sum + Math.max(0, c.supplierStock), 0);
}

