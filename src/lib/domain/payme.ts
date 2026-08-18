// Payme Merchant API — pure protocol core.
//
// This module contains NO database or HTTP code. It implements the JSON-RPC
// dispatch and the transaction state machine over a small `PaymeRepo`
// interface, so the whole protocol can be unit-tested against an in-memory
// repo. The Prisma-backed repo and the HTTP route are thin shells around it
// (src/lib/services/payme-repo.ts, src/app/api/payme/route.ts).
//
// Grounded against the official docs (developer.help.paycom.uz): JSON-RPC 2.0,
// amounts in TIYIN, transaction states 1/2/-1/-2, and the error codes below.
// A few edge codes (account sub-codes, the 12h timeout) follow the widely used
// Payme convention and are called out in docs/PAYME_SETUP.md to confirm against
// the sandbox test suite.

// ---- error codes (from the Payme protocol) ------------------------------
export const PaymeError = {
  // JSON-RPC transport
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  // Auth
  INSUFFICIENT_PRIVILEGE: -32504,
  // Business
  WRONG_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  CANT_CANCEL_COMPLETED: -31007, // goods irreversibly delivered
  CANT_PERFORM: -31008,
  // Account-field errors must sit in -31050..-31099 with `data` = field name.
  ACCOUNT_NOT_FOUND: -31050,
  ACCOUNT_NOT_PAYABLE: -31051,
} as const;

// ---- transaction states (Payme canonical) -------------------------------
export const PaymeState = {
  CREATED: 1,
  PERFORMED: 2,
  CANCELLED: -1, // cancelled while still in CREATED
  CANCELLED_AFTER_PERFORM: -2, // cancelled/refunded after PERFORMED
} as const;

// A transaction that stays in CREATED longer than this is considered expired.
export const TRANSACTION_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h

const ACCOUNT_FIELD = "topup_id"; // Payme checkout account[topup_id]

// Localized messages — Payme shows these to the payer, so all three languages.
type Msg = { ru: string; uz: string; en: string };
function msg(ru: string, uz: string, en: string): Msg {
  return { ru, uz, en };
}
const MESSAGES: Record<number, Msg> = {
  [PaymeError.INSUFFICIENT_PRIVILEGE]: msg("Недостаточно привилегий", "Ruxsat yetarli emas", "Insufficient privilege"),
  [PaymeError.WRONG_AMOUNT]: msg("Неверная сумма", "Noto'g'ri summa", "Wrong amount"),
  [PaymeError.TRANSACTION_NOT_FOUND]: msg("Транзакция не найдена", "Tranzaksiya topilmadi", "Transaction not found"),
  [PaymeError.CANT_CANCEL_COMPLETED]: msg("Заказ выполнен, отмена невозможна", "Buyurtma bajarilgan, bekor qilib bo'lmaydi", "Order completed, cannot cancel"),
  [PaymeError.CANT_PERFORM]: msg("Невозможно выполнить операцию", "Operatsiyani bajarib bo'lmaydi", "Unable to perform operation"),
  [PaymeError.ACCOUNT_NOT_FOUND]: msg("Пополнение не найдено", "To'ldirish topilmadi", "Top-up not found"),
  [PaymeError.ACCOUNT_NOT_PAYABLE]: msg("Пополнение уже оплачено или отменено", "To'ldirish allaqachon to'langan yoki bekor qilingan", "Top-up already paid or cancelled"),
  [PaymeError.METHOD_NOT_FOUND]: msg("Метод не найден", "Metod topilmadi", "Method not found"),
  [PaymeError.INVALID_REQUEST]: msg("Неверный запрос", "Noto'g'ri so'rov", "Invalid request"),
};

// ---- repository interface (implemented by Prisma or an in-memory fake) ----
export type TopUpView = {
  topUpId: number;
  amountTiyin: number; // authoritative expected amount, integer tiyin
  payable: boolean; // pending and not expired/cancelled
};
export type TxnView = {
  paymeId: string;
  topUpId: number;
  amountTiyin: number;
  state: number;
  createTime: number;
  performTime: number;
  cancelTime: number;
  reason: number | null;
};

export interface PaymeRepo {
  now(): number;
  findTopUp(topUpId: number): Promise<TopUpView | null>;
  findTxnByPaymeId(paymeId: string): Promise<TxnView | null>;
  findTxnByTopUp(topUpId: number): Promise<TxnView | null>;
  createTxn(input: { paymeId: string; topUpId: number; amountTiyin: number; createTime: number }): Promise<TxnView>;
  // Atomic: state CREATED->PERFORMED + mark TopUp approved + credit balance.
  // Must be idempotent-safe (caller only invokes on a CREATED txn) and use a
  // DB transaction with row locking.
  performTxn(paymeId: string, performTime: number): Promise<TxnView>;
  // Cancel a CREATED txn (state -> -1).
  cancelCreated(paymeId: string, cancelTime: number, reason: number | null): Promise<TxnView>;
  // Cancel/refund a PERFORMED txn. Returns null if the balance was already
  // spent and cannot be auto-refunded (caller then returns CANT_CANCEL_COMPLETED).
  cancelPerformed(paymeId: string, cancelTime: number, reason: number | null): Promise<TxnView | null>;
  listByRange(fromMs: number, toMs: number): Promise<TxnView[]>;
}

// ---- JSON-RPC helpers ----------------------------------------------------
type Id = string | number | null;
// result is per-method (allow / create_time / state / …); callers narrow it.
export type JsonRpcResult = { jsonrpc: "2.0"; id: Id; result: any };
export type JsonRpcError = { jsonrpc: "2.0"; id: Id; error: { code: number; message: Msg | string; data?: string } };
export type JsonRpcResponse = JsonRpcResult | JsonRpcError;

function ok(id: Id, result: unknown): JsonRpcResult {
  return { jsonrpc: "2.0", id, result };
}
function err(id: Id, code: number, data?: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message: MESSAGES[code] ?? String(code), data } };
}

function accountTopUpId(params: any): number | null {
  const raw = params?.account?.[ACCOUNT_FIELD];
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---- the dispatcher ------------------------------------------------------
// `authorized` is decided by the HTTP shell (Basic auth). Kept as a parameter
// so the pure core stays testable and never touches process.env.
export async function handlePayme(
  body: any,
  repo: PaymeRepo,
  authorized: boolean,
): Promise<JsonRpcResponse> {
  const id: Id = body && typeof body === "object" ? (body.id ?? null) : null;

  if (!authorized) return err(id, PaymeError.INSUFFICIENT_PRIVILEGE);
  if (!body || typeof body !== "object" || typeof body.method !== "string") {
    return err(id, PaymeError.INVALID_REQUEST);
  }
  const p = body.params ?? {};

  switch (body.method) {
    case "CheckPerformTransaction": return checkPerform(id, p, repo);
    case "CreateTransaction": return createTransaction(id, p, repo);
    case "PerformTransaction": return performTransaction(id, p, repo);
    case "CancelTransaction": return cancelTransaction(id, p, repo);
    case "CheckTransaction": return checkTransaction(id, p, repo);
    case "GetStatement": return getStatement(id, p, repo);
    default: return err(id, PaymeError.METHOD_NOT_FOUND);
  }
}

async function checkPerform(id: Id, p: any, repo: PaymeRepo): Promise<JsonRpcResponse> {
  const topUpId = accountTopUpId(p);
  if (topUpId === null) return err(id, PaymeError.ACCOUNT_NOT_FOUND, ACCOUNT_FIELD);
  const topup = await repo.findTopUp(topUpId);
  if (!topup) return err(id, PaymeError.ACCOUNT_NOT_FOUND, ACCOUNT_FIELD);
  if (!topup.payable) return err(id, PaymeError.ACCOUNT_NOT_PAYABLE, ACCOUNT_FIELD);
  if (Number(p.amount) !== topup.amountTiyin) return err(id, PaymeError.WRONG_AMOUNT);
  return ok(id, { allow: true });
}

async function createTransaction(id: Id, p: any, repo: PaymeRepo): Promise<JsonRpcResponse> {
  const paymeId = String(p.id ?? "");
  if (!paymeId) return err(id, PaymeError.INVALID_REQUEST);

  // Idempotent replay of the same Payme id.
  const existing = await repo.findTxnByPaymeId(paymeId);
  if (existing) {
    if (existing.state !== PaymeState.CREATED) return err(id, PaymeError.CANT_PERFORM);
    return ok(id, { create_time: existing.createTime, transaction: existing.paymeId, state: existing.state });
  }

  const topUpId = accountTopUpId(p);
  if (topUpId === null) return err(id, PaymeError.ACCOUNT_NOT_FOUND, ACCOUNT_FIELD);
  const topup = await repo.findTopUp(topUpId);
  if (!topup) return err(id, PaymeError.ACCOUNT_NOT_FOUND, ACCOUNT_FIELD);
  if (!topup.payable) return err(id, PaymeError.ACCOUNT_NOT_PAYABLE, ACCOUNT_FIELD);
  if (Number(p.amount) !== topup.amountTiyin) return err(id, PaymeError.WRONG_AMOUNT);

  // Another (different) Payme transaction already owns this top-up.
  const other = await repo.findTxnByTopUp(topUpId);
  if (other && other.paymeId !== paymeId) return err(id, PaymeError.CANT_PERFORM);

  // Reject a create whose time is already past the timeout window.
  const createTime = Number(p.time) || repo.now();
  if (repo.now() - createTime > TRANSACTION_TIMEOUT_MS) return err(id, PaymeError.CANT_PERFORM);

  const txn = await repo.createTxn({ paymeId, topUpId, amountTiyin: topup.amountTiyin, createTime });
  return ok(id, { create_time: txn.createTime, transaction: txn.paymeId, state: txn.state });
}

async function performTransaction(id: Id, p: any, repo: PaymeRepo): Promise<JsonRpcResponse> {
  const paymeId = String(p.id ?? "");
  const txn = await repo.findTxnByPaymeId(paymeId);
  if (!txn) return err(id, PaymeError.TRANSACTION_NOT_FOUND);

  if (txn.state === PaymeState.PERFORMED) {
    // Idempotent: report the same completion, no second credit.
    return ok(id, { transaction: txn.paymeId, perform_time: txn.performTime, state: txn.state });
  }
  if (txn.state !== PaymeState.CREATED) return err(id, PaymeError.CANT_PERFORM);

  // Expired while pending → cancel and refuse.
  if (repo.now() - txn.createTime > TRANSACTION_TIMEOUT_MS) {
    await repo.cancelCreated(paymeId, repo.now(), 4);
    return err(id, PaymeError.CANT_PERFORM);
  }

  const done = await repo.performTxn(paymeId, repo.now());
  return ok(id, { transaction: done.paymeId, perform_time: done.performTime, state: done.state });
}

async function cancelTransaction(id: Id, p: any, repo: PaymeRepo): Promise<JsonRpcResponse> {
  const paymeId = String(p.id ?? "");
  const reason = p.reason === undefined || p.reason === null ? null : Number(p.reason);
  const txn = await repo.findTxnByPaymeId(paymeId);
  if (!txn) return err(id, PaymeError.TRANSACTION_NOT_FOUND);

  // Already cancelled → idempotent replay.
  if (txn.state === PaymeState.CANCELLED || txn.state === PaymeState.CANCELLED_AFTER_PERFORM) {
    return ok(id, { transaction: txn.paymeId, cancel_time: txn.cancelTime, state: txn.state });
  }

  if (txn.state === PaymeState.CREATED) {
    const c = await repo.cancelCreated(paymeId, repo.now(), reason);
    return ok(id, { transaction: c.paymeId, cancel_time: c.cancelTime, state: c.state });
  }

  // state === PERFORMED → refund if the credited balance is still intact.
  const c = await repo.cancelPerformed(paymeId, repo.now(), reason);
  if (!c) return err(id, PaymeError.CANT_CANCEL_COMPLETED);
  return ok(id, { transaction: c.paymeId, cancel_time: c.cancelTime, state: c.state });
}

async function checkTransaction(id: Id, p: any, repo: PaymeRepo): Promise<JsonRpcResponse> {
  const txn = await repo.findTxnByPaymeId(String(p.id ?? ""));
  if (!txn) return err(id, PaymeError.TRANSACTION_NOT_FOUND);
  return ok(id, {
    create_time: txn.createTime,
    perform_time: txn.performTime,
    cancel_time: txn.cancelTime,
    transaction: txn.paymeId,
    state: txn.state,
    reason: txn.reason,
  });
}

async function getStatement(id: Id, p: any, repo: PaymeRepo): Promise<JsonRpcResponse> {
  const from = Number(p.from) || 0;
  const to = Number(p.to) || repo.now();
  const rows = await repo.listByRange(from, to);
  return ok(id, {
    transactions: rows.map((t) => ({
      id: t.paymeId,
      time: t.createTime,
      amount: t.amountTiyin,
      account: { [ACCOUNT_FIELD]: String(t.topUpId) },
      create_time: t.createTime,
      perform_time: t.performTime,
      cancel_time: t.cancelTime,
      transaction: t.paymeId,
      state: t.state,
      reason: t.reason,
    })),
  });
}

// ---- checkout URL + money conversion -------------------------------------

// UZS сум -> tiyin, integer, no float drift. Rounded because balances are
// stored as Float сум in the existing schema; the rounded tiyin is what we
// store authoritatively on PaymeTransaction and compare against.
export function sumToTiyin(sum: number): number {
  return Math.round(sum * 100);
}

// Payme GET checkout URL: base64 of "m=<id>;ac.<field>=<val>;a=<tiyin>[;c=<cb>;l=<lang>]".
export function buildCheckoutUrl(opts: {
  checkoutBase: string;
  merchantId: string;
  topUpId: number;
  amountTiyin: number;
  callbackUrl?: string;
  lang?: string;
}): string {
  const parts = [
    `m=${opts.merchantId}`,
    `ac.${ACCOUNT_FIELD}=${opts.topUpId}`,
    `a=${opts.amountTiyin}`,
  ];
  if (opts.callbackUrl) parts.push(`c=${opts.callbackUrl}`);
  if (opts.lang) parts.push(`l=${opts.lang}`);
  const encoded = Buffer.from(parts.join(";"), "utf8").toString("base64");
  return `${opts.checkoutBase.replace(/\/+$/, "")}/${encoded}`;
}
