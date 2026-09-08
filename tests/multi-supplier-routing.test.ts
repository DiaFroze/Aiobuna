import { describe, it, expect } from "vitest";
import {
  sortSuppliersByStrategy,
  totalSupplierStock,
  type SupplierCandidate,
} from "../src/lib/domain/supplier-routing";

describe("sortSuppliersByStrategy", () => {
  const candidates: SupplierCandidate[] = [
    {
      supplierKey: "vex",
      supplierExternalId: "vex_gemini",
      supplierPriceUsdt: 4.5,
      supplierStock: 10,
      priority: 2,
      isActive: true,
      name: "Vexoran Level 2",
    },
    {
      supplierKey: "qamify",
      supplierExternalId: "qam_gemini",
      supplierPriceUsdt: 5.0,
      supplierStock: 15,
      priority: 1,
      isActive: true,
      name: "Qamify Level 1",
    },
    {
      supplierKey: "somadeth",
      supplierExternalId: "soma_gemini",
      supplierPriceUsdt: 3.8,
      supplierStock: 0,
      priority: 3,
      isActive: false, // inactive should be omitted
      name: "Inactive Supplier",
    },
  ];

  it("filters out inactive suppliers", () => {
    const sorted = sortSuppliersByStrategy(candidates, "priority");
    expect(sorted.length).toBe(2);
    expect(sorted.some((c) => c.supplierKey === "somadeth")).toBe(false);
  });

  it("strategy 'priority': sorts strictly by priority level (Level 1 before Level 2)", () => {
    const sorted = sortSuppliersByStrategy(candidates, "priority");
    expect(sorted[0].supplierKey).toBe("qamify"); // priority 1
    expect(sorted[1].supplierKey).toBe("vex"); // priority 2
  });

  it("strategy 'cheapest': sorts by lowest purchase price among in-stock suppliers", () => {
    const sorted = sortSuppliersByStrategy(candidates, "cheapest");
    expect(sorted[0].supplierKey).toBe("vex"); // $4.5 < $5.0
    expect(sorted[1].supplierKey).toBe("qamify");
  });

  it("strategy 'cheapest' deprioritizes suppliers with stock = 0", () => {
    const withZeroStock: SupplierCandidate[] = [
      {
        supplierKey: "vex",
        supplierExternalId: "1",
        supplierPriceUsdt: 2.0,
        supplierStock: 0, // cheaper but zero stock
        priority: 1,
        isActive: true,
      },
      {
        supplierKey: "qamify",
        supplierExternalId: "2",
        supplierPriceUsdt: 4.0,
        supplierStock: 5, // more expensive but has stock
        priority: 2,
        isActive: true,
      },
    ];
    const sorted = sortSuppliersByStrategy(withZeroStock, "cheapest");
    expect(sorted[0].supplierKey).toBe("qamify");
    expect(sorted[1].supplierKey).toBe("vex");
  });

  it("strategy 'balance': prioritizes suppliers with verified balance > 0", () => {
    const balances = {
      qamify: 0, // out of balance
      vex: 50.0, // has balance
    };
    const sorted = sortSuppliersByStrategy(candidates, "balance", balances);
    expect(sorted[0].supplierKey).toBe("vex"); // has balance
    expect(sorted[1].supplierKey).toBe("qamify"); // zero balance fallback
  });

  it("strategy 'cheapest': prioritizes suppliers with balance > 0 over empty balance", () => {
    const balances = {
      qamify: 25.0, // has balance
      vex: 0.0, // empty balance
    };
    // Even though vex ($4.5) is cheaper than qamify ($5.0), qamify has balance!
    const sorted = sortSuppliersByStrategy(candidates, "cheapest", balances);
    expect(sorted[0].supplierKey).toBe("qamify");
    expect(sorted[1].supplierKey).toBe("vex");
  });
});

describe("totalSupplierStock", () => {
  it("sums stock across active suppliers only", () => {
    const list: SupplierCandidate[] = [
      { supplierKey: "qamify", supplierExternalId: "1", supplierPriceUsdt: 5, supplierStock: 12, priority: 1, isActive: true },
      { supplierKey: "vex", supplierExternalId: "2", supplierPriceUsdt: 4.5, supplierStock: 8, priority: 2, isActive: true },
      { supplierKey: "off", supplierExternalId: "3", supplierPriceUsdt: 3, supplierStock: 20, priority: 3, isActive: false },
    ];
    expect(totalSupplierStock(list)).toBe(20); // 12 + 8
  });
});
