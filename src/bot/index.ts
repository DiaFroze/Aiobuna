// SubHub store bot (Telegram, long-polling). UZS (сум). RU/EN/UZ i18n with a
// language picker. Storefront + manual quantity + stock/Vex auto-fulfil +
// custom top-up (Stars / card / admin). Buttons coloured via Bot API 9.4 style.
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
} catch {
  /* .env optional; Prisma also loads it on client construct */
}

import { Bot, InlineKeyboard, Keyboard, InputFile, type Context } from "grammy";
import type { MessageEntity } from "grammy/types";
import { db } from "./db";
import { sourceOrder, envVexSource, type Source } from "../lib/supplier";
import { geminiTranslate } from "../lib/gemini";
import { t, LANGS, LANG_NAMES, normalizeLang, btnVariants, type Lang } from "./i18n";
import { generateVerificationCode } from "../lib/orderCode";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Media assets (banners/tutorial videos) under assets/ — each read from disk
// once and cached in memory. A missing file just means that message sends
// text-only instead of erroring — never fatal.
const mediaAssetCache = new Map<string, Buffer>();
function mediaAssetFile(filename: string): InputFile | null {
  let buf = mediaAssetCache.get(filename);
  if (buf === undefined) {
    try {
      buf = fs.readFileSync(path.join(__dirname, "assets", filename));
    } catch {
      buf = Buffer.alloc(0);
    }
    mediaAssetCache.set(filename, buf);
  }
  return buf.length > 0 ? new InputFile(buf, filename) : null;
}
function giftsBannerAsset(): { file: InputFile; isVideo: boolean } | null {
  for (const name of ["gifts-banner.mov", "gifts-banner.mp4", "gifts-banner.png", "gifts-banner.jpg"]) {
    const f = mediaAssetFile(name);
    if (f) {
      const isVideo = name.endsWith(".mov") || name.endsWith(".mp4");
      return { file: f, isVideo };
    }
  }
  return null;
}
const shopBannerFile = () => mediaAssetFile("shop-banner.jpg");
const promoInstructionsFile = () => mediaAssetFile("promo-instructions.mp4");
const howToPayFile = () => mediaAssetFile("how-to-pay.mp4");
const howToActivateFile = () => mediaAssetFile("how-to-activate.mp4");

// Universal "edit or replace" for callback-driven navigation. Works whether
// the source message is plain text (edit its text) or a media message
// (edit its caption, or if that fails, delete + resend). Optionally sends a
// fresh media message with the given photo or video as its caption target.
type SendOrEditOpts = {
  reply_markup?: InlineKeyboard | undefined;
  photo?: InputFile | null;
  video?: InputFile | null;
  link_preview_options?: { url?: string; show_above_text?: boolean; prefer_large_media?: boolean; is_disabled?: boolean } | undefined;
};
async function sendOrEdit(ctx: Context, text: string, opts: SendOrEditOpts = {}) {
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  const kb = opts.reply_markup;
  const photo = opts.photo ?? null;
  const video = opts.video ?? null;

  if (video) {
    if (chatId && messageId) await ctx.api.deleteMessage(chatId, messageId).catch(() => {});
    await ctx.replyWithVideo(video, { caption: text, parse_mode: "HTML", reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    });
    return;
  }

  if (photo) {
    if (chatId && messageId) await ctx.api.deleteMessage(chatId, messageId).catch(() => {});
    await ctx.replyWithPhoto(photo, { caption: text, parse_mode: "HTML", reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    });
    return;
  }

  // No media: try text edit → caption edit → delete+resend, in that order.
  if (chatId && messageId) {
    try {
      await ctx.api.editMessageText(chatId, messageId, text, {
        parse_mode: "HTML",
        reply_markup: kb,
        link_preview_options: opts.link_preview_options,
      });
      return;
    } catch {}
    try {
      await ctx.api.editMessageCaption(chatId, messageId, { caption: text, parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {}
    await ctx.api.deleteMessage(chatId, messageId).catch(() => {});
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: opts.link_preview_options }).catch(() => {});
}

const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
const ADMIN_ID = String(process.env.TELEGRAM_ADMIN_CHAT_ID ?? "");
const CARD_PROVIDER_TOKEN = process.env.TELEGRAM_PROVIDER_TOKEN ?? "";
const STARS_PER_USDT = Number(process.env.STARS_PER_USDT ?? 77);
const UZS_PER_USDT = Number(process.env.USDT_UZS_RATE ?? 12600);
if (!token) {
  console.error("[bot] TELEGRAM_BOT_TOKEN is not set in .env — cannot start.");
  process.exit(1);
}

// Диагностика: чтобы бот не умирал молча — печатаем любую фатальную ошибку.
process.on("unhandledRejection", (e) => console.error("[bot] unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("[bot] uncaughtException:", e));

const PAGE_SIZE = 8;
const MIN_TOPUP = 10000;
const TOPUP_PRESETS = [50000, 100000, 200000];
const SORTS = ["all", "price", "stock"] as const;
type Sort = (typeof SORTS)[number];
const CUR: Record<Lang, string> = { ru: "сум", en: "soum", uz: "so‘m" };

const pending = new Map<
  string,
  | { type: "qty"; variantId: number; back: string }
  | { type: "topup" }
  | { type: "promo" }
  | { type: "formatter_index" }
  | { type: "formatter_links"; startIndex: number; collectedLinks?: string[]; timeoutId?: any }
  | { type: "reject_custom_reason"; topupId: number }
>();

const bot = new Bot(token);

// Telegram Bot API requires icon_custom_emoji_id as a JSON number,
// but these are 19-digit IDs that exceed JS Number precision.
// We patch the raw fetch body to convert "icon_custom_emoji_id":"123" → "icon_custom_emoji_id":123
// without going through JS number parsing (which would lose precision).
const _origFetch = globalThis.fetch;
globalThis.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (
    typeof input === "string" &&
    input.includes("api.telegram.org") &&
    init?.body &&
    typeof init.body === "string" &&
    init.body.includes("icon_custom_emoji_id")
  ) {
    init = {
      ...init,
      body: init.body.replace(/"icon_custom_emoji_id":"(\d+)"/g, '"icon_custom_emoji_id":$1'),
    };
  }
  return _origFetch(input as RequestInfo, init);
} as typeof fetch;

// ---------- helpers ----------
const money = (n: number, lang: string | null | undefined) =>
  `${Math.round(n).toLocaleString("ru-RU")} ${CUR[normalizeLang(lang)]}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TG_TAGS = ["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "blockquote"];
function tgHtml(s: string): string {
  let out = esc(s);
  for (const tag of TG_TAGS) out = out.replace(new RegExp(`&lt;(/?${tag})&gt;`, "gi"), "<$1>");
  return out;
}
const stripTags = (s: string) => s.replace(/<[^>]*>/g, "");
// Drop a leading standard or decorative emoji (+ optional variation selector + spaces) — used
// when a premium emoji icon replaces the plain one on a button.
const stripLeadEmoji = (s: string) =>
  s.replace(/^[\p{Extended_Pictographic}\u2700-\u27BF\u2600-\u26FF✦⭐✨🔥⚡🎁💎🧾💰🤝👤📖🛒🛍️]️?\s*/u, "");

// Brand premium emoji for gift items, matched on the product name. Falls back
// to whatever premium emoji the admin set on the product itself, then to null
// (caller then uses a plain emoji). Add a line here for each new brand.
const GIFT_PREMIUM_EMOJI: Array<{ match: RegExp; id: string }> = [
  { match: /canva/i, id: "5256251637646787356" },
  { match: /gemini/i, id: "5255920066171537833" },
];
function giftPremiumEmoji(productName: string, fallback?: string | null): string | null {
  for (const e of GIFT_PREMIUM_EMOJI) if (e.match.test(productName)) return e.id;
  return fallback ?? null;
}

function formatItemTitle(productName: string, variantName: string): string {
  const p = (productName || "").trim();
  const v = (variantName || "").trim();
  if (!v) return p;
  if (!p) return v;
  if (p.toLowerCase() === v.toLowerCase()) return p;

  const pBase = p.split(/\s*—\s*/)[0].trim();
  const pWord = pBase.split(/\s+/)[0].trim().toLowerCase();

  if (v.toLowerCase().includes(pBase.toLowerCase()) || (pWord.length > 2 && v.toLowerCase().startsWith(pWord))) {
    return v;
  }
  return `${p} — ${v}`;
}
function emojiIcon(emoji: string, premiumCode: string | null | undefined): string {
  const e = esc(emoji || "✨");
  return premiumCode ? `<tg-emoji emoji-id="${premiumCode}">${e}</tg-emoji>` : e;
}
const nextSort = (s: Sort): Sort => SORTS[(SORTS.indexOf(s) + 1) % SORTS.length];
const isAdmin = (ctx: Context) => ADMIN_ID !== "" && String(ctx.from?.id) === ADMIN_ID;
const soumToStars = (soum: number) => Math.max(1, Math.round((soum * STARS_PER_USDT) / UZS_PER_USDT));
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(lo, n), hi);

// Partially hide a buyer's identity for the public sales feed: keep the first
// and last visible chars, mask the middle. "Jahongir" → "Ja••••••ir".
function maskName(s: string): string {
  const v = (s ?? "").trim();
  if (!v) return "•••";
  if (v.length <= 2) return v[0] + "•";
  if (v.length <= 4) return v[0] + "••" + v.slice(-1);
  const keep = Math.min(2, v.length - 2);
  return v.slice(0, keep) + "•".repeat(Math.max(3, v.length - keep - 1)) + v.slice(-1);
}

// Per-user custom prices. Returns Map<variantId, { priceUzs, label }> for the
// given user (optionally scoped to variantIds). Only that user sees these prices.
async function priceOverridesFor(userId: number, variantIds?: number[]) {
  const m = new Map<number, { priceUzs: number; label: string }>();
  try {
    const rows = await db.userVariantPrice.findMany({
      where: { userId, ...(variantIds && variantIds.length ? { variantId: { in: variantIds } } : {}) },
    });
    for (const r of rows) m.set(r.variantId, { priceUzs: r.priceUzs, label: r.label });
  } catch (e) {
    // Table may not exist yet (pre-migration) — fall back to base prices.
    console.error("[bot] priceOverridesFor failed (using base prices):", (e as Error).message);
  }
  return m;
}

// Effective price + optional VIP label for one user+variant (override wins).
async function effPriceFor(userId: number, variantId: number, basePriceUzs: number): Promise<{ price: number; label: string | null }> {
  try {
    const ov = await db.userVariantPrice.findUnique({ where: { userId_variantId: { userId, variantId } } });
    return ov ? { price: ov.priceUzs, label: ov.label || null } : { price: basePriceUzs, label: null };
  } catch (e) {
    console.error("[bot] effPriceFor failed (using base price):", (e as Error).message);
    return { price: basePriceUzs, label: null };
  }
}

// Referral "points" a user currently has to spend: real invitees + admin
// bonus - already spent on referral-priced purchases. Falls back gracefully
// if the spentReferrals column hasn't been added yet (pre-migration).
async function availableReferralPoints(user: { id: number; tgId: string; bonusReferrals?: number | null; spentReferrals?: number | null }): Promise<number> {
  try {
    // Each invited user is counted exactly once (unique referredBy entry).
    // spentReferrals tracks already-redeemed points, preventing double-spend.
    const realRefs = await db.botUser.count({ where: { referredBy: user.tgId } });
    const total = realRefs + (user.bonusReferrals ?? 0);
    return Math.max(0, total - (user.spentReferrals ?? 0));
  } catch (e) {
    console.error("[bot] availableReferralPoints failed:", (e as Error).message);
    return 0;
  }
}

// Button colors (Bot API 9.4): success=green, danger=red, primary=blue.
function styleFor(data?: string): "primary" | "success" | "danger" | undefined {
  if (data === "noop") return undefined;
  if (!data) return "primary";
  if (/^(bc:|tstar|tcard|tman|ap:|top:)/.test(data)) return "success";
  if (/^rj:/.test(data)) return "danger";
  return "primary";
}

// Premium-emoji icon on navigation buttons (Bot API 9.4 icon_custom_emoji_id).
// Configurable via the `button_emoji` setting; loaded once at startup.
let buttonEmoji = "";
// Premium (custom) emoji ids shown on the wallet / profile buttons via the Bot
// API 9.4 `icon_custom_emoji_id` field. Button labels are plain text, so a
// `<tg-emoji>` tag would be printed literally there — only `.icon()` works.
// Overridable via the `wallet_button_emoji` / `profile_button_emoji` settings.
const PREMIUM_EMOJI_WALLET = "5224257782013769471";
const PREMIUM_EMOJI_PROFILE = "5258011929993026890";
const PREMIUM_EMOJI_ORDERS = "5967412305338568701";
const PREMIUM_EMOJI_BACK = "5416113713428057601";
const PREMIUM_EMOJI_SUPPORT = "4970126766132691795";
const PREMIUM_EMOJI_REFER = "6048721430730773527";
const PREMIUM_EMOJI_GIFTS = "5203996991054432397";
const PREMIUM_EMOJI_SHOP = "5859297284029681680";
let walletButtonEmoji = PREMIUM_EMOJI_WALLET;
let profileButtonEmoji = PREMIUM_EMOJI_PROFILE;
let ordersButtonEmoji = PREMIUM_EMOJI_ORDERS;
let backButtonEmoji = PREMIUM_EMOJI_BACK;
let supportButtonEmoji = PREMIUM_EMOJI_SUPPORT;
let referButtonEmoji = PREMIUM_EMOJI_REFER;
let giftsButtonEmoji = PREMIUM_EMOJI_GIFTS;
let shopButtonEmoji = PREMIUM_EMOJI_SHOP;
const ICON_TEXTS = new Set(LANGS.map((l) => t(l, "refresh"))); // 🔄 animated emoji on "Обновить"
// Every "back"-style label in every language. Buttons carrying one of these get
// the premium back-arrow icon (and their plain ⬅️ stripped) in the API
// middleware below — one place instead of ~40 call sites.
const BACK_KEYS = ["back", "back_to_list", "to_shop"] as const;
const BACK_TEXTS = new Set(LANGS.flatMap((l) => BACK_KEYS.map((k) => t(l, k))));
const SUPPORT_TEXTS = new Set(LANGS.map((l) => t(l, "btn_support")));
const REFER_TEXTS = new Set(LANGS.map((l) => t(l, "btn_refer")));
const GIFTS_TEXTS = new Set(LANGS.map((l) => t(l, "btn_freebies")));
const WALLET_TEXTS = new Set(LANGS.map((l) => t(l, "btn_wallet")));
const PROFILE_TEXTS = new Set(LANGS.map((l) => t(l, "btn_profile")));
const ORDERS_TEXTS = new Set(LANGS.map((l) => t(l, "btn_orders")));
const SHOP_TEXTS = new Set(LANGS.map((l) => t(l, "btn_shop")));

// Premium icon for a button label, or undefined if it isn't one of ours.
// Bot API 9.4 supports `icon_custom_emoji_id` on BOTH inline and reply-keyboard
// buttons, so this is applied to either kind in the API middleware below.
function premiumIconFor(text: string): string | undefined {
  if (BACK_TEXTS.has(text)) return backButtonEmoji;
  if (SUPPORT_TEXTS.has(text)) return supportButtonEmoji;
  if (REFER_TEXTS.has(text)) return referButtonEmoji;
  if (GIFTS_TEXTS.has(text)) return giftsButtonEmoji;
  if (WALLET_TEXTS.has(text)) return walletButtonEmoji;
  if (PROFILE_TEXTS.has(text)) return profileButtonEmoji;
  if (ORDERS_TEXTS.has(text)) return ordersButtonEmoji;
  if (SHOP_TEXTS.has(text)) return shopButtonEmoji;
  return undefined;
}

function mainKeyboard(lang: string) {
  return new Keyboard()
    .text(t(lang, "btn_shop")).row()
    .text(t(lang, "btn_wallet")).text(t(lang, "btn_freebies")).row()
    .text(t(lang, "btn_profile")).text(t(lang, "btn_instructions")).row()
    .resized().persistent();
}

function langKeyboard() {
  const kb = new InlineKeyboard();
  for (const l of LANGS) kb.text(LANG_NAMES[l], `lang:${l}`).row();
  return kb;
}

async function setting(key: string, fallback: string): Promise<string> {
  const s = await db.setting.findUnique({ where: { key } });
  return s?.valueRu?.trim() || fallback;
}

async function findUser(ctx: Context) {
  return db.botUser.findUnique({ where: { tgId: String(ctx.from!.id) } });
}

async function getUser(ctx: Context, refParam?: string) {
  const from = ctx.from!;
  const tgId = String(from.id);
  const existing = await db.botUser.findUnique({ where: { tgId } });
  if (existing) {
    // Write only when the profile actually changed — avoids a DB write per click.
    const uname = from.username ?? null;
    const fname = from.first_name ?? null;
    if (existing.username !== uname || existing.firstName !== fname) {
      return db.botUser.update({ where: { tgId }, data: { username: uname, firstName: fname } });
    }
    return existing;
  }
  let referredBy: string | null = null;
  if (refParam && refParam.startsWith("ref")) {
    const refId = refParam.slice(3).trim();
    if (refId && refId !== tgId) {
      const referrer = await db.botUser.findUnique({ where: { tgId: refId }, select: { refBanned: true } }).catch(() => null);
      if (referrer && !referrer.refBanned) referredBy = refId;
    }
  }
  const created = await db.botUser.create({
    data: { tgId, username: from.username ?? null, firstName: from.first_name ?? null, referredBy },
  });
  // No automatic gift here any more — the referrer earns 1 point per invite
  // and spends them explicitly in the /gifts shop when they're ready.
  return created;
}

async function stockMap(): Promise<Map<number, number>> {
  const rows = await db.stockItem.groupBy({ by: ["variantId"], where: { isSold: false }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.variantId, r._count._all]));
}
// Sentinel "stock" used internally for manual-delivery items with no explicit
// cap (admin fulfils by hand, so supply is effectively unlimited). Never show
// this number to the buyer as-is — render it via stockDisplay() instead.
const STOCK_UNLIMITED = 999999;
const stockDisplay = (n: number): string => (n >= STOCK_UNLIMITED ? "♾" : String(n));

async function availableStock(v: { id: number; autoSupplier: boolean; supplierStock: number; manualDelivery?: boolean; manualStockLimit?: number }): Promise<number> {
  if (v.manualDelivery) {
    return v.manualStockLimit !== undefined && v.manualStockLimit >= 0 ? v.manualStockLimit : STOCK_UNLIMITED;
  }
  const local = await db.stockItem.count({ where: { variantId: v.id, isSold: false } });
  // Local stock + API stock (both available; local is used first in doBuy)
  return local + (v.autoSupplier ? v.supplierStock : 0);
}
// Resolve a supplier API source by slug (Variant.supplierKey). Falls back to env Vex.
async function resolveSource(slug: string | null | undefined): Promise<Source | null> {
  if (!slug) return null;
  const row = await db.apiSource.findFirst({ where: { slug, isActive: true } });
  if (row) return { slug: row.slug, baseUrl: row.baseUrl, apiKey: row.apiKey, format: row.format };
  return slug === "vex" ? envVexSource() : null;
}
async function disclaimerFor(lang: string): Promise<string> {
  const custom = await setting("disclaimer", "");
  if (!custom) return ""; // no default text — admin writes their own in settings
  return lang === "ru" ? custom : await translate(custom, lang);
}

// Auto-translation of product text into EN/UZ via Gemini, cached in memory.
// Falls back to the original text on any failure.
const trCache = new Map<string, string>();
async function translate(text: string, target: string): Promise<string> {
  const s = (text ?? "").trim();
  if (!s || target === "ru") return text;
  const key = `${target}:${s}`;
  const hit = trCache.get(key);
  if (hit !== undefined) return hit;
  const out = await geminiTranslate(s, target);
  const result = out || text; // fallback to original if Gemini unavailable
  trCache.set(key, result);
  return result;
}
// Localized product/variant name: ru as-is, uz if admin provided a real one, else auto-translate.
async function locName(ru: string, uz: string | null | undefined, lang: string): Promise<string> {
  if (lang === "ru" || !ru) return ru;
  if (lang === "uz") return uz && uz.trim() && uz.trim() !== ru.trim() ? uz : translate(ru, "uz");
  return translate(ru, "en");
}
// Product text with stored EN/UZ (from import/retranslate); auto-translates if a field is empty.
async function pick3(ru: string, en: string | null | undefined, uz: string | null | undefined, lang: string): Promise<string> {
  if (lang === "ru" || !ru) return ru;
  const stored = lang === "en" ? en : uz;
  if (stored && stored.trim()) return stored;
  return translate(ru, lang);
}
async function prewarmTranslations() {
  try {
    const products = await db.product.findMany({ where: { isActive: true }, select: { titleRu: true } });
    for (const p of products) {
      await translate(p.titleRu, "en");
      await translate(p.titleRu, "uz");
    }
  } catch {
    /* best effort */
  }
}

// Note: the old tier-threshold auto-grant system (giftTiers/grantReferralReward)
// was retired in favor of an explicit points shop — see showGifts / buyForReferrals.
// pointsCost on each Variant is now the single source of truth for referral pricing.

async function buildHeader(): Promise<{ text: string; entities: MessageEntity[] }> {
  const [storeName, emoji, premium, tagline] = await Promise.all([
    setting("store_name", "SB Store"),
    setting("menu_emoji", "🛍"),
    setting("menu_premium_emoji", ""),
    setting("menu_tagline", ""),
  ]);
  const prefix = `${emoji} `;
  const text = tagline ? `${prefix}${storeName}\n${tagline}` : `${prefix}${storeName}`;
  const entities: MessageEntity[] = [];
  if (premium) entities.push({ type: "custom_emoji", offset: 0, length: emoji.length, custom_emoji_id: premium });
  entities.push({ type: "bold", offset: prefix.length, length: storeName.length });
  return { text, entities };
}

// ---------- storefront ----------
async function buildMenu(lang: string, balance: number, page: number, sort: Sort, userId: number, freebies = false) {
  const [products, stock, overrides] = await Promise.all([
    db.product.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      include: { plans: { include: { variants: { where: { isActive: true } } } } },
    }),
    stockMap(),
    priceOverridesFor(userId),
  ]);
  const stOf = (v: { id: number; autoSupplier: boolean; supplierStock: number; manualDelivery: boolean }) =>
    v.manualDelivery ? STOCK_UNLIMITED : v.autoSupplier ? v.supplierStock : stock.get(v.id) ?? 0;
  const priceOf = (v: { id: number; priceUzs: number }) => overrides.get(v.id)?.priceUzs ?? v.priceUzs;

  let items = await Promise.all(
    products.map(async (p) => {
      const variants = p.plans.flatMap((pl) => pl.variants);
      const prices = variants.map((v) => priceOf(v)).filter((x) => x > 0);
      const minPrice = prices.length ? Math.min(...prices) : 0;
      const st = variants.reduce((s, v) => s + stOf(v), 0);
      const hasFree = variants.some((v) => priceOf(v) <= 0 && stOf(v) > 0);
      return { id: p.id, emoji: p.emoji || "✨", premiumEmoji: p.premiumEmoji ?? null, title: await pick3(p.titleRu, p.titleEn, p.titleUz, lang), minPrice, stock: st, hasFree };
    }),
  );

  if (freebies) items = items.filter((i) => i.hasFree);
  if (sort === "price") items.sort((a, b) => a.minPrice - b.minPrice);
  else if (sort === "stock") items.sort((a, b) => b.stock - a.stock);

  // No pagination — every product is shown at once.
  const kb = new InlineKeyboard();
  for (const it of items) {
    const price = it.minPrice > 0 ? money(it.minPrice, lang) : t(lang, "free");
    const cleanTitle = stripLeadEmoji(it.title);
    if (it.premiumEmoji) {
      kb.text(`${cleanTitle} - ${price}`, `p:${it.id}:0:${sort}`).icon(it.premiumEmoji).row();
    } else {
      kb.text(`${it.emoji} ${cleanTitle} - ${price}`, `p:${it.id}:0:${sort}`).row();
    }
  }
  if (!freebies && items.length > 0) {
    kb.text(stripLeadEmoji(t(lang, "btn_wallet")), "bal").icon(walletButtonEmoji)
      .text(stripLeadEmoji(t(lang, "btn_orders")), "ord").icon(ordersButtonEmoji).row();
    kb.text(stripLeadEmoji(t(lang, "btn_profile")), "profile_show").icon(profileButtonEmoji).row();
    // Marketing teaser: advertise the priciest referral-shop item right in the
    // catalog, so people see there's a way to get it for free. Tapping it
    // opens the Подарки shop. Uses getGiftVariants() — the same source the
    // gifts shop reads — so items configured via the admin's tier settings
    // (not just Variant.pointsCost) show up here too.
    const gifts = await getGiftVariants().catch(() => []);
    const topGift = gifts.length ? gifts[gifts.length - 1] : null; // sorted asc by cost
    if (topGift) {
      const gp = lang === "uz" ? topGift.variant.plan.product.titleUz || topGift.variant.plan.product.titleRu : topGift.variant.plan.product.titleRu;
      const gv = lang === "uz" ? topGift.variant.titleUz || topGift.variant.titleRu : topGift.variant.titleRu;
      const title = formatItemTitle(gp, gv);
      const premium = giftPremiumEmoji(gp, topGift.variant.plan.product.premiumEmoji);
      const btn = kb.text(`${premium ? "" : "🎁 "}${title} — ${t(lang, "free")}`, "gifts_show");
      if (premium) btn.icon(premium);
      kb.row();
    }
  }

  const head = freebies ? t(lang, "promo_title") : t(lang, "products_available");
  const text =
    `${t(lang, "balance_line", { v: money(balance, lang) })}\n\n` +
    (items.length === 0
      ? freebies ? t(lang, "no_promo") : t(lang, "catalog_empty")
      : `<b>${head}</b>\n${t(lang, "choose_below")}`);
  return { text, kb };
}

async function showMenu(ctx: Context, page: number, sort: Sort, edit: boolean, freebies = false) {
  try {
    const user = await getUser(ctx);
    const { text, kb } = await buildMenu(user.lang, user.balance, page, sort, user.id, freebies);
    // The main catalog page (not the freebies view) leads with the shop
    // banner as one combined photo+caption+buttons message. sendOrEdit
    // handles the media-vs-text edit correctness for callback navigation.
    const banner = !freebies ? shopBannerFile() : null;
    if (edit) {
      await sendOrEdit(ctx, text, { reply_markup: kb, photo: banner });
    } else if (banner) {
      await ctx.replyWithPhoto(banner, { caption: text, parse_mode: "HTML", reply_markup: kb }).catch(async () => {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
      });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }
  } catch (err) {
    console.error("Error in showMenu:", err);
    await ctx.reply(`⚠️ Ошибка в меню: ${(err as Error).message}\n${(err as Error).stack}`).catch(() => {});
  }
}

async function showProduct(ctx: Context, id: number, back: string) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const p = await db.product.findUnique({
    where: { id },
    include: { plans: { include: { variants: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } } } },
  });
  if (!p) return ctx.answerCallbackQuery({ text: t(lang, "out_of_stock"), show_alert: true });

  const variants = p.plans.flatMap((pl) => pl.variants);
  const overrides = await priceOverridesFor(user.id, variants.map((v) => v.id));
  const availablePoints = await availableReferralPoints(user);
  const kb = new InlineKeyboard();
  for (const v of variants) {
    const st = await availableStock(v);
    const ov = overrides.get(v.id);
    const effPrice = ov?.priceUzs ?? v.priceUzs;
    const price = effPrice > 0 ? `${ov ? "💎 " : ""}${money(effPrice, lang)}` : t(lang, "free");
    const dur = v.durationDays > 0 ? ` · ${v.durationDays}д` : "";
    const vt = await locName(v.titleRu, v.titleUz, lang);
    kb.text(`${vt} — ${price}${dur}`, `b:${v.id}:${back}`).icon("5424972470023104089").row();
    // Referrals-price row: shown only when admin set a pointsCost for this
    // variant. Label mentions the user's own available points so they see
    // whether they can afford it without extra taps.
    if (v.pointsCost > 0 && st > 0) {
      const canAfford = availablePoints >= v.pointsCost;
      const premium = giftPremiumEmoji(p.titleRu, p.premiumEmoji);
      const rbBtn = kb.text(
        `${premium ? "" : canAfford ? "🎁 " : "⏳ "}${vt} — ${v.pointsCost} реф. (у вас: ${availablePoints})`,
        `rb:${v.id}:${back}`,
      );
      if (premium) rbBtn.icon(premium);
      kb.row();
    }
  }
  kb.text(t(lang, "back_to_list"), `m:${back}`).row();

  const pt = await pick3(p.titleRu, p.titleEn, p.titleUz, lang);
  const pd = await pick3(p.descRu ?? "", p.descEn, p.descUz, lang);
  const plainDesc = pd?.trim() ? stripTags(pd.trim()) : "";
  const emojiStr = p.emoji || "✨";

  let text = "";
  const entities: MessageEntity[] = [];

  // 1. Header (emoji + title)
  text += `${emojiStr} ${pt}`;
  if (p.premiumEmoji) {
    entities.push({
      type: "custom_emoji",
      offset: 0,
      length: emojiStr.length,
      custom_emoji_id: p.premiumEmoji,
    });
  }
  entities.push({
    type: "bold",
    offset: emojiStr.length + 1,
    length: pt.length,
  });

  // 2. Description
  if (plainDesc) {
    text += `\n\n${plainDesc}`;
  }

  // 3. Stock levels
  if (variants.length > 0) {
    const stockHeaderOffset = text.length + 2; // \n\n
    text += `\n\n🛍 В наличии:`;
    entities.push({
      type: "bold",
      offset: stockHeaderOffset,
      length: `🛍 В наличии:`.length,
    });

    const premiumStockEmojiId = "5416081784641168838";
    for (const v of variants) {
      const st = await availableStock(v);
      const vt = await locName(v.titleRu, v.titleUz, lang);

      text += `\n• ${vt}: `;
      const emojiOffset = text.length;
      text += "🔖";
      entities.push({
        type: "custom_emoji",
        offset: emojiOffset,
        length: "🔖".length,
        custom_emoji_id: premiumStockEmojiId,
      });

      const boldStart = text.length;
      const stLabel = st >= STOCK_UNLIMITED ? "♾" : `${st} шт.`;
      text += ` ${stLabel}`;
      entities.push({
        type: "bold",
        offset: boldStart + 1, // skip the leading space
        length: stLabel.length,
      });
    }
  }

  // 4. Plan chooser suffix
  const suffix = `\n\n${t(lang, "choose_plan")}`;
  text += suffix;

  // Product card uses message entities (custom_emoji/bold), not HTML — so the
  // parse_mode-based sendOrEdit doesn't apply here. Try in-place text edit
  // first (fast, no flicker); if the source was a photo message (catalog
  // banner), delete it and post fresh so the entities render correctly.
  try {
    await ctx.editMessageText(text, { reply_markup: kb, entities });
  } catch {
    await ctx.deleteMessage().catch(() => {});
    try {
      await ctx.reply(text, { reply_markup: kb, entities });
    } catch {
      await ctx.reply(`${emojiStr} ${pt}${plainDesc ? `\n\n${plainDesc}` : ""}${suffix}`, { reply_markup: kb }).catch(() => {});
    }
  }
  await ctx.answerCallbackQuery().catch(() => {});
}

// ---------- quantity chooser ----------
async function buildQtyChooser(
  v: { id: number; priceUzs: number; autoSupplier: boolean; supplierStock: number; titleRu: string; titleUz: string; durationDays: number; plan: { product: { id: number; titleRu: string; titleEn: string; titleUz: string } } },
  lang: string,
  balance: number,
  qty: number,
  back: string,
  unitPrice: number,
  vipLabel: string | null,
) {
  const pt = await pick3(v.plan.product.titleRu, v.plan.product.titleEn, v.plan.product.titleUz, lang);
  const vt = await locName(v.titleRu, v.titleUz, lang);
  const title = `${pt} — ${vt}`;
  const max = await availableStock(v);
  if (max <= 0) return null;
  qty = clamp(Math.floor(qty) || 1, 1, max);
  const total = unitPrice * qty;
  const disclaimer = await disclaimerFor(lang);

  const kb = new InlineKeyboard()
    .text("➖", `q:${v.id}:${qty - 1}:${back}`)
    .text(`${qty}`, "noop")
    .text("➕", `q:${v.id}:${qty + 1}:${back}`)
    .row()
    .text(t(lang, "enter_qty_btn"), `qi:${v.id}:${back}`)
    .row();
  // Skip the "buy max" shortcut for unlimited manual-delivery items — there's
  // no real ceiling to jump to, and 999999 would be a nonsensical quantity.
  if (max > 1 && max < STOCK_UNLIMITED) kb.text(t(lang, "maximum", { n: max }), `q:${v.id}:${max}:${back}`).row();
  kb.text(t(lang, "buy_for", { v: money(total, lang) }), `bc:${v.id}:${qty}`).row();
  kb.text(t(lang, "back"), `p:${v.plan.product.id}:${back}`);

  const text =
    `🧾 <b>${esc(title)}</b>\n\n` +
    (vipLabel ? `💎 <b>${esc(vipLabel)}</b>\n` : "") +
    `${t(lang, "price_each", { v: unitPrice > 0 ? money(unitPrice, lang) : t(lang, "free") })}\n` +
    `${t(lang, "in_stock", { n: stockDisplay(max) })}\n` +
    `${t(lang, "qty", { n: qty })}\n` +
    `${t(lang, "total", { v: money(total, lang) })}\n` +
    `${t(lang, "your_balance", { v: money(balance, lang) })}` +
    (disclaimer ? `\n\n${disclaimer}` : "");
  return { text, kb, max };
}

async function showQtyChooser(ctx: Context, variantId: number, qty: number, back: string, edit: boolean) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const ack = (o?: { text: string; show_alert: boolean }) =>
    ctx.callbackQuery ? ctx.answerCallbackQuery(o).catch(() => {}) : Promise.resolve();
  const v = await db.variant.findUnique({ where: { id: variantId }, include: { plan: { include: { product: true } } } });
  if (!v || !v.isActive) return ack({ text: t(lang, "plan_unavailable"), show_alert: true });
  const eff = await effPriceFor(user.id, variantId, v.priceUzs);
  const built = await buildQtyChooser(v, lang, user.balance, qty, back, eff.price, eff.label);
  if (!built) {
    const pt = await pick3(v.plan.product.titleRu, v.plan.product.titleEn, v.plan.product.titleUz, lang);
    const vt = await locName(v.titleRu, v.titleUz, lang);
    const noStockText = `😔 <b>${esc(pt)} — ${esc(vt)}</b>\n\n${t(lang, "out_of_stock_msg")}`;
    const noStockKb = new InlineKeyboard()
      .text("🔔 " + t(lang, "notify_btn"), `na:${variantId}`).row()
      .text(t(lang, "back"), `p:${v.plan.product.id}:${back}`);
    if (edit) await sendOrEdit(ctx, noStockText, { reply_markup: noStockKb });
    else await ctx.reply(noStockText, { parse_mode: "HTML", reply_markup: noStockKb });
    return ack();
  }
  if (edit) {
    await sendOrEdit(ctx, built.text, { reply_markup: built.kb });
  } else {
    await ctx.reply(built.text, { parse_mode: "HTML", reply_markup: built.kb });
  }
  await ack();
}

// ---------- deliver / notify ----------
async function deliverOrder(ctx: Context, lang: string, title: string, orderId: number, price: number, balance: number, payload: string) {
  await ctx.editMessageText(
    `${t(lang, "order_paid", { id: orderId })}\n\n` +
      `${esc(title)}\n${t(lang, "charged", { v: money(price, lang) })}\n` +
      `${t(lang, "remaining", { v: money(balance, lang) })}\n\n` +
      `${t(lang, "your_goods")}\n<code>${esc(payload)}</code>`,
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all") },
  ).catch(() => {});
}
async function notifySale(ctx: Context, user: { firstName: string | null; username: string | null; tgId: string }, title: string, price: number, orderId: number, source: string, lang: string) {
  if (!ADMIN_ID) return;
  await ctx.api.sendMessage(ADMIN_ID, `🛒 (${source}) <b>${esc(title)}</b>\n${user.firstName ?? ""} @${user.username ?? "—"} (${user.tgId})\n${money(price, lang)} · #${orderId}`, { parse_mode: "HTML" }).catch(() => {});
}

// Public "sales feed": posts every purchase to the group set in the
// `sales_group_id` setting, with the buyer's name masked. Add the bot to the
// group (as admin) and put the group's chat id (e.g. -1001234567890) in settings.
async function notifySalesGroup(user: { firstName: string | null; username: string | null; tgId: string }, title: string, price: number) {
  const groupId = (await setting("sales_group_id", "")).trim();
  if (!groupId) return;
  const shown = maskName(user.firstName || user.username || user.tgId);
  const text =
    `🛒 <b>Новая покупка!</b>\n\n` +
    `👤 ${esc(shown)}\n` +
    `📦 ${esc(title)}\n` +
    `💰 <b>${money(price, "ru")}</b>`;
  await bot.api.sendMessage(groupId, text, { parse_mode: "HTML" }).catch((e) => {
    console.error("[bot] sales group notify failed:", (e as Error).message);
  });
}

async function executePurchase(tgId: string, variantId: number, qty: number, refPointsCost?: number) {
  const isRefGift = refPointsCost !== undefined && refPointsCost > 0;
  const user = await db.botUser.findUnique({ where: { tgId } });
  if (!user) return;
  const lang = user.lang;
  const v = await db.variant.findUnique({ where: { id: variantId }, include: { plan: { include: { product: true } } } });
  if (!v || !v.isActive) {
    await bot.api.sendMessage(tgId, t(lang, "plan_unavailable")).catch(() => {});
    return;
  }
  const pt = await pick3(v.plan.product.titleRu, v.plan.product.titleEn, v.plan.product.titleUz, lang);
  const vt = await locName(v.titleRu, v.titleUz, lang);
  const baseTitle = `${pt} — ${vt}`;
  const max = await availableStock(v);
  if (max <= 0) {
    await bot.api.sendMessage(tgId, t(lang, "out_of_stock")).catch(() => {});
    return;
  }
  const finalQty = clamp(Math.floor(qty) || 1, 1, max);
  const eff = await effPriceFor(user.id, variantId, v.priceUzs);
  const total = isRefGift ? 0 : eff.price * finalQty;
  const label = finalQty > 1 ? `${baseTitle} ×${finalQty}` : baseTitle;

  // --- Manual delivery: charge, then the admin sends the goods by hand ---
  if (v.manualDelivery) {
    const reserve = await db.$transaction(async (tx) => {
      const u = await tx.botUser.findUnique({ where: { id: user.id } });
      if (!u) return { error: "unavailable" as const };
      if (!isRefGift && u.balance < total) return { error: "balance" as const };
      
      const freshV = await tx.variant.findUnique({ where: { id: variantId } });
      if (!freshV || !freshV.isActive) return { error: "unavailable" as const };
      
      if (freshV.manualStockLimit >= 0) {
        if (freshV.manualStockLimit < finalQty) return { error: "stock" as const };
        await tx.variant.update({
          where: { id: variantId },
          data: { manualStockLimit: { decrement: finalQty } },
        });
      }

      if (!isRefGift && total > 0) {
        await tx.botUser.update({ where: { id: user.id }, data: { balance: { decrement: total } } });
      }
      const order = await tx.botOrder.create({ data: { userId: user.id, variantId, titleRu: label, priceUsdt: 0, payload: "", source: isRefGift ? "referral" : "manual", status: "awaiting_delivery" } });
      return { orderId: order.id };
    });

    if ("error" in reserve) {
      const errText = reserve.error === "balance"
        ? t(lang, "not_enough_funds")
        : reserve.error === "stock"
        ? t(lang, "no_stock_left")
        : t(lang, "plan_unavailable");
      await bot.api.sendMessage(tgId, errText).catch(() => {});
      return;
    }

    const code = generateVerificationCode(reserve.orderId);
    const supportUser = (await setting("support_username", "Aiobuna_support")).replace(/^@/, "");

    const kb = new InlineKeyboard()
      .url(t(lang, "admin_topup"), `https://t.me/${supportUser}`)
      .row()
      .text(t(lang, "to_shop"), "m:0:all");

    await bot.api.sendMessage(
      tgId,
      t(lang, "manual_paid", { id: reserve.orderId, code, admin: supportUser, product: label }),
      { parse_mode: "HTML", reply_markup: kb }
    ).catch(() => {});

    if (ADMIN_ID) {
      await bot.api.sendMessage(
        ADMIN_ID,
        `📦 <b>Ручная выдача (${isRefGift ? "🎁 подарок" : "заказ"}, #${reserve.orderId})</b>\n` +
        `Товар: ${esc(label)} — ${isRefGift ? `${refPointsCost} реф.` : money(total, lang)}\n` +
        `Покупатель: ${user.firstName ?? ""} @${user.username ?? "—"} (${user.tgId})\n` +
        `Код проверки: <code>${code}</code>\n\n` +
        `Выдать: <code>/give ${reserve.orderId} логин:пароль</code>`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
    await notifySalesGroup(user, label, 0);
    return;
  }

  // --- HYBRID FULFILLMENT: stock FIRST, then supplier, then combine ---
  // 1. Gather from local stock (take what's available, don't fail if partial)
  const localCount = await db.stockItem.count({ where: { variantId, isSold: false } });
  const stockQty = Math.min(localCount, finalQty);
  const supplierQty = finalQty - stockQty;

  // Charge & create order in a transaction
  const reserve = await db.$transaction(async (tx) => {
    const u = await tx.botUser.findUnique({ where: { id: user.id } });
    if (!u) return { error: "unavailable" as const };
    if (!isRefGift && u.balance < total) return { error: "balance" as const };
    if (!isRefGift && total > 0) {
      await tx.botUser.update({ where: { id: user.id }, data: { balance: { decrement: total } } });
    }
    const order = await tx.botOrder.create({
      data: {
        userId: user.id,
        variantId,
        titleRu: label,
        priceUsdt: 0,
        payload: "", // populated below as we gather items
        source: isRefGift ? "referral" : "hybrid", // stock + supplier
        status: "processing",
      },
    });
    return { orderId: order.id, order };
  });

  if ("error" in reserve) {
    await bot.api.sendMessage(tgId, t(lang, "not_enough_funds")).catch(() => {});
    return;
  }

  const procMsg = await bot.api.sendMessage(tgId, t(lang, "processing")).catch(() => {});
  const payloads: string[] = [];
  let stockDeliveredQty = 0;
  // Supplier delivery is all-or-nothing per call — either sourceOrder() returns
  // the full requested quantity, or it throws and we got none of it.
  let supplierOk = supplierQty === 0;

  try {
    // 2. Grab stock items
    if (stockQty > 0) {
      const items = await db.stockItem.findMany({
        where: { variantId, isSold: false },
        orderBy: { id: "asc" },
        take: stockQty,
      });
      if (items.length > 0) {
        payloads.push(items.map((it) => it.payload).join("\n"));
        stockDeliveredQty = items.length;
        await db.stockItem.updateMany({
          where: { id: { in: items.map((it) => it.id) } },
          data: { isSold: true, soldAt: new Date(), orderId: reserve.orderId },
        });
      }
    }

    // 3. Grab remaining from supplier
    if (supplierQty > 0 && v.autoSupplier && v.supplierKey && v.supplierExternalId) {
      const src = await resolveSource(v.supplierKey);
      if (src) {
        try {
          const delivered = await sourceOrder(src, v.supplierExternalId, supplierQty);
          if (delivered.payload) {
            payloads.push(delivered.payload);
            supplierOk = true;
          }
        } catch (supplierErr) {
          console.error("[bot] supplier fail:", (supplierErr as Error).message);
        }
      }
    }

    const finalPayload = payloads.filter((p) => p.trim().length > 0).join("\n");
    const deliveredQty = stockDeliveredQty + (supplierOk ? supplierQty : 0);
    const shortfall = finalQty - deliveredQty;

    // Stock/supplier couldn't fully cover the order. Never just refund and shrug —
    // the charge stays (no need for the buyer to pay again), the order becomes an
    // "awaiting_delivery" ticket with a verification code, and the admin can
    // complete it by hand via /give or the "Проверка кодов" admin page (same
    // mechanism already used for manualDelivery items).
    if (shortfall > 0) {
      await db.botOrder.update({
        where: { id: reserve.orderId },
        data: { payload: finalPayload, status: "awaiting_delivery" },
      });
      const code = generateVerificationCode(reserve.orderId);
      const supportUser = (await setting("support_username", "Aiobuna_support")).replace(/^@/, "");
      const kb = new InlineKeyboard().url(t(lang, "admin_topup"), `https://t.me/${supportUser}`).row().text(t(lang, "to_shop"), "m:0:all");

      if (deliveredQty === 0) {
        const msg = t(lang, "delivery_issue_full", { id: reserve.orderId, code, admin: supportUser, product: label });
        if (procMsg) await bot.api.editMessageText(tgId, procMsg.message_id, msg, { parse_mode: "HTML", reply_markup: kb }).catch(() => bot.api.sendMessage(tgId, msg, { parse_mode: "HTML", reply_markup: kb }).catch(() => {}));
        else await bot.api.sendMessage(tgId, msg, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
      } else {
        // Deliver the part we did get, then a follow-up with the code for the rest.
        if (deliveredQty > 5) {
          const fileContent = Buffer.from(finalPayload, "utf-8");
          await bot.api.sendDocument(tgId, new InputFile(fileContent, `order_${reserve.orderId}.txt`), {
            caption: `📄 ${esc(label)} (${deliveredQty}/${finalQty})`,
          }).catch(() => {});
        } else if (procMsg) {
          await bot.api.editMessageText(
            tgId, procMsg.message_id,
            `${t(lang, "your_goods")}\n<code>${esc(finalPayload)}</code>`,
            { parse_mode: "HTML" },
          ).catch(() => {});
        }
        const msg = t(lang, "delivery_issue_partial", { id: reserve.orderId, got: deliveredQty, total: finalQty, missing: shortfall, code, admin: supportUser, product: label });
        await bot.api.sendMessage(tgId, msg, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
      }

      if (ADMIN_ID) {
        const gotLine = deliveredQty > 0 ? `Уже выдано автоматически:\n<code>${esc(finalPayload)}</code>\n\n` : "";
        await bot.api.sendMessage(
          ADMIN_ID,
          `⚠️ <b>Довыдать вручную, заказ #${reserve.orderId}</b> (${deliveredQty}/${finalQty})\n` +
          `Товар: ${esc(label)} — ${isRefGift ? `${refPointsCost} реф.` : money(total, lang)}\n` +
          `Покупатель: ${user.firstName ?? ""} @${user.username ?? "—"} (${user.tgId})\n` +
          `Код проверки: <code>${code}</code>\n\n` +
          gotLine +
          `Довыдать недостающее (${shortfall} шт.): <code>/give ${reserve.orderId} ...</code> или через «Проверка кодов» в панели.`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      }
      if (deliveredQty > 0) await notifySalesGroup(user, label, 0);
      return;
    }

    await db.botOrder.update({
      where: { id: reserve.orderId },
      data: { payload: finalPayload, status: "delivered" },
    });

    // Success: show delivery. One message: the how-to-activate video with the
    // order confirmation as its caption (a text message can't gain a video via
    // edit, so the "processing…" placeholder is deleted and replaced instead
    // of stacking a separate video on top of it).
    const u = await db.botUser.findUnique({ where: { id: user.id } });
    const isLargeOrder = deliveredQty > 5;
    const activateVideo = howToActivateFile();
    const deliveredKb = new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all");

    const chargeLine = isRefGift
      ? `🎁 <b>Подарок за ${refPointsCost} реф.</b>`
      : `${t(lang, "charged", { v: money(total, lang) })}`;

    if (isLargeOrder) {
      // Large order: confirmation (+ video if any) first, links follow as a .txt file.
      const confirmText =
        `${t(lang, "order_paid", { id: reserve.orderId })}\n\n` +
        `${esc(label)}\n${chargeLine}\n` +
        `${t(lang, "remaining", { v: money(u?.balance ?? 0, lang) })}\n\n` +
        `✅ <b>Файл со ссылками отправляется...</b>`;
      if (activateVideo) {
        if (procMsg) await bot.api.deleteMessage(tgId, procMsg.message_id).catch(() => {});
        await bot.api.sendVideo(tgId, activateVideo, { caption: confirmText, parse_mode: "HTML", reply_markup: deliveredKb }).catch(async () => {
          await bot.api.sendMessage(tgId, confirmText, { parse_mode: "HTML", reply_markup: deliveredKb }).catch(() => {});
        });
      } else if (procMsg) {
        await bot.api.editMessageText(tgId, procMsg.message_id, confirmText, { parse_mode: "HTML", reply_markup: deliveredKb }).catch(() => {});
      }
      const filename = `order_${reserve.orderId}.txt`;
      const fileContent = Buffer.from(finalPayload, "utf-8");
      await bot.api.sendDocument(tgId, new InputFile(fileContent, filename), {
        caption: `📄 ${esc(label)} (${deliveredQty} ссылок)`,
      }).catch(() => {});
    } else {
      // Small order: the delivered goods themselves are the caption.
      const confirmText =
        `${t(lang, "order_paid", { id: reserve.orderId })}\n\n` +
        `${esc(label)}\n${chargeLine}\n` +
        `${t(lang, "remaining", { v: money(u?.balance ?? 0, lang) })}\n\n` +
        `${t(lang, "your_goods")}\n<code>${esc(finalPayload)}</code>`;
      if (activateVideo) {
        if (procMsg) await bot.api.deleteMessage(tgId, procMsg.message_id).catch(() => {});
        await bot.api.sendVideo(tgId, activateVideo, { caption: confirmText, parse_mode: "HTML", reply_markup: deliveredKb }).catch(async () => {
          await bot.api.sendMessage(tgId, confirmText, { parse_mode: "HTML", reply_markup: deliveredKb }).catch(() => {});
        });
      } else if (procMsg) {
        await bot.api.editMessageText(tgId, procMsg.message_id, confirmText, { parse_mode: "HTML", reply_markup: deliveredKb }).catch(() => {});
      }
    }

    if (ADMIN_ID) {
      const source = stockQty > 0 && supplierQty > 0 ? "склад+поставщик" : stockQty > 0 ? "склад" : "поставщик";
      await bot.api
        .sendMessage(ADMIN_ID, `🛒 (${source}) <b>${esc(label)}</b>\n${user.firstName ?? ""} @${user.username ?? "—"} (${user.tgId})\n${isRefGift ? `🎁 ${refPointsCost} реф.` : money(total, lang)} · #${reserve.orderId}`, {
          parse_mode: "HTML",
        })
        .catch(() => {});
    }
    await notifySalesGroup(user, label, 0);
  } catch (e) {
    // Critical error: rollback charge
    if (!isRefGift) {
      await db.$transaction([
        db.botUser.update({ where: { id: user.id }, data: { balance: { increment: total } } }),
        db.botOrder.update({ where: { id: reserve.orderId }, data: { status: "failed" } }),
      ]);
    } else if (refPointsCost) {
      await db.$transaction([
        db.botUser.update({ where: { id: user.id }, data: { spentReferrals: { decrement: refPointsCost } } }),
        db.botOrder.update({ where: { id: reserve.orderId }, data: { status: "failed" } }),
      ]);
    }
    console.error("[bot] hybrid order failed critically:", (e as Error).message);
    if (procMsg) {
      await bot.api
        .editMessageText(tgId, procMsg.message_id, t(lang, "supplier_fail"), {
          reply_markup: new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all"),
        })
        .catch(() => {});
    }
    if (ADMIN_ID) {
      await bot.api.sendMessage(ADMIN_ID, `🔥 Критическая ошибка #${reserve.orderId}: ${(e as Error).message}`).catch(() => {});
    }
  }
}

async function doBuy(ctx: Context, variantId: number, qty: number) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const v = await db.variant.findUnique({ where: { id: variantId }, include: { plan: { include: { product: true } } } });
  if (!v || !v.isActive) return ctx.answerCallbackQuery({ text: t(lang, "plan_unavailable"), show_alert: true });
  const pt = await pick3(v.plan.product.titleRu, v.plan.product.titleEn, v.plan.product.titleUz, lang);
  const vt = await locName(v.titleRu, v.titleUz, lang);
  const baseTitle = `${pt} — ${vt}`;
  const max = await availableStock(v);
  if (max <= 0) return ctx.answerCallbackQuery({ text: t(lang, "out_of_stock"), show_alert: true });
  qty = clamp(Math.floor(qty) || 1, 1, max);
  const eff = await effPriceFor(user.id, variantId, v.priceUzs);
  const total = eff.price * qty;
  const label = qty > 1 ? `${baseTitle} ×${qty}` : baseTitle;

  // Enough balance -> execute purchase immediately
  if (user.balance >= total) {
    await ctx.answerCallbackQuery({ text: t(lang, "paid_toast") }).catch(() => {});
    await executePurchase(user.tgId, variantId, qty);
    return;
  }

  // Insufficient balance -> only ask for the SHORTFALL (total minus what's
  // already on the balance), not the full price again. Existing balance
  // stays working capital instead of sitting unused after a full top-up.
  const shortfall = total - user.balance;
  const stars = soumToStars(shortfall);
  const adminUsername = (await setting("support_username", "")).replace(/^@/, "");

  const kb = new InlineKeyboard()
    .text(t(lang, "pay_receipt"), `tcheck_buy:${shortfall}:${variantId}:${qty}`).row()
    .text(t(lang, "pay_stars", { n: stars }), `tstar_buy:${shortfall}:${variantId}:${qty}`).row();
  if (adminUsername) {
    kb.url(t(lang, "admin_topup"), `https://t.me/${adminUsername}`).row();
  } else {
    kb.text(t(lang, "via_admin"), `tman_buy:${shortfall}:${variantId}:${qty}`).row();
  }
  kb.text(t(lang, "back"), `q:${v.id}:${qty}:0:all`);

  const promptText = `👛 <b>Недостаточно средств.</b>\n\n` +
    `Цена <b>${esc(label)}</b>: <b>${money(total, lang)}</b>.\n\n` +
    `У вас на балансе: <b>${money(user.balance, lang)}</b>.\n` +
    `Осталось доплатить: <b>${money(shortfall, lang)}</b>.\n\n` +
    `Пожалуйста, выберите способ оплаты — после зачисления покупка оформится автоматически:`;

  await ctx.answerCallbackQuery().catch(() => {});
  // One message: the how-to-pay video with the price/payment-options text as
  // its caption (a text message can't gain a video via edit, so replace the
  // qty-chooser screen with this instead of stacking a separate video on top).
  const payVideo = howToPayFile();
  if (payVideo) {
    await ctx.deleteMessage().catch(() => {});
    await ctx.replyWithVideo(payVideo, { caption: promptText, parse_mode: "HTML", reply_markup: kb }).catch(async () => {
      await ctx.reply(promptText, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    });
  } else {
    await ctx.editMessageText(promptText, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  }
}

// Purchase paid in referral points (not сум). Reuses executePurchase's
// full delivery path (stock → supplier → manual-ticket fallback) by
// pre-crediting the user's balance with the exact item price and then
// spending it, atomically incrementing spentReferrals in the same tx.
// Result: everything downstream (order records, delivery, admin alerts)
// stays identical to a normal purchase; the "money" is just internal.
// Helper to resolve active gift variants from admin promo settings (ref_reward_tiers)
// as well as variants with explicit pointsCost > 0.
async function getGiftTiersMap(): Promise<{ enabled: boolean; map: Map<number, number> }> {
  const enabledStr = await setting("ref_reward_enabled", "1");
  const enabled = enabledStr !== "0";

  const raw = (await setting("ref_reward_tiers", "")).trim();
  const map = new Map<number, number>(); // variantId -> pointsCost (threshold)

  if (raw) {
    const pairs = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    for (const p of pairs) {
      const [th, vid] = p.split(":").map((x) => Number(x.trim()));
      if (Number.isFinite(th) && th > 0 && Number.isFinite(vid) && vid > 0) {
        map.set(vid, th);
      }
    }
  }

  return { enabled, map };
}

async function getGiftVariants() {
  const { enabled, map } = await getGiftTiersMap();
  if (!enabled) return [];

  const tierVariantIds = Array.from(map.keys());

  const dbVariants = await db.variant.findMany({
    where: {
      isActive: true,
      OR: [
        { id: { in: tierVariantIds } },
        { pointsCost: { gt: 0 } },
      ],
    },
    include: { plan: { include: { product: true } } },
  });

  const list: Array<{ variant: typeof dbVariants[0]; pointsCost: number }> = [];

  for (const v of dbVariants) {
    const cost = map.get(v.id) ?? v.pointsCost;
    if (cost > 0) {
      list.push({ variant: v, pointsCost: cost });
    }
  }

  list.sort((a, b) => a.pointsCost - b.pointsCost || a.variant.id - b.variant.id);
  return list;
}

async function buyForReferrals(ctx: Context, variantId: number) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const { map } = await getGiftTiersMap();
  const v = await db.variant.findUnique({ where: { id: variantId }, include: { plan: { include: { product: true } } } });
  const pointsCost = v ? (map.get(v.id) ?? v.pointsCost) : 0;
  if (!v || !v.isActive || pointsCost <= 0) return ctx.answerCallbackQuery({ text: t(lang, "plan_unavailable"), show_alert: true });

  const points = await availableReferralPoints(user);
  if (points < pointsCost) {
    return ctx.answerCallbackQuery({
      text: `Недостаточно рефералов: у вас ${points}, нужно ${pointsCost}. Пригласите ещё ${pointsCost - points}.`,
      show_alert: true,
    });
  }

  const max = await availableStock(v);
  if (max <= 0) return ctx.answerCallbackQuery({ text: t(lang, "out_of_stock"), show_alert: true });

  // Atomically: spend ONLY points (no money charge or temporary balance increment)
  const reserve = await db.$transaction(async (tx) => {
    const fresh = await tx.botUser.findUnique({ where: { id: user.id } });
    if (!fresh) return { error: "user" as const };
    const realRefs = await tx.botUser.count({ where: { referredBy: fresh.tgId } });
    const stillHave = Math.max(0, realRefs + (fresh.bonusReferrals ?? 0) - (fresh.spentReferrals ?? 0));
    if (stillHave < pointsCost) return { error: "points" as const };
    await tx.botUser.update({
      where: { id: user.id },
      data: { spentReferrals: { increment: pointsCost } },
    });
    return { ok: true as const };
  });

  if ("error" in reserve) {
    await ctx.answerCallbackQuery({ text: reserve.error === "points" ? "Ваши рефералы изменились, попробуйте ещё раз." : "Ошибка", show_alert: true }).catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery({ text: `✅ Списано ${pointsCost} реф.` }).catch(() => {});
  await executePurchase(user.tgId, variantId, 1, pointsCost);
}

// ---------- views ----------
function balanceView(lang: string, balance: number) {
  const kb = new InlineKeyboard();
  for (const a of TOPUP_PRESETS) kb.text(`+${money(a, lang)}`, `top:${a}`);
  kb.row().text(t(lang, "other_amount"), "topin").row();
  kb.text(t(lang, "promo_btn"), "promo").row();
  kb.text(t(lang, "to_shop"), "m:0:all");
  return { text: `${t(lang, "wallet_title", { v: money(balance, lang) })}\n\n${t(lang, "wallet_hint", { min: money(MIN_TOPUP, lang) })}`, kb };
}

// Redeem a promo code → credit its fixed сум amount to the user's balance.
// Validates active/expiry/total-uses/per-user limits atomically in a transaction.
async function redeemPromo(ctx: Context, user: Awaited<ReturnType<typeof getUser>>, input: string) {
  const lang = user.lang;
  const code = (input ?? "").trim().toUpperCase();
  const backKb = new InlineKeyboard().text(t(lang, "btn_wallet"), "bal").row().text(t(lang, "to_shop"), "m:0:all");
  const fail = (msgKey: string) => ctx.reply(t(lang, msgKey), { parse_mode: "HTML", reply_markup: backKb });

  if (!code) return fail("promo_bad");
  let promo;
  try {
    promo = await db.promoCode.findUnique({ where: { code } });
  } catch (e) {
    console.error("[bot] promo lookup failed:", (e as Error).message);
    return fail("promo_bad");
  }
  if (!promo || !promo.isActive) return fail("promo_bad");
  if (promo.expiresAt && promo.expiresAt.getTime() < Date.now()) return fail("promo_expired");
  if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) return fail("promo_used");

  const result = await db.$transaction(async (tx) => {
    const p = await tx.promoCode.findUnique({ where: { id: promo.id } });
    if (!p || !p.isActive) return { error: "promo_bad" as const };
    if (p.expiresAt && p.expiresAt.getTime() < Date.now()) return { error: "promo_expired" as const };
    if (p.maxUses > 0 && p.usedCount >= p.maxUses) return { error: "promo_used" as const };
    const mine = await tx.promoRedemption.count({ where: { promoId: p.id, userId: user.id } });
    if (p.perUserLimit > 0 && mine >= p.perUserLimit) return { error: "promo_limit" as const };
    await tx.promoRedemption.create({ data: { promoId: p.id, userId: user.id, amountUzs: p.amountUzs } });
    await tx.promoCode.update({ where: { id: p.id }, data: { usedCount: { increment: 1 } } });
    const u = await tx.botUser.update({ where: { id: user.id }, data: { balance: { increment: p.amountUzs } } });
    return { amount: p.amountUzs, balance: u.balance };
  });

  if ("error" in result && result.error) return fail(result.error);
  return ctx.reply(
    t(lang, "promo_ok", { v: money(result.amount, lang), balance: money(result.balance, lang) }),
    { parse_mode: "HTML", reply_markup: backKb },
  );
}
async function ordersView(lang: string, userId: number) {
  // Only real purchases — delivered or awaiting manual delivery. Failed/refunded hidden.
  let orders: Array<{ id: number; titleRu: string; priceUsdt: number; payload: string; status: string }> = [];
  try {
    orders = await db.botOrder.findMany({
      where: { userId, status: { in: ["delivered", "awaiting_delivery"] } },
      orderBy: { id: "desc" },
      take: 10,
    });
  } catch (e) {
    console.error("[bot] ordersView query failed:", (e as Error).message);
  }
  const kb = new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all");
  // Clip long fields so the HTML message stays well under Telegram's 4096 limit
  // (a payload with many delivered codes could otherwise blow the limit → 400).
  const clip = (s: string | null | undefined, n: number) => {
    const v = (s ?? "").trim();
    return v.length > n ? v.slice(0, n) + "…" : v;
  };
  const body = orders.length
    ? orders
        .map((o) =>
          o.status === "awaiting_delivery"
            ? `#${o.id} · ${esc(clip(o.titleRu, 80))} — ${money(o.priceUsdt, lang)}\n⏳ ${t(lang, "order_pending")}`
            : `#${o.id} · ${esc(clip(o.titleRu, 80))} — ${money(o.priceUsdt, lang)}\n<code>${esc(clip(o.payload, 150))}</code>`,
        )
        .join("\n\n")
    : t(lang, "no_orders");
  return { text: `${t(lang, "orders_title")}\n\n${body}`, kb };
}
async function profileView(user: Awaited<ReturnType<typeof getUser>>) {
  const lang = user.lang;
  const [ordersCount, realRefs] = await Promise.all([
    db.botOrder.count({ where: { userId: user.id } }),
    db.botUser.count({ where: { referredBy: user.tgId } }),
  ]);
  const refCount = realRefs + (user.bonusReferrals || 0);

  // Professional profile layout with all actions
  const kb = new InlineKeyboard()
    .text(stripLeadEmoji(t(lang, "btn_wallet")), "bal").icon(walletButtonEmoji)
    .text(t(lang, "btn_refer"), "ref").row()
    .text(stripLeadEmoji(t(lang, "p_orders")), "ord").icon(ordersButtonEmoji)
    .text(t(lang, "btn_support"), "support_show").row()
    .text(t(lang, "btn_language"), "lang_pick").row()
    .text(t(lang, "to_shop"), "m:0:all");

  let text =
    `${t(lang, "profile_title")}\n\n` +
    `${t(lang, "p_name")}: ${esc(user.firstName ?? "—")}\n` +
    `ID: <code>${user.tgId}</code>\n` +
    `${emojiIcon("💰", walletButtonEmoji)} ${t(lang, "your_balance", { v: money(user.balance, lang) })}\n` +
    `${emojiIcon("🧾", ordersButtonEmoji)} ${t(lang, "p_orders")}: ${ordersCount}\n` +
    `${emojiIcon("🤝", referButtonEmoji)} ${t(lang, "p_invited")}: ${refCount}`;
  return { text, kb };
}
function referView(ctx: Context, user: Awaited<ReturnType<typeof getUser>>) {
  const lang = user.lang;
  const link = `https://t.me/${ctx.me.username}?start=ref${user.tgId}`;
  const kb = new InlineKeyboard().url(t(lang, "share"), `https://t.me/share/url?url=${encodeURIComponent(link)}`).row().text(t(lang, "to_shop"), "m:0:all");
  return { text: `${t(lang, "refer_title")}\n\n${t(lang, "refer_text")}\n\n<code>${link}</code>`, kb };
}
async function supportView(lang: string) {
  const custom = await setting("support", "");
  const text = custom ? (lang === "ru" ? custom : await translate(custom, lang)) : t(lang, "support_none");
  const kb = new InlineKeyboard();
  kb.url(t(lang, "support_write"), "https://t.me/Abdulloh_Zokirov").row();
  kb.text(t(lang, "to_shop"), "m:0:all");
  return { text: `${t(lang, "support_title")}\n\n${text}`, kb };
}

// Purchase terms / public offer — mandatory onboarding step shown to new users
// right after they pick a language, and to any existing user who hasn't tapped
// "Accept" yet (e.g. was created before this feature shipped). Blocks nothing
// technically — it's just always shown ahead of the shop until accepted once.
// Override the numbered body with the `terms` setting (RU source, auto-translated);
// the title/intro/button stay fixed so the accept flow is always recognisable.
async function sendTermsGate(ctx: Context, lang: string) {
  const custom = (await setting("terms", "")).trim();
  const body = custom ? (lang === "ru" ? custom : await translate(custom, lang)) : t(lang, "terms_body");
  const title = t(lang, "terms_title");
  const intro = esc(t(lang, "terms_intro"));
  const kb = new InlineKeyboard().text(t(lang, "terms_accept_btn"), "terms_accept");

  // One single message: heading + the whole terms text quoted + the accept
  // button. Any tap on an old persistent reply-keyboard (or any other
  // pre-acceptance action) is already redirected back here by the
  // terms-acceptance middleware, so there's no need for a separate
  // remove_keyboard message any more.
  const text = `${title}\n\n<blockquote>${intro}\n\n${body}</blockquote>`;
  await ctx
    .reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } })
    .catch(async () => {
      // Fallback if custom text carries broken markup — deliver it plain, button intact.
      await ctx.reply(stripTags(text), { reply_markup: kb }).catch(() => {});
    });
}

// ---------- gifts (referral reward) ----------
// `silent`: used for the automatic teaser on /start — skip sending anything
// when there's nothing worth interrupting the user for (feature off, or this
// user already claimed their gifts). The explicit "🎁 Подарки" button always
// shows something (the disabled/claimed message included).
// "Подарки" section = referral-points shop. Lists every active variant with
// pointsCost > 0 as a catalog: users spend 1 point per invited friend and
// exchange them for the subscriptions the admin marked as gift-eligible.
// Tapping a variant opens showGiftItem; the automatic tier-based grant flow
// was retired — buying is now always an explicit action.
async function showGifts(ctx: Context, edit = false, silent = false) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const points = await availableReferralPoints(user);

  const giftItems = await getGiftVariants();

  if (giftItems.length === 0) {
    if (silent) return;
    const kb = new InlineKeyboard().text(t(lang, "btn_refer"), "ref").row().text(t(lang, "to_shop"), "m:0:all");
    await sendOrEdit(ctx, t(lang, "gifts_disabled"), { reply_markup: kb });
    return;
  }

  const link = `https://t.me/${ctx.me.username}?start=ref${user.tgId}`;

  const listLines = giftItems.map(({ variant: v, pointsCost }) => {
    const productName = lang === "uz" ? v.plan.product.titleUz || v.plan.product.titleRu : v.plan.product.titleRu;
    const variantName = lang === "uz" ? v.titleUz || v.titleRu : v.titleRu;
    const title = formatItemTitle(productName, variantName);
    const canAfford = points >= pointsCost;
    const premium = giftPremiumEmoji(productName, v.plan.product.premiumEmoji);
    // Brand premium emoji as the row icon (HTML <tg-emoji> works in message
    // text); the ✅ suffix still marks what the user can already afford.
    const icon = premium ? emojiIcon("🎁", premium) : canAfford ? "✅" : "⏳";
    return `${icon} <b>${esc(title)}</b> = ${pointsCost} ${t(lang, "gifts_tier_friends")}${canAfford ? " ✅" : ""}`;
  }).join("\n");

  const text =
    `${t(lang, "gifts_title_v2")}\n\n${listLines}\n\n` +
    `👤 ${t(lang, "p_invited")}: <b>${points}</b>\n\n` +
    `🔗 ${lang === "ru" ? "Ваша ссылка" : lang === "uz" ? "Havolangiz" : "Your link"}:\n<code>${link}</code>`;

  const kb = new InlineKeyboard();
  for (const { variant: v, pointsCost } of giftItems) {
    const productName = lang === "uz" ? v.plan.product.titleUz || v.plan.product.titleRu : v.plan.product.titleRu;
    const variantName = lang === "uz" ? v.titleUz || v.titleRu : v.titleRu;
    const title = formatItemTitle(productName, variantName);
    const canAfford = points >= pointsCost;
    const premium = giftPremiumEmoji(productName, v.plan.product.premiumEmoji);
    // Buttons carry premium emoji through icon_custom_emoji_id (.icon()),
    // not <tg-emoji> — captions/labels are plain text there.
    const btn = kb.text(`${premium ? "" : canAfford ? "🎁 " : "⏳ "}${title} · ${pointsCost} реф.`, `gi:${v.id}`);
    if (premium) btn.icon(premium);
    kb.row();
  }
  kb.url(t(lang, "gifts_share"), `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(lang === "ru" ? `Заходи в бот и получай подарки! 🎁` : `Join the bot and get gifts! 🎁`)}`).row();
  kb.text(t(lang, "btn_refer"), "ref").row();
  kb.text(t(lang, "to_shop"), "m:0:all");

  const videoUrl = (await setting("gifts_video_url", "https://youtu.be/S60i8c1ZRoo?si=pl5dhs9FjNG_Yz5C")).trim();
  if (videoUrl) {
    const linkOpts = { url: videoUrl, show_above_text: true, prefer_large_media: true };
    if (edit) {
      await sendOrEdit(ctx, text, { reply_markup: kb, link_preview_options: linkOpts });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: linkOpts }).catch(() => {});
    }
    return;
  }

  const asset = giftsBannerAsset();
  if (edit) {
    if (asset?.isVideo) {
      await sendOrEdit(ctx, text, { reply_markup: kb, video: asset.file });
    } else {
      await sendOrEdit(ctx, text, { reply_markup: kb, photo: asset?.file ?? null });
    }
  } else if (asset) {
    if (asset.isVideo) {
      await ctx.replyWithVideo(asset.file, { caption: text, parse_mode: "HTML", reply_markup: kb }).catch(async () => {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
      });
    } else {
      await ctx.replyWithPhoto(asset.file, { caption: text, parse_mode: "HTML", reply_markup: kb }).catch(async () => {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
      });
    }
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

let cachedGiftsVideoFileId: string | null = null;
let cachedGiftsPhotoFileId: string | null = null;

async function sendGiftsToUser(user: { id: number; tgId: string; lang: string; bonusReferrals?: number | null; spentReferrals?: number | null }): Promise<boolean> {
  const lang = normalizeLang(user.lang);
  const points = await availableReferralPoints(user);
  const giftItems = await getGiftVariants();
  if (giftItems.length === 0) return false;

  const botInfo = await bot.api.getMe().catch(() => null);
  const botUsername = botInfo?.username || "Aiobunabot";
  const link = `https://t.me/${botUsername}?start=ref${user.tgId}`;

  const listLines = giftItems.map(({ variant: v, pointsCost }) => {
    const productName = lang === "uz" ? v.plan.product.titleUz || v.plan.product.titleRu : v.plan.product.titleRu;
    const variantName = lang === "uz" ? v.titleUz || v.titleRu : v.titleRu;
    const title = formatItemTitle(productName, variantName);
    const canAfford = points >= pointsCost;
    const premium = giftPremiumEmoji(productName, v.plan.product.premiumEmoji);
    const icon = premium ? emojiIcon("🎁", premium) : canAfford ? "✅" : "⏳";
    return `${icon} <b>${esc(title)}</b> = ${pointsCost} ${t(lang, "gifts_tier_friends")}${canAfford ? " ✅" : ""}`;
  }).join("\n");

  const text =
    `${t(lang, "gifts_title_v2")}\n\n${listLines}\n\n` +
    `👤 ${t(lang, "p_invited")}: <b>${points}</b>\n\n` +
    `🔗 ${lang === "ru" ? "Ваша ссылка" : lang === "uz" ? "Havolangiz" : "Your link"}:\n<code>${link}</code>`;

  const kb = new InlineKeyboard();
  for (const { variant: v, pointsCost } of giftItems) {
    const productName = lang === "uz" ? v.plan.product.titleUz || v.plan.product.titleRu : v.plan.product.titleRu;
    const variantName = lang === "uz" ? v.titleUz || v.titleRu : v.titleRu;
    const title = formatItemTitle(productName, variantName);
    const canAfford = points >= pointsCost;
    const premium = giftPremiumEmoji(productName, v.plan.product.premiumEmoji);
    const btn = kb.text(`${premium ? "" : canAfford ? "🎁 " : "⏳ "}${title} · ${pointsCost} реф.`, `gi:${v.id}`);
    if (premium) btn.icon(premium);
    kb.row();
  }
  kb.url(t(lang, "gifts_share"), `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(lang === "ru" ? `Заходи в бот и получай подарки! 🎁` : `Join the bot and get gifts! 🎁`)}`).row();
  kb.text(t(lang, "btn_refer"), "ref").row();
  kb.text(t(lang, "to_shop"), "m:0:all");

  const videoUrl = (await setting("gifts_video_url", "https://youtu.be/S60i8c1ZRoo?si=pl5dhs9FjNG_Yz5C")).trim();
  try {
    if (videoUrl) {
      await bot.api.sendMessage(user.tgId, text, {
        parse_mode: "HTML",
        reply_markup: kb,
        link_preview_options: {
          url: videoUrl,
          show_above_text: true,
          prefer_large_media: true,
        },
      });
      return true;
    }

    const asset = giftsBannerAsset();
    if (asset) {
      if (asset.isVideo) {
        const media = cachedGiftsVideoFileId ?? asset.file;
        const msg = await bot.api.sendVideo(user.tgId, media, { caption: text, parse_mode: "HTML", reply_markup: kb });
        if (msg.video?.file_id) cachedGiftsVideoFileId = msg.video.file_id;
      } else {
        const media = cachedGiftsPhotoFileId ?? asset.file;
        const msg = await bot.api.sendPhoto(user.tgId, media, { caption: text, parse_mode: "HTML", reply_markup: kb });
        if (msg.photo?.[0]?.file_id) cachedGiftsPhotoFileId = msg.photo[0].file_id;
      }
    } else {
      await bot.api.sendMessage(user.tgId, text, { parse_mode: "HTML", reply_markup: kb });
    }
    return true;
  } catch (e) {
    return false;
  }
}

// One gift-item card: name, cost in referrals, user's current points, and
// either a "Купить" button (enough points) or an "Пригласить" button (not
// enough). Always a "Назад" back to the gifts list.
async function showGiftItem(ctx: Context, variantId: number) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const { map } = await getGiftTiersMap();
  const v = await db.variant.findUnique({ where: { id: variantId }, include: { plan: { include: { product: true } } } });
  const pointsCost = v ? (map.get(v.id) ?? v.pointsCost) : 0;
  if (!v || !v.isActive || pointsCost <= 0) {
    await ctx.answerCallbackQuery({ text: t(lang, "plan_unavailable"), show_alert: true }).catch(() => {});
    return;
  }
  const points = await availableReferralPoints(user);
  const productName = lang === "uz" ? v.plan.product.titleUz || v.plan.product.titleRu : v.plan.product.titleRu;
  const variantName = lang === "uz" ? v.titleUz || v.titleRu : v.titleRu;
  const title = formatItemTitle(productName, variantName);
  const canAfford = points >= pointsCost;
  const missing = Math.max(0, pointsCost - points);

  const premium = giftPremiumEmoji(productName, v.plan.product.premiumEmoji);
  const text =
    `${emojiIcon("🎁", premium)} <b>${esc(title)}</b>\n\n` +
    `Цена: <b>${pointsCost}</b> ${t(lang, "gifts_tier_friends")}\n` +
    `У вас: <b>${points}</b> ${t(lang, "gifts_tier_friends")}` +
    (canAfford ? "" : `\n⚠️ Не хватает: <b>${missing}</b> — пригласите ещё столько друзей.`);

  const kb = new InlineKeyboard();
  if (canAfford) {
    kb.text(`✅ Купить за ${pointsCost} реф.`, `rb:${v.id}:0:all`).row();
  } else {
    kb.text(`🤝 Пригласить друзей`, "ref").row();
  }
  kb.text("⬅️ К подаркам", "gifts_show").row();

  await sendOrEdit(ctx, text, { reply_markup: kb });
  await ctx.answerCallbackQuery().catch(() => {});
}

// ---------- top-up ----------
async function buildTopupMethods(lang: string, amount: number) {
  const stars = soumToStars(amount);
  const adminUsername = (await setting("support_username", "")).replace(/^@/, "");
  const kb = new InlineKeyboard()
    .text(t(lang, "pay_receipt"), `tcheck:${amount}`).row()
    .text(t(lang, "pay_stars", { n: stars }), `tstar:${amount}`).row();
  if (adminUsername) {
    kb.url(t(lang, "admin_topup"), `https://t.me/${adminUsername}`).row();
  } else {
    kb.text(t(lang, "via_admin"), `tman:${amount}`).row();
  }
  kb.text(t(lang, "back"), "bal");
  return { text: `${t(lang, "topup_of", { v: money(amount, lang) })}\n\n${t(lang, "choose_method")}`, kb };
}

// Card-by-receipt: show card + deadline, then verify the sent receipt with Gemini.
const RECEIPT_WINDOW_MIN = 10;
async function startReceiptPayment(ctx: Context, lang: string, amount: number, note: string | null = null) {
  await ctx.answerCallbackQuery().catch(() => {});
  const card = await setting("payment_card", "");
  const holder = await setting("payment_card_holder", "");
  if (!card) return ctx.reply(t(lang, "receipt_unavailable"));
  const user = await getUser(ctx);
  const expiresAt = new Date(Date.now() + RECEIPT_WINDOW_MIN * 60_000);
  // cancel any older awaiting receipt payments
  await db.topUp.updateMany({ where: { userId: user.id, method: "receipt", status: "awaiting_receipt" }, data: { status: "rejected" } });
  await db.topUp.create({ data: { userId: user.id, amount, method: "receipt", status: "awaiting_receipt", expiresAt, note } });
  await ctx.reply(
    t(lang, "receipt_pay", { amount: money(amount, lang), card, holder, min: RECEIPT_WINDOW_MIN }),
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(t(lang, "back"), "bal") },
  ).catch(() => {});
}

async function handleReceiptPhoto(ctx: Context, fileId: string) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const topup = await db.topUp.findFirst({
    where: { userId: user.id, method: "receipt", status: "awaiting_receipt" },
    orderBy: { id: "desc" },
  });
  if (!topup) return; // no pending receipt payment — ignore stray photos
  if (topup.expiresAt && topup.expiresAt.getTime() < Date.now()) {
    await db.topUp.update({ where: { id: topup.id }, data: { status: "rejected" } });
    return ctx.reply(t(lang, "receipt_expired"));
  }
  // Receipt is NOT auto-verified — forward it to the admin for manual approval.
  await db.topUp.update({ where: { id: topup.id }, data: { receiptFileId: fileId, status: "review" } });
  await ctx.reply(t(lang, "receipt_review")).catch(() => {});
  if (ADMIN_ID) {
    const kb = new InlineKeyboard().text("✅ Зачислить", `ap:${topup.id}`).text("❌ Отклонить", `rj:${topup.id}`);
    let adminText = `🧾 Новый чек на оплату #${topup.id}\nСумма: ${money(topup.amount, lang)}\nПокупатель: ${user.firstName ?? ""} @${user.username ?? "—"} (${user.tgId})\nПроверьте чек и зачислите или отклоните:`;
    if (topup.note && topup.note.startsWith("buy:")) {
      const [, varIdStr, qtyStr] = topup.note.split(":");
      adminText += `\n🛒 Покупка товара (ID варианта: ${varIdStr}, Кол-во: ${qtyStr})`;
    }
    await ctx.api.sendMessage(ADMIN_ID, adminText, { reply_markup: kb }).catch(() => {});
    await ctx.api.sendPhoto(ADMIN_ID, fileId).catch(() => {});
  }
}

async function starsInvoice(ctx: Context, lang: string, amount: number, note: string | null = null) {
  const stars = soumToStars(amount);
  await ctx.answerCallbackQuery().catch(() => {});
  const payload = note ? `topup:${amount}:stars:${note}` : `topup:${amount}:stars`;
  await ctx.replyWithInvoice(t(lang, "topup_of", { v: money(amount, lang) }), t(lang, "topup_of", { v: money(amount, lang) }), payload, "XTR", [{ label: money(amount, lang), amount: stars }]).catch((e) => { console.error("[bot] stars:", (e as Error).message); ctx.reply("⚠️").catch(() => {}); });
}

async function cardInvoice(ctx: Context, lang: string, amount: number, note: string | null = null) {
  if (!CARD_PROVIDER_TOKEN) {
    await ctx.answerCallbackQuery({ text: t(lang, "card_soon"), show_alert: true }).catch(() => {});
    return requestTopUp(ctx, lang, amount, "card", note);
  }
  await ctx.answerCallbackQuery().catch(() => {});
  const payload = note ? `topup:${amount}:card:${note}` : `topup:${amount}:card`;
  await ctx.replyWithInvoice(t(lang, "topup_of", { v: money(amount, lang) }), t(lang, "pay_card"), payload, "UZS", [{ label: money(amount, lang), amount: Math.round(amount) * 100 }], { provider_token: CARD_PROVIDER_TOKEN }).catch((e) => { console.error("[bot] card:", (e as Error).message); ctx.reply("⚠️").catch(() => {}); });
}

async function requestTopUp(ctx: Context, lang: string, amount: number, method = "manual", note: string | null = null) {
  const user = await getUser(ctx);
  const topup = await db.topUp.create({ data: { userId: user.id, amount, method, note } });
  
  let adminText = `💳 #${topup.id} ${user.firstName ?? ""} @${user.username ?? "—"} (${user.tgId})\n${money(amount, lang)}`;
  if (note && note.startsWith("buy:")) {
    const [, varIdStr, qtyStr] = note.split(":");
    adminText += `\n🛒 Покупка товара (ID варианта: ${varIdStr}, Кол-во: ${qtyStr})`;
  }

  await ctx.reply(t(lang, "topup_created", { v: money(amount, lang), id: topup.id }), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all") }).catch(() => {});
  if (ADMIN_ID) {
    const kb = new InlineKeyboard().text("✅ зачислить", `ap:${topup.id}`).text("❌ отклонить", `rj:${topup.id}`);
    await ctx.api.sendMessage(ADMIN_ID, adminText, { reply_markup: kb }).catch(() => {});
  }
}

async function creditPaidTopUp(ctx: Context, amount: number, method: string, chargeId: string, variantId?: number, qty?: number) {
  const user = await getUser(ctx);
  const lang = user.lang;
  
  const note = (variantId && qty) ? `buy:${variantId}:${qty}` : null;

  await db.$transaction([
    db.botUser.update({ where: { id: user.id }, data: { balance: { increment: amount } } }),
    db.topUp.create({ data: { userId: user.id, amount, method, status: "approved", externalId: chargeId, note } }),
  ]);
  const u = await db.botUser.findUnique({ where: { id: user.id } });
  await ctx.reply(t(lang, "paid_received", { v: money(amount, lang), b: money(u?.balance ?? 0, lang) }), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all") }).catch(() => {});
  if (ADMIN_ID) await ctx.api.sendMessage(ADMIN_ID, `💰 (${method}) ${money(amount, lang)} — ${user.firstName ?? ""} @${user.username ?? "—"} (${user.tgId})`).catch(() => {});

  if (variantId && qty) {
    await executePurchase(user.tgId, variantId, qty).catch((err) => {
      console.error("[bot] creditPaidTopUp auto-purchase fail:", err.message);
    });
  }
}
const REJECT_REASONS = [
  {
    key: "bad_photo",
    labelRu: "📷 Нечёткий чек / Не читается",
    textRu: "Ваш чек нечитаем или размыт. Пожалуйста, отправьте чёткий скриншот или фото чека.",
    textEn: "Your receipt photo is blurry or unreadable. Please send a clear screenshot or photo of the receipt.",
    textUz: "Chekingiz o'qib bo'lmaydigan yoki xira. Iltimos, chekning aniq fotosuratini/skrinshotini yuboring.",
  },
  {
    key: "wrong_amount",
    labelRu: "💰 Неверная сумма в чеке",
    textRu: "Сумма в отправленном чеке не совпадает с заявленной суммой пополнения.",
    textEn: "The amount on the receipt does not match the requested top-up amount.",
    textUz: "Chekdagi summa to'lov summasiga mos kelmaydi.",
  },
  {
    key: "not_received",
    labelRu: "💳 Оплата не поступила",
    textRu: "Средства по данному чеку ещё не поступили на наш счёт. Проверьте статус перевода в банке.",
    textEn: "Payment for this receipt has not reached our account yet. Please check transfer status in your banking app.",
    textUz: "Ushbu chek bo'yicha mablag'lar hali hisobimizga tushmadi. Bank ilovasida o'tkazma holatini tekshiring.",
  },
  {
    key: "duplicate",
    labelRu: "🔄 Повторный / использованный чек",
    textRu: "Этот чек уже был обработан ранее или использован другим пользователем.",
    textEn: "This receipt has already been processed or used previously.",
    textUz: "Ushbu chek ilgari ishlatilgan yoki boshqa foydalanuvchi tomonidan yuborilgan.",
  },
];

async function promptRejectReason(ctx: Context, id: number) {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Admin only", show_alert: true });
  const topup = await db.topUp.findUnique({ where: { id }, include: { user: true } });
  if (!topup || !["pending", "review", "awaiting_receipt"].includes(topup.status)) {
    return ctx.answerCallbackQuery({ text: "Уже обработано", show_alert: true });
  }

  const kb = new InlineKeyboard();
  for (let i = 0; i < REJECT_REASONS.length; i++) {
    kb.text(REJECT_REASONS[i].labelRu, `rjs:${id}:${i}`).row();
  }
  kb.text("✏️ Написать свою причину", `rjs:${id}:custom`).row();
  kb.text("⬅️ Отмена", `rjs:${id}:cancel`).row();

  await ctx.editMessageText(
    `❌ <b>Отклонение чека #${id}</b>\n\n` +
    `Сумма: ${money(topup.amount, topup.user.lang)}\n` +
    `Покупатель: ${topup.user.firstName ?? ""} @${topup.user.username ?? "—"} (${topup.user.tgId})\n\n` +
    `Выберите причину отклонения:`,
    { parse_mode: "HTML", reply_markup: kb }
  ).catch(() => {});
  await ctx.answerCallbackQuery().catch(() => {});
}

async function handleRejectChoice(ctx: Context, id: number, choice: string) {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Admin only", show_alert: true });
  const topup = await db.topUp.findUnique({ where: { id }, include: { user: true } });
  if (!topup || !["pending", "review", "awaiting_receipt"].includes(topup.status)) {
    return ctx.answerCallbackQuery({ text: "Уже обработано", show_alert: true });
  }

  if (choice === "cancel") {
    const kb = new InlineKeyboard().text("✅ Зачислить", `ap:${id}`).text("❌ Отклонить", `rj:${id}`);
    let adminText = `🧾 Новый чек на оплату #${id}\nСумма: ${money(topup.amount, topup.user.lang)}\nПокупатель: ${topup.user.firstName ?? ""} @${topup.user.username ?? "—"} (${topup.user.tgId})\nПроверьте чек и зачислите или отклоните:`;
    await ctx.editMessageText(adminText, { reply_markup: kb }).catch(() => {});
    return ctx.answerCallbackQuery().catch(() => {});
  }

  if (choice === "custom") {
    pending.set(String(ctx.from?.id), { type: "reject_custom_reason", topupId: id });
    await ctx.editMessageText(
      `✏️ <b>Напишите причину отклонения для чека #${id}:</b>\n\n` +
      `Отправьте текстовое сообщение с причиной. Оно будет отправлено пользователю.`
    ).catch(() => {});
    return ctx.answerCallbackQuery().catch(() => {});
  }

  const reasonIdx = Number(choice);
  const reason = REJECT_REASONS[reasonIdx];
  if (!reason) return ctx.answerCallbackQuery({ text: "Ошибка выбора", show_alert: true });

  await executeRejectTopup(ctx, topup, reason.labelRu, reason);
}

async function executeRejectTopup(
  ctx: Context,
  topup: Awaited<ReturnType<typeof db.topUp.findUnique>> & { user: any },
  adminLabel: string,
  reasonObj?: (typeof REJECT_REASONS)[number],
  customText?: string
) {
  if (!topup) return;
  await db.topUp.update({ where: { id: topup.id }, data: { status: "rejected" } });

  if (ctx.callbackQuery) {
    await ctx.editMessageText(`❌ #${topup.id} Отклонен (${esc(adminLabel)})`).catch(() => {});
    await ctx.answerCallbackQuery().catch(() => {});
  } else {
    await ctx.reply(`❌ Чек #${topup.id} отклонен (${esc(adminLabel)})`).catch(() => {});
  }

  const ulang = topup.user.lang;
  let reasonForUser = "";
  if (reasonObj) {
    reasonForUser = ulang === "uz" ? reasonObj.textUz : ulang === "en" ? reasonObj.textEn : reasonObj.textRu;
  } else if (customText) {
    reasonForUser = customText;
  }

  const username = (await setting("support_username", "")).replace(/^@/, "");
  const kb = new InlineKeyboard();
  if (username) kb.url(t(ulang, "support_write"), `https://t.me/${username}`).row();
  kb.text(t(ulang, "to_shop"), "m:0:all");

  const msgText =
    `❌ <b>Ваш чек #${topup.id} на сумму ${money(topup.amount, ulang)} был отклонен.</b>` +
    (reasonForUser ? `\n\n<b>Причина:</b> ${esc(reasonForUser)}` : "");

  await bot.api.sendMessage(topup.user.tgId, msgText, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
}

async function resolveTopUp(ctx: Context, id: number, approve: boolean) {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Admin only", show_alert: true });
  const topup = await db.topUp.findUnique({ where: { id }, include: { user: true } });
  if (!topup || !["pending", "review", "awaiting_receipt"].includes(topup.status)) return ctx.answerCallbackQuery({ text: "Done already", show_alert: true });
  const ulang = topup.user.lang;
  if (approve) {
    await db.$transaction([
      db.topUp.update({ where: { id }, data: { status: "approved" } }),
      db.botUser.update({ where: { id: topup.userId }, data: { balance: { increment: topup.amount } } }),
    ]);
    await ctx.editMessageText(`✅ #${id} +${money(topup.amount, ulang)}`).catch(() => {});
    await ctx.api.sendMessage(topup.user.tgId, t(ulang, "paid_received", { v: money(topup.amount, ulang), b: "" }).split("\n")[0]).catch(() => {});

    // Auto-purchase on approval if there is an associated note
    if (topup.note && topup.note.startsWith("buy:")) {
      const [, varIdStr, qtyStr] = topup.note.split(":");
      const variantId = Number(varIdStr);
      const qty = Number(qtyStr);
      if (variantId && qty) {
        await executePurchase(topup.user.tgId, variantId, qty).catch((err) => {
          console.error("[bot] resolveTopUp auto-purchase fail:", err.message);
        });
      }
    }
  } else {
    await promptRejectReason(ctx, id);
  }
}

// ---------- language ----------
async function showLangPicker(ctx: Context, edit: boolean) {
  const text = "🌐 Выберите язык / Choose language / Tilni tanlang:";
  if (edit) await ctx.editMessageText(text, { reply_markup: langKeyboard() }).catch(() => {});
  else await ctx.reply(text, { reply_markup: langKeyboard() });
}
async function sendHome(ctx: Context, user: Awaited<ReturnType<typeof getUser>>) {
  const { text, entities } = await buildHeader();
  await ctx.reply(text, { entities, reply_markup: mainKeyboard(user.lang) });
  // Shop banner + catalog text + product buttons all as ONE photo message.
  // Product/qty callbacks now use sendOrEdit(), which correctly handles
  // media-source messages via delete+resend when a plain text edit isn't
  // possible — so the buttons work even though they live on a photo.
  const menu = await buildMenu(user.lang, user.balance, 0, "all", user.id);
  const banner = shopBannerFile();
  if (banner) {
    await ctx.replyWithPhoto(banner, { caption: menu.text, parse_mode: "HTML", reply_markup: menu.kb }).catch(async () => {
      await ctx.reply(menu.text, { parse_mode: "HTML", reply_markup: menu.kb }).catch(() => {});
    });
  } else {
    await ctx.reply(menu.text, { parse_mode: "HTML", reply_markup: menu.kb });
  }
}

// Gate every entry into the shop behind a one-time terms acceptance: users who
// haven't tapped "Accept" yet (brand-new, or existing accounts predating this
// feature) see the terms instead of the home screen.
async function enterShop(ctx: Context, user: Awaited<ReturnType<typeof getUser>>) {
  if (!user.termsAcceptedAt) return sendTermsGate(ctx, user.lang);
  return sendHome(ctx, user);
}

// A user satisfies a required channel either by actually being a member (or
// having sent a join request Telegram is holding for admin approval — see
// the chat_join_request handler) or, for channels with "approve new members"
// on, by having a recorded pending request of their own.
// Once a user is confirmed subscribed, skip re-checking on every single
// message for a while — getChatMember is a live Telegram API call per
// required channel, and redoing it on every tap was adding real, noticeable
// latency to every interaction. 5 minutes is plenty responsive (someone who
// unsubscribes mid-window just gets caught on their next check) while cutting
// the network round-trips from "every action" down to "once per ~5 min".
const SUBS_CACHE_TTL_MS = 5 * 60_000;
const subsOkCache = new Map<string, number>();

// ---------- maintenance mode cache (30 s TTL) ----------
let maintenanceCache: { on: boolean; until: number } = { on: false, until: 0 };
async function isMaintenanceOn(): Promise<boolean> {
  if (Date.now() < maintenanceCache.until) return maintenanceCache.on;
  const row = await db.setting.findUnique({ where: { key: "maintenance_mode" } }).catch(() => null);
  const on = row?.valueRu === "1";
  maintenanceCache = { on, until: Date.now() + 30_000 };
  return on;
}
// Stores the message_id of the "subscribe to channels" gate message per user
// so we can delete it automatically when they join.
const subsGateMsg = new Map<string, number>();

async function isSubscribedTo(ctx: Context, tgId: string, chatId: string): Promise<boolean> {
  try {
    const member = await ctx.api.getChatMember(chatId, Number(tgId));
    if (["member", "creator", "administrator", "restricted"].includes(member.status)) return true;
  } catch {
    // Not a member (or bot can't see them) — fall through to the join-request check.
  }
  const pending = await db.channelJoinRequest.findUnique({ where: { chatId_tgId: { chatId, tgId } } }).catch(() => null);
  return pending !== null;
}

// ---------- maintenance mode gate ----------
bot.use(async (ctx, next) => {
  if (String(ctx.from?.id) === ADMIN_ID) return next();
  if (!(await isMaintenanceOn())) return next();
  await ctx.reply(
    "🔧 Магазин временно приостановлен на техническое обслуживание.\n\nПожалуйста, вернитесь позже.",
    { parse_mode: "HTML" },
  ).catch(() => {});
});

// ---------- mandatory terms-acceptance gate ----------
// Nothing works until the user taps "Принимаю условия" — not the reply
// keyboard (sendTermsGate removes it), and not old inline buttons still
// sitting in the chat history either: any action from a user who hasn't
// accepted bounces back to the terms message instead of running.
bot.use(async (ctx, next) => {
  if (String(ctx.from?.id) === ADMIN_ID) return next();

  const data = ctx.callbackQuery?.data;
  if (data === "terms_accept" || data?.startsWith("lang:")) return next();

  const text = ctx.message?.text;
  if (text?.startsWith("/start")) return next();

  const tgId = String(ctx.from?.id ?? "");
  if (!tgId) return next();
  const existingUser = await db.botUser.findUnique({ where: { tgId } });
  if (!existingUser || existingUser.termsAcceptedAt) return next();

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: t(existingUser.lang, "terms_required_toast"), show_alert: true }).catch(() => {});
  }
  return sendTermsGate(ctx, existingUser.lang);
});

// ---------- mandatory subscription check middleware ----------
bot.use(async (ctx, next) => {
  if (String(ctx.from?.id) === ADMIN_ID) {
    return next();
  }

  const data = ctx.callbackQuery?.data;
  if (data === "check_subs" || data === "terms_accept" || data?.startsWith("lang:")) {
    return next();
  }

  const text = ctx.message?.text;
  if (text?.startsWith("/start")) {
    return next();
  }

  // Inviting friends works before subscribing — only the shop/purchase flow
  // requires it. Growing the referrer's own reach is itself worth letting
  // through; the subscription gate still applies to everything else.
  if (data === "ref" || text?.startsWith("/referral") || text?.startsWith("/invite") || text?.startsWith("/taklif")) {
    return next();
  }
  if (text && REFER_TEXTS.has(text)) {
    return next();
  }

  const tgId = String(ctx.from!.id);
  const cachedUntil = subsOkCache.get(tgId);
  if (cachedUntil && cachedUntil > Date.now()) {
    return next();
  }

  const active = await db.requiredChannel.findMany({ where: { isActive: true } });
  if (active.length === 0) {
    return next();
  }

  // Check every required channel in parallel rather than one-by-one — each
  // is a separate network call to Telegram, no reason to serialize them.
  const results = await Promise.all(active.map((ch) => isSubscribedTo(ctx, tgId, ch.chatId)));
  const unsubscribed = active.filter((_, i) => !results[i]);
  const allSubscribed = unsubscribed.length === 0;

  if (allSubscribed) {
    subsOkCache.set(tgId, Date.now() + SUBS_CACHE_TTL_MS);
    // Mark the user as channel-verified so referral points count them.
    db.botUser.updateMany({ where: { tgId, channelVerifiedAt: null }, data: { channelVerifiedAt: new Date() } }).catch(() => {});
    return next();
  }

  const user = await getUser(ctx);
  const lang = user.lang;

  const kb = new InlineKeyboard();
  for (const ch of unsubscribed) {
    kb.url(`📢 ${ch.name}`, ch.url).row();
  }

  const msgText = t(lang, "subs_required_msg");

  // Always send a fresh message — never try to edit the previous one (it may
  // be a photo/banner which rejects editMessageText and would silently hide
  // the channel buttons from the user).
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery().catch(() => {});
  }
  const sent = await ctx.reply(msgText, { parse_mode: "HTML", reply_markup: kb }).catch(() => null);
  if (sent?.message_id) subsGateMsg.set(tgId, sent.message_id);
});

// ---------- commands & reply-keyboard ----------
bot.command("start", async (ctx) => {
  const existing = await findUser(ctx);
  const user = await getUser(ctx, ctx.match?.trim() || undefined);

  // Check required channels BEFORE showing anything else (except for admin).
  if (!isAdmin(ctx)) {
    const tgId = String(ctx.from!.id);
    const active = await db.requiredChannel.findMany({ where: { isActive: true } });
    if (active.length > 0) {
      const cachedUntil = subsOkCache.get(tgId);
      if (!cachedUntil || cachedUntil <= Date.now()) {
        const results = await Promise.all(active.map((ch) => isSubscribedTo(ctx, tgId, ch.chatId)));
        const unsubscribed = active.filter((_, i) => !results[i]);
        if (unsubscribed.length > 0) {
          const kb = new InlineKeyboard();
          for (const ch of unsubscribed) kb.url(`📢 ${ch.name}`, ch.url).row();
          const sent = await ctx.reply(t(user.lang, "subs_required_msg"), { parse_mode: "HTML", reply_markup: kb }).catch(() => null);
          if (sent?.message_id) subsGateMsg.set(tgId, sent.message_id);
          return;
        }
        subsOkCache.set(tgId, Date.now() + SUBS_CACHE_TTL_MS);
        db.botUser.updateMany({ where: { tgId, channelVerifiedAt: null }, data: { channelVerifiedAt: new Date() } }).catch(() => {});
      }
    }
  }

  if (!existing) return showLangPicker(ctx, false); // first visit → pick language
  await enterShop(ctx, user);
});
bot.command("menu", (ctx) => showMenu(ctx, 0, "all", false));

// Admin: /refs <tgId|@username> — list users invited by that person
bot.command("refs", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.match ?? "").trim().replace(/^@/, "");
  if (!arg) return ctx.reply("Формат: /refs <tgId или @username>");

  const referrer = await db.botUser.findFirst({
    where: isNaN(Number(arg)) ? { username: arg } : { tgId: arg },
  });
  if (!referrer) return ctx.reply(`❌ Пользователь не найден: ${arg}`);

  const invited = await db.botUser.findMany({
    where: { referredBy: referrer.tgId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  if (invited.length === 0) {
    return ctx.reply(`👤 ${referrer.firstName ?? "—"} (@${referrer.username ?? referrer.tgId})\n\nПриглашённых нет.`);
  }

  const header = `👤 <b>${esc(referrer.firstName ?? "—")}</b> (@${referrer.username ?? referrer.tgId}) — приглашено: <b>${invited.length}</b>\n\n`;
  const CHUNK_SIZE = 50;
  for (let i = 0; i < invited.length; i += CHUNK_SIZE) {
    const chunk = invited.slice(i, i + CHUNK_SIZE);
    const lines = chunk.map((u, idx) => {
      const name = u.firstName ? esc(u.firstName) : "—";
      const uname = u.username ? ` @${u.username}` : "";
      const date = u.createdAt.toISOString().slice(0, 10);
      return `${i + idx + 1}. <code>${u.tgId}</code> ${name}${uname} · ${date}`;
    });
    const text = (i === 0 ? header : "") + lines.join("\n");
    await ctx.reply(text, { parse_mode: "HTML" }).catch(() => {});
  }
});

// Admin: /unref <tgId> — remove a user from their referrer's count
bot.command("unref", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.match ?? "").trim().replace(/^@/, "");
  if (!arg) return ctx.reply("Формат: /unref <tgId или @username>");

  const u = await db.botUser.findFirst({
    where: isNaN(Number(arg)) ? { username: arg } : { tgId: arg },
  });
  if (!u) return ctx.reply(`❌ Не найден: ${arg}`);
  if (!u.referredBy) return ctx.reply(`ℹ️ У ${u.firstName ?? u.tgId} нет реферера — ничего не изменено.`);

  await db.botUser.update({ where: { id: u.id }, data: { referredBy: null } });
  await ctx.reply(`✅ Реферальная связь удалена.\n\n${u.firstName ?? "—"} (@${u.username ?? u.tgId}) больше не считается чьим-либо рефералом.`);
});

// Admin: /refban <tgId|@username> — ban a user from inviting others
bot.command("refban", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.match ?? "").trim().replace(/^@/, "");
  if (!arg) return ctx.reply("Формат: /refban <tgId или @username>");

  const u = await db.botUser.findFirst({
    where: isNaN(Number(arg)) ? { username: arg } : { tgId: arg },
  });
  if (!u) return ctx.reply(`❌ Не найден: ${arg}`);
  if (u.refBanned) return ctx.reply(`ℹ️ ${u.firstName ?? u.tgId} уже заблокирован от приглашений.`);

  await db.botUser.update({ where: { id: u.id }, data: { refBanned: true } });
  await ctx.reply(`🚫 ${u.firstName ?? "—"} (@${u.username ?? u.tgId}) теперь не может приглашать людей.\n\nЕго реферальная ссылка перестанет давать баллы.`);
});

// Admin: /refunban <tgId|@username> — restore referral invite ability
bot.command("refunban", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.match ?? "").trim().replace(/^@/, "");
  if (!arg) return ctx.reply("Формат: /refunban <tgId или @username>");

  const u = await db.botUser.findFirst({
    where: isNaN(Number(arg)) ? { username: arg } : { tgId: arg },
  });
  if (!u) return ctx.reply(`❌ Не найден: ${arg}`);
  if (!u.refBanned) return ctx.reply(`ℹ️ ${u.firstName ?? u.tgId} не был заблокирован — ничего не изменено.`);

  await db.botUser.update({ where: { id: u.id }, data: { refBanned: false } });
  await ctx.reply(`✅ ${u.firstName ?? "—"} (@${u.username ?? u.tgId}) снова может приглашать людей.`);
});

// Admin: manually deliver goods for a "manual delivery" order → /give <orderId> <login:pass or link>
bot.command("give", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const m = (ctx.match ?? "").trim();
  const sp = m.indexOf(" ");
  const orderId = Number(sp > 0 ? m.slice(0, sp) : m);
  const text = sp > 0 ? m.slice(sp + 1).trim() : "";
  if (!orderId || !text) return ctx.reply("Формат: /give <номер заказа> <логин:пароль или ссылка>");
  const order = await db.botOrder.findUnique({ where: { id: orderId }, include: { user: true } });
  if (!order) return ctx.reply(`Заказ #${orderId} не найден`);
  await db.botOrder.update({ where: { id: orderId }, data: { payload: text, status: "delivered" } });
  const ulang = order.user.lang;
  await bot.api.sendMessage(
    order.user.tgId,
    `🎁 ${t(ulang, "your_goods")}\n<code>${esc(text)}</code>\n\n${esc(order.titleRu)}`,
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(t(ulang, "to_shop"), "m:0:all") },
  ).catch(() => {});
  await ctx.reply(`✅ Выдано заказу #${orderId} → @${order.user.username ?? order.user.tgId}`);
});

// Admin: /stock — show current stock levels for all variants
bot.command("stock", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const variants = await db.variant.findMany({
    where: { isActive: true },
    include: { plan: { include: { product: true } } },
    orderBy: { id: "asc" },
  });
  const lines: string[] = ["📦 <b>Склад</b>\n"];
  for (const v of variants) {
    const local = await db.stockItem.count({ where: { variantId: v.id, isSold: false } });
    const api = v.autoSupplier ? v.supplierStock : 0;
    lines.push(`• <b>${esc(v.plan.product.titleRu)}</b> — ${esc(v.titleRu)}`);
    lines.push(`  Свой склад: ${local} | API: ${api} | Всего: ${local + api}`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

// Admin broadcast: /post <text>  OR  reply to any message with /post
// Sends the message to every bot user. HTML formatting supported; premium
// emojis via <tg-emoji emoji-id="..."> tags carry over. Reply-mode uses
// copyMessage so photos/videos/stickers with premium emoji in captions are
// forwarded exactly (no "Forwarded from" header).
bot.command("post", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const replyTo = ctx.message?.reply_to_message;
  const text = (ctx.match ?? "").trim();
  if (!replyTo && !text) {
    return ctx.reply(
      "📢 Формат:\n" +
      "  <code>/post ваше сообщение</code> — рассылка текста (HTML + &lt;tg-emoji&gt; поддерживаются)\n" +
      "  Или ответьте на любое сообщение командой <code>/post</code> — отправлю точную копию всем.",
      { parse_mode: "HTML" },
    );
  }
  const status = await ctx.reply("📢 Рассылка запущена…").catch(() => null);
  const users = await db.botUser.findMany({ select: { tgId: true } });
  let ok = 0, fail = 0;
  const chunk = 25; // small parallel batches — polite to Telegram, still fast
  for (let i = 0; i < users.length; i += chunk) {
    await Promise.all(
      users.slice(i, i + chunk).map(async (u) => {
        try {
          if (replyTo) {
            await ctx.api.copyMessage(u.tgId, ctx.chat!.id, replyTo.message_id);
          } else {
            await ctx.api.sendMessage(u.tgId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
          }
          ok++;
        } catch {
          fail++;
        }
      }),
    );
    // ~30 msg/s is well under Telegram's global rate limit; small pause per batch.
    await new Promise((r) => setTimeout(r, 900));
  }
  const done = `📢 Готово: доставлено <b>${ok}</b> · не доставлено <b>${fail}</b> (всего ${users.length})`;
  if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, done, { parse_mode: "HTML" }).catch(() => {});
  else await ctx.reply(done, { parse_mode: "HTML" }).catch(() => {});
});

// Admin broadcast: /sendgifts or /postgifts
// Sends the video gift banner + each user's unique referral link & gift buttons to all users
bot.command(["sendgifts", "postgifts"], async (ctx) => {
  if (!isAdmin(ctx)) return;
  const status = await ctx.reply("🎁 Запущена персональная рассылка подарков с видео всем пользователям…").catch(() => null);
  const users = await db.botUser.findMany();
  let ok = 0, fail = 0;
  const chunk = 15;
  for (let i = 0; i < users.length; i += chunk) {
    await Promise.all(
      users.slice(i, i + chunk).map(async (u) => {
        const sent = await sendGiftsToUser(u);
        if (sent) ok++; else fail++;
      })
    );
    await new Promise((r) => setTimeout(r, 1000));
  }
  const done = `🎁 <b>Рассылка подарков завершена!</b>\n\nУспешно доставлено: <b>${ok}</b>\nОшибка / заблокировали бота: <b>${fail}</b>\nВсего пользователей: <b>${users.length}</b>`;
  if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, done, { parse_mode: "HTML" }).catch(() => {});
  else await ctx.reply(done, { parse_mode: "HTML" }).catch(() => {});
});

// Formatter: /code — format links into numbered copy-on-tap lines
bot.command("code", async (ctx) => {
  const allowed = String(ctx.from?.id) === ADMIN_ID || (await db.botUser.findUnique({ where: { tgId: String(ctx.from?.id) } }))?.isFormatterAllowed;
  if (!allowed) return;
  pending.set(String(ctx.from?.id), { type: "formatter_index" });
  await ctx.reply("🔢 <b>С какого числа начать нумерацию?</b>\n\nНапишите число (например, 1 или 51):", { parse_mode: "HTML" });
});

// Slash commands mirroring every menu button (also shown in the "/" command menu).
bot.command("shop", (ctx) => showMenu(ctx, 0, "all", false));
bot.command(["freebies", "deals", "aksiya", "gifts"], (ctx) => showGifts(ctx));
bot.command(["balance", "wallet", "balans"], async (ctx) => { const u = await getUser(ctx); const { text, kb } = balanceView(u.lang, u.balance); await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }); });
bot.command(["orders", "buyurtmalar"], async (ctx) => { const u = await getUser(ctx); const { text, kb } = await ordersView(u.lang, u.id); await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => ctx.reply(stripTags(text), { reply_markup: kb }).catch(() => {})); });
bot.command(["profile", "profil"], async (ctx) => { const u = await getUser(ctx); const { text, kb } = await profileView(u); await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }); });
bot.command(["referral", "invite", "taklif"], async (ctx) => { const u = await getUser(ctx); const { text, kb } = referView(ctx, u); await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }); });
bot.command(["support", "yordam"], async (ctx) => { const u = await getUser(ctx); const { text, kb } = await supportView(u.lang); await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }); });
bot.command(["language", "lang", "til"], (ctx) => showLangPicker(ctx, false));

// Promo-code how-to video: how to get one and where to enter it in the bot.
async function showInstructions(ctx: Context) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const video = promoInstructionsFile();
  const caption = t(lang, "instructions_caption");
  const kb = new InlineKeyboard().text(t(lang, "promo_btn"), "promo").row().text(t(lang, "to_shop"), "m:0:all");
  if (video) {
    await ctx.replyWithVideo(video, { caption, parse_mode: "HTML", reply_markup: kb }).catch(async () => {
      await ctx.reply(caption, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    });
  } else {
    await ctx.reply(caption, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  }
}
bot.command(["instructions", "howto", "instruksiya"], showInstructions);

// ── Методы / гайды ──────────────────────────────────────────────
function methodTitle(m: { titleRu: string; titleUz: string; titleEn: string }, lang: string): string {
  return lang === "uz" ? m.titleUz || m.titleRu : lang === "en" ? m.titleEn || m.titleRu : m.titleRu;
}
function methodDesc(m: { descRu: string; descUz: string; descEn: string }, lang: string): string {
  return lang === "uz" ? m.descUz || m.descRu : lang === "en" ? m.descEn || m.descRu : m.descRu;
}

/** Список активных методов (кнопки → meth:<id>). */
async function showMethods(ctx: Context) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const enabled = (await setting("methods_enabled", "1")) === "1";
  if (!enabled) {
    return ctx.reply(t(lang, "methods_disabled") || "Методы отключены.", {
      reply_markup: new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all"),
    });
  }
  const methods = await db.method.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
  if (!methods.length) return ctx.reply(t(lang, "methods_empty"));
  const kb = new InlineKeyboard();
  for (const m of methods) {
    const price = m.priceUzs > 0 ? money(m.priceUzs, lang) : t(lang, "method_free");
    kb.text(`${m.emoji} ${methodTitle(m, lang)} · ${price}`, `meth:${m.id}`).row();
  }
  return ctx.reply(t(lang, "methods_title"), { reply_markup: kb });
}

/** Отдать пользователю содержимое метода (инструкция + ссылка). */
async function deliverMethod(
  ctx: Context, lang: string,
  m: { emoji: string; titleRu: string; titleUz: string; titleEn: string; descRu: string; descUz: string; descEn: string; url: string | null },
) {
  const title = methodTitle(m, lang);
  const desc = methodDesc(m, lang) || "";
  // No URL button in method delivery — just back to shop.
  const kb = new InlineKeyboard();
  kb.text(t(lang, "to_shop"), "m:0:all");
  const body = `${m.emoji} <b>${esc(title)}</b>\n\n${esc(desc)}`;
  await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } })
    .catch(async () => {
      // Last-resort plain delivery — guarantees the method reaches the user.
      const plain = `${m.emoji} ${title}\n\n${desc}${m.url ? `\n\n${m.url}` : ""}`;
      await ctx.reply(plain, { reply_markup: new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all") }).catch(() => {});
    });
}

/** Открыть метод: бесплатный/купленный — сразу отдать; платный — кнопка покупки. */
async function viewMethod(ctx: Context, id: number) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const m = await db.method.findUnique({ where: { id } });
  if (!m || !m.isActive) return ctx.answerCallbackQuery().catch(() => {});
  await ctx.answerCallbackQuery().catch(() => {});
  const bought = await db.methodPurchase
    .findUnique({ where: { methodId_userId: { methodId: id, userId: user.id } } })
    .catch(() => null);
  if (m.priceUzs <= 0 || bought) return deliverMethod(ctx, lang, m);
  const kb = new InlineKeyboard()
    .text(t(lang, "method_buy", { v: money(m.priceUzs, lang) }), `mbuy:${m.id}`).row()
    .text(t(lang, "to_shop"), "m:0:all");
  const body = `${m.emoji} <b>${esc(methodTitle(m, lang))}</b>\n\n${t(lang, "balance_line", { v: money(user.balance, lang) })}`;
  return ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
}

/** Купить платный метод: списать баланс, зафиксировать покупку, отдать. */
async function buyMethod(ctx: Context, id: number) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const m = await db.method.findUnique({ where: { id } });
  if (!m || !m.isActive) return ctx.answerCallbackQuery().catch(() => {});
  const existing = await db.methodPurchase
    .findUnique({ where: { methodId_userId: { methodId: id, userId: user.id } } })
    .catch(() => null);
  if (existing) {
    await ctx.answerCallbackQuery({ text: t(lang, "method_bought") }).catch(() => {});
    return deliverMethod(ctx, lang, m);
  }
  const price = m.priceUzs;
  if (price > 0 && user.balance < price) {
    return ctx.answerCallbackQuery({
      text: t(lang, "method_need_balance", { v: money(price - user.balance, lang) }),
      show_alert: true,
    }).catch(() => {});
  }
  try {
    await db.$transaction(async (tx) => {
      if (price > 0) await tx.botUser.update({ where: { id: user.id }, data: { balance: { decrement: price } } });
      await tx.methodPurchase.create({ data: { methodId: id, userId: user.id, pricePaid: price } });
    });
  } catch {
    // гонка по уникальному ключу — считаем, что уже куплено
  }
  await ctx.answerCallbackQuery({ text: t(lang, "method_delivered") }).catch(() => {});
  return deliverMethod(ctx, lang, m);
}

bot.hears(btnVariants("btn_methods"), (ctx) => showMethods(ctx));
bot.hears(btnVariants("btn_shop"), (ctx) => showMenu(ctx, 0, "all", false));
bot.hears(btnVariants("btn_freebies"), (ctx) => showGifts(ctx));
bot.hears(btnVariants("btn_wallet"), async (ctx) => { const u = await getUser(ctx); const { text, kb } = balanceView(u.lang, u.balance); await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }); });
bot.hears(btnVariants("btn_orders"), async (ctx) => { const u = await getUser(ctx); const { text, kb } = await ordersView(u.lang, u.id); await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => ctx.reply(stripTags(text), { reply_markup: kb }).catch(() => {})); });
bot.hears(btnVariants("btn_profile"), async (ctx) => { const u = await getUser(ctx); const { text, kb } = await profileView(u); await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }); });
bot.hears(btnVariants("btn_instructions"), showInstructions);
bot.hears(btnVariants("btn_refer"), async (ctx) => { const u = await getUser(ctx); const { text, kb } = referView(ctx, u); await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }); });
bot.hears(btnVariants("btn_support"), async (ctx) => { const u = await getUser(ctx); const { text, kb } = await supportView(u.lang); await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }); });
bot.hears(btnVariants("btn_language"), (ctx) => showLangPicker(ctx, false));

// ---------- inline callbacks ----------
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  console.log(`[bot] callback from ${ctx.from?.id}: "${data}"`);
  try {
    if (data === "noop") return ctx.answerCallbackQuery();
    if (data === "check_subs") {
      const user = await getUser(ctx);
      const active = await db.requiredChannel.findMany({ where: { isActive: true } });
      const results = await Promise.all(active.map((ch) => isSubscribedTo(ctx, user.tgId, ch.chatId)));
      const unsubscribed = active.filter((_, i) => !results[i]);
      if (unsubscribed.length === 0) {
        subsOkCache.set(user.tgId, Date.now() + SUBS_CACHE_TTL_MS);
        db.botUser.updateMany({ where: { tgId: user.tgId, channelVerifiedAt: null }, data: { channelVerifiedAt: new Date() } }).catch(() => {});
        await ctx.answerCallbackQuery({ text: t(user.lang, "subs_ok_toast"), show_alert: true }).catch(() => {});
        return enterShop(ctx, user);
      } else {
        await ctx.answerCallbackQuery({ text: t(user.lang, "subs_missing_toast"), show_alert: true }).catch(() => {});
        const kb = new InlineKeyboard();
        for (const ch of unsubscribed) {
          kb.url(`📢 ${ch.name}`, ch.url).row();
        }
        kb.text(t(user.lang, "check_subs_btn"), "check_subs").row();
        const text = t(user.lang, "subs_required_msg");
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
        return;
      }
    }
    if (data.startsWith("lang:")) {
      const lang = normalizeLang(data.split(":")[1]);
      await db.botUser.update({ where: { tgId: String(ctx.from?.id) }, data: { lang } }).catch(() => {});
      await ctx.answerCallbackQuery({ text: t(lang, "lang_set") }).catch(() => {});
      await ctx.editMessageText(t(lang, "lang_set")).catch(() => {});
      const user = await getUser(ctx);
      return enterShop(ctx, user);
    }
    if (data === "terms_accept") {
      const user = await getUser(ctx);
      const now = new Date();
      await db.botUser.update({
        where: { id: user.id },
        data: {
          termsAcceptedAt: now,
          // Accepting terms means they passed the subscription gate — mark as verified.
          channelVerifiedAt: user.channelVerifiedAt ?? now,
        },
      }).catch(() => {});
      await ctx.answerCallbackQuery({ text: t(user.lang, "terms_accepted_toast") }).catch(() => {});
      await ctx.editMessageReplyMarkup().catch(() => {});
      return sendHome(ctx, user);
    }
    const user = await getUser(ctx);
    const lang = user.lang;
    if (data === "bal") { const { text, kb } = balanceView(lang, user.balance); await sendOrEdit(ctx, text, { reply_markup: kb }); return ctx.answerCallbackQuery().catch(() => {}); }
    if (data === "ord") { const { text, kb } = await ordersView(lang, user.id); await sendOrEdit(ctx, text, { reply_markup: kb }); return ctx.answerCallbackQuery().catch(() => {}); }
    if (data === "ref") { const { text, kb } = referView(ctx, user); await sendOrEdit(ctx, text, { reply_markup: kb }); return ctx.answerCallbackQuery().catch(() => {}); }
    if (data === "topin") { pending.set(String(ctx.from?.id), { type: "topup" }); await ctx.answerCallbackQuery().catch(() => {}); return ctx.reply(t(lang, "enter_amount", { min: money(MIN_TOPUP, lang) })); }
    if (data === "promo") { pending.set(String(ctx.from?.id), { type: "promo" }); await ctx.answerCallbackQuery().catch(() => {}); return ctx.reply(t(lang, "promo_enter")); }
    if (data === "methods_show") { await ctx.answerCallbackQuery().catch(() => {}); return showMethods(ctx); }
    if (data === "gifts_show") { await ctx.answerCallbackQuery().catch(() => {}); return showGifts(ctx, true, false); }
    if (data === "support_show") { const { text, kb } = await supportView(lang); await sendOrEdit(ctx, text, { reply_markup: kb }); return ctx.answerCallbackQuery().catch(() => {}); }
    if (data === "lang_pick") { await ctx.answerCallbackQuery().catch(() => {}); return showLangPicker(ctx, true); }
    if (data === "profile_show") { const { text, kb } = await profileView(user); await sendOrEdit(ctx, text, { reply_markup: kb }); return ctx.answerCallbackQuery().catch(() => {}); }

    const [tag, ...rest] = data.split(":");
    if (tag === "m") { const page = Number(rest[0]) || 0; const sort = (SORTS.includes(rest[1] as Sort) ? rest[1] : "all") as Sort; await ctx.answerCallbackQuery().catch(() => {}); return showMenu(ctx, page, sort, true); }
    if (tag === "p") return showProduct(ctx, Number(rest[0]), `${Number(rest[1]) || 0}:${rest[2] ?? "all"}`);
    if (tag === "b") return showQtyChooser(ctx, Number(rest[0]), 1, `${rest[1] ?? "0"}:${rest[2] ?? "all"}`, true);
    if (tag === "q") return showQtyChooser(ctx, Number(rest[0]), Number(rest[1]) || 1, `${rest[2] ?? "0"}:${rest[3] ?? "all"}`, true);
    if (tag === "qi") { pending.set(String(ctx.from?.id), { type: "qty", variantId: Number(rest[0]), back: `${rest[1] ?? "0"}:${rest[2] ?? "all"}` }); await ctx.answerCallbackQuery().catch(() => {}); return ctx.reply(t(lang, "enter_qty_msg")); }
    if (tag === "bc") return doBuy(ctx, Number(rest[0]), Number(rest[1]) || 1);
    if (tag === "rb") return buyForReferrals(ctx, Number(rest[0]));
    if (tag === "na") {
      // "Notify me when back in stock" — save a StockAlert for this variant.
      const variantId = Number(rest[0]);
      await ctx.answerCallbackQuery().catch(() => {});
      if (!variantId) return;
      await db.$executeRawUnsafe(
        `INSERT INTO "StockAlert" ("tgId", "variantId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        user.tgId, variantId,
      ).catch(() => {});
      await ctx.reply(t(lang, "notify_saved")).catch(() => {});
      return;
    }
    if (tag === "gi") return showGiftItem(ctx, Number(rest[0]));
    if (tag === "meth") return viewMethod(ctx, Number(rest[0]));
    if (tag === "mbuy") return buyMethod(ctx, Number(rest[0]));
    if (tag === "top") { await ctx.answerCallbackQuery().catch(() => {}); const b = await buildTopupMethods(lang, Number(rest[0])); await sendOrEdit(ctx, b.text, { reply_markup: b.kb }); return; }
    if (tag === "tstar") return starsInvoice(ctx, lang, Number(rest[0]));
    if (tag === "tcheck") return startReceiptPayment(ctx, lang, Number(rest[0]));
    if (tag === "tcard") return cardInvoice(ctx, lang, Number(rest[0]));
    if (tag === "tman") { await ctx.answerCallbackQuery().catch(() => {}); return requestTopUp(ctx, lang, Number(rest[0]), "manual"); }
    if (tag === "tcheck_buy") return startReceiptPayment(ctx, lang, Number(rest[0]), `buy:${rest[1]}:${rest[2]}`);
    if (tag === "tstar_buy") return starsInvoice(ctx, lang, Number(rest[0]), `buy:${rest[1]}:${rest[2]}`);
    if (tag === "tman_buy") { await ctx.answerCallbackQuery().catch(() => {}); return requestTopUp(ctx, lang, Number(rest[0]), "manual", `buy:${rest[1]}:${rest[2]}`); }
    if (tag === "ap") return resolveTopUp(ctx, Number(rest[0]), true);
    if (tag === "rj") return resolveTopUp(ctx, Number(rest[0]), false);
    if (tag === "rjs") return handleRejectChoice(ctx, Number(rest[0]), rest[1]);
    return ctx.answerCallbackQuery();
  } catch (e) {
    console.error("[bot] callback error:", (e as Error).message);
    return ctx.answerCallbackQuery({ text: "⚠️", show_alert: true }).catch(() => {});
  }
});

// ---------- free-text input ----------
bot.on("message:text", async (ctx) => {
  const key = String(ctx.from?.id);
  const state = pending.get(key);
  if (!state) return;

  if (state.type === "reject_custom_reason") {
    pending.delete(key);
    const customReason = (ctx.message.text ?? "").trim();
    if (!customReason) {
      return ctx.reply("⚠️ Текст причины не может быть пустым. Пожалуйста, напишите причину ещё раз:");
    }
    const topup = await db.topUp.findUnique({ where: { id: state.topupId }, include: { user: true } });
    if (!topup || !["pending", "review", "awaiting_receipt"].includes(topup.status)) {
      return ctx.reply("⚠️ Этот чек уже обработан или не найден.");
    }
    await executeRejectTopup(ctx, topup, customReason, undefined, customReason);
    return;
  }

  if (state.type !== "formatter_links") {
    pending.delete(key);
  }

  const user = await getUser(ctx);
  const lang = user.lang;

  if (state.type === "formatter_index") {
    const rawNum = ctx.message.text.replace(/[^\d]/g, "");
    const startVal = parseInt(rawNum);
    const startIndex = Number.isFinite(startVal) ? Math.max(1, startVal) : 1;

    pending.set(key, { type: "formatter_links", startIndex });
    return ctx.reply("📥 <b>Отправьте список ссылок</b> (каждая на новой строке):", { parse_mode: "HTML" });
  }

  if (state.type === "formatter_links") {
    const rawText = ctx.message.text ?? "";
    const links = rawText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Accumulate links in memory state
    if (!state.collectedLinks) {
      state.collectedLinks = [];
    }
    state.collectedLinks.push(...links);

    // Debounce processing to wait for all messages to arrive
    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
    }

    state.timeoutId = setTimeout(async () => {
      // Done collecting, clean up state
      pending.delete(key);

      const rawLinks = state.collectedLinks || [];
      if (rawLinks.length === 0) {
        return ctx.reply("⚠️ Ссылки не найдены. Пожалуйста, отправьте список ссылок еще раз:");
      }

      // A pasted URL sometimes carries a stray line break mid-way (copied from
      // a source that soft-wrapped it), which would otherwise split ONE link
      // into two numbered entries. Any "line" that isn't itself a fresh
      // http(s):// link is a continuation of the previous one — rejoin it.
      const allLinks: string[] = [];
      for (const line of rawLinks) {
        if (allLinks.length > 0 && !/^https?:\/\//i.test(line)) {
          allLinks[allLinks.length - 1] += line;
        } else {
          allLinks.push(line);
        }
      }

      let current = state.startIndex;
      // Query strings in these links are full of "&" — parse_mode HTML requires
      // it (and "<"/">") escaped, or Telegram silently rejects the whole
      // message; that was dropping entire chunks of links without any error.
      const formattedLines = allLinks.map((link) => `<code>${current++}. ${esc(link)}</code>`);

      await ctx.reply("✅ <b>Форматированный список:</b>", { parse_mode: "HTML" }).catch(() => {});

      let currentMessage = "";
      for (const line of formattedLines) {
        if (currentMessage.length + line.length + 1 > 4000) {
          await ctx.reply(currentMessage, { parse_mode: "HTML" }).catch((e) => console.error("[bot] /code chunk failed:", (e as Error).message));
          currentMessage = "";
        }
        currentMessage += (currentMessage ? "\n" : "") + line;
      }
      if (currentMessage) {
        await ctx.reply(currentMessage, { parse_mode: "HTML" }).catch((e) => console.error("[bot] /code chunk failed:", (e as Error).message));
      }
    }, 1000);

    // Save back to pending map
    pending.set(key, state);
    return;
  }

  if (state.type === "promo") {
    return redeemPromo(ctx, user, ctx.message.text);
  }

  const n = Math.floor(Number(ctx.message.text.replace(/[^\d]/g, "")));
  if (state.type === "qty") {
    if (!Number.isFinite(n) || n < 1) return ctx.reply(t(lang, "enter_number"));
    return showQtyChooser(ctx, state.variantId, n, state.back, false);
  }
  if (!Number.isFinite(n) || n < MIN_TOPUP) return ctx.reply(t(lang, "min_amount", { min: money(MIN_TOPUP, lang) }));
  const b = await buildTopupMethods(lang, n);
  return ctx.reply(b.text, { parse_mode: "HTML", reply_markup: b.kb });
});

// ---------- receipt photo (card payment verification) ----------
bot.on("message:photo", async (ctx) => {
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1]?.file_id; // largest size
  if (fileId) await handleReceiptPhoto(ctx, fileId);
});
// Receipt sent as an image file (document)
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  if (doc.mime_type?.startsWith("image/") && doc.file_id) await handleReceiptPhoto(ctx, doc.file_id);
});

// A user submitted a join request on a channel that has "approve new
// members" enabled. getChatMember won't show them as a member until an admin
// approves it, so record the request itself — the subscription gate treats a
// pending request the same as an approved membership (see isSubscribedTo()).
// Auto-detect when a user joins a required channel (bot must be admin there).
// Telegram sends chat_member updates for group/channel member status changes
// only when the bot is an admin with the right to see members.
bot.on("chat_member", async (ctx) => {
  const newStatus = ctx.chatMember.new_chat_member.status;
  const oldStatus = ctx.chatMember.old_chat_member.status;
  // Only react when someone actually joins (left/kicked → member/administrator).
  const joined = (newStatus === "member" || newStatus === "administrator") &&
    (oldStatus === "left" || oldStatus === "kicked");
  if (!joined) return;

  const newUser = ctx.chatMember.new_chat_member.user;
  // Skip bots and anonymous/channel accounts (their IDs are negative or is_bot=true).
  if (newUser.is_bot || newUser.id <= 0) return;

  const tgId = String(newUser.id);
  const chatId = String(ctx.chat.id);

  // Only care about required channels.
  const ch = await db.requiredChannel.findFirst({ where: { chatId, isActive: true } }).catch(() => null);
  if (!ch) return;

  // Check if user is now subscribed to ALL required channels.
  const allChannels = await db.requiredChannel.findMany({ where: { isActive: true } }).catch(() => []);
  const results = await Promise.all(allChannels.map((c) => isSubscribedTo(ctx, tgId, c.chatId)));
  if (!results.every(Boolean)) return;

  // All channels verified — mark user and notify them.
  subsOkCache.set(tgId, Date.now() + SUBS_CACHE_TTL_MS);
  const user = await db.botUser.findUnique({ where: { tgId } }).catch(() => null);
  if (!user) return;

  db.botUser.updateMany({ where: { tgId, channelVerifiedAt: null }, data: { channelVerifiedAt: new Date() } }).catch(() => {});

  // Delete the gate message (channel links) if we know its ID.
  const gateMsgId = subsGateMsg.get(tgId);
  if (gateMsgId) {
    bot.api.deleteMessage(tgId, gateMsgId).catch(() => {});
    subsGateMsg.delete(tgId);
  }

  const lang = user.lang ?? "ru";

  if (!user.termsAcceptedAt) {
    // New user: show terms gate next (they'll see the shop after accepting).
    const termsCustom = await db.setting.findUnique({ where: { key: "terms" } }).then((r) => r?.valueRu?.trim() ?? "").catch(() => "");
    const body = termsCustom || t(lang, "terms_body");
    const termsText = `${t(lang, "terms_title")}\n\n<blockquote>${esc(t(lang, "terms_intro"))}\n\n${body}</blockquote>`;
    const termsKb = new InlineKeyboard().text(t(lang, "terms_accept_btn"), "terms_accept");
    await bot.api.sendMessage(tgId, termsText, { parse_mode: "HTML", reply_markup: termsKb, link_preview_options: { is_disabled: true } }).catch(async () => {
      await bot.api.sendMessage(tgId, stripTags(termsText), { reply_markup: termsKb }).catch(() => {});
    });
    return;
  }

  // Returning user: open shop directly.
  const menu = await buildMenu(lang, user.balance, 0, "all", user.id);
  const banner = shopBannerFile();
  if (banner) {
    await bot.api.sendPhoto(tgId, banner, { caption: menu.text, parse_mode: "HTML", reply_markup: menu.kb }).catch(async () => {
      await bot.api.sendMessage(tgId, menu.text, { parse_mode: "HTML", reply_markup: menu.kb }).catch(() => {});
    });
  } else {
    await bot.api.sendMessage(tgId, menu.text, { parse_mode: "HTML", reply_markup: menu.kb }).catch(() => {});
  }
});

bot.on("chat_join_request", async (ctx) => {
  const chatId = String(ctx.chatJoinRequest.chat.id);
  const tgId = String(ctx.chatJoinRequest.from.id);
  await db.channelJoinRequest
    .upsert({ where: { chatId_tgId: { chatId, tgId } }, create: { chatId, tgId }, update: {} })
    .catch((e) => console.error("[bot] chat_join_request record failed:", (e as Error).message));
  // Auto-approve so the person actually becomes a channel member instead of
  // sitting "pending" forever waiting on a human — requires the bot to be an
  // admin on the channel with rights to invite/manage members.
  await ctx.approveChatJoinRequest(ctx.chatJoinRequest.from.id).catch((e) => console.error("[bot] auto-approve join request failed:", (e as Error).message));
});

// ---------- payments ----------
bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true).catch(() => {}));
bot.on("message:successful_payment", async (ctx) => {
  const sp = ctx.message.successful_payment;
  const parts = (sp.invoice_payload ?? "").split(":");
  const tag = parts[0];
  const amtStr = parts[1];
  const method = parts[2];
  if (tag !== "topup") return;
  const amount = Number(amtStr);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const variantId = parts[3] === "buy" ? Number(parts[4]) : undefined;
  const qty = parts[3] === "buy" ? Number(parts[5]) : undefined;

  await creditPaidTopUp(ctx, amount, method || "stars", sp.telegram_payment_charge_id, variantId, qty);
});

bot.catch((err) => console.error("[bot] error:", err.error));

// Auto-color every button (Bot API 9.4 `style`).
bot.api.config.use((prev, method, payload, signal) => {
  const rm = (payload as { reply_markup?: { inline_keyboard?: unknown[][]; keyboard?: unknown[][] } }).reply_markup;
  if (rm?.inline_keyboard)
    for (const row of rm.inline_keyboard)
      for (const btn of row as Array<{ text?: string; callback_data?: string; style?: string; icon_custom_emoji_id?: string }>) {
        const st = styleFor(btn.callback_data);
        if (st && !btn.style) btn.style = st;
        // Premium icon on known nav buttons (back / support / invite / gifts).
        // The plain leading emoji is stripped so it isn't shown twice.
        if (btn.text && !btn.icon_custom_emoji_id) {
          const icon = premiumIconFor(btn.text);
          if (icon) {
            btn.icon_custom_emoji_id = icon;
            btn.text = stripLeadEmoji(btn.text);
          }
        }
      }
  if (rm?.keyboard)
    for (const row of rm.keyboard)
      for (const btn of row as Array<{ text?: string; style?: string; icon_custom_emoji_id?: string }>) {
        if (typeof btn !== "object" || btn === null) continue;
        if (!btn.style) btn.style = "primary";
        // Reply-keyboard buttons take premium icons too (Bot API 9.4).
        if (btn.text && !btn.icon_custom_emoji_id) {
          const icon = premiumIconFor(btn.text);
          if (icon) {
            btn.icon_custom_emoji_id = icon;
            btn.text = stripLeadEmoji(btn.text);
          }
        }
      }
  return prev(method, payload, signal);
});

// Create tables added in this release if they're missing (idempotent), via the
// Prisma client itself — no CLI/shell, works with the internal DB URL at runtime.
// DDL matches `prisma migrate diff` output. Non-fatal: logs and continues.
async function ensureSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS "UserVariantPrice" (
      "id" SERIAL NOT NULL,
      "userId" INTEGER NOT NULL,
      "variantId" INTEGER NOT NULL,
      "priceUzs" INTEGER NOT NULL,
      "label" TEXT NOT NULL DEFAULT '',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "UserVariantPrice_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "UserVariantPrice_userId_idx" ON "UserVariantPrice"("userId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "UserVariantPrice_userId_variantId_key" ON "UserVariantPrice"("userId", "variantId")`,
    `CREATE TABLE IF NOT EXISTS "PromoCode" (
      "id" SERIAL NOT NULL,
      "code" TEXT NOT NULL,
      "amountUzs" INTEGER NOT NULL,
      "maxUses" INTEGER NOT NULL DEFAULT 0,
      "usedCount" INTEGER NOT NULL DEFAULT 0,
      "perUserLimit" INTEGER NOT NULL DEFAULT 1,
      "expiresAt" TIMESTAMP(3),
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "note" TEXT NOT NULL DEFAULT '',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PromoCode_code_key" ON "PromoCode"("code")`,
    `CREATE TABLE IF NOT EXISTS "PromoRedemption" (
      "id" SERIAL NOT NULL,
      "promoId" INTEGER NOT NULL,
      "userId" INTEGER NOT NULL,
      "amountUzs" INTEGER NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "PromoRedemption_promoId_userId_idx" ON "PromoRedemption"("promoId", "userId")`,
    `CREATE TABLE IF NOT EXISTS "Method" (
      "id" SERIAL NOT NULL,
      "code" TEXT NOT NULL,
      "titleRu" TEXT NOT NULL,
      "titleUz" TEXT NOT NULL,
      "titleEn" TEXT NOT NULL DEFAULT '',
      "emoji" TEXT NOT NULL DEFAULT '📘',
      "premiumEmoji" TEXT,
      "bannerFileId" TEXT,
      "descRu" TEXT NOT NULL DEFAULT '',
      "descUz" TEXT NOT NULL DEFAULT '',
      "descEn" TEXT NOT NULL DEFAULT '',
      "url" TEXT,
      "priceUzs" INTEGER NOT NULL DEFAULT 0,
      "priceStars" INTEGER NOT NULL DEFAULT 0,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Method_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Method_code_key" ON "Method"("code")`,
    `CREATE TABLE IF NOT EXISTS "MethodPurchase" (
      "id" SERIAL NOT NULL,
      "methodId" INTEGER NOT NULL,
      "userId" INTEGER NOT NULL,
      "pricePaid" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "MethodPurchase_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "MethodPurchase_userId_idx" ON "MethodPurchase"("userId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "MethodPurchase_methodId_userId_key" ON "MethodPurchase"("methodId", "userId")`,
    `ALTER TABLE "BotUser" ADD COLUMN IF NOT EXISTS "bonusReferrals" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "BotUser" ADD COLUMN IF NOT EXISTS "termsAcceptedAt" TIMESTAMP(3)`,
    `ALTER TABLE "BotUser" ADD COLUMN IF NOT EXISTS "spentReferrals" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "BotUser" ADD COLUMN IF NOT EXISTS "channelVerifiedAt" TIMESTAMP(3)`,
    `ALTER TABLE "BotUser" ADD COLUMN IF NOT EXISTS "refBanned" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Variant" ADD COLUMN IF NOT EXISTS "pointsCost" INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS "ChannelJoinRequest" (
      "id" SERIAL NOT NULL,
      "chatId" TEXT NOT NULL,
      "tgId" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ChannelJoinRequest_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ChannelJoinRequest_chatId_tgId_key" ON "ChannelJoinRequest"("chatId", "tgId")`,
    `CREATE TABLE IF NOT EXISTS "StockAlert" (
      "id" SERIAL NOT NULL,
      "tgId" TEXT NOT NULL,
      "variantId" INTEGER NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "StockAlert_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "StockAlert_tgId_variantId_key" ON "StockAlert"("tgId", "variantId")`,
  ];
  for (const sql of statements) {
    try {
      await db.$executeRawUnsafe(sql);
    } catch (e) {
      console.error("[bot] ensureSchema failed:", (e as Error).message);
    }
  }
}

function genAdminPassword(len = 20) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_";
  const buf = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

// Admin reset. Two modes:
//  • If ADMIN_LOGIN + ADMIN_PASSWORD env vars are set → enforce that single admin
//    on EVERY start (owner controls the password; timing/markers don't matter).
//  • Otherwise → one-time random reset (guarded by a BotSetting marker) with the
//    generated credentials DM'd to the admin Telegram chat.
async function maybeResetAdmins() {
  try {
    const role = await db.role.findUnique({ where: { key: "superadmin" } });
    if (!role) {
      console.error("[bot] maybeResetAdmins: superadmin role missing — skipping.");
      return;
    }

    const envEmail = (process.env.ADMIN_LOGIN || "").trim();
    const envPass = (process.env.ADMIN_PASSWORD || "").trim();
    const useEnv = envEmail.length > 0 && envPass.length >= 6;

    // In random mode, only run once (marker-gated). In env mode, always enforce.
    const MARKER = "admin_reset_v2_done";
    if (!useEnv) {
      const done = await db.botSetting.findUnique({ where: { key: MARKER } });
      if (done) return;
    }

    const email = useEnv ? envEmail : `admin_${randomBytes(4).toString("hex")}@sb.eu`;
    const password = useEnv ? envPass : genAdminPassword();
    const passwordHash = await bcrypt.hash(password, 12);

    const fresh = await db.admin.upsert({
      where: { email },
      create: { email, name: email.split("@")[0], passwordHash, roleId: role.id, isActive: true },
      update: { passwordHash, roleId: role.id, isActive: true },
    });
    const del = await db.admin.deleteMany({ where: { id: { not: fresh.id } } });

    if (!useEnv) {
      await db.botSetting.upsert({
        where: { key: MARKER },
        create: { key: MARKER, valueRu: new Date().toISOString(), type: "text" },
        update: { valueRu: new Date().toISOString() },
      });
      if (ADMIN_ID) {
        await bot.api.sendMessage(
          ADMIN_ID,
          `🔐 <b>Админ-панель обновлена</b>\n\n` +
            `Удалено прежних админов: <b>${del.count}</b>\n\n` +
            `Новый вход в веб-панель:\n` +
            `Логин: <code>${email}</code>\n` +
            `Пароль: <code>${password}</code>\n\n` +
            `⚠️ Сохраните это сообщение — пароль больше нигде не хранится.`,
          { parse_mode: "HTML" },
        ).catch(() => {});
      }
    }
    console.info(`[bot] admin reset (${useEnv ? "env" : "random"}) done: deleted ${del.count}, login=${email}`);
  } catch (e) {
    console.error("[bot] maybeResetAdmins failed:", (e as Error).message);
  }
}

async function bootstrap() {
  await ensureSchema();       // create missing tables before serving anything
  await maybeResetAdmins();   // one-time admin reset (guarded)
  await bot.start({
    drop_pending_updates: false,
    allowed_updates: [
      "message", "callback_query", "chat_member", "chat_join_request",
      "pre_checkout_query",
    ],
    onStart: async (me) => {
      buttonEmoji = await setting("button_emoji", "");
      walletButtonEmoji = (await setting("wallet_button_emoji", "")).trim() || PREMIUM_EMOJI_WALLET;
      profileButtonEmoji = (await setting("profile_button_emoji", "")).trim() || PREMIUM_EMOJI_PROFILE;
      ordersButtonEmoji = (await setting("orders_button_emoji", "")).trim() || PREMIUM_EMOJI_ORDERS;
      backButtonEmoji = (await setting("back_button_emoji", "")).trim() || PREMIUM_EMOJI_BACK;
      supportButtonEmoji = (await setting("support_button_emoji", "")).trim() || PREMIUM_EMOJI_SUPPORT;
      referButtonEmoji = (await setting("refer_button_emoji", "")).trim() || PREMIUM_EMOJI_REFER;
      giftsButtonEmoji = (await setting("gifts_button_emoji", "")).trim() || PREMIUM_EMOJI_GIFTS;
      shopButtonEmoji = (await setting("shop_button_emoji", "")).trim() || PREMIUM_EMOJI_SHOP;
      await bot.api.setMyCommands([
        { command: "start", description: "🛍 Магазин / Menu" },
        { command: "shop", description: "🛍 Магазин" },
        { command: "balance", description: "👛 Баланс" },
        { command: "freebies", description: "🎁 Акции" },
        { command: "orders", description: "🧾 Заказы" },
        { command: "profile", description: "👤 Профиль" },
        { command: "referral", description: "🤝 Пригласить" },
        { command: "support", description: "🆘 Поддержка" },
        { command: "language", description: "🌐 Язык / Language / Til" },
      ]).catch(() => {});
      prewarmTranslations().catch(() => {}); // pre-cache EN/UZ product titles
      console.info(`[bot] started as @${me.username} (long-polling)`);
    },
  });
}

bootstrap().catch((e) => {
  console.error("[bot] start FAILED:", e instanceof Error ? e.stack || e.message : e);
  process.exit(1);
});
