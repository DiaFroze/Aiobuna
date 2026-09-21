import { describe, it, expect } from "vitest";
import {
  extractItemQuantity,
  isSuccessfulSale,
  orderRevenue,
  calculateSalesMetrics,
  groupSalesByDay,
  groupSalesByProduct,
  formatUzs,
  computePeriodDateRange,
  toTashkentDateKey,
  formatTashkentDate,
  RawSalesOrder,
} from "@/lib/domain/sales-statistics";

describe("Sales Statistics Domain Helpers", () => {
  describe("extractItemQuantity", () => {
    it("defaults to 1 when no multiplier is present", () => {
      expect(extractItemQuantity("Gemini Advanced 1 месяц")).toBe(1);
      expect(extractItemQuantity("Telegram Premium")).toBe(1);
      expect(extractItemQuantity("")).toBe(1);
    });

    it("parses ×N, xN and * N multipliers", () => {
      expect(extractItemQuantity("Gemini Pro 1.5 ×2")).toBe(2);
      expect(extractItemQuantity("CapCut Pro 1 год x3")).toBe(3);
      expect(extractItemQuantity("Canva Team * 5")).toBe(5);
      expect(extractItemQuantity("Claude Pro ×10")).toBe(10);
    });
  });

  describe("isSuccessfulSale & Protection against cancelled/unpaid orders", () => {
    it("accepts successful statuses with price > 0", () => {
      expect(isSuccessfulSale({ status: "delivered", priceUsdt: 50000, priceUzs: 50000 })).toBe(true);
      expect(isSuccessfulSale({ status: "completed", priceUsdt: 75000, priceUzs: null })).toBe(true);
      expect(isSuccessfulSale({ status: "awaiting_delivery", priceUsdt: 40000 })).toBe(true);
      expect(isSuccessfulSale({ status: "processing", priceUsdt: 30000 })).toBe(true);
      expect(isSuccessfulSale({ status: "course_ready", priceUsdt: 120000 })).toBe(true);
      expect(isSuccessfulSale({ status: "awaiting_course_link", priceUsdt: 90000 })).toBe(true);
    });

    it("rejects failed, cancelled, refunded or unpaid orders", () => {
      expect(isSuccessfulSale({ status: "failed", priceUsdt: 50000, priceUzs: 50000 })).toBe(false);
      expect(isSuccessfulSale({ status: "cancelled", priceUsdt: 50000, priceUzs: 50000 })).toBe(false);
      expect(isSuccessfulSale({ status: "refunded", priceUsdt: 50000, priceUzs: 50000 })).toBe(false);
      expect(isSuccessfulSale({ status: "pending", priceUsdt: 50000, priceUzs: 50000 })).toBe(false);
      expect(isSuccessfulSale({ status: "awaiting_payment", priceUsdt: 50000, priceUzs: 50000 })).toBe(false);
    });

    it("rejects free / zero-price promotional or gift orders", () => {
      expect(isSuccessfulSale({ status: "delivered", priceUsdt: 0, priceUzs: 0 })).toBe(false);
      expect(isSuccessfulSale({ status: "delivered", priceUsdt: 0, priceUzs: null })).toBe(false);
      expect(isSuccessfulSale({ status: "completed", priceUsdt: 0 })).toBe(false);
    });
  });

  describe("orderRevenue", () => {
    it("prefers priceUzs if provided and > 0, otherwise priceUsdt", () => {
      expect(orderRevenue({ priceUzs: 85000, priceUsdt: 85000 })).toBe(85000);
      expect(orderRevenue({ priceUzs: null, priceUsdt: 45000 })).toBe(45000);
      expect(orderRevenue({ priceUzs: 0, priceUsdt: 55000 })).toBe(55000);
    });
  });

  describe("formatUzs", () => {
    it("formats amounts in UZS or returns dash for null/undefined", () => {
      expect(formatUzs(null)).toBe("—");
      expect(formatUzs(undefined)).toBe("—");
      expect(formatUzs(150000)).toMatch(/150[\s\u00A0]000 сум/);
    });
  });

  describe("computePeriodDateRange (Tashkent timezone filters)", () => {
    const fixedNow = new Date("2026-09-21T12:00:00+05:00");

    it("returns empty range for 'all' (all-time default)", () => {
      const range = computePeriodDateRange("all", fixedNow);
      expect(range.from).toBeUndefined();
      expect(range.to).toBeUndefined();
    });

    it("returns full Tashkent day boundaries for 'today'", () => {
      const range = computePeriodDateRange("today", fixedNow);
      expect(range.from).toBeDefined();
      expect(range.to).toBeDefined();
      expect(range.from?.toISOString()).toBe(new Date("2026-09-21T00:00:00+05:00").toISOString());
      expect(range.to?.toISOString()).toBe(new Date("2026-09-21T23:59:59.999+05:00").toISOString());
    });

    it("returns 7-day lookback for '7d'", () => {
      const range = computePeriodDateRange("7d", fixedNow);
      expect(range.from).toBeDefined();
      expect(range.from?.getTime()).toBe(fixedNow.getTime() - 7 * 86_400_000);
      expect(range.to).toBeUndefined();
    });

    it("returns 30-day lookback for '30d'", () => {
      const range = computePeriodDateRange("30d", fixedNow);
      expect(range.from).toBeDefined();
      expect(range.from?.getTime()).toBe(fixedNow.getTime() - 30 * 86_400_000);
      expect(range.to).toBeUndefined();
    });

    it("handles custom date range correctly with Tashkent day boundaries", () => {
      const range = computePeriodDateRange("custom", fixedNow, "2026-09-01", "2026-09-15");
      expect(range.from?.toISOString()).toBe(new Date("2026-09-01T00:00:00+05:00").toISOString());
      expect(range.to?.toISOString()).toBe(new Date("2026-09-15T23:59:59.999+05:00").toISOString());
    });
  });

  describe("calculateSalesMetrics", () => {
    it("returns zero metrics when orders array is empty", () => {
      const result = calculateSalesMetrics([]);
      expect(result).toEqual({
        totalOrders: 0,
        totalItems: 0,
        totalRevenue: 0,
        totalCost: 0,
        incompleteCostOrders: 0,
        grossProfit: 0,
        netProfit: 0,
        totalLoss: 0,
        averageOrderValue: 0,
        hasIncompleteData: false,
      });
    });

    it("accurately computes revenue, cost, profit, loss, average check and flags incomplete data", () => {
      const orders: RawSalesOrder[] = [
        // Order 1: profitable single item
        {
          id: 1,
          titleRu: "Gemini Pro 1m",
          priceUsdt: 100000,
          priceUzs: 100000,
          costPriceUzs: 40000,
          status: "delivered",
          createdAt: new Date("2026-09-20T10:00:00Z"),
        },
        // Order 2: multiple items (x2), profitable
        {
          id: 2,
          titleRu: "CapCut Pro 1m ×2",
          priceUsdt: 140000,
          priceUzs: 140000,
          costPriceUzs: 80000,
          status: "delivered",
          createdAt: new Date("2026-09-20T11:00:00Z"),
        },
        // Order 3: loss making (sale 30 000 < cost 45 000)
        {
          id: 3,
          titleRu: "Telegram Premium",
          priceUsdt: 30000,
          priceUzs: 30000,
          costPriceUzs: 45000,
          status: "completed",
          createdAt: new Date("2026-09-21T09:00:00Z"),
        },
        // Order 4: missing cost price (incomplete data)
        {
          id: 4,
          titleRu: "Canva Pro",
          priceUsdt: 50000,
          priceUzs: 50000,
          costPriceUzs: null,
          status: "delivered",
          createdAt: new Date("2026-09-21T12:00:00Z"),
        },
        // Order 5: failed order (must be excluded from sales)
        {
          id: 5,
          titleRu: "Failed Order",
          priceUsdt: 50000,
          priceUzs: 50000,
          costPriceUzs: 20000,
          status: "failed",
          createdAt: new Date("2026-09-21T13:00:00Z"),
        },
        // Order 6: cancelled order (must be excluded)
        {
          id: 6,
          titleRu: "Cancelled Order",
          priceUsdt: 70000,
          priceUzs: 70000,
          costPriceUzs: 30000,
          status: "cancelled",
          createdAt: new Date("2026-09-21T14:00:00Z"),
        },
        // Order 7: free gift (0 price, must be excluded)
        {
          id: 7,
          titleRu: "Free Gift",
          priceUsdt: 0,
          priceUzs: 0,
          costPriceUzs: 10000,
          status: "delivered",
          createdAt: new Date("2026-09-21T15:00:00Z"),
        },
      ];

      const metrics = calculateSalesMetrics(orders);

      expect(metrics.totalOrders).toBe(4);
      expect(metrics.totalItems).toBe(5); // 1 + 2 + 1 + 1
      expect(metrics.totalRevenue).toBe(100000 + 140000 + 30000 + 50000); // 320 000
      expect(metrics.totalCost).toBe(40000 + 80000 + 45000); // 165 000
      expect(metrics.incompleteCostOrders).toBe(1);
      expect(metrics.hasIncompleteData).toBe(true);
      expect(metrics.grossProfit).toBe(320000 - 165000); // 155 000
      expect(metrics.netProfit).toBe(155000);
      expect(metrics.totalLoss).toBe(15000); // 45000 - 30000
      expect(metrics.averageOrderValue).toBe(Math.round(320000 / 4)); // 80 000
    });

    it("reports complete data when all orders have costPriceUzs", () => {
      const orders: RawSalesOrder[] = [
        {
          id: 1,
          titleRu: "Product 1",
          priceUsdt: 50000,
          priceUzs: 50000,
          costPriceUzs: 20000,
          status: "delivered",
          createdAt: new Date(),
        },
      ];
      const metrics = calculateSalesMetrics(orders);
      expect(metrics.incompleteCostOrders).toBe(0);
      expect(metrics.hasIncompleteData).toBe(false);
      expect(metrics.grossProfit).toBe(30000);
      expect(metrics.totalLoss).toBe(0);
    });
  });

  describe("groupSalesByDay", () => {
    it("aggregates orders by day in descending order with full metrics", () => {
      const orders: RawSalesOrder[] = [
        {
          id: 1,
          titleRu: "Product A",
          priceUsdt: 50000,
          priceUzs: 50000,
          costPriceUzs: 20000,
          status: "delivered",
          createdAt: new Date("2026-09-19T10:00:00+05:00"),
        },
        {
          id: 2,
          titleRu: "Product B ×2",
          priceUsdt: 100000,
          priceUzs: 100000,
          costPriceUzs: 60000,
          status: "delivered",
          createdAt: new Date("2026-09-20T10:00:00+05:00"),
        },
        {
          id: 3,
          titleRu: "Product C",
          priceUsdt: 40000,
          priceUzs: 40000,
          costPriceUzs: null,
          status: "completed",
          createdAt: new Date("2026-09-20T12:00:00+05:00"),
        },
      ];

      const days = groupSalesByDay(orders);

      expect(days.length).toBe(2);
      expect(days[0].dateKey).toBe("2026-09-20");
      expect(days[0].ordersCount).toBe(2);
      expect(days[0].itemsCount).toBe(3);
      expect(days[0].revenue).toBe(140000);
      expect(days[0].cost).toBe(60000);
      expect(days[0].profit).toBe(80000);
      expect(days[0].unknownCostOrders).toBe(1);

      expect(days[1].dateKey).toBe("2026-09-19");
      expect(days[1].ordersCount).toBe(1);
      expect(days[1].revenue).toBe(50000);
      expect(days[1].cost).toBe(20000);
    });
  });

  describe("groupSalesByProduct", () => {
    it("groups products and assigns badges: top seller, top profit, loss making and missing cost", () => {
      const orders: RawSalesOrder[] = [
        // Product A: 2 sales, 3 items, profitable
        {
          id: 1,
          titleRu: "Gemini Pro",
          priceUsdt: 60000,
          priceUzs: 60000,
          costPriceUzs: 20000,
          status: "delivered",
          createdAt: new Date(),
        },
        {
          id: 2,
          titleRu: "Gemini Pro",
          priceUsdt: 60000,
          priceUzs: 60000,
          costPriceUzs: 20000,
          status: "delivered",
          createdAt: new Date(),
        },
        // Product B: 1 sale, loss
        {
          id: 3,
          titleRu: "Cheap Product",
          priceUsdt: 20000,
          priceUzs: 20000,
          costPriceUzs: 35000,
          status: "delivered",
          createdAt: new Date(),
        },
        // Product C: 1 sale, missing cost
        {
          id: 4,
          titleRu: "Unknown Cost Product",
          priceUsdt: 80000,
          priceUzs: 80000,
          costPriceUzs: null,
          status: "delivered",
          createdAt: new Date(),
        },
      ];

      const products = groupSalesByProduct(orders);
      expect(products.length).toBe(3);

      const gemini = products.find((p) => p.title === "Gemini Pro");
      expect(gemini).toBeDefined();
      expect(gemini?.ordersCount).toBe(2);
      expect(gemini?.revenue).toBe(120000);
      expect(gemini?.cost).toBe(40000);
      expect(gemini?.profit).toBe(80000);
      expect(gemini?.avgPrice).toBe(60000);
      expect(gemini?.profitMarginPct).toBe(Math.round((80000 / 120000) * 100)); // 67%
      expect(gemini?.isTopSeller).toBe(true);
      expect(gemini?.isTopProfit).toBe(true);
      expect(gemini?.isLossMaking).toBe(false);

      const cheap = products.find((p) => p.title === "Cheap Product");
      expect(cheap).toBeDefined();
      expect(cheap?.isLossMaking).toBe(true);
      expect(cheap?.lossOrdersCount).toBe(1);

      const unk = products.find((p) => p.title === "Unknown Cost Product");
      expect(unk).toBeDefined();
      expect(unk?.isMissingCost).toBe(true);
      expect(unk?.unknownCostCount).toBe(1);
    });
  });
});
