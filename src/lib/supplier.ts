// Generic supplier-API client. A "source" (base URL + key + format) is stored in
// the ApiSource table and managed from the admin panel, so new reseller APIs can
// be added without code — as long as they follow a supported `format`.
// Currently supported format: "vex" (see docs/VEX_API.md). Add new formats here.
import { primaryCeCode, replaceCeTokensForPublic } from "./emoji/ce-tokens";
import { serializeStockPayload, parseStockPayload, tryParseLabeledAccount } from "./domain/stock-payload";

export interface Source {
  slug: string;
  baseUrl: string;
  apiKey: string;
  format: string;
}

export interface SupplierProduct {
  id: string;
  name: string;
  price: number;
  stock: number;
  available: boolean;
  category: string | null;
  manualDelivery: boolean;
  apiOrderable: boolean;      // !manual_delivery && api is able to fulfill
  descriptionClean: string;
  premiumEmojiCode: string | null;
  warrantyType?: "none" | "full" | string | null;
}

export interface SupplierOrderResult {
  payload: string;
  status: string;
  idempotentReplay?: boolean; // true when Vexoran returned the same order again
  raw: unknown;
}

function assertVex(src: Source) {
  if (src.format !== "vex") throw new Error(`Формат API «${src.format}» пока не поддерживается`);
  if (!src.baseUrl || !src.apiKey) throw new Error("У источника не заданы URL или ключ");
}

// --- Qamify Reseller API (format: "qamify") -------------------------------
// REST reseller API: GET /v1/ping, GET /v1/balance, GET /v1/products, POST /v1/orders
// Idempotency-Key header is required for orders.
async function qamifyCall(
  src: Source,
  path: string,
  opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
) {
  const baseUrl = (src.baseUrl || "https://api.qamify.site").replace(/\/+$/, "");
  if (!src.apiKey) throw new Error("У источника не задан API ключ");
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts?.method ?? "GET",
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${src.apiKey}`,
      "X-API-Key": src.apiKey,
      "Content-Type": "application/json",
      ...(opts?.headers ?? {}),
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${src.slug} ${path} ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${src.slug} ${path}: invalid JSON`);
  }
}

// --- SoMaDeth "Buyer API" (format: "somadeth") -----------------------------
// Bearer-auth REST wallet: GET /balance, GET /products, POST /purchase
// {product_id, qty}. The key lives in Railway env, never in code.
async function buyerCall(src: Source, path: string, opts?: { method?: string; body?: unknown }) {
  if (!src.baseUrl || !src.apiKey) throw new Error("У источника не заданы URL или ключ");
  const res = await fetch(`${src.baseUrl}${path}`, {
    method: opts?.method ?? "GET",
    signal: AbortSignal.timeout(20000), // don't hang the bot on a slow supplier API
    headers: { Authorization: `Bearer ${src.apiKey}`, "Content-Type": "application/json" },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${src.slug} ${path} ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${src.slug} ${path}: invalid JSON`);
  }
}

async function vexCall(src: Source, action: string, opts?: { method?: string; body?: unknown }) {
  const res = await fetch(`${src.baseUrl}?action=${action}`, {
    method: opts?.method ?? "GET",
    signal: AbortSignal.timeout(20000), // don't hang the bot on a slow supplier API
    headers: { Authorization: `Bearer ${src.apiKey}`, "Content-Type": "application/json" },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${src.slug} ${action} ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${src.slug} ${action}: invalid JSON`);
  }
}

export async function sourceBalance(src: Source): Promise<number> {
  if (src.format === "qamify") {
    const j = await qamifyCall(src, "/v1/balance");
    return Number(j?.balance ?? j?.data?.balance ?? 0);
  }
  if (src.format === "somadeth") {
    const j = await buyerCall(src, "/api/telegram-buyer/balance");
    return Number(j?.balance ?? 0);
  }
  assertVex(src);
  const j = await vexCall(src, "balance");
  return Number(j?.balance ?? 0);
}

export async function sourceProducts(src: Source): Promise<SupplierProduct[]> {
  if (src.format === "qamify") {
    const j = await qamifyCall(src, "/v1/products");
    const arr: any[] = Array.isArray(j)
      ? j
      : Array.isArray(j?.products)
      ? j.products
      : Array.isArray(j?.data)
      ? j.data
      : [];
    return arr
      .map((p) => {
        const available = p.available !== undefined ? Boolean(p.available) : (p.stock ?? 0) > 0;
        const rawStock = p.stock ?? p.available_qty ?? p.qty ?? p.count;
        const stock = rawStock !== undefined && rawStock !== null ? Number(rawStock) : available ? 9999 : 0;
        return {
          id: String(p.id ?? p.product_id ?? ""),
          name: String(p.name ?? p.title ?? "").trim(),
          price: Number(p.price ?? p.reseller_price ?? p.base_price ?? 0),
          stock,
          available,
          category: p.category ?? null,
          manualDelivery: Boolean(p.manual_delivery),
          apiOrderable: !p.manual_delivery,
          descriptionClean: replaceCeTokensForPublic(p.description ?? ""),
          premiumEmojiCode: primaryCeCode(p.description ?? "")?.code ?? null,
          warrantyType: p.warranty_type ?? null,
        };
      })
      .filter((p) => p.id && p.name);
  }
  if (src.format === "somadeth") {
    const j = await buyerCall(src, "/api/telegram-buyer/products");
    const arr: any[] = Array.isArray(j?.products) ? j.products : [];
    return arr
      .map((p) => {
        const available = p.available !== undefined ? Boolean(p.available) : true;
        const rawStock = p.stock ?? p.available_qty ?? p.qty ?? p.count;
        // Wallet-based supplier: supply is limited by the wallet balance, not a
        // per-product stock. If the API doesn't report stock, assume plenty so
        // sales aren't blocked — a purchase past the balance 400s and falls back
        // to manual delivery.
        const stock = rawStock !== undefined && rawStock !== null ? Number(rawStock) : available ? 9999 : 0;
        return {
          id: String(p.id ?? p.product_id ?? ""),
          name: String(p.name ?? p.title ?? "").trim(),
          price: Number(p.price ?? p.base_price ?? 0),
          stock,
          available,
          category: p.category ?? null,
          manualDelivery: Boolean(p.manual_delivery),
          apiOrderable: !p.manual_delivery,
          descriptionClean: replaceCeTokensForPublic(p.description ?? ""),
          premiumEmojiCode: primaryCeCode(p.description ?? "")?.code ?? null,
        };
      })
      .filter((p) => p.id && p.name);
  }
  assertVex(src);
  const j = await vexCall(src, "products");
  const arr: any[] = Array.isArray(j?.products) ? j.products : [];
  return arr
    .map((p) => ({
      id: String(p.id),
      name: String(p.name ?? "").trim(),
      price: Number(p.price ?? p.base_price ?? 0),
      stock: Number(p.stock ?? 0),
      available: Boolean(p.available),
      category: p.category ?? null,
      manualDelivery: Boolean(p.manual_delivery),
      // api_orderable is the canonical Vexoran field; fall back to !manual_delivery
      apiOrderable: p.api_orderable !== undefined ? Boolean(p.api_orderable) : !p.manual_delivery,
      descriptionClean: replaceCeTokensForPublic(p.description),
      premiumEmojiCode: primaryCeCode(p.description)?.code ?? null,
      warrantyType: p.warranty_type ?? null,
    }))
    .filter((p) => p.id && p.name);
}

export async function sourceOrder(
  src: Source,
  productId: string,
  quantity = 1,
  externalOrderId?: string | number,
): Promise<SupplierOrderResult> {
  if (src.format === "qamify") {
    const idempotencyKey = externalOrderId
      ? `order-${externalOrderId}`
      : `order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const j = await qamifyCall(src, "/v1/orders", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
      },
      body: {
        product_id: Number(productId),
        qty: quantity,
        idempotency_key: idempotencyKey,
      },
    });
    return {
      payload: extractDelivery(j),
      status: String(j?.status ?? (j?.ok ? "ok" : "delivered")),
      idempotentReplay: Boolean(j?.idempotent_replay ?? j?.replayed),
      raw: j,
    };
  }
  if (src.format === "somadeth") {
    // Buyer API buys per-call with {product_id, qty}. A 400 (insufficient wallet
    // balance / validation) is thrown by buyerCall and handled upstream — the
    // order falls back to manual delivery, so the customer never loses money.
    const j = await buyerCall(src, "/api/telegram-buyer/purchase", {
      method: "POST",
      body: { product_id: Number(productId), qty: quantity },
    });
    return { payload: extractDelivery(j), status: String(j?.status ?? "ok"), raw: j };
  }
  assertVex(src);
  // Pass external_order_id so Vexoran can de-duplicate retries:
  // a second call with the same ID returns the original order (idempotent_replay: true)
  // and never double-charges or double-delivers.
  const body: Record<string, unknown> = { product_id: productId, quantity };
  if (externalOrderId !== undefined) body.external_order_id = String(externalOrderId);
  const j = await vexCall(src, "order", { method: "POST", body });
  return {
    payload: extractDelivery(j),
    status: String(j?.status ?? "unknown"),
    idempotentReplay: Boolean(j?.idempotent_replay),
    raw: j,
  };
}

export function isOrderTrackingCode(str: string): boolean {
  const s = String(str ?? "").trim();
  if (!s) return false;
  // Qamify order code: RA-5588C8F82B
  if (/^RA-[A-Z0-9]+$/i.test(s)) return true;
  // Generic order reference codes like ORD-12345, ORDER-12345, INV-12345
  if (/^(?:ORD|ORDER|INV|INVOICE)-[A-Z0-9]+$/i.test(s)) return true;
  // Boolean or status words
  if (/^(?:ok|success|completed|delivered|pending|processing|true|false)$/i.test(s)) return true;
  return false;
}

export function normalizeDeliveryItem(it: any): string {
  if (it === null || it === undefined) return "";
  if (typeof it === "string") {
    const s = it.trim();
    if (!s || isOrderTrackingCode(s)) return "";
    const labeled = tryParseLabeledAccount(s);
    if (labeled) {
      return serializeStockPayload(labeled);
    }
    const parsed = parseStockPayload(s);
    if (parsed.type === "account") {
      return serializeStockPayload(parsed);
    }
    return s;
  }
  if (typeof it === "object") {
    // Check if it is an account object with email/login and password
    const login = it.email ?? it.login ?? it.username ?? it.user ?? it.mail ?? it.account;
    const password = it.password ?? it.pass ?? it.pwd ?? it.parol;
    if (typeof login === "string" && typeof password === "string" && login.trim() && password.trim()) {
      const extra = it.extra ?? it["2fa"] ?? it.pin ?? it.secret ?? it.token;
      return serializeStockPayload({
        type: "account",
        login: login.trim(),
        password: password.trim(),
        ...(extra ? { extra: String(extra).trim() } : {}),
      });
    }
    // Check if it is an object containing key/license/credentials/delivery/delivered_goods/code
    for (const prop of ["key", "license", "credentials", "delivery", "delivered_goods", "content", "promo", "data", "code"]) {
      const val = it[prop];
      if (typeof val === "string" && val.trim() && !isOrderTrackingCode(val.trim())) {
        return normalizeDeliveryItem(val.trim());
      }
      if (Array.isArray(val) && val.length > 0) {
        const mapped = val.map(normalizeDeliveryItem).filter(Boolean);
        if (mapped.length > 0) return mapped.join("\n");
      }
    }
    return JSON.stringify(it);
  }
  return String(it);
}

export function extractDelivery(j: any): string {
  if (!j || typeof j !== "object") return String(j ?? "");

  // 1. Prioritize explicit item/key arrays (which represent the actual delivered units)
  const arraySources = [
    j?.order?.keys,
    j?.order?.items,
    j?.order?.delivered_goods,
    j?.order?.deliveries,
    j?.order?.credentials,
    j?.keys,
    j?.items,
    j?.deliveries,
    j?.data?.keys,
    j?.data?.items,
    j?.result?.keys,
    j?.result?.items,
  ];

  for (const arr of arraySources) {
    if (Array.isArray(arr) && arr.length > 0) {
      const lines = arr.map(normalizeDeliveryItem).filter(Boolean);
      if (lines.length > 0) return lines.join("\n");
    }
  }

  // 2. Check delivery fields (excluding order references like `order.code`)
  const fieldNames = [
    "delivered_goods",
    "delivery",
    "delivery_content",
    "credentials",
    "content",
    "license",
    "account",
    "key",
    "data",
  ];

  const containers = [j?.order, j?.data, j?.result, j];

  for (const field of fieldNames) {
    for (const container of containers) {
      if (!container || typeof container !== "object") continue;
      const v = container[field];
      if (typeof v === "string" && v.trim() && !isOrderTrackingCode(v.trim())) {
        const norm = normalizeDeliveryItem(v.trim());
        if (norm) return norm;
      }
      if (Array.isArray(v) && v.length > 0) {
        const lines = v.map(normalizeDeliveryItem).filter(Boolean);
        if (lines.length > 0) return lines.join("\n");
      }
      if (v && typeof v === "object") {
        const norm = normalizeDeliveryItem(v);
        if (norm && !norm.startsWith("{")) return norm;
      }
    }
  }

  // 3. Fallback: single code property ONLY IF not an order tracking code and not in an order wrapper
  if (typeof j.code === "string" && j.code.trim() && !isOrderTrackingCode(j.code.trim()) && !j.order) {
    const norm = normalizeDeliveryItem(j.code.trim());
    if (norm) return norm;
  }

  return "```\n" + JSON.stringify(j, null, 2).slice(0, 1500) + "\n```";
}

// Fallback source from env (legacy Vex), used when no ApiSource row exists yet.
export function envVexSource(): Source | null {
  const baseUrl = process.env.VEX_API_URL ?? "";
  const apiKey = process.env.VEX_API_KEY ?? "";
  return baseUrl && apiKey ? { slug: "vex", baseUrl, apiKey, format: "vex" } : null;
}

// SoMaDeth Buyer API source from env (Railway → Variables). The URL/key var
// names are matched case-tolerantly so whatever spelling is set in Railway
// (SOMADETH_API_URL, SoMaDeth_API_URL, BUYER_API_URL, …) is picked up.
export function envBuyerSource(): Source | null {
  const pick = (...names: string[]) => {
    for (const n of names) if (process.env[n]) return process.env[n] as string;
    return "";
  };
  const baseUrl = pick("SOMADETH_API_URL", "SoMaDeth_API_URL", "SOMADETH_URL", "BUYER_API_URL").replace(/\/+$/, "");
  const apiKey = pick("SOMADETH_API_KEY", "SoMaDeth_API_KEY", "SOMADETH_KEY", "BUYER_API_KEY");
  return baseUrl && apiKey ? { slug: "somadeth", baseUrl, apiKey, format: "somadeth" } : null;
}

// Qamify Reseller API source from env (Railway → Variables).
export function envQamifySource(): Source | null {
  const pick = (...names: string[]) => {
    for (const n of names) if (process.env[n]) return process.env[n] as string;
    return "";
  };
  const baseUrl = (pick("QAMIFY_API_URL", "QAMIFY_URL") || "https://api.qamify.site").replace(/\/+$/, "");
  const apiKey = pick("QAMIFY_API_KEY", "QAMIFY_KEY");
  return apiKey ? { slug: "qamify", baseUrl, apiKey, format: "qamify" } : null;
}

