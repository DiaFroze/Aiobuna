// Click SHOP-API (Merchant API) — pure protocol core.
//
// Click calls two callbacks on our backend: Prepare (action=0) verifies the
// order can be paid, Complete (action=1) confirms the money moved. No DB/HTTP
// here — everything runs over a small ClickRepo, so it's fully unit-testable.
//
// Grounded against Click's own library (github.com/click-llc/click-integration-php):
//   Prepare  sign = md5(click_trans_id + service_id + KEY + merchant_trans_id + amount + action + sign_time)
//   Complete sign = md5(click_trans_id + service_id + KEY + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)

import { createHash } from "node:crypto";

export const ClickError = {
  SUCCESS: 0,
  SIGN_FAILED: -1,
  INVALID_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4, // order in a state that can't be paid
  ORDER_NOT_FOUND: -5, // merchant_trans_id doesn't resolve to an order
  TXN_NOT_FOUND: -6, // Complete for something Prepare never created
  BAD_REQUEST: -8,
  CANCELLED: -9,
} as const;

export const ClickAction = { PREPARE: 0, COMPLETE: 1 } as const;

// Raw form params exactly as Click POSTs them (all strings — used verbatim in
// the signature, so never re-format amount before signing).
export type ClickParams = {
  click_trans_id?: string;
  service_id?: string;
  click_paydoc_id?: string;
  merchant_trans_id?: string;
  merchant_prepare_id?: string;
  amount?: string;
  action?: string;
  error?: string;
  error_note?: string;
  sign_time?: string;
  sign_string?: string;
};

export type ClickResponse = {
  click_trans_id: string;
  merchant_trans_id: string;
  merchant_prepare_id?: string;
  merchant_confirm_id?: string;
  error: number;
  error_note: string;
};

function md5(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

export function prepareSign(p: ClickParams, key: string): string {
  return md5(`${p.click_trans_id}${p.service_id}${key}${p.merchant_trans_id}${p.amount}${p.action}${p.sign_time}`);
}
export function completeSign(p: ClickParams, key: string): string {
  return md5(`${p.click_trans_id}${p.service_id}${key}${p.merchant_trans_id}${p.merchant_prepare_id}${p.amount}${p.action}${p.sign_time}`);
}

// Compare two amounts in сум at 1-tiyin precision (Click sends "1000.00").
function amountMatches(clickAmount: string | undefined, orderSum: number): boolean {
  const a = Math.round(Number(clickAmount) * 100);
  const b = Math.round(orderSum * 100);
  return Number.isFinite(a) && a === b;
}

export type ClickTopUp = {
  topUpId: number;
  amountSum: number;
  status: string; // pending | approved | rejected
  clickTransId: string | null;
};

export interface ClickRepo {
  findTopUp(topUpId: number): Promise<ClickTopUp | null>;
  savePrepare(topUpId: number, clickTransId: string): Promise<void>;
  // Atomic: status pending -> approved + credit balance, exactly once.
  complete(topUpId: number, clickTransId: string): Promise<"ok" | "already">;
  cancel(topUpId: number, clickTransId: string): Promise<void>;
}

const NOTE: Record<number, string> = {
  [ClickError.SUCCESS]: "Success",
  [ClickError.SIGN_FAILED]: "SIGN CHECK FAILED!",
  [ClickError.INVALID_AMOUNT]: "Incorrect parameter amount",
  [ClickError.ACTION_NOT_FOUND]: "Action not found",
  [ClickError.ALREADY_PAID]: "Already paid",
  [ClickError.ORDER_NOT_FOUND]: "Order not found",
  [ClickError.TXN_NOT_FOUND]: "Transaction does not exist",
  [ClickError.BAD_REQUEST]: "Error in request from click",
  [ClickError.CANCELLED]: "Transaction cancelled",
};

function reply(p: ClickParams, error: number, extra: Partial<ClickResponse> = {}): ClickResponse {
  return {
    click_trans_id: p.click_trans_id ?? "",
    merchant_trans_id: p.merchant_trans_id ?? "",
    error,
    error_note: NOTE[error] ?? String(error),
    ...extra,
  };
}

export async function handleClick(p: ClickParams, secretKey: string, repo: ClickRepo): Promise<ClickResponse> {
  const action = Number(p.action);

  // Signature first — a bad sign is rejected before any lookup.
  const expected = action === ClickAction.COMPLETE ? completeSign(p, secretKey) : prepareSign(p, secretKey);
  if (!secretKey || (p.sign_string ?? "").toLowerCase() !== expected.toLowerCase()) {
    return reply(p, ClickError.SIGN_FAILED);
  }

  const topUpId = Number(p.merchant_trans_id);
  if (!Number.isInteger(topUpId) || topUpId <= 0) return reply(p, ClickError.ORDER_NOT_FOUND);

  if (action === ClickAction.PREPARE) return prepare(p, topUpId, repo);
  if (action === ClickAction.COMPLETE) return complete(p, topUpId, repo);
  return reply(p, ClickError.ACTION_NOT_FOUND);
}

async function prepare(p: ClickParams, topUpId: number, repo: ClickRepo): Promise<ClickResponse> {
  const t = await repo.findTopUp(topUpId);
  if (!t) return reply(p, ClickError.ORDER_NOT_FOUND);
  if (t.status === "approved") return reply(p, ClickError.ALREADY_PAID);
  if (t.status === "rejected") return reply(p, ClickError.CANCELLED);
  if (!amountMatches(p.amount, t.amountSum)) return reply(p, ClickError.INVALID_AMOUNT);

  await repo.savePrepare(topUpId, p.click_trans_id ?? "");
  return reply(p, ClickError.SUCCESS, { merchant_prepare_id: String(topUpId) });
}

async function complete(p: ClickParams, topUpId: number, repo: ClickRepo): Promise<ClickResponse> {
  // Complete must reference the exact Prepare we answered.
  if (Number(p.merchant_prepare_id) !== topUpId) return reply(p, ClickError.TXN_NOT_FOUND);
  const t = await repo.findTopUp(topUpId);
  if (!t || t.clickTransId !== (p.click_trans_id ?? "")) return reply(p, ClickError.TXN_NOT_FOUND);

  // Click reports its own failure/cancel via a negative error → cancel our side.
  if (Number(p.error) < 0) {
    if (t.status !== "approved") await repo.cancel(topUpId, p.click_trans_id ?? "");
    return reply(p, ClickError.CANCELLED, { merchant_confirm_id: String(topUpId) });
  }

  if (t.status === "approved") {
    // Idempotent replay — money already credited once.
    return reply(p, ClickError.SUCCESS, { merchant_confirm_id: String(topUpId) });
  }
  if (!amountMatches(p.amount, t.amountSum)) return reply(p, ClickError.INVALID_AMOUNT);

  await repo.complete(topUpId, p.click_trans_id ?? "");
  return reply(p, ClickError.SUCCESS, { merchant_confirm_id: String(topUpId) });
}

// Click "button" payment URL — opens Click Up / my.click.uz with the invoice.
export function buildClickUrl(opts: {
  serviceId: string;
  merchantId: string;
  topUpId: number;
  amountSum: number;
  returnUrl?: string;
}): string {
  const params = new URLSearchParams({
    service_id: opts.serviceId,
    merchant_id: opts.merchantId,
    amount: String(Math.round(opts.amountSum * 100) / 100),
    transaction_param: String(opts.topUpId),
  });
  if (opts.returnUrl) params.set("return_url", opts.returnUrl);
  return `https://my.click.uz/services/pay?${params.toString()}`;
}
