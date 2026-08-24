// HTTP client for fragment-api.com.
//
// Two rules shape this file:
//
//  1. The credential never reaches a log. The Fragment Connection JWT grants
//     spending rights on the hot wallet, so it is passed straight into the
//     header and never included in an error, a message or a thrown object.
//  2. A failed call never becomes a guess. Every method returns a discriminated
//     result — success, or a failure the caller can classify — because "the
//     request failed" and "the order was not placed" are different statements,
//     and only the second one makes a retry safe.

import {
  FRAGMENT_API_BASE,
  type FragmentOrderResponse,
  type PremiumOrderRequest,
  type PricesResponse,
  type StarsOrderRequest,
  type UserInfoResponse,
  type WalletInfoResponse,
} from "./api-types";
import type { PostFailure } from "./purchase-policy";

export interface FragmentApiConfig {
  /** Fragment Connection JWT from the vendor dashboard (NOT the account API key). */
  jwt: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: PostFailure };

const DEFAULT_TIMEOUT_MS = 30_000;

/** Redact anything that looks like a credential before it can be logged. */
export function redact(text: string): string {
  return text
    .replace(/JWT\s+[A-Za-z0-9._-]+/gi, "JWT [redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, "[redacted-jwt]");
}

async function request<T>(
  cfg: FragmentApiConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  auth = true,
): Promise<ApiResult<T>> {
  const url = `${cfg.baseUrl ?? FRAGMENT_API_BASE}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    if (!cfg.jwt) {
      return { ok: false, failure: { kind: "http", status: 401, body: "no Fragment Connection JWT configured" } };
    }
    // The vendor schema is explicit: "Format: JWT <token>". Not Bearer.
    headers.Authorization = `JWT ${cfg.jwt}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    // No response at all. The caller must treat this as "outcome unknown", not
    // as "it did not happen" — the request may have been fully processed.
    return { ok: false, failure: { kind: "transport", message: redact((e as Error).message) } };
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 500);
  }

  if (!res.ok) {
    return { ok: false, failure: { kind: "http", status: res.status, body: parsed } };
  }
  return { ok: true, data: parsed as T };
}

// ---------------------------------------------------------------------------
// Read-only
// ---------------------------------------------------------------------------

/** Live prices. Public — works without a JWT, which makes it a useful health probe. */
export function getPrices(cfg?: Partial<FragmentApiConfig>): Promise<ApiResult<PricesResponse>> {
  return request<PricesResponse>({ jwt: "", ...cfg }, "GET", "/v1/misc/prices/", undefined, false);
}

/** Hot-wallet balances, one entry per currency. */
export function getWallet(cfg: FragmentApiConfig): Promise<ApiResult<WalletInfoResponse>> {
  return request<WalletInfoResponse>(cfg, "GET", "/v1/misc/wallet/");
}

/** Confirm a recipient exists on Fragment before any money moves. */
export function getUser(cfg: FragmentApiConfig, username: string): Promise<ApiResult<UserInfoResponse>> {
  return request<UserInfoResponse>(cfg, "GET", `/v1/misc/user/${encodeURIComponent(username)}/`);
}

/**
 * Canonical order state. This is the authority for whether a purchase happened
 * — a webhook callback is only a hint to come and ask this question.
 */
export function getOrder(cfg: FragmentApiConfig, id: string): Promise<ApiResult<FragmentOrderResponse>> {
  return request<FragmentOrderResponse>(cfg, "GET", `/v1/order/${encodeURIComponent(id)}/`);
}

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

/**
 * Buy Stars. THIS SPENDS REAL FUNDS.
 *
 * There is no idempotency key to send, so calling it twice buys twice. Callers
 * must hold an atomic claim on the order before getting here, and must never
 * call it again after an ambiguous failure — reconcile instead.
 */
export function createStarsOrder(cfg: FragmentApiConfig, req: StarsOrderRequest): Promise<ApiResult<FragmentOrderResponse>> {
  return request<FragmentOrderResponse>(cfg, "POST", "/v1/order/stars/", req);
}

/** Gift Premium. Same warning as createStarsOrder: this spends real funds. */
export function createPremiumOrder(cfg: FragmentApiConfig, req: PremiumOrderRequest): Promise<ApiResult<FragmentOrderResponse>> {
  return request<FragmentOrderResponse>(cfg, "POST", "/v1/order/premium/", req);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Short, safe description of a failure for logs. Never contains credentials. */
export function describeFailure(f: PostFailure): string {
  if (f.kind === "transport") return `transport: ${redact(f.message)}`;
  const body = typeof f.body === "string" ? f.body : JSON.stringify(f.body ?? "");
  return `http ${f.status}: ${redact(body).slice(0, 300)}`;
}
