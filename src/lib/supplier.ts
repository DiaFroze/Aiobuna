// Generic supplier-API client. A "source" (base URL + key + format) is stored in
// the ApiSource table and managed from the admin panel, so new reseller APIs can
// be added without code — as long as they follow a supported `format`.
// Currently supported format: "vex" (see docs/VEX_API.md). Add new formats here.
import { primaryCeCode, replaceCeTokensForPublic } from "./emoji/ce-tokens";

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
  if (src.format === "somadeth") {
    const j = await buyerCall(src, "/api/telegram-buyer/balance");
    return Number(j?.balance ?? 0);
  }
  assertVex(src);
  const j = await vexCall(src, "balance");
  return Number(j?.balance ?? 0);
}

export async function sourceProducts(src: Source): Promise<SupplierProduct[]> {
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

function extractDelivery(j: any): string {
  if (!j || typeof j !== "object") return String(j ?? "");
  for (const k of ["delivery", "delivery_content", "content", "credentials", "code", "key", "data"]) {
    const v = j[k] ?? j?.order?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const items = j.items ?? j.deliveries ?? j?.order?.items;
  if (Array.isArray(items) && items.length) {
    const lines = items.map((it) =>
      typeof it === "string" ? it : it?.code ?? it?.content ?? it?.credentials ?? JSON.stringify(it),
    );
    if (lines.some(Boolean)) return lines.filter(Boolean).join("\n");
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
