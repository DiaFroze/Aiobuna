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
  descriptionClean: string;
  premiumEmojiCode: string | null;
}

export interface SupplierOrderResult {
  payload: string;
  status: string;
  raw: unknown;
}

function assertVex(src: Source) {
  if (src.format !== "vex") throw new Error(`Формат API «${src.format}» пока не поддерживается`);
  if (!src.baseUrl || !src.apiKey) throw new Error("У источника не заданы URL или ключ");
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
  assertVex(src);
  const j = await vexCall(src, "balance");
  return Number(j?.balance ?? 0);
}

export async function sourceProducts(src: Source): Promise<SupplierProduct[]> {
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
      descriptionClean: replaceCeTokensForPublic(p.description),
      premiumEmojiCode: primaryCeCode(p.description)?.code ?? null,
    }))
    .filter((p) => p.id && p.name);
}

export async function sourceOrder(src: Source, productId: string, quantity = 1): Promise<SupplierOrderResult> {
  assertVex(src);
  const j = await vexCall(src, "order", { method: "POST", body: { product_id: productId, quantity } });
  return { payload: extractDelivery(j), status: String(j?.status ?? "unknown"), raw: j };
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
