import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getPrices,
  getWallet,
  getUser,
  getOrder,
  createStarsOrder,
  createPremiumOrder,
  describeFailure,
  redact,
} from "../src/lib/fragment/api-client";

const CFG = { jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.PAYLOAD.SIGNATURE" };

/** Capture what the client sends, and reply with whatever the test wants. */
function mockFetch(reply: { status?: number; body?: unknown } | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (reply instanceof Error) throw reply;
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      text: async () => (reply.body === undefined ? "" : JSON.stringify(reply.body)),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("authentication", () => {
  it("sends the vendor's exact scheme: 'JWT <token>', never Bearer", () => {
    const calls = mockFetch({ body: { balances: [] } });
    return getWallet(CFG).then(() => {
      const auth = (calls[0].init.headers as Record<string, string>).Authorization;
      expect(auth).toBe(`JWT ${CFG.jwt}`);
      expect(auth.startsWith("Bearer")).toBe(false);
    });
  });

  it("refuses an authenticated call when no JWT is configured", async () => {
    const calls = mockFetch({ body: {} });
    const res = await getWallet({ jwt: "" });
    expect(res.ok).toBe(false);
    // It must not even reach the network without a credential.
    expect(calls).toHaveLength(0);
  });

  it("calls prices without any Authorization header", async () => {
    const calls = mockFetch({ body: { stars: [], premium: [] } });
    await getPrices();
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("credentials never leak into diagnostics", () => {
  it("redacts JWTs from arbitrary text", () => {
    expect(redact("Authorization: JWT eyJabc.def.ghi")).not.toContain("eyJabc");
    expect(redact("token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toContain("[redacted-jwt]");
    expect(redact("Bearer sk_live_123456")).toContain("[redacted]");
  });

  it("keeps the token out of a transport-failure message", async () => {
    mockFetch(new Error(`connect failed while sending JWT ${CFG.jwt}`));
    const res = await getWallet(CFG);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const text = describeFailure(res.failure);
      expect(text).not.toContain(CFG.jwt);
      expect(text).not.toContain("eyJhbGci");
    }
  });

  it("keeps the token out of an http-failure body", async () => {
    mockFetch({ status: 403, body: { detail: `bad token JWT ${CFG.jwt}` } });
    const res = await getOrder(CFG, "abc");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(describeFailure(res.failure)).not.toContain(CFG.jwt);
  });
});

describe("request shapes match the vendor schema", () => {
  it("posts Stars to /v1/order/stars/ with the documented body", async () => {
    const calls = mockFetch({ body: { id: "uuid-1", status: "COMPLETED" } });
    await createStarsOrder(CFG, { username: "durov", quantity: 50, currency: "ton" });

    expect(calls[0].url).toBe("https://api.fragment-api.com/v1/order/stars/");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      username: "durov", quantity: 50, currency: "ton",
    });
  });

  it("posts Premium to /v1/order/premium/ with months", async () => {
    const calls = mockFetch({ body: { id: "uuid-2", status: "PENDING" } });
    await createPremiumOrder(CFG, { username: "durov", months: 3 });

    expect(calls[0].url).toBe("https://api.fragment-api.com/v1/order/premium/");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ username: "durov", months: 3 });
  });

  it("escapes the username in a lookup", async () => {
    const calls = mockFetch({ body: { username: "x" } });
    await getUser(CFG, "weird name/../x");
    expect(calls[0].url).toContain(encodeURIComponent("weird name/../x"));
  });

  it("reads an order by id", async () => {
    const calls = mockFetch({ body: { id: "abc", status: "PENDING" } });
    await getOrder(CFG, "abc");
    expect(calls[0].url).toBe("https://api.fragment-api.com/v1/order/abc/");
    expect(calls[0].init.method).toBe("GET");
  });
});

describe("failures are returned, never thrown", () => {
  it("reports a transport failure when there is no response", async () => {
    mockFetch(new Error("The operation was aborted due to timeout"));
    const res = await createStarsOrder(CFG, { username: "durov", quantity: 50 });
    expect(res.ok).toBe(false);
    // Distinguishing this from an http rejection is what stops a double purchase.
    if (!res.ok) expect(res.failure.kind).toBe("transport");
  });

  it("reports an http failure with its status", async () => {
    mockFetch({ status: 400, body: { errors: [{ error: "Recipient username was not found" }] } });
    const res = await createStarsOrder(CFG, { username: "nobody", quantity: 50 });
    expect(res.ok).toBe(false);
    if (!res.ok && res.failure.kind === "http") {
      expect(res.failure.status).toBe(400);
      expect(describeFailure(res.failure)).toMatch(/not found/);
    }
  });

  it("returns parsed data on success", async () => {
    mockFetch({ body: { balances: [{ currency: "ton", amount: "12.5" }] } });
    const res = await getWallet(CFG);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.balances[0]).toEqual({ currency: "ton", amount: "12.5" });
  });

  it("survives a non-JSON body instead of crashing", async () => {
    mockFetch({ status: 502, body: undefined });
    const res = await getWallet(CFG);
    expect(res.ok).toBe(false);
  });
});
