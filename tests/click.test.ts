import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  handleClick,
  buildClickUrl,
  ClickError,
  ClickAction,
  type ClickRepo,
  type ClickTopUp,
  type ClickParams,
} from "../src/lib/domain/click";

const KEY = "test_secret_key";
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

// In-memory ClickRepo. Money lives in `credited`; complete() is the only thing
// that moves it, so tests can assert "credited exactly once".
class FakeRepo implements ClickRepo {
  topups = new Map<number, ClickTopUp>();
  credited = new Map<number, number>();
  completeCount = new Map<number, number>();

  async findTopUp(id: number) { return this.topups.get(id) ?? null; }
  async savePrepare(id: number, ctid: string) {
    const t = this.topups.get(id); if (t) t.clickTransId = ctid;
  }
  async complete(id: number, _ctid: string) {
    this.completeCount.set(id, (this.completeCount.get(id) ?? 0) + 1);
    const t = this.topups.get(id)!;
    if (t.status === "approved") return "already" as const;
    t.status = "approved";
    this.credited.set(id, (this.credited.get(id) ?? 0) + t.amountSum);
    return "ok" as const;
  }
  async cancel(id: number, _ctid: string) {
    const t = this.topups.get(id); if (t) t.status = "rejected";
  }
}

let repo: FakeRepo;
beforeEach(() => {
  repo = new FakeRepo();
  repo.topups.set(42, { topUpId: 42, amountSum: 1000, status: "pending", clickTransId: null });
});

// Build a signed params object the way Click would.
function signedPrepare(over: Partial<ClickParams> = {}): ClickParams {
  const p: ClickParams = {
    click_trans_id: "111", service_id: "999", merchant_trans_id: "42",
    amount: "1000.00", action: "0", sign_time: "2026-01-01 00:00:00", ...over,
  };
  // Only compute a valid signature when the test didn't supply its own.
  if (over.sign_string === undefined) {
    p.sign_string = md5(`${p.click_trans_id}${p.service_id}${KEY}${p.merchant_trans_id}${p.amount}${p.action}${p.sign_time}`);
  }
  return p;
}
function signedComplete(over: Partial<ClickParams> = {}): ClickParams {
  const p: ClickParams = {
    click_trans_id: "111", service_id: "999", merchant_trans_id: "42", merchant_prepare_id: "42",
    amount: "1000.00", action: "1", error: "0", sign_time: "2026-01-01 00:00:01", ...over,
  };
  if (over.sign_string === undefined) {
    p.sign_string = md5(`${p.click_trans_id}${p.service_id}${KEY}${p.merchant_trans_id}${p.merchant_prepare_id}${p.amount}${p.action}${p.sign_time}`);
  }
  return p;
}

describe("signature", () => {
  it("rejects a wrong signature with -1", async () => {
    const p = signedPrepare({ sign_string: "deadbeef" });
    const r = await handleClick(p, KEY, repo);
    expect(r.error).toBe(ClickError.SIGN_FAILED);
  });
  it("rejects everything when the secret key is empty", async () => {
    const r = await handleClick(signedPrepare(), "", repo);
    expect(r.error).toBe(ClickError.SIGN_FAILED);
  });
});

describe("Prepare", () => {
  it("accepts a valid pending order and returns merchant_prepare_id", async () => {
    const r = await handleClick(signedPrepare(), KEY, repo);
    expect(r.error).toBe(ClickError.SUCCESS);
    expect(r.merchant_prepare_id).toBe("42");
    expect(repo.topups.get(42)!.clickTransId).toBe("111");
  });
  it("rejects a nonexistent order with -5", async () => {
    const r = await handleClick(signedPrepare({ merchant_trans_id: "9999" }), KEY, repo);
    expect(r.error).toBe(ClickError.ORDER_NOT_FOUND);
  });
  it("rejects a wrong amount with -2", async () => {
    const r = await handleClick(signedPrepare({ amount: "500.00" }), KEY, repo);
    expect(r.error).toBe(ClickError.INVALID_AMOUNT);
  });
  it("rejects an already-paid order with -4", async () => {
    repo.topups.get(42)!.status = "approved";
    const r = await handleClick(signedPrepare(), KEY, repo);
    expect(r.error).toBe(ClickError.ALREADY_PAID);
  });
  it("does not credit any balance", async () => {
    await handleClick(signedPrepare(), KEY, repo);
    expect(repo.credited.get(42) ?? 0).toBe(0);
  });
});

describe("Complete", () => {
  const prepareFirst = () => handleClick(signedPrepare(), KEY, repo);

  it("completes a prepared order and credits the balance once", async () => {
    await prepareFirst();
    const r = await handleClick(signedComplete(), KEY, repo);
    expect(r.error).toBe(ClickError.SUCCESS);
    expect(r.merchant_confirm_id).toBe("42");
    expect(repo.credited.get(42)).toBe(1000);
  });
  it("is idempotent — a repeat Complete does not credit twice", async () => {
    await prepareFirst();
    await handleClick(signedComplete(), KEY, repo);
    const second = await handleClick(signedComplete(), KEY, repo);
    expect(second.error).toBe(ClickError.SUCCESS);
    expect(repo.credited.get(42)).toBe(1000);
  });
  it("rejects a Complete whose prepare_id doesn't match with -6", async () => {
    await prepareFirst();
    const r = await handleClick(signedComplete({ merchant_prepare_id: "77" }), KEY, repo);
    expect(r.error).toBe(ClickError.TXN_NOT_FOUND);
  });
  it("rejects a Complete for a click_trans_id that never prepared with -6", async () => {
    await prepareFirst();
    const r = await handleClick(signedComplete({ click_trans_id: "222" }), KEY, repo);
    expect(r.error).toBe(ClickError.TXN_NOT_FOUND);
  });
  it("cancels our side when Click reports its own failure", async () => {
    await prepareFirst();
    // A negative error must be signed with THAT error value.
    const p = signedComplete({ error: "-5000" });
    const r = await handleClick(p, KEY, repo);
    expect(r.error).toBe(ClickError.CANCELLED);
    expect(repo.topups.get(42)!.status).toBe("rejected");
    expect(repo.credited.get(42) ?? 0).toBe(0);
  });
});

describe("buildClickUrl", () => {
  it("builds a my.click.uz pay URL with service, merchant, amount and order", () => {
    const url = buildClickUrl({ serviceId: "S", merchantId: "M", topUpId: 42, amountSum: 1000 });
    expect(url).toContain("https://my.click.uz/services/pay?");
    expect(url).toContain("service_id=S");
    expect(url).toContain("merchant_id=M");
    expect(url).toContain("amount=1000");
    expect(url).toContain("transaction_param=42");
  });
});
