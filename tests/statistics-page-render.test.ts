import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import React from "react";
import StatisticsPage from "@/app/admin/(protected)/statistics/page";

describe("StatisticsPage Server Component", () => {
  it("renders with default all-time period", async () => {
    const page = await StatisticsPage({ searchParams: {} });
    expect(page).toBeDefined();
    expect(React.isValidElement(page)).toBe(true);
  });

  it("renders with today filter", async () => {
    const page = await StatisticsPage({ searchParams: { period: "today" } });
    expect(page).toBeDefined();
    expect(React.isValidElement(page)).toBe(true);
  });

  it("renders with 7d filter", async () => {
    const page = await StatisticsPage({ searchParams: { period: "7d" } });
    expect(page).toBeDefined();
    expect(React.isValidElement(page)).toBe(true);
  });

  it("renders with 30d filter", async () => {
    const page = await StatisticsPage({ searchParams: { period: "30d" } });
    expect(page).toBeDefined();
    expect(React.isValidElement(page)).toBe(true);
  });

  it("renders with custom date range filter", async () => {
    const page = await StatisticsPage({
      searchParams: {
        period: "custom",
        from: "2026-09-01",
        to: "2026-09-21",
      },
    });
    expect(page).toBeDefined();
    expect(React.isValidElement(page)).toBe(true);
  });

  it("renders with future date range when no sales exist", async () => {
    const page = await StatisticsPage({
      searchParams: {
        period: "custom",
        from: "2030-01-01",
        to: "2030-01-02",
      },
    });
    expect(page).toBeDefined();
    expect(React.isValidElement(page)).toBe(true);
  });
});
