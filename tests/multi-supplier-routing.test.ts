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

  it("strategy 'cheapest': skips supplier with partial insufficient balance (e.g. $1.00 when item costs $4.50)", () => {
    const balances = {
      vex: 1.0, // $1.00 < $4.50 cost -> insufficient!
      qamify: 20.0, // $20.00 >= $5.00 cost -> sufficient!
    };
    const sorted = sortSuppliersByStrategy(candidates, "cheapest", balances, 1);
    expect(sorted[0].supplierKey).toBe("qamify");
    expect(sorted[1].supplierKey).toBe("vex");
  });

  it("strategy 'priority': cascades to Level 2 if Level 1 has 0 balance", () => {
    const balances = {
      qamify: 0.0, // Level 1 (priority 1) has 0 balance!
      vex: 50.0, // Level 2 (priority 2) has balance!
    };
    const sorted = sortSuppliersByStrategy(candidates, "priority", balances);
    expect(sorted[0].supplierKey).toBe("vex"); // cascades to Level 2!
    expect(sorted[1].supplierKey).toBe("qamify");
  });

  it("scales needed cost with quantity", () => {
    const balances = {
      vex: 10.0, // $10 balance: enough for 2 items ($9.0), but NOT enough for 3 items ($13.5)!
      qamify: 20.0, // $20 balance: enough for 3 items ($15.0)!
    };
    // Qty = 1: vex is cheaper ($4.5 vs $5.0) and $10 >= $4.5
    const sorted1 = sortSuppliersByStrategy(candidates, "cheapest", balances, 1);
    expect(sorted1[0].supplierKey).toBe("vex");

    // Qty = 3: vex needs $13.5 but has only $10. Qamify needs $15.0 and has $20!
    const sorted3 = sortSuppliersByStrategy(candidates, "cheapest", balances, 3);
    expect(sorted3[0].supplierKey).toBe("qamify");
  });
});

import { simulateSupplierRouting } from "../src/lib/domain/supplier-routing";

describe("simulateSupplierRouting", () => {
  it("produces human-readable routing decision logs", () => {
    const list: SupplierCandidate[] = [
      { supplierKey: "vex", supplierExternalId: "vex_gemini", supplierPriceUsdt: 3.5, supplierStock: 10, priority: 1, isActive: true },
      { supplierKey: "qamify", supplierExternalId: "qam_gemini", supplierPriceUsdt: 3.2, supplierStock: 5, priority: 2, isActive: true },
    ];
    const balances = { vex: 15.0, qamify: 0.0 };
    const res = simulateSupplierRouting(list, "cheapest", balances, 1);

    expect(res.selectedCandidate?.supplierKey).toBe("vex");
    expect(res.logs.length).toBeGreaterThan(0);
    expect(res.logs.some((l) => l.includes("Выбран поставщик [vex]"))).toBe(true);
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
