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

/**
 * Sort candidate suppliers according to the configured routing strategy.
 */
export function sortSuppliersByStrategy(
  candidates: SupplierCandidate[],
  strategy: RoutingStrategy = "priority",
  balances?: Record<string, number>,
): SupplierCandidate[] {
  const active = candidates.filter((c) => c.isActive);
  if (active.length <= 1) return [...active];

  return [...active].sort((a, b) => {
    const balA = balances ? (balances[a.supplierKey] ?? 0) : 0;
    const balB = balances ? (balances[b.supplierKey] ?? 0) : 0;

    if (strategy === "cheapest") {
      if (balances) {
        const hasBalA = balA > 0 ? 1 : 0;
        const hasBalB = balB > 0 ? 1 : 0;
        if (hasBalA !== hasBalB) return hasBalB - hasBalA;
      }

      const hasStockA = a.supplierStock > 0 ? 1 : 0;
      const hasStockB = b.supplierStock > 0 ? 1 : 0;
      if (hasStockA !== hasStockB) return hasStockB - hasStockA;

      if (a.supplierPriceUsdt !== b.supplierPriceUsdt) {
        return a.supplierPriceUsdt - b.supplierPriceUsdt;
      }

      return a.priority - b.priority;
    }

    if (strategy === "balance") {
      if (balances) {
        const hasBalA = balA > 0 ? 1 : 0;
        const hasBalB = balB > 0 ? 1 : 0;
        if (hasBalA !== hasBalB) return hasBalB - hasBalA;
      }

      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      return a.supplierPriceUsdt - b.supplierPriceUsdt;
    }

    // Default: "priority" (strict cascade by level)
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }

    return a.supplierPriceUsdt - b.supplierPriceUsdt;
  });
}

/**
 * Calculate total available supplier stock across all active suppliers for a variant.
 */
export function totalSupplierStock(candidates: SupplierCandidate[]): number {
  return candidates
    .filter((c) => c.isActive)
    .reduce((sum, c) => sum + Math.max(0, c.supplierStock), 0);
}
