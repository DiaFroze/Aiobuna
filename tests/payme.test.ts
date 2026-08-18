import { describe, it, expect, beforeEach } from "vitest";
import {
  handlePayme,
  PaymeError,
  PaymeState,
  sumToTiyin,
  buildCheckoutUrl,
  TRANSACTION_TIMEOUT_MS,
  type PaymeRepo,
  type TxnView,
} from "../src/lib/domain/payme";

// In-memory PaymeRepo mirroring the Prisma adapter's contract. Money lives in
// `balances`; performTxn is the only thing that moves it, so tests can assert
// "credited exactly once" and "callback/redirect never credits".
class FakeRepo implements PaymeRepo {
  clock = 1_700_000_000_000;
  topups = new Map<number, { amountTiyin: number; payable: boolean; spent?: boolean }>();
  txns = new Map<string, TxnView>();
  balances = new Map<number, number>(); // topUpId -> сум credited
  performCount = new Map<string, number>();

  now() { return this.clock; }

  async findTopUp(topUpId: number) {
    const t = this.topups.get(topUpId);
    return t ? { topUpId, amountTiyin: t.amountTiyin, payable: t.payable } : null;
  }
  async findTxnByPaymeId(paymeId: string) { return this.txns.get(paymeId) ?? null; }
  async findTxnByTopUp(topUpId: number) {
    for (const t of this.txns.values()) if (t.topUpId === topUpId) return t;
    return null;
  }
  async createTxn(input: { paymeId: string; topUpId: number; amountTiyin: number; createTime: number }) {
    const txn: TxnView = {
      paymeId: input.paymeId, topUpId: input.topUpId, amountTiyin: input.amountTiyin,
      state: PaymeState.CREATED, createTime: input.createTime, performTime: 0, cancelTime: 0, reason: null,
    };
    this.txns.set(txn.paymeId, txn);
    return txn;
  }
  async performTxn(paymeId: string, performTime: number) {
    const txn = this.txns.get(paymeId)!;
    // Guard mirrors the Prisma `updateMany where state=CREATED`: credit once.
    this.performCount.set(paymeId, (this.performCount.get(paymeId) ?? 0) + 1);
    if (txn.state === PaymeState.CREATED) {
      txn.state = PaymeState.PERFORMED;
      txn.performTime = performTime;
      const tu = this.topups.get(txn.topUpId)!;
      tu.payable = false;
      this.balances.set(txn.topUpId, (this.balances.get(txn.topUpId) ?? 0) + tu.amountTiyin / 100);
    }
    return txn;
  }
  async cancelCreated(paymeId: string, cancelTime: number, reason: number | null) {
    const txn = this.txns.get(paymeId)!;
    txn.state = PaymeState.CANCELLED; txn.cancelTime = cancelTime; txn.reason = reason;
    const tu = this.topups.get(txn.topUpId); if (tu) tu.payable = false;
    return txn;
  }
  async cancelPerformed(paymeId: string, cancelTime: number, reason: number | null) {
    const txn = this.txns.get(paymeId)!;
    const tu = this.topups.get(txn.topUpId)!;
    if (tu.spent) return null; // balance already used → not auto-refundable
    txn.state = PaymeState.CANCELLED_AFTER_PERFORM; txn.cancelTime = cancelTime; txn.reason = reason;
    this.balances.set(txn.topUpId, (this.balances.get(txn.topUpId) ?? 0) - tu.amountTiyin / 100);
    return txn;
  }
  async listByRange(fromMs: number, toMs: number) {
    return [...this.txns.values()].filter((t) => t.createTime >= fromMs && t.createTime <= toMs);
  }
}

const AMOUNT_TIYIN = 5_000_000; // 50 000 сум
let repo: FakeRepo;
beforeEach(() => {
  repo = new FakeRepo();
  repo.topups.set(1, { amountTiyin: AMOUNT_TIYIN, payable: true });
});

const call = (method: string, params: any, id: any = 1, auth = true) =>
  handlePayme({ jsonrpc: "2.0", id, method, params }, repo, auth);
const isErr = (r: any): r is { error: { code: number; data?: string } } => "error" in r;
const isOk = (r: any): r is { result: any } => "result" in r;

describe("money helpers", () => {
  it("converts сум to tiyin as integers without float drift", () => {
    expect(sumToTiyin(50000)).toBe(5_000_000);
    expect(sumToTiyin(10000.1)).toBe(1_000_010);
    expect(Number.isInteger(sumToTiyin(33333.33))).toBe(true);
  });
  it("builds a base64 checkout URL with merchant, account and tiyin amount", () => {
    const url = buildCheckoutUrl({ checkoutBase: "https://checkout.paycom.uz", merchantId: "M1", topUpId: 7, amountTiyin: 5_000_000 });
    const decoded = Buffer.from(url.split("/").pop()!, "base64").toString("utf8");
    expect(decoded).toBe("m=M1;ac.topup_id=7;a=5000000");
  });
});

describe("auth", () => {
  it("rejects an unauthorized request with -32504", async () => {
    const r = await call("CheckPerformTransaction", { amount: AMOUNT_TIYIN, account: { topup_id: 1 } }, 1, false);
    expect(isErr(r) && r.error.code).toBe(PaymeError.INSUFFICIENT_PRIVILEGE);
  });
  it("rejects an unknown method", async () => {
    const r = await call("Nope", {});
    expect(isErr(r) && r.error.code).toBe(PaymeError.METHOD_NOT_FOUND);
  });
});

describe("CheckPerformTransaction", () => {
  it("allows a valid, payable top-up", async () => {
    const r = await call("CheckPerformTransaction", { amount: AMOUNT_TIYIN, account: { topup_id: 1 } });
    expect(isOk(r) && r.result).toEqual({ allow: true });
  });
  it("rejects a wrong amount with -31001", async () => {
    const r = await call("CheckPerformTransaction", { amount: 999, account: { topup_id: 1 } });
    expect(isErr(r) && r.error.code).toBe(PaymeError.WRONG_AMOUNT);
  });
  it("rejects a nonexistent top-up with an account error naming the field", async () => {
    const r = await call("CheckPerformTransaction", { amount: AMOUNT_TIYIN, account: { topup_id: 999 } });
    expect(isErr(r) && r.error.code).toBe(PaymeError.ACCOUNT_NOT_FOUND);
    expect(isErr(r) && r.error.data).toBe("topup_id");
  });
  it("rejects an already-paid top-up as not payable", async () => {
    repo.topups.get(1)!.payable = false;
    const r = await call("CheckPerformTransaction", { amount: AMOUNT_TIYIN, account: { topup_id: 1 } });
    expect(isErr(r) && r.error.code).toBe(PaymeError.ACCOUNT_NOT_PAYABLE);
  });
});

describe("CreateTransaction", () => {
  const create = (paymeId: string, extra: any = {}) =>
    call("CreateTransaction", { id: paymeId, time: repo.now(), amount: AMOUNT_TIYIN, account: { topup_id: 1 }, ...extra });

  it("creates a transaction in state CREATED", async () => {
    const r = await create("A");
    expect(isOk(r) && r.result.state).toBe(PaymeState.CREATED);
    expect(isOk(r) && r.result.transaction).toBe("A");
  });
  it("is idempotent for a repeated CreateTransaction with the same id", async () => {
    const first = await create("A");
    const second = await create("A");
    expect(second).toEqual(first);
    expect(repo.txns.size).toBe(1);
  });
  it("rejects a second Payme id for the same top-up (conflict)", async () => {
    await create("A");
    const r = await create("B");
    expect(isErr(r) && r.error.code).toBe(PaymeError.CANT_PERFORM);
  });
  it("rejects a wrong amount", async () => {
    const r = await create("A", { amount: 123 });
    expect(isErr(r) && r.error.code).toBe(PaymeError.WRONG_AMOUNT);
  });
  it("rejects creation whose time is older than the timeout window", async () => {
    const r = await create("A", { time: repo.now() - TRANSACTION_TIMEOUT_MS - 1 });
    expect(isErr(r) && r.error.code).toBe(PaymeError.CANT_PERFORM);
  });
  it("does not credit any balance on create", async () => {
    await create("A");
    expect(repo.balances.get(1) ?? 0).toBe(0);
  });
});

describe("PerformTransaction", () => {
  const create = () => call("CreateTransaction", { id: "A", time: repo.now(), amount: AMOUNT_TIYIN, account: { topup_id: 1 } });

  it("performs a created transaction and credits the balance once", async () => {
    await create();
    const r = await call("PerformTransaction", { id: "A" });
    expect(isOk(r) && r.result.state).toBe(PaymeState.PERFORMED);
    expect(repo.balances.get(1)).toBe(50000);
  });
  it("is idempotent — a repeated Perform does not credit twice", async () => {
    await create();
    const first = await call("PerformTransaction", { id: "A" });
    const second = await call("PerformTransaction", { id: "A" });
    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    expect((first as any).result).toEqual((second as any).result);
    expect(repo.balances.get(1)).toBe(50000); // still one credit
  });
  it("rejects an unknown transaction with -31003", async () => {
    const r = await call("PerformTransaction", { id: "ghost" });
    expect(isErr(r) && r.error.code).toBe(PaymeError.TRANSACTION_NOT_FOUND);
  });
  it("refuses to perform an expired created transaction and cancels it", async () => {
    await create();
    repo.clock += TRANSACTION_TIMEOUT_MS + 1;
    const r = await call("PerformTransaction", { id: "A" });
    expect(isErr(r) && r.error.code).toBe(PaymeError.CANT_PERFORM);
    expect(repo.txns.get("A")!.state).toBe(PaymeState.CANCELLED);
    expect(repo.balances.get(1) ?? 0).toBe(0);
  });

  it("credits exactly once under two concurrent Perform calls", async () => {
    await create();
    const [a, b] = await Promise.all([
      call("PerformTransaction", { id: "A" }),
      call("PerformTransaction", { id: "A" }),
    ]);
    expect(isOk(a) && a.result.state).toBe(PaymeState.PERFORMED);
    expect(isOk(b) && b.result.state).toBe(PaymeState.PERFORMED);
    // Even if performTxn ran twice, the state guard means one credit.
    expect(repo.balances.get(1)).toBe(50000);
  });
});

describe("CancelTransaction", () => {
  const create = () => call("CreateTransaction", { id: "A", time: repo.now(), amount: AMOUNT_TIYIN, account: { topup_id: 1 } });

  it("cancels a created transaction to state -1", async () => {
    await create();
    const r = await call("CancelTransaction", { id: "A", reason: 3 });
    expect(isOk(r) && r.result.state).toBe(PaymeState.CANCELLED);
  });
  it("is idempotent for a repeated cancel", async () => {
    await create();
    const first = await call("CancelTransaction", { id: "A", reason: 3 });
    const second = await call("CancelTransaction", { id: "A", reason: 3 });
    expect(first).toEqual(second);
  });
  it("refunds a performed transaction to -2 when the balance is untouched", async () => {
    await create();
    await call("PerformTransaction", { id: "A" });
    const r = await call("CancelTransaction", { id: "A", reason: 5 });
    expect(isOk(r) && r.result.state).toBe(PaymeState.CANCELLED_AFTER_PERFORM);
    expect(repo.balances.get(1)).toBe(0); // reversed
  });
  it("refuses to cancel a performed transaction whose balance was already spent (-31007)", async () => {
    await create();
    await call("PerformTransaction", { id: "A" });
    repo.topups.get(1)!.spent = true; // customer already used the balance
    const r = await call("CancelTransaction", { id: "A", reason: 5 });
    expect(isErr(r) && r.error.code).toBe(PaymeError.CANT_CANCEL_COMPLETED);
  });
  it("rejects cancelling an unknown transaction with -31003", async () => {
    const r = await call("CancelTransaction", { id: "ghost", reason: 1 });
    expect(isErr(r) && r.error.code).toBe(PaymeError.TRANSACTION_NOT_FOUND);
  });
});

describe("CheckTransaction", () => {
  const create = () => call("CreateTransaction", { id: "A", time: repo.now(), amount: AMOUNT_TIYIN, account: { topup_id: 1 } });

  it("reports a pending transaction", async () => {
    await create();
    const r = await call("CheckTransaction", { id: "A" });
    expect(isOk(r) && r.result.state).toBe(PaymeState.CREATED);
    expect(isOk(r) && r.result.perform_time).toBe(0);
  });
  it("reports a performed transaction with its perform_time", async () => {
    await create();
    await call("PerformTransaction", { id: "A" });
    const r = await call("CheckTransaction", { id: "A" });
    expect(isOk(r) && r.result.state).toBe(PaymeState.PERFORMED);
    expect(isOk(r) && r.result.perform_time).toBeGreaterThan(0);
  });
  it("reports a cancelled transaction with its reason", async () => {
    await create();
    await call("CancelTransaction", { id: "A", reason: 3 });
    const r = await call("CheckTransaction", { id: "A" });
    expect(isOk(r) && r.result.state).toBe(PaymeState.CANCELLED);
    expect(isOk(r) && r.result.reason).toBe(3);
  });
  it("rejects an unknown transaction with -31003", async () => {
    const r = await call("CheckTransaction", { id: "ghost" });
    expect(isErr(r) && r.error.code).toBe(PaymeError.TRANSACTION_NOT_FOUND);
  });
});
