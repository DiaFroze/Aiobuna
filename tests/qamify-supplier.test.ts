import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sourceBalance,
  sourceProducts,
  sourceOrder,
  envQamifySource,
  type Source,
} from "../src/lib/supplier";

describe("Qamify Supplier Integration", () => {
  const qamifySource: Source = {
    slug: "qamify",
    baseUrl: "https://api.qamify.site",
    apiKey: "test-qamify-key-123",
    format: "qamify",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sourceBalance fetches balance and parses numeric response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (url, init) => {
      expect(String(url)).toBe("https://api.qamify.site/v1/balance");
      const headers = (init?.headers as Record<string, string>) || {};
      expect(headers["Authorization"]).toBe("Bearer test-qamify-key-123");
      expect(headers["X-API-Key"]).toBe("test-qamify-key-123");
      return new Response(JSON.stringify({ balance: 42.5 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const balance = await sourceBalance(qamifySource);
    expect(balance).toBe(42.5);
  });

  it("sourceProducts parses products list with stock, prices, and clean descriptions", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (url) => {
      expect(String(url)).toBe("https://api.qamify.site/v1/products");
      return new Response(
        JSON.stringify({
          products: [
            {
              id: 101,
              name: "Gemini Advanced 1 Month",
              price: 4.8,
              stock: 25,
              available: true,
              category: "AI",
              manual_delivery: false,
            },
            {
              id: 102,
              name: "ChatGPT Plus 1 Month",
              price: 8.5,
              stock: 0,
              available: false,
              category: "AI",
              manual_delivery: false,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const products = await sourceProducts(qamifySource);
    expect(products.length).toBe(2);
    expect(products[0]).toMatchObject({
      id: "101",
      name: "Gemini Advanced 1 Month",
      price: 4.8,
      stock: 25,
      available: true,
      apiOrderable: true,
    });
    expect(products[1]).toMatchObject({
      id: "102",
      name: "ChatGPT Plus 1 Month",
      price: 8.5,
      stock: 0,
      available: false,
      apiOrderable: true,
    });
  });

  it("sourceOrder sends Idempotency-Key and extracts delivery credentials correctly", async () => {
    let capturedHeaders: any = null;
    let capturedBody: any = null;

    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (url, init) => {
      expect(String(url)).toBe("https://api.qamify.site/v1/orders");
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          status: "completed",
          order: {
            id: 9999,
            keys: ["KEY-ABCD-1234-EFGH", "KEY-WXYZ-5678-IJKL"],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const res = await sourceOrder(qamifySource, "101", 1, "order-abc-123");
    expect(capturedHeaders["Idempotency-Key"]).toBe("order-order-abc-123");
    expect(capturedBody.product_id).toBe(101);
    expect(capturedBody.idempotency_key).toBe("order-order-abc-123");
    expect(res.status).toBe("completed");
    expect(res.payload).toContain("KEY-ABCD-1234-EFGH\nKEY-WXYZ-5678-IJKL");
  });

  it("extracts account credentials from Qamify order ignoring order.code tracking reference", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      return new Response(
        JSON.stringify({
          status: "success",
          order: {
            id: 1047,
            code: "RA-5588C8F82B",
            product_id: 123,
            keys: [
              "Email: ShamikaRexroat52591@outlook.com\nPassword: masuk123",
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const res = await sourceOrder(qamifySource, "123", 1, "order-1047");
    // Crucial check: order reference code RA-... must NOT be returned as goods
    expect(res.payload).not.toContain("RA-5588C8F82B");
    expect(res.payload).toContain("ShamikaRexroat52591@outlook.com");
    expect(res.payload).toContain("masuk123");
  });


  it("envQamifySource picks up environment variables", () => {
    const originalEnv = { ...process.env };
    try {
      process.env.QAMIFY_API_KEY = "env-secret-qamify-key";
      process.env.QAMIFY_API_URL = "https://custom.qamify.site";
      const src = envQamifySource();
      expect(src).not.toBeNull();
      expect(src?.apiKey).toBe("env-secret-qamify-key");
      expect(src?.baseUrl).toBe("https://custom.qamify.site");
      expect(src?.slug).toBe("qamify");
      expect(src?.format).toBe("qamify");
    } finally {
      process.env = originalEnv;
    }
  });
});
