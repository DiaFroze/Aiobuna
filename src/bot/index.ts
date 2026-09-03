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
import { sourceOrder, envVexSource, envBuyerSource, type Source } from "../lib/supplier";
import { geminiTranslate } from "../lib/gemini";
import { t, LANGS, LANG_NAMES, normalizeLang, btnVariants, type Lang } from "./i18n";
import { generateVerificationCode } from "../lib/orderCode";
import { parseBulkPrices, parseBulkBonus, bulkTotal, bonusQty, bulkSaving, describeBulk } from "../lib/domain/bulk-pricing";
import { checkUsername } from "../lib/domain/telegram-username";
import { buildCheckoutUrl, sumToTiyin } from "../lib/domain/payme";
import { buildClickUrl } from "../lib/domain/click";
// The auto-delivery decision logic (classifyGiftError / decideAfterReconcile)
// lives in the same module and is unit-tested, but is intentionally NOT wired up
// yet: PREMIUM_DELIVERY_MODE stays "manual" until the Star-balance experiment
// confirms the bot can actually pay for giftPremiumSubscription.
import { premiumStarCost, buildBuyNote, parseBuyNote, deliversToAccount, closeDeliveryPatch } from "../lib/domain/premium-delivery";
import { STARS_MIN_QUANTITY, STARS_MAX_QUANTITY, isValidStarsQuantity } from "../lib/fragment/api-types";
import { STARS_RATE_CARRIER_AMOUNT, minQtyForStars } from "../lib/domain/stars-pricing";
import { lowStockCount, parseLowStockThreshold } from "../lib/domain/low-stock";
import { approveTopUp, APPROVABLE_STATUSES } from "../lib/domain/topup-approval";
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
// Shop banner: an admin-set Telegram file_id (photo OR video) wins; otherwise a
// file on disk (shop-banner.mov/.mp4 → video, .jpg/.png → photo). Set it from
// the phone with /banner — no redeploy needed to change it.
async function shopBanner(): Promise<{ src: string | InputFile; isVideo: boolean } | null> {
  const fileId = (await setting("shop_banner_file_id", "")).trim();
  if (fileId) return { src: fileId, isVideo: (await setting("shop_banner_is_video", "")).trim() === "1" };
  for (const name of ["shop-banner.mov", "shop-banner.mp4"]) {
    const f = mediaAssetFile(name);
    if (f) return { src: f, isVideo: true };
  }
  for (const name of ["shop-banner.jpg", "shop-banner.png"]) {
    const f = mediaAssetFile(name);
    if (f) return { src: f, isVideo: false };
  }
  return null;
}
const promoInstructionsFile = () => mediaAssetFile("promo-instructions.mp4");
const howToPayFile = () => mediaAssetFile("how-to-pay.mp4");
const howToActivateFile = () => mediaAssetFile("how-to-activate.mp4");

// Universal "edit or replace" for callback-driven navigation. Works whether
// the source message is plain text (edit its text) or a media message
// (edit its caption, or if that fails, delete + resend). Optionally sends a
// fresh media message with the given photo or video as its caption target.
type SendOrEditOpts = {
  reply_markup?: InlineKeyboard | undefined;
  photo?: string | InputFile | null;
  video?: string | InputFile | null;
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
// Payme (пополнение баланса, UZS). The webhook lives in the Next.js app; here
// the bot only offers the button and builds the checkout URL. paymeReady()
// gates the button so a half-configured merchant can never be shown.
function isAdmin(ctx: Context) {
  return ADMIN_ID !== "" && String(ctx.from?.id) === ADMIN_ID;
}
const PAYME_ENABLED = process.env.PAYME_ENABLED === "1";
const PAYME_MERCHANT_ID = process.env.PAYME_MERCHANT_ID ?? "";
const PAYME_CHECKOUT_URL = (process.env.PAYME_CHECKOUT_URL ?? "https://checkout.paycom.uz").replace(/\/+$/, "");
const paymeReady = (_ctx?: Context) => PAYME_ENABLED && PAYME_MERCHANT_ID !== "";
// Click SHOP-API (merchant.click.uz). The bot only builds the pay link; the
// Prepare/Complete callbacks live in the Next.js app (/api/click).
const CLICK_ENABLED = process.env.CLICK_ENABLED === "1";
const CLICK_SERVICE_ID = process.env.CLICK_SERVICE_ID ?? "";
const CLICK_MERCHANT_ID = process.env.CLICK_MERCHANT_ID ?? "";
const clickReady = (_ctx?: Context) =>
  CLICK_ENABLED && CLICK_SERVICE_ID !== "" && CLICK_MERCHANT_ID !== "";
// Premium-emoji ids for the bank buttons (same ones used in the poll).
const PAYME_BTN_EMOJI = "5204128408463744787";
const CLICK_BTN_EMOJI = "5350345287246311562";
// Premium emoji for the pay screen: ⭐️ header, ⬇️ "choose method", 🌟 Stars
// button, 👑 contact-admin button.
const PAY_STAR_EMOJI = "5359512328003941083";
const PAY_ARROW_EMOJI = "5771449161123631882";
const STARS_BTN_EMOJI = "5895708410447401643";
const ADMIN_BTN_EMOJI = "6129805886383723340";
// Flash-sale badge: 🔺 percent, ⏱ countdown.
const FLASH_PCT_EMOJI = "5289682726775967230";
const FLASH_TIME_EMOJI = "5382194935057372936";

// Telegram Premium delivery mode.
//   manual (DEFAULT) — the order becomes a job for the admin, who fulfils it by
//                      hand. This is the only mode that runs until the owner has
//                      confirmed, by experiment, that the bot's Star balance can
//                      actually pay for giftPremiumSubscription.
//   auto             — the bot calls giftPremiumSubscription itself.
// Deliberately opt-in: an accidental "auto" with an unverified balance burns
// 1000-2500 Stars per attempt and a sent gift cannot be undone.
const PREMIUM_DELIVERY_MODE: "manual" | "auto" =
  (process.env.PREMIUM_DELIVERY_MODE ?? "manual").trim().toLowerCase() === "auto" ? "auto" : "manual";
// Warn the admin when the bot's Star balance drops below this. 0 = no warning.
const PREMIUM_MIN_STAR_BALANCE = Math.max(0, Math.trunc(Number(process.env.PREMIUM_MIN_STAR_BALANCE ?? 0)) || 0);
// There is no customer balance any more. Every purchase is paid in full at the
// moment of buying — to a bank (Payme / Click) or in Telegram Stars. The
// `balance` column still exists for historical orders and for top-ups an admin
// approves by hand, but nothing in the bot shows it, offers it or spends it.

// Referral discount: invite N verified friends → % off eligible products. The
// discount is a coupon — a purchase SPENDS `min` referrals (the threshold), and
// the count drops afterwards. Tiers are checked high→low; the best affordable
// one wins. Only products flagged refDiscount in admin take part.
const REF_DISCOUNT_TIERS = [
  { min: 20, pct: 40 },
  { min: 10, pct: 20 },
  { min: 5, pct: 10 },
] as const;
// Best tier `avail` referrals can buy, or null. cost = referrals it will spend.
function bestRefDiscount(avail: number): { pct: number; cost: number } | null {
  for (const tier of REF_DISCOUNT_TIERS) if (avail >= tier.min) return { pct: tier.pct, cost: tier.min };
  return null;
}
// The % that a given referral-spend (5/10/20) corresponds to — used on delivery
// to recompute the exact discounted price the customer already paid.
function refDiscountPct(cost: number): number {
  return REF_DISCOUNT_TIERS.find((tier) => tier.min === cost)?.pct ?? 0;
}
// Подарки (free item for referral points) are retired in favour of the discount.
const GIFTS_ENABLED: boolean = false;
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
  | { type: "target_username"; variantId: number; qty: number }
  | { type: "set_banner" }
  | { type: "set_product_video"; productId: number }
  | { type: "promo_price"; variantId: number }
  // Premium: waiting for a native contact pick (users_shared) for "gift to
  // someone else". Carries the order so the shared id lands on the right item.
  | { type: "premium_pick_user"; variantId: number; qty: number }
  // Telegram Stars bought by a freely typed amount rather than a fixed pack.
  | { type: "stars_custom_qty"; variantId: number; back: string }
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
const soumToStars = (soum: number) => Math.max(1, Math.round((soum * STARS_PER_USDT) / UZS_PER_USDT));
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(lo, n), hi);

// Partially hide a buyer's identity for the public sales feed: keep the first
// and last visible chars, mask the middle. "Jahongir" → "Ja••••••ir".
// Uses Array.from to safely handle multi-byte Unicode emojis without splitting
// surrogate pairs, which would cause Telegram UTF-8 400 errors.
function maskName(s: string): string {
  const chars = Array.from((s ?? "").trim());
  if (!chars.length) return "•••";
  if (chars.length <= 2) return chars[0] + "•";
  if (chars.length <= 4) return chars[0] + "••" + chars[chars.length - 1];
  const keep = Math.min(2, chars.length - 2);
  return chars.slice(0, keep).join("") + "•".repeat(Math.max(3, chars.length - keep - 1)) + chars[chars.length - 1];
}

// Same idea for the numeric id: enough for the buyer to recognise their own
// purchase in the feed, not enough for anyone else to look them up.
// "7141343261" → "714•••••61".
function maskId(s: string): string {
  const chars = Array.from((s ?? "").trim());
  if (chars.length <= 4) return "•".repeat(Math.max(3, chars.length));
  return chars.slice(0, 3).join("") + "•".repeat(Math.max(3, chars.length - 5)) + chars.slice(-2).join("");
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

// An invited user only counts once they have actually subscribed to the
// required channels (channelVerifiedAt is stamped the moment the subscription
// gate passes). A bare /start?start=refXXX from a bot never sets it, so
// referral spam earns nothing.
const VERIFIED_REFERRAL = { channelVerifiedAt: { not: null } } as const;
function countVerifiedRefs(referrerTgId: string): Promise<number> {
  return db.botUser.count({ where: { referredBy: referrerTgId, ...VERIFIED_REFERRAL } });
}

// Referral "points" a user currently has to spend: verified invitees + admin
// bonus - already spent on referral-priced purchases. Falls back gracefully
// if the spentReferrals column hasn't been added yet (pre-migration).
async function availableReferralPoints(user: { id: number; tgId: string; bonusReferrals?: number | null; spentReferrals?: number | null }): Promise<number> {
  try {
    // Each invited user is counted exactly once (unique referredBy entry).
    // spentReferrals tracks already-redeemed points, preventing double-spend.
    const realRefs = await countVerifiedRefs(user.tgId);
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
  const bank = BANK_STYLE.get(data); // per-bank poll colour
  if (bank) return bank;
  // Nav buttons (Заказы / Профиль) green so they stand apart from the blue
  // product buttons.
  if (data === "ord" || data === "profile_show") return "success";
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
const PREMIUM_EMOJI_PROFILE = "5258011929993026890";
const PREMIUM_EMOJI_ORDERS = "5967412305338568701";
const PREMIUM_EMOJI_BACK = "5416113713428057601";
const PREMIUM_EMOJI_SUPPORT = "4970126766132691795";
const PREMIUM_EMOJI_REFER = "6048721430730773527";
const PREMIUM_EMOJI_GIFTS = "5203996991054432397";
const PREMIUM_EMOJI_SHOP = "5859297284029681680";
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
  if (PROFILE_TEXTS.has(text)) return profileButtonEmoji;
  if (ORDERS_TEXTS.has(text)) return ordersButtonEmoji;
  if (SHOP_TEXTS.has(text)) return shopButtonEmoji;
  return undefined;
}

function mainKeyboard(lang: string) {
  const kb = new Keyboard().text(t(lang, "btn_shop")).row();
  // Подарки retired (GIFTS_ENABLED=false) — referral rewards are now a discount
  // applied at checkout, not a free-item shop.
  if (GIFTS_ENABLED) kb.text(t(lang, "btn_freebies")).row();
  kb.text(t(lang, "btn_profile")).text(t(lang, "btn_instructions")).row();
  return kb.resized().persistent();
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
  // Record who invited this person REGARDLESS of whether referrals are
  // currently enabled. The flag pauses earning and spending, not remembering:
  // the ref id lives only in this one /start payload, so skipping the write
  // threw it away forever and the invite could never be credited once the
  // admin switched referrals back on. Storing it is safe on its own — a point
  // additionally requires channelVerifiedAt, and spending is gated separately.
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
// "Осталось 4 шт." is worth saying when it is true and useless when it is not,
// so it appears only below the admin's threshold and never for goods bought on
// demand. The number printed is always the measured stock — there is no path
// here that shrinks it for effect.
async function lowStockLeft(v: { fragmentKind?: string | null }, stock: number): Promise<number | null> {
  const threshold = parseLowStockThreshold(await setting("low_stock_threshold", ""));
  return lowStockCount(stock, threshold, isFragmentBacked(v) || stock >= STOCK_UNLIMITED);
}
const stockDisplay = (n: number): string => (n >= STOCK_UNLIMITED ? "♾" : String(n));
// A variant is only buyable while BOTH it and its product are switched on.
// Checking the variant alone was not enough: turning a product off in the admin
// panel left every variant active, so anyone still holding an older catalog
// message could walk straight past the hidden product and pay for it.
const isVariantBuyable = (v: { isActive: boolean; plan: { product: { isActive: boolean } } }): boolean =>
  v.isActive && v.plan.product.isActive;

// Goods fulfilled by an external supplier rather than from our own stock.
const isFragmentBacked = (v: { fragmentKind?: string | null }): boolean =>
  v.fragmentKind === "stars" || v.fragmentKind === "premium";

async function availableStock(v: { id: number; autoSupplier: boolean; supplierStock: number; manualDelivery?: boolean; manualStockLimit?: number; fragmentKind?: string }): Promise<number> {
  // Supplier-backed goods (Telegram Stars / Premium) have no warehouse at all:
  // they are bought on demand from Fragment, so counting uploaded codes or a
  // manual limit is meaningless. Deriving availability from those fields is why
  // a Stars pack could read "товара временно нет" while nothing was actually
  // wrong — a limit of 0 left over in the admin form was enough.
  //
  // Visibility stays the admin's decision (product.isActive). Whether a
  // purchase can actually go through — supplier reachable, wallet funded, quote
  // fresh — is a separate live check that belongs with the supplier client.
  if (isFragmentBacked(v)) return STOCK_UNLIMITED;
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
  if (slug === "vex") return envVexSource();
  if (slug === "somadeth" || slug === "buyer") return envBuyerSource();
  return null;
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
async function buildMenu(lang: string, page: number, sort: Sort, userId: number, freebies = false) {
  const [products, stock, overrides] = await Promise.all([
    db.product.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      include: { plans: { include: { variants: { where: { isActive: true } } } } },
    }),
    stockMap(),
    priceOverridesFor(userId),
  ]);
  // Mirrors availableStock() exactly, but reads the batched stockMap() instead
  // of one COUNT per variant. The two used to disagree: this ignored local
  // stock whenever autoSupplier was on (a product with 5 in local stock but 0
  // at the supplier read as sold out) and ignored manualStockLimit entirely
  // (a sold-out manual item still looked available). Keep the two in sync.
  const stOf = (v: { id: number; autoSupplier: boolean; supplierStock: number; manualDelivery: boolean; manualStockLimit?: number; fragmentKind?: string }) => {
    if (isFragmentBacked(v)) return STOCK_UNLIMITED;
    if (v.manualDelivery) {
      return v.manualStockLimit !== undefined && v.manualStockLimit >= 0 ? v.manualStockLimit : STOCK_UNLIMITED;
    }
    return (stock.get(v.id) ?? 0) + (v.autoSupplier ? v.supplierStock : 0);
  };
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

  // Active flash sale (from /promo): find which product carries the discounted
  // variant, so its catalog row shows old→new price + % and the header gets a
  // countdown line.
  let promo: { productId: number; originalPrice: number; newPrice: number; pct: number; expiresAt: number } | null = null;
  const promoRaw = (await setting("promo_active", "")).trim();
  if (promoRaw) {
    try {
      const p = JSON.parse(promoRaw) as { variantId: number; originalPrice: number; expiresAt: number };
      if (Date.now() < p.expiresAt) {
        for (const prod of products) {
          const vv = prod.plans.flatMap((pl) => pl.variants).find((v) => v.id === p.variantId);
          if (vv) {
            const newPrice = priceOf(vv);
            const pct = p.originalPrice > newPrice ? Math.round((p.originalPrice - newPrice) / p.originalPrice * 100) : 0;
            if (pct > 0) promo = { productId: prod.id, originalPrice: p.originalPrice, newPrice, pct, expiresAt: p.expiresAt };
            break;
          }
        }
      }
    } catch { /* malformed marker */ }
  }

  // No pagination — every product is shown at once.
  const kb = new InlineKeyboard();
  for (const it of items) {
    const cleanTitle = stripLeadEmoji(it.title);
    const onSale = promo && promo.productId === it.id;
    const priceStr = onSale
      ? `${money(promo!.originalPrice, lang)}→${money(promo!.newPrice, lang)} (−${promo!.pct}%)`
      : it.minPrice > 0 ? money(it.minPrice, lang) : t(lang, "free");
    const label = onSale ? `🔥 ${cleanTitle} — ${priceStr}` : `${cleanTitle} - ${priceStr}`;
    if (it.premiumEmoji) {
      kb.text(label, `p:${it.id}:0:${sort}`).icon(it.premiumEmoji).row();
    } else {
      kb.text(onSale ? label : `${it.emoji} ${label}`, `p:${it.id}:0:${sort}`).row();
    }
  }
  if (!freebies && items.length > 0) {
    // Orders and Profile share one row.
    kb.text(stripLeadEmoji(t(lang, "btn_orders")), "ord").icon(ordersButtonEmoji)
      .text(stripLeadEmoji(t(lang, "btn_profile")), "profile_show").icon(profileButtonEmoji).row();
  }

  const head = freebies ? t(lang, "promo_title") : t(lang, "products_available");
  const flashLine = promo
    ? `<tg-emoji emoji-id="${FLASH_PCT_EMOJI}">🔺</tg-emoji> <b>FLASH SALE −${promo.pct}%</b> · <tg-emoji emoji-id="${FLASH_TIME_EMOJI}">⏱</tg-emoji> ${formatCountdown(promo.expiresAt - Date.now())}\n\n`
    : "";
  const text =
    flashLine +
    (items.length === 0
      ? freebies ? t(lang, "no_promo") : t(lang, "catalog_empty")
      : `<b>${head}</b>\n${t(lang, "choose_below")}`);
  return { text, kb };
}

async function showMenu(ctx: Context, page: number, sort: Sort, edit: boolean, freebies = false) {
  try {
    const user = await getUser(ctx);
    const { text, kb } = await buildMenu(user.lang, page, sort, user.id, freebies);
    // The main catalog page (not the freebies view) leads with the shop
    // banner as one combined photo+caption+buttons message. sendOrEdit
    // handles the media-vs-text edit correctness for callback navigation.
    const banner = !freebies ? await shopBanner() : null;
    if (edit) {
      await sendOrEdit(ctx, text, {
        reply_markup: kb,
        photo: banner && !banner.isVideo ? banner.src : null,
        video: banner && banner.isVideo ? banner.src : null,
      });
    } else if (banner) {
      const send = banner.isVideo
        ? ctx.replyWithVideo(banner.src, { caption: text, parse_mode: "HTML", reply_markup: kb })
        : ctx.replyWithPhoto(banner.src, { caption: text, parse_mode: "HTML", reply_markup: kb });
      await send.catch(async () => {
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
  // A switched-off product is refused here too, not just hidden from the
  // catalogue — an older message still carries a working button to it.
  if (!p || !p.isActive) return ctx.answerCallbackQuery({ text: t(lang, "plan_unavailable"), show_alert: true });

  const allVariants = p.plans.flatMap((pl) => pl.variants);
  // The one-star Stars variant carries the rate for freely typed amounts; it is
  // not a pack. Listed as one it reads "1 звезда — 260 сум", and buying it would
  // be refused by the supplier, whose minimum is 50.
  const isRateCarrier = (v: { fragmentKind?: string | null; fragmentAmount?: number | null }) =>
    v.fragmentKind === "stars" && v.fragmentAmount === STARS_RATE_CARRIER_AMOUNT;
  const variants = allVariants.filter((v) => !isRateCarrier(v));
  // Single-variant product: skip the plan list and open the all-in-one buy card
  // straight away (video + description + qty ± + pay buttons in one message).
  //
  // Only when it is actually buyable. Sold out, the buy card renders the
  // "out of stock" screen whose Back button returns here — and this shortcut
  // sent the customer straight back to that same screen, so Back looked dead
  // and just re-posted the message. Out of stock falls through to the normal
  // product page instead, where Back leads to the catalogue.
  if (variants.length === 1 && (await availableStock(variants[0])) > 0) {
    return showQtyChooser(ctx, variants[0].id, 1, back, true, true);
  }
  const overrides = await priceOverridesFor(user.id, variants.map((v) => v.id));
  const availablePoints = await availableReferralPoints(user);
  const kb = new InlineKeyboard();
  for (const v of variants) {
    const st = await availableStock(v);
    const ov = overrides.get(v.id);
    const effPrice = ov?.priceUzs ?? v.priceUzs;
    const price = effPrice > 0 ? `${ov ? "💎 " : ""}${money(effPrice, lang)}` : t(lang, "free");
    // A duration only means something for a subscription. Telegram Stars are a
    // quantity, not a term, so "250 Stars — 45 000 so'm · 30д" reads as
    // nonsense — the stars do not expire.
    const dur = v.durationDays > 0 && v.fragmentKind !== "stars" ? ` · ${v.durationDays}д` : "";
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
  // "Any amount" for Telegram Stars. Fixed packs cover the common cases, but
  // someone who wants 137 stars should not have to buy 250. The price comes from
  // a per-star variant (fragmentAmount = 1, priceUzs = price of one star), so the
  // rate stays editable in the admin panel like every other price. Without such a
  // variant there is nothing to multiply, so the button simply is not offered.
  const perStar = allVariants.find(isRateCarrier);
  if (perStar) {
    kb.text(`✏️ ${t(lang, "stars_custom_btn")}`, `starsq:${perStar.id}:${back}`).row();
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

  // The per-product video now lives on the buy card (buildQtyChooser), so the
  // multi-variant plan list stays text-only — showing the video here too would
  // play it twice (plan list + buy card).

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
// Price and free-item count for an order, honouring the variant's quantity
// rules. A per-user VIP override replaces the base price but leaves the bundle
// tiers alone — those are the shop's promo, not a personal discount.
function quantityDeal(
  v: { bulkPrices?: string | null; bulkBonus?: string | null },
  unitPrice: number,
  qty: number,
) {
  const tiers = parseBulkPrices(v.bulkPrices);
  const bonuses = parseBulkBonus(v.bulkBonus);
  return {
    tiers,
    bonuses,
    total: bulkTotal(unitPrice, qty, tiers),
    free: bonusQty(qty, bonuses),
    saved: bulkSaving(unitPrice, qty, tiers),
  };
}

// "4d 17h 56m" style countdown from a millisecond remainder.
function formatCountdown(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (d > 0 || h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}
// Live flash-sale info for a variant, from the promo_active marker (/promo).
async function activePromoForVariant(variantId: number): Promise<{ originalPrice: number; expiresAt: number } | null> {
  const raw = (await setting("promo_active", "")).trim();
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { variantId: number; originalPrice: number; expiresAt: number };
    if (p.variantId === variantId && Date.now() < p.expiresAt) return { originalPrice: p.originalPrice, expiresAt: p.expiresAt };
  } catch { /* malformed marker */ }
  return null;
}

// Append the direct-pay buttons (Payme / Click / Stars / contact-admin) to a
// keyboard for the "all-in-one" buy card. Payme and Click are one-tap URL
// buttons (a pending top-up is pre-created for the exact price); Stars is a
// callback (an invoice message, to avoid a slow API call on every ± re-render);
// admin opens a chat with the product pre-filled.
async function appendCardPayButtons(kb: InlineKeyboard, userId: number, variantId: number, qty: number, label: string, total: number, refSpend: number, lang: string) {
  const note = `buy:${variantId}:${qty}`;
  const amt = money(total, lang);
  if (paymeReady()) {
    const topup = await db.topUp.create({ data: { userId, amount: total, method: "payme", status: "pending", note, refSpend, expiresAt: new Date(Date.now() + 30 * 60_000) } }).catch(() => null);
    if (topup) kb.url(`Payme · ${amt}`, buildCheckoutUrl({ checkoutBase: PAYME_CHECKOUT_URL, merchantId: PAYME_MERCHANT_ID, topUpId: topup.id, amountTiyin: sumToTiyin(total), lang })).icon(PAYME_BTN_EMOJI).row();
  }
  if (clickReady()) {
    const ctopup = await db.topUp.create({ data: { userId, amount: total, method: "click", status: "pending", note, refSpend, expiresAt: new Date(Date.now() + 30 * 60_000) } }).catch(() => null);
    if (ctopup) kb.url(`Click · ${amt}`, buildClickUrl({ serviceId: CLICK_SERVICE_ID, merchantId: CLICK_MERCHANT_ID, topUpId: ctopup.id, amountSum: total })).icon(CLICK_BTN_EMOJI).row();
  } else {
    kb.text(`Click · ${amt}`, `tclick_buy:${total}:${variantId}:${qty}`).icon(CLICK_BTN_EMOJI).row();
  }
  kb.text(stripLeadEmoji(t(lang, "pay_stars", { n: soumToStars(total) })), `tstar_buy:${total}:${variantId}:${qty}`).icon(STARS_BTN_EMOJI).row();
  const adminUser = (await setting("support_username", "Aiobuna_support")).replace(/^@/, "");
  kb.url(stripLeadEmoji(t(lang, "admin_topup")), `https://t.me/${adminUser}?text=${encodeURIComponent(`${label} — ${money(total, lang)}`)}`).icon(ADMIN_BTN_EMOJI).row();
}

async function buildQtyChooser(
  v: { id: number; priceUzs: number; autoSupplier: boolean; supplierStock: number; titleRu: string; titleUz: string; durationDays: number; needsUsername?: boolean; fragmentKind?: string; fragmentAmount?: number; bulkPrices?: string | null; bulkBonus?: string | null; plan: { product: { id: number; titleRu: string; titleEn: string; titleUz: string; descRu?: string; descEn?: string; descUz?: string; refDiscount?: boolean; videoFileId?: string | null } } },
  lang: string,
  user: { id: number; tgId: string; bonusReferrals?: number | null; spentReferrals?: number | null },
  qty: number,
  back: string,
  unitPrice: number,
  vipLabel: string | null,
) {
  const pt = await pick3(v.plan.product.titleRu, v.plan.product.titleEn, v.plan.product.titleUz, lang);
  const vt = await locName(v.titleRu, v.titleUz, lang);
  // formatItemTitle drops the duplicate when product and variant names repeat
  // ("Gemini AI Pro 18 Oy — Gemini AI Pro 18m" → "Gemini AI Pro 18m").
  const title = formatItemTitle(pt, vt);
  const brandEmoji = giftPremiumEmoji(pt);
  const head = brandEmoji ? `<tg-emoji emoji-id="${brandEmoji}">💎</tg-emoji>` : "🧾";
  const max = await availableStock(v);
  if (max <= 0) return null;
  // Fragment refuses anything under 50 stars, so the ± buttons must not be able
  // to walk below that — a card offering "3 stars" would take money for an order
  // the supplier cannot fill.
  const starsPerUnit = v.fragmentKind === "stars" ? (v.fragmentAmount ?? 0) : 0;
  const minQty = starsPerUnit > 0 ? minQtyForStars(starsPerUnit, STARS_MIN_QUANTITY) : 1;
  // Stepping one star at a time from 50 to 500 would be 450 taps, so the
  // one-star variant gets coarse steps. Packs still move one pack at a time.
  const starStep = starsPerUnit === STARS_RATE_CARRIER_AMOUNT;
  qty = clamp(Math.floor(qty) || minQty, minQty, max);
  const deal = quantityDeal(v, unitPrice, qty);
  const total = deal.total;
  // Referral discount (same rule as doBuy): eligible product + enough referrals.
  const disc = v.plan.product.refDiscount && !v.needsUsername ? bestRefDiscount(await availableReferralPoints(user)) : null;
  const payTotal = disc ? Math.round(total * (100 - disc.pct) / 100) : total;
  const label = qty > 1 ? `${title} ×${qty}` : title;

  // Flash sale (from /promo): auto % off + a live countdown, shown as a badge
  // button and in the caption.
  const left = await lowStockLeft(v, max);
  const promo = await activePromoForVariant(v.id);
  const flashPct = promo && promo.originalPrice > unitPrice ? Math.round((promo.originalPrice - unitPrice) / promo.originalPrice * 100) : 0;

  const kb = new InlineKeyboard();
  if (starStep) {
    kb.text("−50", `q:${v.id}:${qty - 50}:${back}`)
      .text("−10", `q:${v.id}:${qty - 10}:${back}`)
      .text(`${qty} ⭐`, "noop")
      .text("+10", `q:${v.id}:${qty + 10}:${back}`)
      .text("+50", `q:${v.id}:${qty + 50}:${back}`)
      .row();
  } else {
    kb.text("➖", `q:${v.id}:${qty - 1}:${back}`)
      .text(`${qty}`, "noop")
      .text("➕", `q:${v.id}:${qty + 1}:${back}`)
      .row();
  }
  // Offer the cheapest bundle as a one-tap shortcut. Only tiers that fit stock.
  const shortcut = deal.tiers.filter((tier) => tier.qty !== qty && tier.qty <= max && tier.qty >= minQty).slice(0, 3);
  for (const tier of shortcut) {
    const s = Math.max(0, unitPrice * tier.qty - tier.totalUzs);
    kb.text(`${tier.qty} шт. — ${money(tier.totalUzs, lang)}${s > 0 ? ` 🔥` : ""}`, `q:${v.id}:${tier.qty}:${back}`).row();
  }
  // Anything delivered to a Telegram account must learn its recipient BEFORE
  // money moves, so those items get a single buy button that routes through
  // doBuy (which asks) instead of the direct-pay buttons. Keying this on
  // needsUsername alone was wrong: a Premium item is identified by a numeric id
  // and normally has needsUsername = false, so it slipped straight to payment
  // and was then delivered to the buyer instead of the intended recipient.
  if (deliversToAccount(v)) {
    kb.text(t(lang, "buy_for", { v: money(payTotal, lang) }), `bc:${v.id}:${qty}`).row();
  } else {
    await appendCardPayButtons(kb, user.id, v.id, qty, label, payTotal, disc?.cost ?? 0, lang);
  }
  // Back goes to the plan list only when there IS one; a single-variant product
  // opens this card directly (showProduct skips its page), so "back" there must
  // return to the shop — otherwise it loops straight back onto this card.
  const siblings = await db.variant.count({ where: { isActive: true, plan: { productId: v.plan.product.id } } });
  kb.text(t(lang, "back"), siblings > 1 ? `p:${v.plan.product.id}:${back}` : `m:${back}`);

  const pd = await pick3(v.plan.product.descRu ?? "", v.plan.product.descEn, v.plan.product.descUz, lang);
  const descFull = pd?.trim() ? stripTags(pd.trim()) : "";
  const desc = descFull.length > 380 ? `${descFull.slice(0, 380)}…` : descFull;
  const offers = describeBulk(unitPrice, deal.tiers, deal.bonuses, (n) => money(n, lang));

  const flashBlock = promo && flashPct > 0
    ? `<tg-emoji emoji-id="${FLASH_PCT_EMOJI}">🔺</tg-emoji> <b>FLASH SALE −${flashPct}%</b>\n` +
      `<s>${money(promo.originalPrice, lang)}</s> → <b>${money(unitPrice, lang)}</b>\n` +
      `<tg-emoji emoji-id="${FLASH_TIME_EMOJI}">⏱</tg-emoji> ${formatCountdown(promo.expiresAt - Date.now())}\n`
    : "";

  const text =
    `${head} <b>${esc(title)}</b>\n` +
    (desc ? `\n${esc(desc)}\n` : "") +
    (flashBlock ? `\n${flashBlock}` : "") +
    (vipLabel ? `\n💎 <b>${esc(vipLabel)}</b>` : "") +
    `\n${t(lang, "price_each", { v: unitPrice > 0 ? money(unitPrice, lang) : t(lang, "free") })}` +
    `\n${t(lang, "qty", { n: qty })}` +
    (left !== null ? `\n${t(lang, "low_stock", { n: left })}` : "") +
    (deal.free > 0 ? `\n🎁 <b>+${deal.free} в подарок</b> → получите ${qty + deal.free} шт.` : "") +
    (disc ? `\n🎁 Скидка за рефералов: <b>−${disc.pct}%</b> (спишется ${disc.cost} реф.)` : "") +
    `\n${t(lang, "total", { v: money(payTotal, lang) })}` +
    (deal.saved > 0 && !disc ? ` <b>(−${money(deal.saved, lang)})</b>` : "") +
    (offers.length > 0 ? `\n\n🔥 <b>Выгодные наборы:</b>\n${offers.map((o) => `• ${o}`).join("\n")}` : "");
  return { text, kb, max, videoFileId: v.plan.product.videoFileId ?? null };
}

async function showQtyChooser(ctx: Context, variantId: number, qty: number, back: string, edit: boolean, initial = false) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const ack = (o?: { text: string; show_alert: boolean }) =>
    ctx.callbackQuery ? ctx.answerCallbackQuery(o).catch(() => {}) : Promise.resolve();
  const v = await db.variant.findUnique({ where: { id: variantId }, include: { plan: { include: { product: true } } } });
  if (!v || !isVariantBuyable(v)) return ack({ text: t(lang, "plan_unavailable"), show_alert: true });
  const eff = await effPriceFor(user.id, variantId, v.priceUzs);
  const built = await buildQtyChooser(v, lang, user, qty, back, eff.price, eff.label);
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
  const video = built.videoFileId;
  if (!edit) {
    // Fresh message (e.g. after typing a quantity).
    if (video) {
      await ctx.replyWithVideo(video, { caption: built.text, parse_mode: "HTML", reply_markup: built.kb }).catch(async () => {
        await ctx.reply(built.text, { parse_mode: "HTML", reply_markup: built.kb }).catch(() => {});
      });
    } else {
      await ctx.reply(built.text, { parse_mode: "HTML", reply_markup: built.kb });
    }
  } else if (initial && video) {
    // First entry from the product card: replace it with the video buy card.
    await sendOrEdit(ctx, built.text, { reply_markup: built.kb, video });
  } else {
    // ± re-render: edit text/caption in place — keeps the video, no flicker.
    await sendOrEdit(ctx, built.text, { reply_markup: built.kb });
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
// `sales_group_id` setting. Add the bot to the group and set the group via
// /salesgroup. The post carries ONLY what the item was and how it was paid
// for — never a username, a link, or a full id.
async function notifySalesGroup(
  user: { firstName: string | null; username: string | null; tgId: string },
  title: string,
  paid: { price: number; refPoints?: number },
) {
  // Separate switch from the group id, so the feed can be paused and resumed
  // without losing the configured group.
  if ((await setting("sales_feed_enabled", "1")) === "0") return;
  const groupId = (await setting("sales_group_id", "")).trim();
  if (!groupId) return;

  // Identity is deliberately partial: enough for the buyer to recognise their
  // own purchase, not enough for anyone else to identify them.
  const shown = maskName(user.firstName || user.username || user.tgId);
  const isGift = (paid.refPoints ?? 0) > 0;

  const text = isGift
    ? `🎁 <b>Забрал подарок за рефералов!</b>\n\n` +
      `👤 ${esc(shown)} · <code>${maskId(user.tgId)}</code>\n` +
      `📦 ${esc(title)}\n` +
      `🤝 <b>${paid.refPoints} реф.</b> — бесплатно`
    : `🛒 <b>Новая покупка!</b>\n\n` +
      `👤 ${esc(shown)} · <code>${maskId(user.tgId)}</code>\n` +
      `📦 ${esc(title)}\n` +
      `💰 <b>${paid.price > 0 ? money(paid.price, "ru") : "бесплатно"}</b>`;

  await bot.api.sendMessage(groupId, text, { parse_mode: "HTML" }).catch((e) => {
    console.error("[bot] sales group notify failed:", (e as Error).message);
  });
}

// ---------- Instagram review prompt ----------
// Asked right after a successful delivery — the one moment the customer is
// demonstrably happy, having just received what they paid for.
//
// Three deliberate constraints, because a review ask that annoys people costs
// more than the reviews are worth:
//   • off by default, so nothing reaches customers until the admin previews it
//   • at most once per REVIEW_COOLDOWN_DAYS per person, never after every order
//   • only on a completed delivery, never on an order still awaiting the admin
const REVIEW_COOLDOWN_DAYS = 45;

async function reviewConfig() {
  const [enabled, url, rewardRaw] = await Promise.all([
    setting("review_enabled", "0"),
    setting("review_url", ""),
    setting("review_reward", "0"),
  ]);
  const reward = Math.max(0, Math.trunc(Number(rewardRaw) || 0));
  return { on: enabled === "1" && url.trim().length > 0, url: url.trim(), reward };
}

function reviewMessage(lang: string, reward: number) {
  const kb = new InlineKeyboard();
  const body =
    `🎉 <b>${t(lang, "review_title")}</b>\n\n` +
    `${t(lang, "review_body")}\n\n` +
    (reward > 0 ? `${t(lang, "review_reward_line", { n: reward })}\n\n` : "") +
    `<i>${t(lang, "review_time")}</i>`;
  return { body, kb };
}

/** Send the review ask, unless it would be spam. Never throws. */
async function askForReview(user: { id: number; tgId: string; lang: string; reviewAskedAt?: Date | null }) {
  try {
    const cfg = await reviewConfig();
    if (!cfg.on) return;

    const last = user.reviewAskedAt;
    if (last && Date.now() - last.getTime() < REVIEW_COOLDOWN_DAYS * 86_400_000) return;

    // Stamp BEFORE sending: if the send fails we would rather skip this round
    // than risk re-asking on every retry.
    await db.botUser.update({ where: { id: user.id }, data: { reviewAskedAt: new Date() } }).catch(() => {});

    const lang = normalizeLang(user.lang);
    const { body } = reviewMessage(lang, cfg.reward);
    const kb = new InlineKeyboard()
      .url(t(lang, "review_btn_open"), cfg.url).row()
      .text(t(lang, "review_btn_done"), "rev:done").row();

    await bot.api.sendMessage(user.tgId, body, {
      parse_mode: "HTML",
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    }).catch(() => {});
  } catch (e) {
    console.error("[bot] askForReview failed:", (e as Error).message);
  }
}

// buyForReferrals() increments spentReferrals BEFORE calling executePurchase,
// so every path that aborts the purchase has to hand those points back — or the
// user pays referrals and receives nothing. Clamped at 0 so a double refund can
// never mint points out of thin air.
async function refundRefPoints(userId: number, points: number | undefined) {
  if (!points || points <= 0) return;
  await db.$executeRawUnsafe(
    `UPDATE "BotUser" SET "spentReferrals" = GREATEST(0, "spentReferrals" - $1) WHERE "id" = $2`,
    points, userId,
  ).catch((e) => console.error("[bot] refundRefPoints failed:", (e as Error).message));
}

async function executePurchase(tgId: string, variantId: number, qty: number, refPointsCost?: number, targetUsername?: string, discountCost = 0, recipientTgId?: string, paymentMethod?: string, paymentId?: string) {
  const isRefGift = refPointsCost !== undefined && refPointsCost > 0;
  const user = await db.botUser.findUnique({ where: { tgId } });
  if (!user) return;
  const lang = user.lang;
  // Points are already spent at this point — give them back on every abort.
  const abort = async (msgKey: string) => {
    if (isRefGift) await refundRefPoints(user.id, refPointsCost);
    const suffix = isRefGift ? `\n\n♻️ ${refPointsCost} реф. возвращены на ваш счёт.` : "";
    await bot.api.sendMessage(tgId, t(lang, msgKey) + suffix, { parse_mode: "HTML" }).catch(() => {});
  };
  const v = await db.variant.findUnique({ where: { id: variantId }, include: { plan: { include: { product: true } } } });
  if (!v || !isVariantBuyable(v)) return abort("plan_unavailable");
  const pt = await pick3(v.plan.product.titleRu, v.plan.product.titleEn, v.plan.product.titleUz, lang);
  const vt = await locName(v.titleRu, v.titleUz, lang);
  const baseTitle = `${pt} — ${vt}`;
  const max = await availableStock(v);
  if (max <= 0) return abort("out_of_stock");
  // Last line of defence on the supplier's 50-star floor. The buy card already
  // clamps it, but a quantity also arrives from a stale callback and from the
  // typed-amount flow, and an order below the floor cannot be filled at all.
  const starsUnit = v.fragmentKind === "stars" ? v.fragmentAmount : 0;
  const minQty = starsUnit > 0 ? minQtyForStars(starsUnit, STARS_MIN_QUANTITY) : 1;
  const paidQty = clamp(Math.floor(qty) || minQty, minQty, max);
  const eff = await effPriceFor(user.id, variantId, v.priceUzs);

  // Quantity rules: the bundle price is what we charge, and the bonus items are
  // delivered on top. A referral gift is always a single free item — bundles
  // and bonuses are money promos and must not compound with points.
  const deal = isRefGift
    ? { total: 0, free: 0 }
    : quantityDeal(v, eff.price, paidQty);
  // Bonus items still have to physically exist; never promise more than stock.
  const freeQty = Math.min(deal.free, Math.max(0, max - paidQty));
  const finalQty = paidQty + freeQty;
  // Referral-discount coupon: recompute the exact discounted price the customer
  // already paid on the pay screen (so the balance charge nets to zero), and
  // spend the referrals below once the order is committed.
  const discPct = discountCost > 0 ? refDiscountPct(discountCost) : 0;
  const total = isRefGift ? 0 : Math.round(deal.total * (100 - discPct) / 100);
  const label =
    freeQty > 0 ? `${baseTitle} ×${paidQty} +${freeQty} 🎁`
    : paidQty > 1 ? `${baseTitle} ×${paidQty}`
    : baseTitle;

  // --- Manual delivery: charge, then the admin sends the goods by hand ---
  //
  // Supplier-backed goods (Stars / Premium) always come through here for now,
  // whatever the admin ticked. They have no warehouse, so the stock+supplier
  // path below finds nothing, reports a shortfall and tells the customer
  // "автоматическая выдача не сработала" — which reads as a broken shop when in
  // fact the automatic supplier simply is not built yet. Routing them here
  // gives the ordinary "order accepted, the admin is on it" message and a clean
  // job for the admin. Remove this once the Fragment client fulfils them.
  if (v.manualDelivery || isFragmentBacked(v)) {
    // Fragment goods (Premium / Stars) additionally enter the delivery state
    // machine. Everything else keeps deliveryState = "" and is untouched by the
    // Premium pipeline. "Себе" defaults the recipient to the buyer.
    const isFragmentItem = v.fragmentKind === "premium" || v.fragmentKind === "stars";
    const recipient = recipientTgId ?? (v.fragmentKind === "premium" ? tgId : null);
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
      if (discountCost > 0) {
        await tx.botUser.update({ where: { id: user.id }, data: { spentReferrals: { increment: discountCost } } });
      }
      const order = await tx.botOrder.create({
        data: {
          userId: user.id, variantId, titleRu: label, priceUsdt: 0, payload: "",
          source: isRefGift ? "referral" : "manual", status: "awaiting_delivery",
          targetUsername: targetUsername ?? null,
          recipientTgId: isFragmentItem ? recipient : null,
          deliveryState: isFragmentItem ? "PAID" : "",
          paymentMethod: paymentMethod ?? null,
          paymentId: paymentId ?? null,
        },
      });
      return { orderId: order.id };
    });

    if ("error" in reserve) {
      return abort(
        reserve.error === "balance" ? "not_enough_funds"
        : reserve.error === "stock" ? "no_stock_left"
        : "plan_unavailable",
      );
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
      // For a Fragment item the recipient is the whole job — put it on its own
      // line, copyable, with the exact quantity to buy, so it can be pasted
      // straight into Fragment without re-reading the order.
      const isFragmentJob = v.needsUsername || v.fragmentKind === "premium" || v.fragmentKind === "stars";
      const fragmentBlock = isFragmentJob
        ? `\n🎯 <b>ВЫДАТЬ ${v.fragmentKind === "premium" ? "PREMIUM" : "НА FRAGMENT"}</b>\n` +
          // Numeric id first: it is the identifier a gift is actually delivered
          // to, and unlike a username it cannot be mistyped or re-registered.
          `ID получателя: <code>${esc(recipient ?? "—")}</code>\n` +
          `Username: <code>${esc(targetUsername ?? "—")}</code>\n` +
          (v.fragmentKind === "stars" ? `Купить: <b>${v.fragmentAmount * finalQty} Stars</b>\n`
           : v.fragmentKind === "premium"
             ? `Купить: <b>Premium ${v.fragmentAmount} мес.</b>` +
               `${premiumStarCost(v.fragmentAmount) ? ` (${premiumStarCost(v.fragmentAmount)}⭐ через API)` : ""}\n` +
               `Режим выдачи: <b>${PREMIUM_DELIVERY_MODE}</b>\n`
             : "") +
          `\nПосле выдачи: <code>/give ${reserve.orderId} выдано</code>\n`
        : `\nВыдать: <code>/give ${reserve.orderId} логин:пароль</code>`;
      await bot.api.sendMessage(
        ADMIN_ID,
        `📦 <b>Ручная выдача (${isRefGift ? "🎁 подарок" : "заказ"}, #${reserve.orderId})</b>\n` +
        `Товар: ${esc(label)} — ${isRefGift ? `${refPointsCost} реф.` : money(total, lang)}\n` +
        `Покупатель: ${user.firstName ?? ""} @${user.username ?? "—"} (${user.tgId})\n` +
        `Код проверки: <code>${code}</code>\n` +
        fragmentBlock,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
    await notifySalesGroup(user, label, { price: total, refPoints: refPointsCost });
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
    if (discountCost > 0) {
      await tx.botUser.update({ where: { id: user.id }, data: { spentReferrals: { increment: discountCost } } });
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
        targetUsername: targetUsername ?? null,
      },
    });
    return { orderId: order.id, order };
  });

  if ("error" in reserve) {
    // A referral gift never hits the balance check, so "unavailable" is the
    // only error it can produce — reporting "not enough funds" would be wrong.
    return abort(reserve.error === "balance" ? "not_enough_funds" : "plan_unavailable");
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
          // Pass our order ID as external_order_id — Vexoran will de-duplicate
          // retries: same ID → same order returned, never double-charged.
          const delivered = await sourceOrder(src, v.supplierExternalId, supplierQty, reserve.orderId);
          if (delivered.idempotentReplay) {
            console.log(`[bot] supplier idempotent replay for order #${reserve.orderId}`);
          }
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
      if (deliveredQty > 0) await notifySalesGroup(user, label, { price: total, refPoints: refPointsCost });
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
    // Per-product video (set via /pvideo) wins; else the global how-to-activate.
    const activateVideo: string | InputFile | null = v.plan.product.videoFileId || howToActivateFile();
    // "Я получил" comes first: the customer confirms the goods actually work
    // before anything is asked of them. Tapping it is what triggers the review
    // prompt — a review from someone who has not yet checked their purchase is
    // worth little, and asking before they know is how you earn a bad one.
    const deliveredKb = new InlineKeyboard()
      .text(t(lang, "btn_got_it"), "got").row()
      .text(t(lang, "to_shop"), "m:0:all");

    const chargeLine = isRefGift
      ? `🎁 <b>Подарок за ${refPointsCost} реф.</b>`
      : `${t(lang, "charged", { v: money(total, lang) })}`;

    if (isLargeOrder) {
      // Large order: confirmation (+ video if any) first, links follow as a .txt file.
      const confirmText =
        `${t(lang, "order_paid", { id: reserve.orderId })}\n\n` +
        `${esc(label)}\n${chargeLine}\n` +
        `\n✅ <b>Файл со ссылками отправляется...</b>`;
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
        `\n${t(lang, "your_goods")}\n<code>${esc(finalPayload)}</code>`;
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
    await notifySalesGroup(user, label, { price: total, refPoints: refPointsCost });
    // The review prompt is NOT sent here — it waits for the customer to tap
    // "Я получил" on the delivery message above, confirming the goods work.
  } catch (e) {
    // Critical error: rollback whatever was charged.
    if (!isRefGift) {
      await db.$transaction([
        db.botUser.update({ where: { id: user.id }, data: { balance: { increment: total } } }),
        db.botOrder.update({ where: { id: reserve.orderId }, data: { status: "failed" } }),
      ]).catch((err) => console.error("[bot] balance rollback failed:", (err as Error).message));
    } else {
      // GREATEST(0, …) rather than a bare decrement — a raw decrement could
      // drive spentReferrals negative and hand out points that never existed.
      await refundRefPoints(user.id, refPointsCost);
      await db.botOrder.update({ where: { id: reserve.orderId }, data: { status: "failed" } })
        .catch(() => {});
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

// Ask who the goods are for. Runs BEFORE any money moves: a Fragment transfer
// lands on whatever username it is given and cannot be reversed, so the buyer
// gets to see and confirm the recipient while they can still change it.
async function askTargetUsername(ctx: Context, v: { id: number; titleRu: string; titleUz: string; plan: { product: { titleRu: string; titleEn: string; titleUz: string } } }, qty: number, lang: string) {
  const pt = await pick3(v.plan.product.titleRu, v.plan.product.titleEn, v.plan.product.titleUz, lang);
  const vt = await locName(v.titleRu, v.titleUz, lang);
  const item = `📦 <b>${esc(formatItemTitle(pt, vt))}</b>${qty > 1 ? ` ×${qty}` : ""}`;
  pending.set(String(ctx.from?.id), { type: "target_username", variantId: v.id, qty });
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.reply(t(lang, "uname_ask", { item }), { parse_mode: "HTML" }).catch(() => {});
}

// Who is this Premium subscription for? Asked BEFORE any money moves, because a
// gifted subscription cannot be taken back.
//
// giftPremiumSubscription accepts a numeric user_id and nothing else, so the two
// primary paths both yield one: "myself" uses the buyer's own id, "someone else"
// uses Telegram's native contact picker (request_users → users_shared), which
// returns the real id. Typing a @username is only a fallback — it resolves to an
// id only if that person has used this bot before, and an order left without an
// id can never be auto-delivered, only fulfilled by hand.
async function askPremiumRecipient(ctx: Context, v: { id: number; titleRu: string; titleUz: string; plan: { product: { titleRu: string; titleEn: string; titleUz: string } } }, qty: number, lang: string) {
  const pt = await pick3(v.plan.product.titleRu, v.plan.product.titleEn, v.plan.product.titleUz, lang);
  const vt = await locName(v.titleRu, v.titleUz, lang);
  const item = `${esc(formatItemTitle(pt, vt))}${qty > 1 ? ` ×${qty}` : ""}`;
  const kb = new InlineKeyboard()
    .text("👤 Себе", `premself:${v.id}:${qty}`).row()
    .text("👥 Другому", `premgift:${v.id}:${qty}`).row()
    .text(t(lang, "back"), `q:${v.id}:${qty}:0:all`);
  await ctx.answerCallbackQuery().catch(() => {});
  const text = `💎 <b>${item}</b>\n\nКому оформить подписку?`;
  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(async () => {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  });
}

// Native contact picker. request_users hands back the recipient's numeric id —
// the only identifier a gift can actually be delivered to.
async function askPremiumSharedUser(ctx: Context, variantId: number, qty: number, lang: string) {
  pending.set(String(ctx.from?.id), { type: "premium_pick_user", variantId, qty });
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.reply(
    "👥 Нажмите кнопку ниже и выберите получателя из своих контактов.\n\n" +
    "Так подписка точно уйдёт нужному человеку.\n\n" +
    "Если его нет в контактах — пришлите его @username сообщением.",
    {
      reply_markup: {
        keyboard: [[{
          text: "👥 Выбрать получателя",
          request_users: { request_id: 1, user_is_bot: false, max_quantity: 1, request_username: true },
        }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    },
  ).catch(() => {});
}

// Direct-pay bank picker (Payme / Click) — the whole payment price, no balance.
// Each bank button carries its premium emoji; tapping Payme builds a checkout
// link for the full price and hands back the pay button.
async function showBankPicker(
  ctx: Context,
  lang: string,
  v: { id: number },
  qty: number,
  label: string,
  total: number,
  targetUsername?: string,
  disc: { pct: number; cost: number } | null = null,
  recipientTgId?: string,
) {
  const user = await getUser(ctx);
  // Callback-data suffix for the fallback pay buttons. Mirrors the note layout
  // (username, then numeric id) so those paths carry the recipient too.
  const suffix = (targetUsername || recipientTgId)
    ? `:${targetUsername ?? ""}${recipientTgId ? `:${recipientTgId}` : ""}`
    : "";
  // The note is what carries the recipient through the payment round-trip.
  const note = buildBuyNote(v.id, qty, targetUsername ?? null, recipientTgId ?? null);
  const refSpend = disc?.cost ?? 0;
  const kb = new InlineKeyboard();

  // Payme is a direct URL button: pre-create the pending top-up for the full
  // price, build its checkout link, and put it straight on the button — one tap
  // opens Payme, no intermediate "оплатить" screen.
  if (paymeReady(ctx)) {
    const topup = await db.topUp.create({
      data: { userId: user.id, amount: total, method: "payme", status: "pending", note, refSpend, expiresAt: new Date(Date.now() + 30 * 60_000) },
    });
    const url = buildCheckoutUrl({ checkoutBase: PAYME_CHECKOUT_URL, merchantId: PAYME_MERCHANT_ID, topUpId: topup.id, amountTiyin: sumToTiyin(total), lang });
    kb.url(`Payme · ${money(total, lang)}`, url).icon(PAYME_BTN_EMOJI).row();
  }
  // Click — same one-tap URL button when configured; a separate pending top-up
  // (method=click) so Prepare/Complete resolve it by its own id. Until the
  // merchant service is live it stays a callback explaining it's coming.
  if (clickReady(ctx)) {
    const ctopup = await db.topUp.create({
      data: { userId: user.id, amount: total, method: "click", status: "pending", note, refSpend, expiresAt: new Date(Date.now() + 30 * 60_000) },
    });
    const url = buildClickUrl({ serviceId: CLICK_SERVICE_ID, merchantId: CLICK_MERCHANT_ID, topUpId: ctopup.id, amountSum: total });
    kb.url(`Click · ${money(total, lang)}`, url).icon(CLICK_BTN_EMOJI).row();
  } else {
    kb.text(`Click · ${money(total, lang)}`, `tclick_buy:${total}:${v.id}:${qty}${suffix}`).icon(CLICK_BTN_EMOJI).row();
  }
  // Telegram Stars — one-tap like Click: build an invoice link and put it on a
  // URL button, so tapping opens the Stars payment sheet directly (no second
  // message). The product name is the invoice title. Falls back to a callback
  // invoice if the link can't be created.
  const starLabel = stripLeadEmoji(t(lang, "pay_stars", { n: soumToStars(total) }));
  // Fixed 8-field payload so the referral-spend rides along to delivery even
  // when there's no recipient: topup:<amount>:stars:buy:<vid>:<qty>:<uname>:<refSpend>
  const starPayload = `topup:${total}:stars:buy:${v.id}:${qty}:${targetUsername ?? ""}:${refSpend}:${recipientTgId ?? ""}`;
  try {
    const cap = await buyInvoiceCaption(note, lang);
    const starLink = await ctx.api.createInvoiceLink(
      cap?.title ?? label.slice(0, 32),
      cap?.desc ?? label.slice(0, 255),
      starPayload,
      "", "XTR",
      [{ label: money(total, lang), amount: soumToStars(total) }],
    );
    kb.url(starLabel, starLink).icon(STARS_BTN_EMOJI).row();
  } catch (e) {
    console.error("[bot] stars link:", (e as Error).message);
    kb.text(starLabel, `tstar_buy:${total}:${v.id}:${qty}${suffix}`).icon(STARS_BTN_EMOJI).row();
  }
  // Contact admin: a URL button that opens the admin's personal chat with the
  // product name pre-filled, so the customer only has to hit send.
  const adminUser = (await setting("support_username", "Aiobuna_support")).replace(/^@/, "");
  const adminText = `${label} — ${money(total, lang)}${targetUsername ? ` (@${targetUsername})` : ""}`;
  kb.url(stripLeadEmoji(t(lang, "admin_topup")), `https://t.me/${adminUser}?text=${encodeURIComponent(adminText)}`).icon(ADMIN_BTN_EMOJI).row();
  kb.text(t(lang, "back"), `q:${v.id}:${qty}:0:all`);

  const text =
    `🧾 <b>${esc(label)}</b>\n\n` +
    (targetUsername ? `${t(lang, "uname_for")}: <b>@${esc(targetUsername)}</b>\n\n` : "") +
    (disc ? `🎁 Скидка за рефералов: <b>−${disc.pct}%</b> (спишется ${disc.cost} реф.)\n\n` : "") +
    `<tg-emoji emoji-id="${PAY_STAR_EMOJI}">⭐️</tg-emoji> К оплате: <b>${money(total, lang)}</b>\n\n` +
    `Выберите способ оплаты <tg-emoji emoji-id="${PAY_ARROW_EMOJI}">⬇️</tg-emoji>`;
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(async () => {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  });
}

async function doBuy(ctx: Context, variantId: number, qty: number, targetUsername?: string, recipientTgId?: string) {
  const user = await getUser(ctx);
  const lang = user.lang;
  const v = await db.variant.findUnique({ where: { id: variantId }, include: { plan: { include: { product: true } } } });
  if (!v || !isVariantBuyable(v)) return ctx.answerCallbackQuery({ text: t(lang, "plan_unavailable"), show_alert: true });
  // Telegram Premium: the recipient is a numeric id, so ask who it's for rather
  // than demanding a username. needsUsername stays optional for these items.
  if (v.fragmentKind === "premium" && !recipientTgId && !targetUsername) {
    return askPremiumRecipient(ctx, v, qty, lang);
  }
  // Other goods delivered to an account (Stars) still capture a username. This
  // mirrors deliversToAccount(): the buy card routes every account-delivered
  // item here, so a Stars item configured without needsUsername would otherwise
  // reach payment with no recipient captured at all.
  if (deliversToAccount(v) && !targetUsername && !recipientTgId) return askTargetUsername(ctx, v, qty, lang);
  const pt = await pick3(v.plan.product.titleRu, v.plan.product.titleEn, v.plan.product.titleUz, lang);
  const vt = await locName(v.titleRu, v.titleUz, lang);
  const baseTitle = `${pt} — ${vt}`;
  const max = await availableStock(v);
  if (max <= 0) return ctx.answerCallbackQuery({ text: t(lang, "out_of_stock"), show_alert: true });
  qty = clamp(Math.floor(qty) || 1, 1, max);
  const eff = await effPriceFor(user.id, variantId, v.priceUzs);
  // Must use the SAME bundle price executePurchase() will charge. Multiplying
  // the unit price here would quote a higher figure than the actual debit and
  // ask the customer to top up money they don't need.
  const deal = quantityDeal(v, eff.price, qty);
  const total = deal.total;
  const freeQty = Math.min(deal.free, Math.max(0, max - qty));
  const label =
    freeQty > 0 ? `${baseTitle} ×${qty} +${freeQty} 🎁`
    : qty > 1 ? `${baseTitle} ×${qty}`
    : baseTitle;

  // Referral-discount coupon: eligible product + enough referrals → cut the
  // price and remember how many referrals delivery will spend. Never on a
  // Fragment (Stars/Premium) item — those go out at face value.
  let disc: { pct: number; cost: number } | null = null;
  if (v.plan.product.refDiscount && !v.needsUsername) {
    disc = bestRefDiscount(await availableReferralPoints(user));
  }
  const payTotal = disc ? Math.round(total * (100 - disc.pct) / 100) : total;

  // Always straight to the bank / Stars picker for the full price.
  return showBankPicker(ctx, lang, v, qty, label, payTotal, targetUsername, disc, recipientTgId);
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
  if (!GIFTS_ENABLED) {
    return ctx.answerCallbackQuery({ text: "Подарки отключены. Теперь при покупке действует скидка за рефералов.", show_alert: true }).catch(() => {});
  }
  if (!(await isReferralsEnabled())) {
    return ctx.answerCallbackQuery({ text: "⏸ Реферальная программа временно приостановлена.", show_alert: true });
  }
  // refBanned users cannot spend points either — not just invite.
  if (user.refBanned) {
    return ctx.answerCallbackQuery({ text: "🚫 Ваш аккаунт заблокирован в реферальной программе.", show_alert: true });
  }
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
    // Must use the same verified-only filter as availableReferralPoints(),
    // otherwise unverified invitees would be spendable through this path.
    const realRefs = await tx.botUser.count({ where: { referredBy: fresh.tgId, ...VERIFIED_REFERRAL } });
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

// Redeem a promo code → credit its fixed сум amount to the user's balance.
// Validates active/expiry/total-uses/per-user limits atomically in a transaction.
// Promo codes credited the balance, and there is no balance any more. Rather
// than tell someone "20 000 сум зачислено" for money they can never spend, the
// codes are paused — the redemption logic is gone with the balance it fed.
async function redeemPromo(ctx: Context, user: Awaited<ReturnType<typeof getUser>>, _input: string) {
  const kb = new InlineKeyboard().text(t(user.lang, "to_shop"), "m:0:all");
  return ctx.reply(t(user.lang, "promo_retired"), { parse_mode: "HTML", reply_markup: kb });
}
async function ordersView(lang: string, userId: number) {
  // Only real purchases — delivered or awaiting manual delivery. Failed/refunded hidden.
  let orders: Array<{ id: number; titleRu: string; priceUsdt: number; payload: string; status: string }> = [];
  try {
    orders = await db.botOrder.findMany({
      where: { userId, status: { in: ["delivered", "awaiting_delivery"] } },
      orderBy: { id: "desc" },
      take: 5,
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
            : `#${o.id} · ${esc(clip(o.titleRu, 80))} — ${money(o.priceUsdt, lang)}\n<code>${esc(clip(o.payload, 500))}</code>`,
        )
        .join("\n\n")
    : t(lang, "no_orders");
  return { text: `${t(lang, "orders_title")}\n\n${body}`, kb };
}
async function profileView(user: Awaited<ReturnType<typeof getUser>>) {
  const lang = user.lang;
  const [ordersCount, realRefs] = await Promise.all([
    db.botOrder.count({ where: { userId: user.id } }),
    countVerifiedRefs(user.tgId),
  ]);
  const refCount = realRefs + (user.bonusReferrals || 0);
  // The gifts screen shows points left to spend, the profile used to show the
  // lifetime total — under the SAME label. Someone who had invited 13 and spent
  // them saw "13" here and "0" there and reasonably concluded the bot was
  // broken. Show the whole picture instead.
  const spentRefs = user.spentReferrals ?? 0;
  const availableRefs = Math.max(0, refCount - spentRefs);

  // Professional profile layout with all actions
  const kb = new InlineKeyboard();
  kb.text(t(lang, "btn_refer"), "ref").row()
    .text(stripLeadEmoji(t(lang, "p_orders")), "ord").icon(ordersButtonEmoji)
    .text(t(lang, "btn_support"), "support_show").row()
    .text(t(lang, "btn_language"), "lang_pick").row()
    .text(t(lang, "to_shop"), "m:0:all");

  let text =
    `${t(lang, "profile_title")}\n\n` +
    `${t(lang, "p_name")}: ${esc(user.firstName ?? "—")}\n` +
    `ID: <code>${user.tgId}</code>\n` +
    `${emojiIcon("🧾", ordersButtonEmoji)} ${t(lang, "p_orders")}: ${ordersCount}\n` +
    `${emojiIcon("🤝", referButtonEmoji)} ${t(lang, "p_invited")}: ${refCount}` +
    (spentRefs > 0 ? `\n➖ ${t(lang, "p_ref_spent")}: ${spentRefs}` : "") +
    `\n🎁 <b>${t(lang, "p_ref_available")}: ${availableRefs}</b>`;
  return { text, kb };
}
function referView(ctx: Context, user: Awaited<ReturnType<typeof getUser>>) {
  const lang = user.lang;
  const link = `https://t.me/${ctx.me.username}?start=ref${user.tgId}`;
  const kb = new InlineKeyboard().url(t(lang, "share"), `https://t.me/share/url?url=${encodeURIComponent(link)}`).row().text(t(lang, "to_shop"), "m:0:all");
  return { text: `${t(lang, "refer_title")}\n\n${t(lang, "refer_text")}\n\n<code>${link}</code>`, kb };
}
async function supportView(lang: string) {
  const [custom, supportUsername] = await Promise.all([
    setting("support", ""),
    setting("support_username", "").then((s) => s.replace(/^@/, "")),
  ]);
  const text = custom ? (lang === "ru" ? custom : await translate(custom, lang)) : t(lang, "support_none");
  const kb = new InlineKeyboard();
  if (supportUsername) kb.url(t(lang, "support_write"), `https://t.me/${supportUsername}`).row();
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

  // Подарки retired: referral rewards are now a discount applied at checkout.
  if (!GIFTS_ENABLED) {
    if (silent) return;
    const avail = await availableReferralPoints(user);
    const tiers = REF_DISCOUNT_TIERS.map((tr) => `• ${tr.min} реф. → −${tr.pct}%`).join("\n");
    const kb = new InlineKeyboard().text(t(lang, "btn_refer"), "ref").row().text(t(lang, "to_shop"), "m:0:all");
    await sendOrEdit(
      ctx,
      `🎁 <b>Скидка за друзей</b>\n\nПриглашайте друзей — и получайте скидку на покупку:\n${tiers}\n\nСкидка списывается при покупке (как купон).\nУ вас приглашено: <b>${avail}</b> реф.`,
      { reply_markup: kb },
    );
    return;
  }

  if (!(await isReferralsEnabled())) {
    if (silent) return;
    const kb = new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all");
    await sendOrEdit(ctx, "⏸ <b>Реферальная программа временно приостановлена.</b>\n\nПожалуйста, возвращайтесь позже.", { reply_markup: kb });
    return;
  }

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
    `🎁 ${t(lang, "p_ref_available")}: <b>${points}</b>\n\n` +
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
  // Don't advertise the gifts shop while referrals are paused — every button in
  // this message dead-ends on "программа приостановлена".
  if (!(await isReferralsEnabled())) return false;
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
    `🎁 ${t(lang, "p_ref_available")}: <b>${points}</b>\n\n` +
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
        // photo[] is ordered smallest→largest; caching photo[0] would re-send a
        // thumbnail to every subsequent recipient.
        const largest = msg.photo?.[msg.photo.length - 1];
        if (largest?.file_id) cachedGiftsPhotoFileId = largest.file_id;
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
async function buildTopupMethods(lang: string, amount: number, ctx?: Context) {
  const stars = soumToStars(amount);
  const adminUsername = (await setting("support_username", "")).replace(/^@/, "");
  const kb = new InlineKeyboard()
    .text(t(lang, "pay_receipt"), `tcheck:${amount}`).row()
    .text(t(lang, "pay_stars", { n: stars }), `tstar:${amount}`).row();
  if (paymeReady(ctx)) kb.text(t(lang, "pay_payme"), `tpayme:${amount}`).row();
  if (adminUsername) {
    kb.url(t(lang, "admin_topup"), `https://t.me/${adminUsername}`).row();
  } else {
    kb.text(t(lang, "via_admin"), `tman:${amount}`).row();
  }
  kb.text(t(lang, "back"), "m:0:all");
  return { text: `${t(lang, "topup_of", { v: money(amount, lang) })}\n\n${t(lang, "choose_method")}`, kb };
}

// Create a pending Payme top-up and hand the user a checkout button. The
// pending TopUp's id is the Payme `account[topup_id]`; the balance is credited
// later, only by the Merchant API webhook. `note` carries an optional
// `buy:variantId:qty[:username]` so a paid top-up can auto-fulfil a purchase,
// exactly like the receipt/Stars paths.
async function startPaymePayment(ctx: Context, lang: string, amount: number, note: string | null = null) {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!paymeReady(ctx)) return ctx.reply("Пополнение через Payme доступно только для администратора.").catch(() => {});
  const user = await getUser(ctx);
  const topup = await db.topUp.create({
    data: {
      userId: user.id,
      amount,
      method: "payme",
      status: "pending",
      note,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
  const url = buildCheckoutUrl({
    checkoutBase: PAYME_CHECKOUT_URL,
    merchantId: PAYME_MERCHANT_ID,
    topUpId: topup.id,
    amountTiyin: sumToTiyin(amount),
    lang,
  });
  const kb = new InlineKeyboard()
    .url(t(lang, "pay_payme"), url).row()
    .text(t(lang, "to_shop"), "m:0:all");
  await ctx.reply(t(lang, "payme_created", { v: money(amount, lang) }), { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
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
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(t(lang, "back"), "m:0:all") },
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
      const [, varIdStr, qtyStr, uname] = topup.note.split(":");
      adminText += `\n🛒 Покупка товара (ID варианта: ${varIdStr}, Кол-во: ${qtyStr})`;
      if (uname) adminText += `\n🎯 Получатель: @${uname}`;
    }
    await ctx.api.sendMessage(ADMIN_ID, adminText, { reply_markup: kb }).catch(() => {});
    await ctx.api.sendPhoto(ADMIN_ID, fileId).catch(() => {});
  }
}

// Product title for a "buy:<variantId>:…" note, e.g. "Gemini Pro — 1 месяц",
// so a product bought with Stars shows its own name on the invoice rather than a
// generic top-up. Title ≤32 chars, description ≤255 (Telegram invoice limits).
async function buyInvoiceCaption(note: string | null, lang: string): Promise<{ title: string; desc: string } | null> {
  if (!note?.startsWith("buy:")) return null;
  const vid = Number(note.split(":")[1]);
  if (!Number.isFinite(vid)) return null;
  const v = await db.variant.findUnique({ where: { id: vid }, include: { plan: { include: { product: true } } } });
  if (!v) return null;
  const pt = await pick3(v.plan.product.titleRu, v.plan.product.titleEn, v.plan.product.titleUz, lang);
  const vt = await locName(v.titleRu, v.titleUz, lang);
  return { title: pt.slice(0, 32), desc: `${pt} — ${vt}`.slice(0, 255) };
}

async function starsInvoice(ctx: Context, lang: string, amount: number, note: string | null = null) {
  const stars = soumToStars(amount);
  await ctx.answerCallbackQuery().catch(() => {});
  const payload = note ? `topup:${amount}:stars:${note}` : `topup:${amount}:stars`;
  const cap = await buyInvoiceCaption(note, lang);
  const title = cap?.title ?? t(lang, "topup_of", { v: money(amount, lang) });
  const desc = cap?.desc ?? t(lang, "topup_of", { v: money(amount, lang) });
  await ctx.replyWithInvoice(title, desc, payload, "XTR", [{ label: money(amount, lang), amount: stars }]).catch((e) => { console.error("[bot] stars:", (e as Error).message); ctx.reply("⚠️").catch(() => {}); });
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
    const [, varIdStr, qtyStr, uname] = note.split(":");
    adminText += `\n🛒 Покупка товара (ID варианта: ${varIdStr}, Кол-во: ${qtyStr})`;
    if (uname) adminText += `\n🎯 Получатель: @${uname}`;
  }

  await ctx.reply(t(lang, "topup_created", { v: money(amount, lang), id: topup.id }), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all") }).catch(() => {});
  if (ADMIN_ID) {
    const kb = new InlineKeyboard().text("✅ зачислить", `ap:${topup.id}`).text("❌ отклонить", `rj:${topup.id}`);
    await ctx.api.sendMessage(ADMIN_ID, adminText, { reply_markup: kb }).catch(() => {});
  }
}

async function creditPaidTopUp(ctx: Context, amount: number, method: string, chargeId: string, variantId?: number, qty?: number, targetUsername?: string, discountCost = 0, recipientTgId?: string) {
  const user = await getUser(ctx);
  const lang = user.lang;

  const note = (variantId && qty) ? buildBuyNote(variantId, qty, targetUsername ?? null, recipientTgId ?? null) : null;

  // Idempotency. Telegram can deliver the same successful_payment more than once
  // (a restart mid-processing replays the long-polling offset), and this path
  // both credits money and ships goods, so it must run exactly once per payment.
  // The charge id identifies the payment uniquely and is guarded twice: this
  // check catches the ordinary repeat, and the partial unique index on
  // TopUp.externalId (see ensureSchema) makes the loser of a genuine race fail
  // instead of double-crediting. Payme and Click have their own guards
  // (state machine / SELECT … FOR UPDATE); this closes the Stars path.
  if (chargeId) {
    const seen = await db.topUp.findFirst({ where: { externalId: chargeId }, select: { id: true } });
    if (seen) {
      console.warn(`[bot] duplicate payment ignored (already credited): charge=${chargeId} user=${user.tgId}`);
      return;
    }
  }

  try {
    await db.$transaction([
      db.botUser.update({ where: { id: user.id }, data: { balance: { increment: amount } } }),
      db.topUp.create({ data: { userId: user.id, amount, method, status: "approved", externalId: chargeId, note, refSpend: discountCost } }),
    ]);
  } catch (e) {
    // P2002 = unique violation → a concurrent handler credited this charge first.
    if ((e as { code?: string }).code === "P2002") {
      console.warn(`[bot] duplicate payment ignored (race): charge=${chargeId} user=${user.tgId}`);
      return;
    }
    throw e;
  }
  const u = await db.botUser.findUnique({ where: { id: user.id } });
  // A product purchase (buy note) gets its own delivery message from
  // executePurchase below — don't also show a "balance credited" screen, since
  // the balance is hidden everywhere now.
  if (!(variantId && qty)) {
    await ctx.reply(t(lang, "paid_received", { v: money(amount, lang), b: money(u?.balance ?? 0, lang) }), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all") }).catch(() => {});
  }
  if (ADMIN_ID) await ctx.api.sendMessage(ADMIN_ID, `💰 (${method}) ${money(amount, lang)} — ${user.firstName ?? ""} @${user.username ?? "—"} (${user.tgId})`).catch(() => {});

  if (variantId && qty) {
    await executePurchase(user.tgId, variantId, qty, undefined, targetUsername, discountCost, recipientTgId, method, chargeId).catch((err) => {
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
  if (!approve) return promptRejectReason(ctx, id);

  const result = await approveTopUp(id, {
    // Compare-and-set: the status transition IS the lock. Reading the row and
    // then updating it let two concurrent approvals (admin double-tap, two
    // admins, a redelivered callback) both see "pending" and both credit the
    // balance. Here only the caller whose UPDATE actually changed a row gets
    // past this point, and the credit rides inside the same transaction.
    claim: async (topUpId) =>
      db.$transaction(async (tx) => {
        const changed = await tx.topUp.updateMany({
          where: { id: topUpId, status: { in: [...APPROVABLE_STATUSES] } },
          data: { status: "approved" },
        });
        if (changed.count !== 1) return null; // lost the race, or not approvable
        const t = await tx.topUp.findUnique({ where: { id: topUpId } });
        if (!t) return null;
        await tx.botUser.update({ where: { id: t.userId }, data: { balance: { increment: t.amount } } });
        return { id: t.id, userId: t.userId, amount: t.amount, note: t.note };
      }),

    // Runs only for the winner, and outside the transaction: it talks to
    // Telegram and suppliers, and holding a row lock across that would turn a
    // slow supplier into a database lock timeout.
    fulfil: async (claimed) => {
      const user = await db.botUser.findUnique({ where: { id: claimed.userId } });
      if (!user) return;
      const ulang = user.lang;
      await ctx.editMessageText(`✅ #${claimed.id} +${money(claimed.amount, ulang)}`).catch(() => {});
      await ctx.api.sendMessage(user.tgId, t(ulang, "paid_received", { v: money(claimed.amount, ulang), b: "" }).split("\n")[0]).catch(() => {});

      const parsed = parseBuyNote(claimed.note);
      if (parsed) {
        await executePurchase(
          user.tgId, parsed.variantId, parsed.qty, undefined,
          parsed.username ?? undefined, 0, parsed.recipientTgId ?? undefined,
          "admin", String(claimed.id),
        ).catch((err) => {
          console.error(`[bot] resolveTopUp auto-purchase fail: topup=${claimed.id} user=${user.tgId} ${(err as Error).message}`);
        });
      }
    },
  });

  if (result.kind === "already_processed") {
    return ctx.answerCallbackQuery({ text: "Уже обработано", show_alert: true }).catch(() => {});
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
  const menu = await buildMenu(user.lang, 0, "all", user.id, false);
  const banner = await shopBanner();
  if (banner) {
    const send = banner.isVideo
      ? ctx.replyWithVideo(banner.src, { caption: menu.text, parse_mode: "HTML", reply_markup: menu.kb })
      : ctx.replyWithPhoto(banner.src, { caption: menu.text, parse_mode: "HTML", reply_markup: menu.kb });
    await send.catch(async () => {
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

// Stamp the moment a user is known to satisfy the channel requirement. This is
// the single gate a referral has to pass: countVerifiedRefs() only counts
// invitees with this set, so a /start?start=refXXX that never subscribes earns
// the referrer nothing. Idempotent — the null guard keeps the first timestamp.
//
// The updateMany count is also the "first time" signal: exactly one call can
// flip a given user, so the referrer's "+1" message can be sent from here
// without any risk of firing twice, no matter which path detected the join.
// Pass notify: false for bulk repairs (/reffix), which would otherwise fire
// hundreds of messages at once and hit Telegram's rate limit.
async function markChannelVerified(tgId: string, opts: { notify?: boolean } = {}): Promise<boolean> {
  const res = await db.botUser
    .updateMany({ where: { tgId, channelVerifiedAt: null }, data: { channelVerifiedAt: new Date() } })
    .catch(() => ({ count: 0 }));
  const firstTime = res.count > 0;
  if (firstTime && opts.notify !== false) notifyReferrerCounted(tgId).catch(() => {});
  return firstTime;
}

// Tell the inviter that someone opened the bot through their link but has not
// subscribed yet — so a referral that is still pending looks like progress
// rather than silence.
async function notifyReferrerPending(invitee: { tgId: string; firstName: string | null; referredBy: string | null }) {
  if (!invitee.referredBy) return;
  if (!(await isReferralsEnabled())) return;
  const referrer = await db.botUser.findUnique({ where: { tgId: invitee.referredBy } }).catch(() => null);
  if (!referrer || referrer.refBanned) return;
  const lang = referrer.lang;
  await bot.api.sendMessage(
    referrer.tgId,
    t(lang, "ref_pending_notify", { name: esc(maskName(invitee.firstName || invitee.tgId)) }),
    { parse_mode: "HTML" },
  ).catch(() => {});
}

// Tell the inviter the referral just became real, and what they can spend now.
async function notifyReferrerCounted(inviteeTgId: string) {
  const invitee = await db.botUser.findUnique({ where: { tgId: inviteeTgId } }).catch(() => null);
  if (!invitee?.referredBy) return;
  if (!(await isReferralsEnabled())) return;
  const referrer = await db.botUser.findUnique({ where: { tgId: invitee.referredBy } }).catch(() => null);
  if (!referrer || referrer.refBanned) return;
  const points = await availableReferralPoints(referrer);
  const lang = referrer.lang;
  const kb = new InlineKeyboard().text(t(lang, "btn_freebies"), "gifts_show");
  await bot.api.sendMessage(
    referrer.tgId,
    t(lang, "ref_counted_notify", { name: esc(maskName(invitee.firstName || invitee.tgId)), n: points }),
    { parse_mode: "HTML", reply_markup: kb },
  ).catch(() => {});
}

// ---------- maintenance mode cache (30 s TTL) ----------
let maintenanceCache: { on: boolean; until: number } = { on: false, until: 0 };
async function isMaintenanceOn(): Promise<boolean> {
  if (Date.now() < maintenanceCache.until) return maintenanceCache.on;
  const row = await db.setting.findUnique({ where: { key: "maintenance_mode" } }).catch(() => null);
  const on = row?.valueRu === "1";
  maintenanceCache = { on, until: Date.now() + 30_000 };
  return on;
}

// ---------- referrals enabled cache (30 s TTL) ----------
// When off: new invites don't count, gifts tab and buy-for-refs are blocked.
let referralsEnabledCache: { enabled: boolean; until: number } = { enabled: true, until: 0 };
async function isReferralsEnabled(): Promise<boolean> {
  if (Date.now() < referralsEnabledCache.until) return referralsEnabledCache.enabled;
  const row = await db.setting.findUnique({ where: { key: "referrals_enabled" } }).catch(() => null);
  // Default on (if key absent). Disabled only when explicitly set to "0".
  const enabled = row === null || row.valueRu !== "0";
  referralsEnabledCache = { enabled, until: Date.now() + 30_000 };
  return enabled;
}
// Stores the message_id of the "subscribe to channels" gate message per user
// so we can delete it automatically when they join.
const subsGateMsg = new Map<string, number>();

async function isSubscribedTo(ctx: Context, tgId: string, chatId: string): Promise<boolean> {
  try {
    const member = await ctx.api.getChatMember(chatId, Number(tgId));
    if (["member", "creator", "administrator", "restricted"].includes(member.status)) {
      // Confirmed member → the join-request row has served its purpose. Drop it,
      // otherwise it outlives the membership: someone who joins via a request
      // link and then leaves would keep passing this gate forever (and keep
      // counting as a verified referral).
      db.channelJoinRequest.deleteMany({ where: { chatId, tgId } }).catch(() => {});
      return true;
    }
    return false;
  } catch (err) {
    const pending = await db.channelJoinRequest.findUnique({ where: { chatId_tgId: { chatId, tgId } } }).catch(() => null);
    if (pending !== null) return true;
    console.warn(`[bot] isSubscribedTo API check failed for channel ${chatId}:`, (err as Error).message);
    return true;
  }
}

// The gates below decide what a user may do in their private chat with the
// bot. They must only run on updates that ARE such an action — a message or a
// button tap.
//
// Every other update type (chat_member when someone joins a channel,
// chat_join_request, pre_checkout_query) has no message to gate, and its
// ctx.chat is the channel rather than the private chat. Running the gates on
// those was actively harmful: a brand-new invitee has termsAcceptedAt = null,
// so the terms gate swallowed their chat_member update and bot.on("chat_member")
// never ran — meaning subscribing to the channel never credited the referral,
// which is the whole point of the flow. It also tried to post the terms text
// into the channel itself, and blocked chat_join_request so join requests were
// never auto-approved.
const isUserAction = (ctx: Context) => Boolean(ctx.message || ctx.callbackQuery);

// Why a brand-new user opened the bot, carried across the language/terms
// onboarding so the final screen matches the link they clicked. In memory only:
// losing it on a restart just means they land in the shop instead of gifts.
const pendingIntent = new Map<string, string>();

// ---------- private chat only ----------
// The bot is a member of the public sales-feed group, and every handler below
// answers with ctx.reply() — which replies into whatever chat the update came
// from. Without this guard the bot talked INSIDE the group: a plain message
// there tripped the subscription gate and posted "Подпишитесь на наши каналы!",
// and any text matching a menu label ran that screen — including "Пригласить",
// which published a member's personal referral link to all 125 participants.
//
// The shop is a one-to-one experience, so messages and taps are only ever
// handled in a private chat. Channel-side updates (chat_member,
// chat_join_request) are deliberately NOT filtered here: they always arrive
// from the channel and are what credits referrals. The sales feed is unaffected
// too — it posts outbound via bot.api.sendMessage(groupId), not through a
// handler.
bot.use(async (ctx, next) => {
  if (!isUserAction(ctx)) return next();
  const type = ctx.chat?.type;
  if (type && type !== "private") {
    // Acknowledge taps so the client doesn't spin, but render nothing.
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    return; // never reply into a group or channel
  }
  return next();
});

// ---------- maintenance mode gate ----------
bot.use(async (ctx, next) => {
  if (!isUserAction(ctx)) return next();
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
  if (!isUserAction(ctx)) return next();
  if (String(ctx.from?.id) === ADMIN_ID) return next();

  const data = ctx.callbackQuery?.data;
  // check_subs MUST pass through: a brand-new user has termsAcceptedAt = null,
  // so without this the terms screen swallowed their "Проверить подписку" tap.
  // channelVerifiedAt then never got stamped and their referrer never earned
  // the point, even though the person really had subscribed.
  if (data === "terms_accept" || data === "check_subs" || data?.startsWith("lang:") || data?.startsWith("vote:")) return next();

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
  if (!isUserAction(ctx)) return next();
  if (String(ctx.from?.id) === ADMIN_ID) {
    return next();
  }

  const data = ctx.callbackQuery?.data;
  if (data === "check_subs" || data === "terms_accept" || data?.startsWith("lang:") || data?.startsWith("vote:")) {
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
    // No channels configured → nothing to gate on, so the requirement is
    // trivially met. Stamp it, otherwise referral points could never accrue.
    await markChannelVerified(tgId);
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
    await markChannelVerified(tgId);
    return next();
  }

  const user = await getUser(ctx);
  const lang = user.lang;

  const kb = new InlineKeyboard();
  for (const ch of unsubscribed) {
    kb.url(`📢 ${ch.name}`, ch.url).row();
  }
  kb.text(t(lang, "check_subs_btn"), "check_subs").row();

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
  const payload = (ctx.match ?? "").trim();
  // The referral link is recorded on the BotUser row right away so it survives
  // a bot restart. It does NOT earn a point yet: availableReferralPoints only
  // counts invitees whose channelVerifiedAt is set, which happens once they
  // actually pass the subscription gate below.
  const user = await getUser(ctx, payload || undefined);
  const tgId = user.tgId;

  // Freshly created AND attributed to someone → tell the inviter it landed, so
  // a referral that is still waiting on the channel gate looks like progress
  // instead of nothing happening. Fire-and-forget: the invitee's own flow must
  // not stall on it.
  if (!existing && user.referredBy) notifyReferrerPending(user).catch(() => {});

  // Check required channels BEFORE showing anything else (except for admin).
  if (!isAdmin(ctx)) {
    const active = await db.requiredChannel.findMany({ where: { isActive: true } });
    const cachedUntil = subsOkCache.get(tgId);
    if (active.length > 0 && (!cachedUntil || cachedUntil <= Date.now())) {
      const results = await Promise.all(active.map((ch) => isSubscribedTo(ctx, tgId, ch.chatId)));
      const unsubscribed = active.filter((_, i) => !results[i]);
      if (unsubscribed.length > 0) {
        const kb = new InlineKeyboard();
        for (const ch of unsubscribed) kb.url(`📢 ${ch.name}`, ch.url).row();
        kb.text(t(user.lang, "check_subs_btn"), "check_subs").row();
        const sent = await ctx.reply(t(user.lang, "subs_required_msg"), { parse_mode: "HTML", reply_markup: kb }).catch(() => null);
        if (sent?.message_id) subsGateMsg.set(tgId, sent.message_id);
        return;
      }
      subsOkCache.set(tgId, Date.now() + SUBS_CACHE_TTL_MS);
    }
    // Nothing left to gate on — either every required channel is satisfied or
    // none are configured. Stamp the verification that referral points key off.
    await markChannelVerified(tgId);
  }

  // Deep links:
  // - start=gifts → opens gifts
  // - start=buy_<variantId> → opens buy card for specific discounted variant
  // - start=p_<productId> → opens specific product
  // - start=promo → opens shop with flash sale
  if (!existing) {
    // A first-time visitor still has to pick a language and accept the terms.
    // Remember why they came so the last onboarding step lands on their intent.
    if (payload) pendingIntent.set(tgId, payload);
    return showLangPicker(ctx, false);
  }
  if (payload === "gifts") return showGifts(ctx, false);
  if (payload.startsWith("buy_")) {
    const vid = Number(payload.slice(4));
    if (vid > 0) return showQtyChooser(ctx, vid, 1, "0:all", false);
  }
  if (payload.startsWith("p_")) {
    const pid = Number(payload.slice(2));
    if (pid > 0) return showProduct(ctx, pid, "0:all");
  }
  if (payload === "promo") return showMenu(ctx, 0, "all", false);
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

  const verified = invited.filter((u) => u.channelVerifiedAt !== null).length;
  const header =
    `👤 <b>${esc(referrer.firstName ?? "—")}</b> (@${referrer.username ?? referrer.tgId})\n` +
    `Перешли по ссылке: <b>${invited.length}</b>\n` +
    `✅ Подписались (засчитано): <b>${verified}</b>\n` +
    `⏳ Не подписались (не в счёт): <b>${invited.length - verified}</b>\n\n`;
  const CHUNK_SIZE = 50;
  for (let i = 0; i < invited.length; i += CHUNK_SIZE) {
    const chunk = invited.slice(i, i + CHUNK_SIZE);
    const lines = chunk.map((u, idx) => {
      const name = u.firstName ? esc(u.firstName) : "—";
      const uname = u.username ? ` @${u.username}` : "";
      const date = u.createdAt.toISOString().slice(0, 10);
      const mark = u.channelVerifiedAt ? "✅" : "⏳";
      return `${i + idx + 1}. ${mark} <code>${u.tgId}</code> ${name}${uname} · ${date}`;
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

// How many points a user's gift orders actually justify having spent.
// spentReferrals is incremented up front by buyForReferrals(); before the
// refund fix, an aborted delivery left it incremented with nothing to show for
// it, so points silently evaporated. Orders are the ground truth: replay them
// and compare. Failed orders don't count — those were (or should have been)
// refunded. Cost is resolved the same way buyForReferrals() resolves it: the
// admin tier map first, then the variant's own pointsCost.
async function reconciledSpend(userId: number): Promise<{ expected: number; orders: number }> {
  const { map } = await getGiftTiersMap();
  const orders = await db.botOrder.findMany({
    where: { userId, source: "referral", status: { not: "failed" } },
    select: { variantId: true },
  });
  let expected = 0;
  for (const o of orders) {
    if (o.variantId == null) continue;
    const v = await db.variant.findUnique({ where: { id: o.variantId }, select: { pointsCost: true } }).catch(() => null);
    expected += map.get(o.variantId) ?? v?.pointsCost ?? 0;
  }
  return { expected, orders: orders.length };
}

// Send a long report as several messages — Telegram rejects anything over
// 4096 chars, and a rejected report is worse than a split one.
async function replyChunked(ctx: Context, lines: string[]) {
  let buf = "";
  for (const line of lines) {
    if (buf.length + line.length + 1 > 3800) {
      await ctx.reply(buf, { parse_mode: "HTML" }).catch(() => {});
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) await ctx.reply(buf, { parse_mode: "HTML" }).catch(() => {});
}

const D = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "—");

// Admin: /refinfo <tgId|@username> — the complete referral picture for one
// person: who they invited, who counted and who didn't, every point earned and
// spent, and the exact gift orders the points went to.
bot.command(["refinfo", "refwhy"], async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.match ?? "").trim().replace(/^@/, "");
  if (!arg) {
    return ctx.reply(
      "Формат: <code>/refinfo &lt;tgId или @username&gt;</code>\n\n" +
      "Показывает всё о рефералах человека: кого пригласил, кто подписался,\n" +
      "сколько очков заработал, сколько потратил и на какие именно подарки.",
      { parse_mode: "HTML" },
    );
  }

  const u = await db.botUser.findFirst({ where: isNaN(Number(arg)) ? { username: arg } : { tgId: arg } });
  if (!u) return ctx.reply(`❌ Не найден: ${arg}`);

  const [invited, giftOrders, refsOn, tiers] = await Promise.all([
    db.botUser.findMany({ where: { referredBy: u.tgId }, orderBy: { createdAt: "desc" } }),
    db.botOrder.findMany({ where: { userId: u.id, source: "referral" }, orderBy: { id: "desc" } }),
    isReferralsEnabled(),
    getGiftTiersMap(),
  ]);

  const verified = invited.filter((x) => x.channelVerifiedAt !== null);
  const unverified = invited.filter((x) => x.channelVerifiedAt === null);
  const bonus = u.bonusReferrals ?? 0;
  const earned = verified.length + bonus;
  const spent = u.spentReferrals ?? 0;
  const available = Math.max(0, earned - spent);

  // Cost per gift order, resolved the way buyForReferrals resolves it.
  const costOf = async (variantId: number | null) => {
    if (variantId == null) return 0;
    const v = await db.variant.findUnique({ where: { id: variantId }, select: { pointsCost: true } }).catch(() => null);
    return tiers.map.get(variantId) ?? v?.pointsCost ?? 0;
  };
  const orderRows: Array<{ id: number; title: string; cost: number; status: string; at: Date }> = [];
  for (const o of giftOrders) {
    orderRows.push({ id: o.id, title: o.titleRu, cost: await costOf(o.variantId), status: o.status, at: o.createdAt });
  }
  const okOrders = orderRows.filter((o) => o.status !== "failed");
  const justified = okOrders.reduce((s, o) => s + o.cost, 0);
  const lost = spent - justified;

  const L: string[] = [];
  L.push(`📊 <b>ПОЛНЫЕ ДАННЫЕ ПО РЕФЕРАЛАМ</b>`);
  L.push(``);
  L.push(`👤 <b>${esc(u.firstName ?? "—")}</b>${u.username ? ` @${u.username}` : ""}`);
  L.push(`ID: <code>${u.tgId}</code>`);
  L.push(`Регистрация: ${D(u.createdAt)}`);
  L.push(`Подписка подтверждена: ${u.channelVerifiedAt ? "✅ " + D(u.channelVerifiedAt) : "❌ нет"}`);
  L.push(`Рефералка в боте: ${refsOn ? "✅ включена" : "⏸ ВЫКЛЮЧЕНА"}`);
  L.push(`Бан в рефералке: ${u.refBanned ? "🚫 ДА (не может ни приглашать, ни тратить)" : "нет"}`);
  L.push(``);

  L.push(`━━━━━━━━━━━━━━━━━━`);
  L.push(`🤝 <b>ПРИГЛАШЕНИЯ</b>`);
  L.push(`━━━━━━━━━━━━━━━━━━`);
  L.push(`Перешли по ссылке: <b>${invited.length}</b> чел.`);
  L.push(`✅ Подписались — засчитано: <b>${verified.length}</b>`);
  L.push(`⏳ Не подписались — не в счёт: <b>${unverified.length}</b>`);
  L.push(``);

  L.push(`━━━━━━━━━━━━━━━━━━`);
  L.push(`💰 <b>ОЧКИ</b>`);
  L.push(`━━━━━━━━━━━━━━━━━━`);
  L.push(`За приглашения: <b>${verified.length}</b>`);
  L.push(`Бонус от админа: <b>${bonus > 0 ? "+" : ""}${bonus}</b>`);
  L.push(`Всего заработано: <b>${earned}</b>`);
  L.push(`Потрачено: <b>−${spent}</b>`);
  L.push(`🎁 <b>ДОСТУПНО СЕЙЧАС: ${available}</b>`);
  L.push(``);

  L.push(`━━━━━━━━━━━━━━━━━━`);
  L.push(`🎁 <b>НА ЧТО ПОТРАЧЕНО</b>`);
  L.push(`━━━━━━━━━━━━━━━━━━`);
  if (orderRows.length === 0) {
    L.push(`Подарков не заказывал.`);
  } else {
    for (const o of orderRows) {
      const mark = o.status === "delivered" ? "✅ выдан"
        : o.status === "awaiting_delivery" ? "⏳ ждёт выдачи"
        : o.status === "failed" ? "❌ сорвался (очки возвращены)"
        : `• ${esc(o.status)}`;
      L.push(`#${o.id} · ${D(o.at)}`);
      L.push(`   ${esc(o.title)}`);
      L.push(`   <b>${o.cost} очк.</b> · ${mark}`);
    }
    L.push(``);
    L.push(`Итого по действующим заказам: <b>${justified}</b> очк.`);
  }
  L.push(``);

  // Sanity check: the counter and the orders must tell the same story.
  L.push(`━━━━━━━━━━━━━━━━━━`);
  L.push(`🔍 <b>СВЕРКА</b>`);
  L.push(`━━━━━━━━━━━━━━━━━━`);
  L.push(`Списано по счётчику: <b>${spent}</b>`);
  L.push(`Оправдано заказами: <b>${justified}</b>`);
  if (lost > 0) {
    L.push(`🔴 <b>Потеряно впустую: ${lost} очк.</b>`);
    L.push(`Очки списаны, а подарка нет — сорвавшаяся выдача или ручное /refzero.`);
    L.push(`Вернуть: <code>/refrepair ${u.tgId}</code>`);
  } else if (lost < 0) {
    L.push(`🟡 Заказов больше, чем списано (на ${-lost} очк.).`);
    L.push(`Обычно это подарки, выданные вручную админом.`);
  } else {
    L.push(`✅ Всё сходится.`);
  }
  L.push(``);

  L.push(`━━━━━━━━━━━━━━━━━━`);
  L.push(`👥 <b>КОГО ПРИГЛАСИЛ</b> (${invited.length})`);
  L.push(`━━━━━━━━━━━━━━━━━━`);
  if (invited.length === 0) {
    L.push(`Никого — по его ссылке никто не зарегистрирован.`);
    L.push(``);
    L.push(`⚠️ Если он уверяет, что приглашал: скорее всего те люди зашли,`);
    L.push(`когда рефералка была выключена — тогда ссылка не сохранялась.`);
    L.push(`Автоматически не восстановить, начислите вручную:`);
    L.push(`<code>/refgive ${u.tgId} 1</code>`);
  } else {
    let i = 0;
    for (const x of invited) {
      i++;
      const mark = x.channelVerifiedAt ? "✅" : "⏳";
      const note = x.channelVerifiedAt ? "" : " — НЕ подписан";
      L.push(`${i}. ${mark} <code>${x.tgId}</code> ${esc(x.firstName ?? "—")}${x.username ? ` @${x.username}` : ""} · ${D(x.createdAt)}${note}`);
    }
    if (unverified.length > 0) {
      L.push(``);
      L.push(`💡 Если кто-то из «⏳» на самом деле подписан — <code>/reffix</code>`);
      L.push(`перепроверит всех через Telegram и засчитает подтверждённых.`);
    }
  }

  await replyChunked(ctx, L);
});

// Admin: /refrepair [tgId|@username | all] — return points that were debited
// without a gift ever being delivered, by resetting spentReferrals to what the
// user's actual gift orders justify. "all" previews every affected user; add
// "apply" to write the changes.
//
// NOTE: this also undoes a deliberate /refzero, since both look identical in
// the data — points spent with no order behind them. Re-run /refzero on the
// fraudsters afterwards.
bot.command("refrepair", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const target = (parts[0] ?? "").replace(/^@/, "");
  if (!target) {
    return ctx.reply(
      "Формат:\n" +
      "  <code>/refrepair &lt;tgId или @username&gt;</code> — вернуть очки одному\n" +
      "  <code>/refrepair all</code> — показать всех пострадавших (без изменений)\n" +
      "  <code>/refrepair all apply</code> — вернуть очки всем\n\n" +
      "Возвращает очки, списанные без выданного подарка.\n" +
      "⚠️ Отменяет и ручное /refzero — мошенников придётся обнулить заново.",
      { parse_mode: "HTML" },
    );
  }

  // ---- single user ----
  if (target !== "all") {
    const u = await db.botUser.findFirst({ where: isNaN(Number(target)) ? { username: target } : { tgId: target } });
    if (!u) return ctx.reply(`❌ Не найден: ${target}`);
    const spent = u.spentReferrals ?? 0;
    const { expected, orders } = await reconciledSpend(u.id);
    if (spent <= expected) {
      return ctx.reply(`✅ У ${u.firstName ?? u.tgId} расхождений нет (списано ${spent}, подарков на ${expected}). Ничего не изменено.`);
    }
    await db.botUser.update({ where: { id: u.id }, data: { spentReferrals: expected } });
    const after = await availableReferralPoints({ ...u, spentReferrals: expected });
    return ctx.reply(
      `✅ <b>Очки возвращены</b>\n\n` +
      `👤 ${esc(u.firstName ?? "—")} @${u.username ?? u.tgId}\n` +
      `Было списано: <b>${spent}</b>\n` +
      `Подарков получено: <b>${orders}</b> на <b>${expected}</b> очк.\n` +
      `Возвращено: <b>${spent - expected}</b>\n` +
      `Доступно теперь: <b>${after}</b>`,
      { parse_mode: "HTML" },
    );
  }

  // ---- everyone ----
  const apply = parts[1] === "apply";
  const candidates = await db.botUser.findMany({
    where: { spentReferrals: { gt: 0 } },
    select: { id: true, tgId: true, username: true, firstName: true, spentReferrals: true },
  });
  if (candidates.length === 0) return ctx.reply("✅ Ни у кого нет списанных очков — чинить нечего.");

  const status = await ctx.reply(`🔍 Сверяю ${candidates.length} чел. с их заказами…`).catch(() => null);

  const affected: Array<{ id: number; tgId: string; name: string; spent: number; expected: number }> = [];
  for (const c of candidates) {
    const { expected } = await reconciledSpend(c.id);
    const spent = c.spentReferrals ?? 0;
    if (spent > expected) {
      affected.push({ id: c.id, tgId: c.tgId, name: c.firstName ?? c.username ?? c.tgId, spent, expected });
    }
  }

  if (affected.length === 0) {
    const msg = "✅ Расхождений не найдено — у всех списания совпадают с полученными подарками.";
    if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, msg).catch(() => {});
    else await ctx.reply(msg).catch(() => {});
    return;
  }

  const totalLost = affected.reduce((s, a) => s + (a.spent - a.expected), 0);
  if (apply) {
    for (const a of affected) {
      await db.botUser.update({ where: { id: a.id }, data: { spentReferrals: a.expected } }).catch(() => {});
    }
  }

  const head =
    (apply ? `✅ <b>Очки возвращены</b>\n\n` : `📋 <b>Предпросмотр (ничего не изменено)</b>\n\n`) +
    `Пострадавших: <b>${affected.length}</b>\n` +
    `Всего очков ${apply ? "возвращено" : "к возврату"}: <b>${totalLost}</b>\n\n`;
  const rows = affected
    .sort((a, b) => (b.spent - b.expected) - (a.spent - a.expected))
    .slice(0, 40)
    .map((a) => `• ${esc(a.name)} <code>${a.tgId}</code> — +${a.spent - a.expected}`);
  const tail = affected.length > 40 ? `\n\n…и ещё ${affected.length - 40} чел.` : "";
  const foot = apply
    ? `\n\n⚠️ Если среди них есть мошенники — обнулите заново: <code>/refzero &lt;id&gt;</code>`
    : `\n\nПрименить: <code>/refrepair all apply</code>`;

  const done = head + rows.join("\n") + tail + foot;
  if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, done, { parse_mode: "HTML" }).catch(() => {});
  else await ctx.reply(done, { parse_mode: "HTML" }).catch(() => {});
});

// Admin: /refgive <tgId|@username> <n> — manually credit referral points.
// For invites that were lost while referrals were switched off (the ref id
// lived only in that one /start payload and is unrecoverable).
bot.command("refgive", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return ctx.reply("Формат: /refgive <tgId или @username> <сколько>\n\nНачисляет очки вручную (bonusReferrals).");
  const arg = parts[0].replace(/^@/, "");
  const n = Math.trunc(Number(parts[1]));
  if (!Number.isFinite(n) || n === 0) return ctx.reply("❌ Укажите число (можно отрицательное, чтобы отнять).");

  const u = await db.botUser.findFirst({ where: isNaN(Number(arg)) ? { username: arg } : { tgId: arg } });
  if (!u) return ctx.reply(`❌ Не найден: ${arg}`);

  const updated = await db.botUser.update({
    where: { id: u.id },
    data: { bonusReferrals: Math.max(0, (u.bonusReferrals ?? 0) + n) },
  });
  const points = await availableReferralPoints(updated);
  await ctx.reply(
    `✅ ${n > 0 ? "Начислено" : "Списано"} ${Math.abs(n)} очк.\n\n` +
    `👤 ${esc(u.firstName ?? "—")} @${u.username ?? u.tgId}\n` +
    `Бонус: ${u.bonusReferrals ?? 0} → <b>${updated.bonusReferrals}</b>\n` +
    `Доступно сейчас: <b>${points}</b>`,
    { parse_mode: "HTML" },
  );
});

// Admin: /reffix — repair pass. Re-checks every invitee that has a referrer but
// no channelVerifiedAt against the live Telegram membership, and stamps the
// ones who really are subscribed. This is the recovery path for people who
// subscribed but were never stamped (e.g. their "Проверить подписку" tap was
// swallowed by the terms gate before that was fixed).
bot.command("reffix", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const active = await db.requiredChannel.findMany({ where: { isActive: true } });
  if (active.length === 0) {
    const n = await db.botUser.updateMany({
      where: { referredBy: { not: null }, channelVerifiedAt: null },
      data: { channelVerifiedAt: new Date() },
    });
    return ctx.reply(`✅ Обязательных каналов нет — засчитаны все приглашённые.\n\nОбновлено: ${n.count}`);
  }

  const pendingUsers = await db.botUser.findMany({
    where: { referredBy: { not: null }, channelVerifiedAt: null },
    select: { id: true, tgId: true },
  });
  if (pendingUsers.length === 0) return ctx.reply("✅ Все приглашённые уже проверены — чинить нечего.");

  const status = await ctx.reply(`🔍 Проверяю ${pendingUsers.length} чел. через Telegram…`).catch(() => null);

  let fixed = 0, stillNot = 0;
  const CHUNK = 20;
  for (let i = 0; i < pendingUsers.length; i += CHUNK) {
    const batch = pendingUsers.slice(i, i + CHUNK);
    await Promise.all(batch.map(async (u) => {
      const results = await Promise.all(active.map((ch) => isSubscribedTo(ctx, u.tgId, ch.chatId)));
      if (results.every(Boolean)) {
        // Silent: this is a catch-up pass over historic joins, and firing a
        // "+1" message per row would blast hundreds at once and hit the rate
        // limit. Points are still credited exactly the same.
        await markChannelVerified(u.tgId, { notify: false });
        fixed++;
      } else {
        stillNot++;
      }
    }));
    await new Promise((r) => setTimeout(r, 600)); // stay under Telegram's rate limit
  }

  const done =
    `✅ <b>Проверка завершена</b>\n\n` +
    `Проверено: <b>${pendingUsers.length}</b>\n` +
    `Засчитано (реально подписаны): <b>${fixed}</b>\n` +
    `Действительно не подписаны: <b>${stillNot}</b>`;
  if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, done, { parse_mode: "HTML" }).catch(() => {});
  else await ctx.reply(done, { parse_mode: "HTML" }).catch(() => {});
});

// Admin: /salesgroup [@group | id | off | test] — configure the public sales
// feed and prove it actually posts, rather than failing silently in a log.
bot.command("salesgroup", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.match ?? "").trim();
  const current = (await setting("sales_group_id", "")).trim();
  const on = (await setting("sales_feed_enabled", "1")) !== "0";
  const setFlag = (v: string) =>
    db.setting.upsert({ where: { key: "sales_feed_enabled" }, create: { key: "sales_feed_enabled", valueRu: v }, update: { valueRu: v } });

  const usage =
    `📣 <b>Лента продаж</b>\n\n` +
    `Автоотправка: ${on ? "✅ включена" : "⏸ выключена"}\n` +
    `Группа: ${current ? `<code>${esc(current)}</code>` : "<i>не задана</i>"}\n\n` +
    `<b>Команды:</b>\n` +
    `<code>/salesgroup @subhub_group</code> — задать группу\n` +
    `<code>/salesgroup on</code> — включить автоотправку\n` +
    `<code>/salesgroup off</code> — выключить автоотправку\n` +
    `<code>/salesgroup test</code> — отправить пробное сообщение\n` +
    `<code>/salesgroup clear</code> — забыть группу\n\n` +
    `⚠️ Бот должен состоять в группе и иметь право писать.\n` +
    `Для закрытых групп используйте числовой id (например <code>-1001234567890</code>).`;

  if (!arg) return ctx.reply(usage, { parse_mode: "HTML" });

  if (arg === "off") {
    await setFlag("0");
    return ctx.reply("⏸ Автоотправка выключена — сообщения о покупках не публикуются.\n\nГруппа сохранена, включить обратно: /salesgroup on");
  }
  if (arg === "on") {
    await setFlag("1");
    return ctx.reply(
      current
        ? `✅ Автоотправка включена — покупки публикуются в <code>${esc(current)}</code>.`
        : "✅ Автоотправка включена, но группа не задана.\n\nЗадайте: /salesgroup @subhub_group",
      { parse_mode: "HTML" },
    );
  }
  if (arg === "clear") {
    await db.setting.upsert({ where: { key: "sales_group_id" }, create: { key: "sales_group_id", valueRu: "" }, update: { valueRu: "" } });
    return ctx.reply("✅ Группа удалена из настроек.");
  }

  if (arg === "test") {
    if (!current) return ctx.reply("❌ Группа не задана. Сначала: <code>/salesgroup @subhub_group</code>", { parse_mode: "HTML" });
    if (!on) return ctx.reply("⏸ Автоотправка выключена — включите: <code>/salesgroup on</code>", { parse_mode: "HTML" });
    // Send the exact same shapes real purchases produce, so what the admin
    // sees here is what members will see.
    const fake = { firstName: "Jahongir", username: "jahongir", tgId: "7141343261" };
    await notifySalesGroup(fake, "Gemini AI Pro — 18 месяцев", { price: 0, refPoints: 10 });
    await notifySalesGroup(fake, "Canva Pro — 1 год", { price: 50000 });
    return ctx.reply(
      `📤 Отправил 2 пробных сообщения в <code>${esc(current)}</code>.\n\n` +
      `Если в группе ничего не появилось — бот не состоит в ней или не может писать.`,
      { parse_mode: "HTML" },
    );
  }

  // Accept @name, t.me/name, or a raw numeric id.
  let value = arg.replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").trim();
  if (!/^-?\d+$/.test(value)) value = `@${value}`;

  // Verify before saving — a wrong value would otherwise fail silently forever.
  try {
    const chat = await ctx.api.getChat(value);
    await db.setting.upsert({
      where: { key: "sales_group_id" },
      create: { key: "sales_group_id", valueRu: value },
      update: { valueRu: value },
    });
    const title = "title" in chat && chat.title ? chat.title : value;
    await ctx.reply(
      `✅ <b>Группа сохранена</b>\n\n` +
      `Название: ${esc(String(title))}\n` +
      `Адрес: <code>${esc(value)}</code>\n\n` +
      `Проверьте отправку: <code>/salesgroup test</code>`,
      { parse_mode: "HTML" },
    );
  } catch (e) {
    await ctx.reply(
      `❌ <b>Не удалось открыть</b> <code>${esc(value)}</code>\n\n` +
      `<code>${esc((e as Error).message.slice(0, 150))}</code>\n\n` +
      `Проверьте, что бот добавлен в группу и может писать в неё.`,
      { parse_mode: "HTML" },
    );
  }
});

// Default channel promo. Editable in the admin panel (Тексты и меню бота →
// promo_post_text) so the wording can change without a deploy.
//
// The urgency line says the promo "may stop at any time" rather than naming a
// deadline: that is literally true (referrals are a switch the admin controls),
// whereas a date that passes without the offer ending teaches readers to
// discount every future post.
const PROMO_POST_DEFAULT = `🎁 <b>BEPUL OBUNA — HALI OCHIQ</b>

Do'stlaringizni taklif qiling va pullik obunalarni <b>bepul</b> oling:

💜 <b>Canva Pro — 1 yil</b> → 5 ta do'st
✦ <b>Gemini AI Pro — 18 oy</b> → 10 ta do'st

Do'stingiz botga kiradi va kanalga obuna bo'ladi — ochko <b>avtomatik</b> hisoblanadi.

⚠️ <i>Aksiya istalgan vaqtda to'xtatilishi mumkin. Ulgurib qoling.</i>`;

const PROMO_BUTTON_DEFAULT = "🎁 Sovg'ani olish";

/** Build the promo post exactly as it will appear, for preview and for send. */
async function buildPromoPost() {
  const [text, label] = await Promise.all([
    setting("promo_post_text", PROMO_POST_DEFAULT),
    setting("promo_post_button", PROMO_BUTTON_DEFAULT),
  ]);
  const me = await bot.api.getMe();
  const kb = new InlineKeyboard().url(label, `https://t.me/${me.username}?start=gifts`);
  return { text, kb };
}

// Admin: /promopost — preview privately; /promopost send — publish to the
// channel. Publishing is never automatic: the admin pulls the trigger.
bot.command("promopost", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.match ?? "").trim();
  const { text, kb } = await buildPromoPost();

  if (arg === "send") {
    const target = (await setting("promo_post_channel", "")).trim()
      || (await db.requiredChannel.findFirst({ where: { isActive: true } }))?.chatId
      || "";
    if (!target) {
      return ctx.reply(
        "❌ Не задан канал для публикации.\n\n" +
        "Укажите его: <code>/promopost channel @nomi</code>\n" +
        "Либо добавьте обязательный канал — тогда пост уйдёт туда.",
        { parse_mode: "HTML" },
      );
    }
    try {
      const sent = await bot.api.sendMessage(target, text, {
        parse_mode: "HTML",
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      });
      await ctx.reply(
        `✅ <b>Опубликовано в ${esc(target)}</b>\n\nID сообщения: <code>${sent.message_id}</code>`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      await ctx.reply(
        `❌ <b>Не удалось опубликовать</b>\n\n<code>${esc((e as Error).message.slice(0, 200))}</code>\n\n` +
        `Бот должен быть администратором канала с правом публикации.`,
        { parse_mode: "HTML" },
      );
    }
    return;
  }

  if (arg.startsWith("channel ")) {
    let v = arg.slice(8).trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
    if (!/^-?\d+$/.test(v)) v = `@${v}`;
    try {
      await ctx.api.getChat(v);
    } catch (e) {
      return ctx.reply(`❌ Нет доступа к <code>${esc(v)}</code>\n\n<code>${esc((e as Error).message.slice(0, 150))}</code>`, { parse_mode: "HTML" });
    }
    await db.setting.upsert({ where: { key: "promo_post_channel" }, create: { key: "promo_post_channel", valueRu: v }, update: { valueRu: v } });
    return ctx.reply(`✅ Канал для промо-поста: <code>${esc(v)}</code>`, { parse_mode: "HTML" });
  }

  // Default: preview. Same text, same button, sent only to the admin.
  const channel = (await setting("promo_post_channel", "")).trim()
    || (await db.requiredChannel.findFirst({ where: { isActive: true } }))?.chatId
    || "— не задан —";
  await ctx.reply("👀 <b>Так пост будет выглядеть в канале:</b>", { parse_mode: "HTML" });
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } })
    .catch(async (e) => {
      await ctx.reply(`⚠️ Текст не отправился — вероятно, сломана HTML-разметка:\n<code>${esc((e as Error).message.slice(0, 200))}</code>`, { parse_mode: "HTML" });
    });
  await ctx.reply(
    `Канал: <code>${esc(channel)}</code>\n\n` +
    `<b>Опубликовать:</b> <code>/promopost send</code>\n` +
    `<b>Сменить канал:</b> <code>/promopost channel @nomi</code>\n` +
    `<b>Изменить текст:</b> админ-панель → Тексты и меню бота`,
    { parse_mode: "HTML" },
  );
});

// Admin: /review — configure and preview the post-purchase review prompt.
// Off by default: nothing reaches a customer until it has been previewed here.
bot.command("review", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.match ?? "").trim();
  const save = (key: string, valueRu: string) =>
    db.setting.upsert({ where: { key }, create: { key, valueRu }, update: { valueRu } });

  if (arg === "on" || arg === "off") {
    const cfg = await reviewConfig();
    if (arg === "on" && !cfg.url) {
      return ctx.reply("❌ Сначала укажите ссылку:\n<code>/review url https://instagram.com/reel/...</code>", { parse_mode: "HTML" });
    }
    await save("review_enabled", arg === "on" ? "1" : "0");
    return ctx.reply(arg === "on"
      ? "✅ Просьба об отзыве включена — придёт клиенту после успешной выдачи."
      : "⏸ Просьба об отзыве выключена.");
  }

  if (arg.startsWith("url ")) {
    const url = arg.slice(4).trim();
    if (!/^https?:\/\//i.test(url)) return ctx.reply("❌ Ссылка должна начинаться с https://");
    await save("review_url", url);
    return ctx.reply(`✅ Ссылка сохранена:\n<code>${esc(url)}</code>\n\nПосмотреть: <code>/review</code>`, { parse_mode: "HTML" });
  }

  if (arg.startsWith("reward ")) {
    const n = Math.max(0, Math.trunc(Number(arg.slice(7).trim()) || 0));
    await save("review_reward", String(n));
    return ctx.reply(n > 0
      ? `✅ За отзыв обещаем +${n} реферал.\n\nНачисляете вы вручную после проверки — бот только присылает заявку.`
      : "✅ Награда отключена — просьба будет без обещания подарка.");
  }

  // Default: status + preview exactly as the customer receives it.
  const cfg = await reviewConfig();
  const enabledRaw = await setting("review_enabled", "0");
  await ctx.reply(
    `📸 <b>Просьба об отзыве</b>\n\n` +
    `Статус: ${enabledRaw === "1" ? "✅ включена" : "⏸ выключена"}\n` +
    `Ссылка: ${cfg.url ? `<code>${esc(cfg.url)}</code>` : "<i>не задана</i>"}\n` +
    `Награда: ${cfg.reward > 0 ? `+${cfg.reward} реф.` : "нет"}\n` +
    `Частота: не чаще раза в ${REVIEW_COOLDOWN_DAYS} дней на человека\n\n` +
    `<code>/review url &lt;ссылка&gt;</code>\n` +
    `<code>/review reward 1</code> — обещать +1 реферал (0 = без награды)\n` +
    `<code>/review on</code> / <code>/review off</code>`,
    { parse_mode: "HTML" },
  );

  await ctx.reply(
    `👇 <b>Шаг 1</b> — так выглядит выдача товара.\nПросьба об отзыве придёт только после нажатия «Я получил»:`,
    { parse_mode: "HTML" },
  );
  await ctx.reply(
    `${t("ru", "order_paid", { id: 1234 })}\n\nCanva Pro — 1 год\n${t("ru", "charged", { v: money(50000, "ru") })}\n\n` +
    `${t("ru", "your_goods")}\n<code>login:password</code>`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text(t("ru", "btn_got_it"), "noop").row()
        .text(t("ru", "to_shop"), "noop"),
    },
  ).catch(() => {});

  await ctx.reply("👇 <b>Шаг 2</b> — что придёт после нажатия:", { parse_mode: "HTML" });
  const { body } = reviewMessage("ru", cfg.reward);
  const kb = new InlineKeyboard()
    .url(t("ru", "review_btn_open"), cfg.url || "https://example.com").row()
    .text(t("ru", "review_btn_done"), "noop").row();
  await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }).catch(() => {});
});

// Admin: /reftest — everything needed to verify the referral flow by hand:
// the live preconditions, both notification messages as they really render,
// and the exact steps to walk through with a second account.
bot.command("reftest", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const me = await bot.api.getMe();
  const adminId = String(ctx.from!.id);
  const refsOn = await isReferralsEnabled();
  const channels = await db.requiredChannel.findMany({ where: { isActive: true } });

  // Preconditions first — a failing one explains "рефералы не работают" on its
  // own, before any manual testing.
  const checks: string[] = [];
  checks.push(refsOn ? "✅ Реферальная программа включена" : "❌ Реферальная программа ВЫКЛЮЧЕНА — включите в админ-панели");
  if (channels.length === 0) {
    checks.push("⚠️ Обязательных каналов нет — реферал засчитывается сразу после /start");
  } else {
    for (const ch of channels) {
      try {
        const m = await ctx.api.getChatMember(ch.chatId, me.id);
        const ok = m.status === "administrator" || m.status === "creator";
        checks.push(ok
          ? `✅ Бот админ в «${esc(ch.name)}» — подписка засчитается автоматически`
          : `❌ Бот НЕ админ в «${esc(ch.name)}» — засчитается только по кнопке «Проверить подписку»`);
      } catch {
        checks.push(`❌ Нет доступа к «${esc(ch.name)}» — проверьте, что бот добавлен в канал`);
      }
    }
  }

  await ctx.reply(
    `🧪 <b>ТЕСТ РЕФЕРАЛЬНОЙ СИСТЕМЫ</b>\n\n` +
    `<b>Проверка настроек:</b>\n${checks.join("\n")}\n\n` +
    `<b>Ваша ссылка для теста:</b>\n<code>https://t.me/${me.username}?start=ref${adminId}</code>`,
    { parse_mode: "HTML" },
  );

  // Show the two messages exactly as a real referrer receives them.
  await ctx.reply("👇 <b>Так выглядят уведомления, которые придут пригласившему:</b>", { parse_mode: "HTML" });
  await ctx.reply(t("ru", "ref_pending_notify", { name: "Ja•••••r" }), { parse_mode: "HTML" }).catch(() => {});
  await ctx.reply(
    t("ru", "ref_counted_notify", { name: "Ja•••••r", n: 3 }),
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(t("ru", "btn_freebies"), "gifts_show") },
  ).catch(() => {});

  await ctx.reply(
    `📋 <b>Как протестировать по-настоящему</b>\n\n` +
    `Нужен <b>второй Telegram-аккаунт</b> — по своей же ссылке реферал не засчитается, ` +
    `и вы как админ проходите мимо проверки подписки.\n\n` +
    `<b>1.</b> Со второго аккаунта откройте ссылку выше и нажмите «Старт»\n` +
    `   → сюда придёт «По вашей ссылке зашёл человек»\n\n` +
    `<b>2.</b> НЕ подписывайтесь на канал, проверьте: <code>/refinfo ${adminId}</code>\n` +
    `   → в списке он будет помечен ⏳ «НЕ подписан», очко не начислено\n\n` +
    `<b>3.</b> Теперь подпишитесь на канал со второго аккаунта\n` +
    `   → сюда придёт «+1 реферал засчитан»\n\n` +
    `<b>4.</b> Проверьте снова: <code>/refinfo ${adminId}</code>\n` +
    `   → пометка сменится на ✅, очко появится\n\n` +
    `<b>Убрать следы теста:</b>\n` +
    `<code>/unref &lt;id второго аккаунта&gt;</code> — отвязать\n` +
    `<code>/refgive ${adminId} -1</code> — отнять тестовое очко`,
    { parse_mode: "HTML" },
  );
});

// Admin: /channels — is automatic crediting actually possible right now?
// Telegram only delivers chat_member updates to a bot that is an ADMIN of the
// channel with permission to see members. Without that the bot cannot notice a
// subscription on its own and the user has to tap "Проверить подписку" — which
// looks exactly like "рефералы не начисляются". This reports the truth.
bot.command("channels", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const channels = await db.requiredChannel.findMany({ orderBy: { id: "asc" } });
  if (channels.length === 0) {
    return ctx.reply("📢 Обязательных каналов нет.\n\nПодписка ни у кого не требуется — рефералы засчитываются сразу после /start.");
  }

  const me = await ctx.api.getMe();
  const L: string[] = ["📢 <b>ОБЯЗАТЕЛЬНЫЕ КАНАЛЫ</b>", ""];
  let autoOk = true;

  for (const ch of channels) {
    L.push(`<b>${esc(ch.name)}</b>`);
    L.push(`chatId: <code>${ch.chatId}</code>`);
    L.push(`Статус: ${ch.isActive ? "✅ активен" : "⏸ выключен"}`);
    if (!ch.isActive) { L.push(``); continue; }

    try {
      const member = await ctx.api.getChatMember(ch.chatId, me.id);
      const isAdminThere = member.status === "administrator" || member.status === "creator";
      if (isAdminThere) {
        L.push(`Бот в канале: ✅ администратор`);
        L.push(`Автозачёт при подписке: ✅ работает`);
      } else {
        autoOk = false;
        L.push(`Бот в канале: ⚠️ <b>НЕ администратор</b> (${esc(member.status)})`);
        L.push(`Автозачёт при подписке: ❌ <b>НЕ работает</b>`);
      }
    } catch (e) {
      autoOk = false;
      L.push(`Бот в канале: ❌ <b>нет доступа</b>`);
      L.push(`Ошибка: <code>${esc((e as Error).message.slice(0, 120))}</code>`);
      L.push(`Автозачёт при подписке: ❌ <b>НЕ работает</b>`);
    }
    L.push(``);
  }

  if (autoOk) {
    L.push(`✅ <b>Всё настроено верно.</b>`);
    L.push(`Человек подписывается — реферал засчитывается автоматически,`);
    L.push(`ничего нажимать не нужно.`);
  } else {
    L.push(`🔴 <b>ГЛАВНАЯ ПРИЧИНА «РЕФЕРАЛЫ НЕ НАЧИСЛЯЮТСЯ»</b>`);
    L.push(``);
    L.push(`Telegram сообщает боту о новых подписчиках только если бот —`);
    L.push(`<b>администратор канала</b>. Сейчас это не так, поэтому подписку`);
    L.push(`бот сам не видит и ждёт нажатия «Проверить подписку».`);
    L.push(``);
    L.push(`<b>Как починить:</b>`);
    L.push(`1. Откройте канал → Управление → Администраторы`);
    L.push(`2. Добавьте @${me.username} администратором`);
    L.push(`3. Достаточно самых базовых прав (без публикации)`);
    L.push(`4. Проверьте снова: <code>/channels</code>`);
    L.push(``);
    L.push(`Потом догоните пропущенных: <code>/reffix</code>`);
  }

  await replyChunked(ctx, L);
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

// Admin: /refzero <tgId|@username> — zero out all available referral points
// Use this BEFORE enabling referrals to freeze fraudulent accumulated points.
// Sets spentReferrals = realRefs + bonusReferrals so available becomes 0.
bot.command("refzero", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.match ?? "").trim().replace(/^@/, "");
  if (!arg) {
    return ctx.reply(
      "Формат: /refzero <tgId или @username>\n\n" +
      "Обнуляет доступные реферальные очки пользователя.\n" +
      "Используйте перед включением рефералок чтобы заморозить накрученные очки мошенников.",
    );
  }

  const u = await db.botUser.findFirst({
    where: isNaN(Number(arg)) ? { username: arg } : { tgId: arg },
  });
  if (!u) return ctx.reply(`❌ Не найден: ${arg}`);

  const realRefs = await countVerifiedRefs(u.tgId);
  const total = realRefs + (u.bonusReferrals ?? 0);
  const wasAvailable = Math.max(0, total - (u.spentReferrals ?? 0));

  // Freeze all points: spentReferrals = total → available = 0
  await db.botUser.update({
    where: { id: u.id },
    data: { spentReferrals: total },
  });

  await ctx.reply(
    `✅ <b>Очки обнулены</b>\n\n` +
    `👤 ${esc(u.firstName ?? "—")} @${u.username ?? u.tgId}\n` +
    `ID: <code>${u.tgId}</code>\n\n` +
    `Приглашённых: ${realRefs}\n` +
    `Бонусов от админа: ${u.bonusReferrals ?? 0}\n` +
    `Было доступно: <b>${wasAvailable}</b>\n` +
    `Теперь доступно: <b>0</b>\n\n` +
    `(spentReferrals установлен в ${total})`,
    { parse_mode: "HTML" },
  );
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

// Admin: /auditfraud — dump all referral/free orders for the 4 suspect accounts as a .txt file
bot.command("auditfraud", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply("🔍 Запрашиваю базу данных, подождите...");

  const TARGETS = ["wasd006", "KhayrulloyevAzizbek", "evgeniy1009", "Kamolbek_uz"];

  const lines: string[] = [];
  lines.push("=== АУДИТ БЕСПЛАТНЫХ ЗАКАЗОВ ===");
  lines.push(`Дата: ${new Date().toISOString()}`);
  lines.push("Подозреваемые: " + TARGETS.map((u) => "@" + u).join(", "));
  lines.push("=".repeat(60));
  lines.push("");

  for (const username of TARGETS) {
    const user = await db.botUser.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
    }).catch(() => null);

    lines.push(`━━━ @${username} ━━━`);

    if (!user) {
      lines.push("  ❌ Пользователь не найден в базе.");
      lines.push("");
      continue;
    }

    const [totalRefs, verifiedRefs] = await Promise.all([
      db.botUser.count({ where: { referredBy: user.tgId } }).catch(() => 0),
      countVerifiedRefs(user.tgId).catch(() => 0),
    ]);

    lines.push(`  tgId:        ${user.tgId}`);
    lines.push(`  Имя:         ${user.firstName ?? "—"}`);
    lines.push(`  Переходов:   ${totalRefs} чел.`);
    lines.push(`  Засчитано:   ${verifiedRefs} чел. (подписались)`);
    lines.push(`  Бонус:       ${user.bonusReferrals ?? 0}`);
    lines.push(`  Потрачено:   ${user.spentReferrals ?? 0}`);
    lines.push(`  Рег:         ${user.createdAt?.toISOString() ?? "—"}`);
    lines.push("");

    const freeOrders = await db.botOrder.findMany({
      where: {
        userId: user.id,
        OR: [{ source: "referral" }, { priceUsdt: 0 }],
        status: { in: ["delivered", "awaiting_delivery"] },
      },
      orderBy: { id: "asc" },
    }).catch(() => []);

    if (freeOrders.length === 0) {
      lines.push("  Бесплатных заказов: нет");
    } else {
      lines.push(`  Бесплатных заказов: ${freeOrders.length}`);
      lines.push("");
      for (const o of freeOrders) {
        lines.push(`  Заказ #${o.id}  |  ${o.titleRu}  |  source=${o.source}`);
        lines.push(`  ${o.payload}`);
        lines.push("");
      }
    }
    lines.push("");
  }

  lines.push("=".repeat(60));
  lines.push("Конец отчёта.");

  const content = lines.join("\n");
  const buf = Buffer.from(content, "utf-8");
  const file = new InputFile(buf, `audit_${Date.now()}.txt`);

  await ctx.replyWithDocument(file, { caption: "📋 Аудит бесплатных заказов" }).catch(async (e) => {
    // fallback: send as text chunks
    const CHUNK = 4000;
    for (let i = 0; i < content.length; i += CHUNK) {
      await ctx.reply("<pre>" + esc(content.slice(i, i + CHUNK)) + "</pre>", { parse_mode: "HTML" }).catch(() => {});
    }
  });
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
  // Refuse to hand out a Premium/Stars order twice. COMPLETED is terminal, so
  // a second /give on the same order is a mistake worth stopping, not repeating.
  if (order.deliveryState === "COMPLETED") {
    return ctx.reply(`⚠️ Заказ #${orderId} уже отмечен как выданный (${order.deliveredAt?.toLocaleString("ru-RU") ?? "—"}).\n\nЕсли нужно выдать повторно осознанно — скажите, сниму отметку.`);
  }
  await db.botOrder.update({
    where: { id: orderId },
    data: { payload: text, ...closeDeliveryPatch(order) },
  });
  const ulang = order.user.lang;
  // A Stars / Premium order has no credentials to hand over — the goods went
  // to a Telegram account. Showing "Ваш товар: выдано" would read as nonsense,
  // so confirm the destination instead.
  const body = order.targetUsername
    ? `✅ <b>${esc(order.titleRu)}</b>\n\n${t(ulang, "uname_for")}: <b>@${esc(order.targetUsername)}</b>\n\nПроверьте свой аккаунт 🎉`
    : `🎁 ${t(ulang, "your_goods")}\n<code>${esc(text)}</code>\n\n${esc(order.titleRu)}`;
  await bot.api.sendMessage(
    order.user.tgId,
    body,
    {
      parse_mode: "HTML",
      // A hand-delivered order is a real delivery — same confirmation button,
      // so these customers reach the review prompt too.
      reply_markup: new InlineKeyboard()
        .text(t(ulang, "btn_got_it"), "got").row()
        .text(t(ulang, "to_shop"), "m:0:all"),
    },
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
// ---------- background broadcast ----------
// Send to every user WITHOUT freezing the bot. The old broadcast blasted ~28
// msg/s, which nearly maxes Telegram's ~30/s bot limit, starving live traffic —
// the bot looked frozen for the whole run. This paces at ~18/s (leaving ~12/s
// for live users) and runs detached, editing a status message as it goes.
async function broadcastInBackground(
  ctx: Context,
  send: (tgId: string) => Promise<void>,
  label: string,
  usersOverride?: Array<{ tgId: string }>,
) {
  const users = usersOverride ?? await db.botUser.findMany({ select: { tgId: true } });
  const total = users.length;
  const statusMsg = await ctx.reply(`📢 ${label}: запуск… (0/${total})`).catch(() => null);
  const chatId = ctx.chat?.id;

  // Detached — the command returns immediately, the bot keeps serving users.
  (async () => {
    let ok = 0, fail = 0;
    const BATCH = 18;
    for (let i = 0; i < users.length; i += BATCH) {
      await Promise.all(users.slice(i, i + BATCH).map(async (u) => {
        try { await send(u.tgId); ok++; } catch { fail++; }
      }));
      // ~18 msg/s — under half the global limit, so replies stay fast.
      await new Promise((r) => setTimeout(r, 1000));
      // Update progress roughly every ~180 sends.
      if (statusMsg && chatId && (i / BATCH) % 10 === 0) {
        await bot.api.editMessageText(chatId, statusMsg.message_id, `📢 ${label}: ${ok + fail}/${total} (✅ ${ok} · ❌ ${fail})`).catch(() => {});
      }
    }
    const done = `📢 ${label} — готово.\n\n✅ Доставлено: <b>${ok}</b>\n❌ Не доставлено: <b>${fail}</b>\nВсего: <b>${total}</b>`;
    if (statusMsg && chatId) await bot.api.editMessageText(chatId, statusMsg.message_id, done, { parse_mode: "HTML" }).catch(() => {});
  })().catch((e) => console.error("[bot] broadcast failed:", (e as Error).message));
}

// ---------- health check ----------
// Bot's own Star balance. Official method (getMyStarBalance, Bot API 9.1);
// returns null if the call fails, so a health check never throws.
async function botStarBalance(): Promise<number | null> {
  try {
    const bal = await bot.api.getMyStarBalance();
    return bal?.amount ?? null;
  } catch (e) {
    console.error("[bot] getMyStarBalance failed:", (e as Error).message);
    return null;
  }
}

bot.command("health", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const dot = (ok: boolean) => (ok ? "🟢" : "🔴");

  let dbOk = true;
  try { await db.$queryRawUnsafe("SELECT 1"); } catch { dbOk = false; }

  const [pendingOrders, failedOrders, manualReview, stars] = await Promise.all([
    db.botOrder.count({ where: { deliveryState: { in: ["PAID", "PROCESSING"] } } }).catch(() => -1),
    db.botOrder.count({ where: { deliveryState: "FAILED" } }).catch(() => -1),
    db.botOrder.count({ where: { deliveryState: "MANUAL_REVIEW" } }).catch(() => -1),
    botStarBalance(),
  ]);

  // How many 3-month gifts the current balance could cover — the number that
  // actually matters before switching delivery to auto.
  const cost3 = premiumStarCost(3)!;
  const starLine = stars === null
    ? "🔴 Star-баланс: недоступен"
    : `⭐ Star-баланс: <b>${stars}</b>` +
      ` (хватит на ~${Math.floor(stars / cost3)} подписок по 3 мес)` +
      (PREMIUM_MIN_STAR_BALANCE > 0 && stars < PREMIUM_MIN_STAR_BALANCE ? "\n⚠️ <b>Ниже порога!</b>" : "");

  await ctx.reply(
    `🩺 <b>Состояние системы</b>\n\n` +
    `${dot(true)} Telegram Bot\n` +
    `${dot(dbOk)} База данных\n` +
    `${dot(paymeReady())} Payme\n` +
    `${dot(clickReady())} Click\n` +
    `${dot(true)} Telegram Stars (оплата)\n` +
    `${PREMIUM_DELIVERY_MODE === "auto" ? "🟢" : "🟡"} Выдача Premium: <b>${PREMIUM_DELIVERY_MODE}</b>` +
    `${PREMIUM_DELIVERY_MODE === "manual" ? " (автовыдача выключена)" : ""}\n` +
    `🟡 Выдача Stars: <b>manual</b> (только вручную)\n\n` +
    `${starLine}\n\n` +
    `📦 Ожидают выдачи: <b>${pendingOrders}</b>\n` +
    `❌ Ошибок: <b>${failedOrders}</b>\n` +
    `🔍 Ручная проверка: <b>${manualReview}</b>`,
    { parse_mode: "HTML" },
  ).catch(() => {});
});

// ---------- limited-time promo broadcast ----------
// Temporarily drops a variant's price, blasts an Uzbek offer with a one-tap buy
// button, and auto-restores the price after N hours (checkPromoExpiry, on the
// delivery interval). The buy button is `bc:` — straight to the pay screen.
type PromoDraft = {
  variantId: number;
  name: string;
  originalPrice: number;
  price: number;
  hours: number;
  sendBroadcast: boolean;
  publishChannel: boolean;
};
const promoDraft = new Map<string, PromoDraft>();

async function getPromoChannel(): Promise<string> {
  const custom = (await setting("promo_post_channel", "")).trim();
  if (custom) return custom;
  const req = await db.requiredChannel.findFirst({ where: { isActive: true } });
  return req?.chatId?.trim() ?? "";
}

async function buildPromoSetupView(draft: PromoDraft) {
  const pct = draft.originalPrice > draft.price ? Math.round(((draft.originalPrice - draft.price) / draft.originalPrice) * 100) : 0;
  const channel = await getPromoChannel();
  const channelDisplay = channel ? channel : "— не задан —";

  const text =
    `⚙️ <b>Настройка параметров акции</b>\n\n` +
    `📦 <b>Товар:</b> ${esc(draft.name)}\n` +
    `💰 <b>Цена со скидкой:</b> <s>${money(draft.originalPrice, "ru")}</s> → <b>${money(draft.price, "ru")}</b> (−${pct}%)\n` +
    `⏱ <b>Длительность:</b> <b>${draft.hours} ч.</b>\n\n` +
    `<b>Параметры отправки:</b>\n` +
    `• 📢 <b>Пост в канал:</b> ${draft.publishChannel ? `✅ <b>ВКЛ</b> (<code>${esc(channelDisplay)}</code>)` : "❌ <b>ВЫКЛ</b>"}\n` +
    `• 👥 <b>Рассылка всем в ЛС:</b> ${draft.sendBroadcast ? "✅ <b>ВКЛ</b> (каждый получит в ЛС)" : "❌ <b>ВЫКЛ</b> (только скидка в магазине)"}\n\n` +
    `<i>Нажимайте кнопки ниже, чтобы включить/выключить отправку:</i>`;

  const kb = new InlineKeyboard()
    .text(`📢 Канал: ${draft.publishChannel ? "✅ ВКЛ" : "❌ ВЫКЛ"}`, "promo_tgl_chan").row()
    .text(`👥 Рассылка в ЛС: ${draft.sendBroadcast ? "✅ ВКЛ" : "❌ ВЫКЛ"}`, "promo_tgl_bc").row()
    .text("🚀 Запустить акцию", "promo_send").row()
    .text("❌ Отмена", "promo_cancel");

  return { text, kb };
}

// `left` is the real remaining stock, or null when there is plenty (or when the
// item is bought on demand and has no warehouse at all). It is measured once
// before the broadcast rather than per recipient — and it is never invented.
function promoMessage(name: string, oldPrice: number, newPrice: number, hours: number, variantId: number, left: number | null = null): { text: string; kb: InlineKeyboard } {
  const pct = oldPrice > newPrice ? Math.round((oldPrice - newPrice) / oldPrice * 100) : 0;
  // Brand premium emoji (e.g. 🤖 for Gemini) instead of a generic 💎.
  const pe = giftPremiumEmoji(name);
  const brand = pe ? `<tg-emoji emoji-id="${pe}">💎</tg-emoji>` : "💎";
  const kb = new InlineKeyboard().text(`🛒 Ulgurib qoling −${pct}%`, `b:${variantId}:0:all`);
  const text =
    `<tg-emoji emoji-id="${FLASH_PCT_EMOJI}">🔺</tg-emoji> <b>FLASH SALE −${pct}%</b>\n\n` +
    `${brand} <b>${esc(name)}</b>\n` +
    `<s>${money(oldPrice, "uz")}</s> → <b>${money(newPrice, "uz")}</b>\n\n` +
    `<tg-emoji emoji-id="${FLASH_TIME_EMOJI}">⏱</tg-emoji> Chegirma ${hours} soat davom etadi — ulgurib qoling!` +
    (left !== null ? `\n\n${t("uz", "low_stock", { n: left })}` : "");
  return { text, kb };
}

async function showPromoVariantPicker(ctx: Context) {
  const variants = await db.variant.findMany({
    where: { isActive: true, plan: { product: { isActive: true } } },
    include: { plan: { include: { product: true } } },
    orderBy: { id: "asc" },
  });
  if (!variants.length) return ctx.reply("Нет активных товаров.").catch(() => {});
  const kb = new InlineKeyboard();
  for (const v of variants) kb.text(`${v.plan.product.titleRu} — ${v.titleRu} (${money(v.priceUzs, "ru")})`, `promo_v:${v.id}`).row();
  await ctx.reply("🔥 Выберите товар для акции:", { reply_markup: kb }).catch(() => {});
}

bot.command("promo", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const raw = (await setting("promo_active", "")).trim();
  if (raw) {
    try {
      const p = JSON.parse(raw) as { variantId: number; originalPrice: number; expiresAt: number };
      if (Date.now() < p.expiresAt) {
        const v = await db.variant.findUnique({
          where: { id: p.variantId },
          include: { plan: { include: { product: true } } },
        });
        const kb = new InlineKeyboard()
          .text("🛑 Выключить акцию сейчас", "promo_stop").row()
          .text("➕ Запустить другую акцию", "promo_new").row()
          .text("❌ Закрыть", "promo_close");
        const title = v ? `${v.plan.product.titleRu} — ${v.titleRu}` : `Товар #${p.variantId}`;
        return ctx.reply(
          `🔥 <b>Сейчас идёт акция!</b>\n\n` +
          `📦 <b>Товар:</b> ${title}\n` +
          `💰 <b>Цена со скидкой:</b> <s>${money(p.originalPrice, "ru")}</s> → <b>${money(v?.priceUzs ?? 0, "ru")}</b>\n` +
          `⏱ <b>Осталось:</b> ${formatCountdown(p.expiresAt - Date.now())}\n\n` +
          `Вы можете выключить акцию досрочно — цена вернётся на исходную, а сообщение с акцией автоматически удалится у всех пользователей и из канала.`,
          { parse_mode: "HTML", reply_markup: kb },
        ).catch(() => {});
      }
    } catch { /* malformed marker */ }
  }
  return showPromoVariantPicker(ctx);
});

bot.command("promostop", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await stopPromo(true, String(ctx.from?.id));
});

async function sendPromoBroadcast(ctx: Context) {
  const key = String(ctx.from?.id);
  const draft = promoDraft.get(key);
  if (!draft) return ctx.answerCallbackQuery({ text: "Черновик не найден. Начните заново: /promo", show_alert: true }).catch(() => {});
  promoDraft.delete(key);
  await ctx.answerCallbackQuery().catch(() => {});

  // Clean up any previously stored promo broadcast message references before starting a new broadcast
  await db.promoBroadcastMessage.deleteMany().catch(() => {});

  const payload = JSON.stringify({ variantId: draft.variantId, originalPrice: draft.originalPrice, expiresAt: Date.now() + draft.hours * 3600_000 });
  try {
    await db.setting.upsert({ where: { key: "promo_active" }, create: { key: "promo_active", valueRu: payload }, update: { valueRu: payload } });
    await db.variant.update({ where: { id: draft.variantId }, data: { priceUzs: draft.price } });
  } catch (e) {
    console.error(`[bot] promo start failed: variant=${draft.variantId} price=${draft.price} ${(e as Error).message}`);
    // Best effort: put the price back, so a half-applied promo can't linger.
    await db.variant.update({ where: { id: draft.variantId }, data: { priceUzs: draft.originalPrice } }).catch(() => {});
    await db.setting.update({ where: { key: "promo_active" }, data: { valueRu: "" } }).catch(() => {});
    await ctx.editMessageText("❌ Не удалось запустить акцию — цена не изменена, запуск отменен.").catch(() => {});
    return;
  }

  const promoVariant = await db.variant.findUnique({ where: { id: draft.variantId } });
  const promoLeft = promoVariant ? await lowStockLeft(promoVariant, await availableStock(promoVariant)) : null;
  const pct = draft.originalPrice > draft.price ? Math.round(((draft.originalPrice - draft.price) / draft.originalPrice) * 100) : 0;

  let channelSentOk = false;
  let channelError = "";

  // 1. Publish to Telegram Channel if enabled
  if (draft.publishChannel) {
    const channel = await getPromoChannel();
    if (channel) {
      try {
        const botUsername = ctx.me?.username || (await bot.api.getMe()).username;
        const channelKb = new InlineKeyboard().url(`🛒 Ulgurib qoling −${pct}%`, `https://t.me/${botUsername}?start=buy_${draft.variantId}`);
        const { text: chText } = promoMessage(draft.name, draft.originalPrice, draft.price, draft.hours, draft.variantId, promoLeft);
        const sent = await bot.api.sendMessage(channel, chText, {
          parse_mode: "HTML",
          reply_markup: channelKb,
          link_preview_options: { is_disabled: true },
        });
        if (sent?.message_id) {
          await db.promoBroadcastMessage.create({
            data: { tgId: String(channel), messageId: sent.message_id },
          }).catch(() => {});
          channelSentOk = true;
        }
      } catch (err) {
        channelError = (err as Error).message;
        console.error("[bot] failed to post promo to channel:", channelError);
      }
    }
  }

  // 2. Broadcast in DMs to all users if enabled
  if (draft.sendBroadcast) {
    await ctx.editMessageText(
      `✅ <b>Акция запущена!</b>\n\n` +
      `💰 Цена: <b>${money(draft.price, "ru")}</b> (было ${money(draft.originalPrice, "ru")})\n` +
      `⏱ Длительность: <b>${draft.hours} ч.</b>\n` +
      (draft.publishChannel ? (channelSentOk ? `📢 Пост в канал отправлен.\n` : `⚠️ Ошибка отправки в канал: <code>${esc(channelError.slice(0, 100))}</code>\n`) : "") +
      `\n👥 Рассылаю пользователям… По окончании акции все сообщения будут автоматически удалены.`,
      { parse_mode: "HTML" },
    ).catch(() => {});

    await broadcastInBackground(ctx, async (tgId) => {
      const { text, kb } = promoMessage(draft.name, draft.originalPrice, draft.price, draft.hours, draft.variantId, promoLeft);
      const sent = await bot.api.sendMessage(tgId, text, { parse_mode: "HTML", reply_markup: kb });
      if (sent?.message_id) {
        await db.promoBroadcastMessage.create({
          data: { tgId: String(tgId), messageId: sent.message_id },
        }).catch(() => {});
      }
    }, "Акция");
  } else {
    // Silent promo (discount in catalog only + optional channel post)
    await ctx.editMessageText(
      `✅ <b>Акция запущена без рассылки в ЛС!</b>\n\n` +
      `💰 Скидка активирована в магазине: <b>${money(draft.price, "ru")}</b> (было ${money(draft.originalPrice, "ru")})\n` +
      `⏱ Длительность: <b>${draft.hours} ч.</b>\n` +
      (draft.publishChannel
        ? (channelSentOk
            ? `📢 <b>Пост опубликован в канал</b> (будет автоматически удалён по окончании).\n`
            : `⚠️ Не удалось отправить в канал: <code>${esc(channelError.slice(0, 100))}</code>\n`)
        : `📢 Пост в канал: выключен.\n`) +
      `\n🛍 Пользователи увидят скидку при открытии магазина. По окончании акции цена вернётся автоматически.`,
      { parse_mode: "HTML" },
    ).catch(() => {});
  }
}

let promoCleanupInProgress = false;

function cleanupPromoMessages(notifyChatId?: string) {
  if (promoCleanupInProgress) return;
  promoCleanupInProgress = true;

  (async () => {
    try {
      const messages = await db.promoBroadcastMessage.findMany();
      if (!messages.length) return;

      let deleted = 0;
      let failed = 0;
      const BATCH = 20;

      for (let i = 0; i < messages.length; i += BATCH) {
        const chunk = messages.slice(i, i + BATCH);
        await Promise.all(
          chunk.map(async (m) => {
            try {
              await bot.api.deleteMessage(m.tgId, m.messageId);
              deleted++;
            } catch {
              failed++;
            }
          }),
        );
        await new Promise((r) => setTimeout(r, 1000));
      }

      await db.promoBroadcastMessage.deleteMany().catch(() => {});

      if (notifyChatId) {
        await bot.api.sendMessage(
          notifyChatId,
          `✅ <b>Очистка промо-сообщений завершена!</b>\n\n` +
          `🗑 Удалено сообщений: <b>${deleted}</b>` +
          (failed > 0 ? `\n⚠️ Не требовалось удалять / недоступно: <b>${failed}</b>` : "") +
          `\nВсего было в рассылке: <b>${messages.length}</b>`,
          { parse_mode: "HTML" },
        ).catch(() => {});
      }
    } catch (err) {
      console.error("[bot] cleanupPromoMessages error:", (err as Error).message);
    } finally {
      promoCleanupInProgress = false;
    }
  })().catch(() => {
    promoCleanupInProgress = false;
  });
}

// Stop the active promo (either manually by admin or when timer expires).
// Restores original price, clears marker, and deletes all sent promo messages.
async function stopPromo(triggeredByAdmin = false, adminTgId?: string) {
  const raw = (await setting("promo_active", "")).trim();
  if (!raw) {
    const orphanCount = await db.promoBroadcastMessage.count().catch(() => 0);
    if (orphanCount > 0) {
      cleanupPromoMessages(adminTgId || ADMIN_ID);
      if (adminTgId) {
        await bot.api.sendMessage(adminTgId, `🧹 Найдено ${orphanCount} старых промо-сообщений. Удаляю у пользователей…`).catch(() => {});
      }
      return;
    }
    if (triggeredByAdmin && adminTgId) {
      await bot.api.sendMessage(adminTgId, "ℹ️ Сейчас нет активной акции.").catch(() => {});
    }
    return;
  }

  let p: { variantId: number; originalPrice: number; expiresAt: number } | null = null;
  try {
    p = JSON.parse(raw);
  } catch {
    await db.setting.update({ where: { key: "promo_active" }, data: { valueRu: "" } }).catch(() => {});
    cleanupPromoMessages(adminTgId || ADMIN_ID);
    return;
  }

  if (!p) return;

  // Restore the price first and clear the marker only if that succeeded.
  try {
    await db.variant.update({ where: { id: p.variantId }, data: { priceUzs: p.originalPrice } });
  } catch (e) {
    console.error(`[bot] promo stop price restore failed, will retry: variant=${p.variantId} ${(e as Error).message}`);
    return;
  }

  await db.setting.update({ where: { key: "promo_active" }, data: { valueRu: "" } }).catch(() => {});

  const notifyChatId = adminTgId || ADMIN_ID;
  const reasonText = triggeredByAdmin ? "🛑 <b>Акция выключена досрочно</b>" : "⏱ <b>Время акции истекло</b>";

  if (notifyChatId) {
    await bot.api.sendMessage(
      notifyChatId,
      `${reasonText}\n\n` +
      `Цена товара возвращена на <b>${money(p.originalPrice, "ru")}</b>.\n` +
      `🧹 Удаляю промо-сообщения у всех пользователей…`,
      { parse_mode: "HTML" },
    ).catch(() => {});
  }

  cleanupPromoMessages(notifyChatId);
}

// Restore the promo price and delete messages once the timer runs out (called on the delivery tick).
async function checkPromoExpiry() {
  const raw = (await setting("promo_active", "")).trim();
  if (!raw) return;
  try {
    const p = JSON.parse(raw) as { variantId: number; originalPrice: number; expiresAt: number };
    if (Date.now() < p.expiresAt) return;
    await stopPromo(false);
  } catch { /* malformed marker — ignore */ }
}


// ---------- review request to buyers only ----------
// One-off broadcast of the review ask, targeted to users who have at least one
// order (bought or received free). Each gets it in their own language.
async function buyerTgLangs(): Promise<Array<{ tgId: string; lang: string }>> {
  const rows = await db.botOrder.findMany({ distinct: ["userId"], select: { userId: true } });
  const ids = rows.map((r) => r.userId);
  if (!ids.length) return [];
  return db.botUser.findMany({ where: { id: { in: ids } }, select: { tgId: true, lang: true } });
}

bot.command("askreview", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const cfg = await reviewConfig();
  if (!cfg.url) return ctx.reply("❌ Сначала укажите ссылку на отзыв:\n<code>/review url https://...</code>", { parse_mode: "HTML" }).catch(() => {});
  const buyers = await buyerTgLangs();
  const { body } = reviewMessage("ru", cfg.reward);
  const previewKb = new InlineKeyboard().url(t("ru", "review_btn_open"), cfg.url).row().text(t("ru", "review_btn_done"), "rev:done");
  await ctx.reply("👇 Так увидят покупатели (каждый на своём языке):").catch(() => {});
  await ctx.reply(body, { parse_mode: "HTML", reply_markup: previewKb, link_preview_options: { is_disabled: true } }).catch(() => {});
  const ctrlKb = new InlineKeyboard().text(`📢 Отправить покупателям (${buyers.length})`, "askrev_send").row().text("❌ Отмена", "askrev_cancel");
  await ctx.reply(`Получат только те, кто покупал или получал бесплатно: <b>${buyers.length}</b> чел. Отправить?`, { parse_mode: "HTML", reply_markup: ctrlKb }).catch(() => {});
});

async function sendReviewToBuyers(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => {});
  const cfg = await reviewConfig();
  if (!cfg.url) return ctx.reply("❌ Ссылка не задана: /review url ...").catch(() => {});
  const buyers = await buyerTgLangs();
  const langByTg = new Map(buyers.map((b) => [b.tgId, b.lang]));
  await ctx.editMessageText(`📢 Отправляю просьбу об отзыве ${buyers.length} покупателям…`).catch(() => {});
  await broadcastInBackground(ctx, async (tgId) => {
    const lang = normalizeLang(langByTg.get(tgId) ?? "ru");
    const { body } = reviewMessage(lang, cfg.reward);
    const kb = new InlineKeyboard().url(t(lang, "review_btn_open"), cfg.url).row().text(t(lang, "review_btn_done"), "rev:done");
    await bot.api.sendMessage(tgId, body, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
  }, "Просьба об отзыве", buyers);
}

// ---------- bank poll ----------
// Premium-emoji ids supplied by the admin, one per bank. The base emoji is the
// fallback if a premium one ever becomes invalid (the API transformer strips it).
const BANK_POLL: Array<{ key: string; label: string; emoji: string; premium: string; style: "primary" | "success" | "danger" }> = [
  // PAYNET and Uzum premium ids were swapped — 🍇 (grape) belongs to Uzum.
  // `style` is the button colour; Telegram only offers primary/success/danger
  // (blue/green/red), so exact brand colours (purple, light blue) aren't
  // possible — the premium emoji carries each bank's identity instead.
  { key: "payme", label: "Payme", emoji: "💳", premium: "5204128408463744787", style: "primary" as const },
  { key: "click", label: "Click", emoji: "⭐️", premium: "5350345287246311562", style: "primary" as const },
  { key: "paynet", label: "PAYNET", emoji: "🟢", premium: "5474339588627509561", style: "success" as const },
  { key: "uzum", label: "Uzum Bank", emoji: "🍇", premium: "5281003701677334497", style: "primary" as const },
];
const BANK_KEYS = new Set(BANK_POLL.map((b) => b.key));
// vote:<key> → button colour, read by styleFor() in the API transformer.
const BANK_STYLE = new Map(BANK_POLL.map((b) => [`vote:${b.key}`, b.style]));

// Premium (animated) emoji for the poll header and the arrow, supplied by admin.
const POLL_HEADER_EMOJI = { emoji: "⭐️", id: "5359512328003941083" };
const POLL_ARROW_EMOJI = { emoji: "⬇️", id: "5771449161123631882" };

function pollMessage(): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const b of BANK_POLL) kb.text(b.label, `vote:${b.key}`).icon(b.premium).row();
  const head = emojiIcon(POLL_HEADER_EMOJI.emoji, POLL_HEADER_EMOJI.id);
  const arrow = emojiIcon(POLL_ARROW_EMOJI.emoji, POLL_ARROW_EMOJI.id);
  const text =
    `${head} <b>Qaysi bankdan ko'proq foydalanasiz?</b>\n\n` +
    `Xizmatimizni yanada qulay qilishga yordam bering — quyidan o'zingizga mosini tanlang ${arrow}\n\n` +
    `<i>Ovozingizni istalgan vaqtda o'zgartirishingiz mumkin.</i>`;
  return { text, kb };
}

// Admin: /poll — preview the poll (sent only to the admin, to check the buttons).
bot.command("poll", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { text, kb } = pollMessage();
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }).catch(() => {});
  await ctx.reply(
    "👆 Так опрос увидят пользователи. Проверьте кнопки (нажмите — засчитается ваш голос).\n\n" +
    "Когда всё ок — разошлите всем: <code>/pollsend</code>\n" +
    "Статистика: админ-панель → «Опрос».",
    { parse_mode: "HTML" },
  ).catch(() => {});
});

// Admin: /pollsend — broadcast the poll to everyone, in the background.
bot.command("pollsend", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { text, kb } = pollMessage();
  await broadcastInBackground(
    ctx,
    (tgId) => bot.api.sendMessage(tgId, text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }).then(() => {}),
    "Опрос",
  );
});

// Set the shop banner from the phone: /banner, then send a photo or video.
bot.command("banner", async (ctx) => {
  if (!isAdmin(ctx)) return;
  pending.set(String(ctx.from?.id), { type: "set_banner" });
  await ctx.reply("🖼 Пришлите новое <b>фото или видео</b> для баннера магазина одним сообщением.", { parse_mode: "HTML" }).catch(() => {});
});
// Reset the banner back to the built-in default (drops the admin-set file_id).
bot.command("banner_reset", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await db.setting.upsert({ where: { key: "shop_banner_file_id" }, create: { key: "shop_banner_file_id", valueRu: "" }, update: { valueRu: "" } }).catch(() => {});
  await ctx.reply("♻️ Баннер сброшен на стандартный.").catch(() => {});
});
// Preview the terms screen exactly as users see it (admin already accepted, so
// the gate no longer shows on its own).
bot.command("terms", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const u = await getUser(ctx);
  await sendTermsGate(ctx, u.lang);
});
// Set a per-product video (shown on the product card + on delivery): pick a
// product, then send the video. 🎬 marks products that already have one.
bot.command("pvideo", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const products = await db.product.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" }, select: { id: true, titleRu: true, videoFileId: true } });
  if (!products.length) return ctx.reply("Нет активных товаров.").catch(() => {});
  const kb = new InlineKeyboard();
  for (const p of products) kb.text(`${p.videoFileId ? "🎬 " : ""}${p.titleRu}`, `pvid:${p.id}`).row();
  await ctx.reply("🎬 Выберите товар, чтобы задать видео (🎬 = видео уже есть):", { reply_markup: kb }).catch(() => {});
});

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
  const fromChatId = ctx.chat!.id;
  const replyToId = replyTo?.message_id;
  await broadcastInBackground(
    ctx,
    (tgId) =>
      replyToId
        ? ctx.api.copyMessage(tgId, fromChatId, replyToId).then(() => {})
        : ctx.api.sendMessage(tgId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).then(() => {}),
    "Рассылка",
  );
});

// Admin broadcast: /sendgifts or /postgifts
// Sends the video gift banner + each user's unique referral link & gift buttons to all users
bot.command(["sendgifts", "postgifts"], async (ctx) => {
  if (!isAdmin(ctx)) return;
  // Fail loudly instead of reporting "0 доставлено" for a non-obvious reason.
  if (!(await isReferralsEnabled())) {
    return ctx.reply("⏸ Реферальная программа выключена — рассылка подарков отменена.\n\nВключите её в админ-панели и повторите.");
  }
  if ((await getGiftVariants()).length === 0) {
    return ctx.reply("⚠️ Нет ни одного подарочного товара (pointsCost > 0) — рассылать нечего.");
  }
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
    return ctx.reply(t(lang, "methods_disabled"), {
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

  // Re-check the balance INSIDE the transaction against a fresh row. The check
  // above reads a snapshot taken before this handler ran, so two quick taps
  // could both pass it and debit twice, driving the balance negative.
  const result = await db.$transaction(async (tx) => {
    const already = await tx.methodPurchase
      .findUnique({ where: { methodId_userId: { methodId: id, userId: user.id } } })
      .catch(() => null);
    if (already) return { status: "already" as const };
    const fresh = await tx.botUser.findUnique({ where: { id: user.id } });
    if (!fresh) return { status: "error" as const };
    if (price > 0 && fresh.balance < price) return { status: "funds" as const, balance: fresh.balance };
    if (price > 0) await tx.botUser.update({ where: { id: user.id }, data: { balance: { decrement: price } } });
    await tx.methodPurchase.create({ data: { methodId: id, userId: user.id, pricePaid: price } });
    return { status: "ok" as const };
  }).catch((e) => {
    console.error("[bot] buyMethod tx failed:", (e as Error).message);
    return { status: "error" as const };
  });

  // Only "ok" and "already" mean the user is entitled to the content — a failed
  // charge must never fall through to delivery.
  if (result.status === "funds") {
    return ctx.answerCallbackQuery({
      text: t(lang, "method_need_balance", { v: money(price - result.balance, lang) }),
      show_alert: true,
    }).catch(() => {});
  }
  if (result.status === "error") {
    return ctx.answerCallbackQuery({ text: t(lang, "plan_unavailable"), show_alert: true }).catch(() => {});
  }

  await ctx.answerCallbackQuery({ text: t(lang, "method_delivered") }).catch(() => {});
  return deliverMethod(ctx, lang, m);
}

bot.hears(btnVariants("btn_methods"), (ctx) => showMethods(ctx));
bot.hears(btnVariants("btn_shop"), (ctx) => showMenu(ctx, 0, "all", false));
bot.hears(btnVariants("btn_freebies"), (ctx) => showGifts(ctx));
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
    // Bank poll vote — one changeable vote per user, keyed by tgId. Handled
    // before getUser()/gates so anyone who received the poll can answer.
    if (data.startsWith("vote:")) {
      const choice = data.slice(5);
      const tgId = String(ctx.from?.id ?? "");
      if (!BANK_KEYS.has(choice) || !tgId) return ctx.answerCallbackQuery().catch(() => {});
      await db.botPollVote.upsert({
        where: { tgId },
        create: { tgId, choice },
        update: { choice },
      }).catch(() => {});
      const bank = BANK_POLL.find((b) => b.key === choice);
      return ctx.answerCallbackQuery({ text: `✅ Ваш голос за «${bank?.label ?? choice}» учтён. Спасибо!`, show_alert: false }).catch(() => {});
    }
    if (data === "check_subs") {
      const user = await getUser(ctx);
      const active = await db.requiredChannel.findMany({ where: { isActive: true } });
      const results = await Promise.all(active.map((ch) => isSubscribedTo(ctx, user.tgId, ch.chatId)));
      const unsubscribed = active.filter((_, i) => !results[i]);
      if (unsubscribed.length === 0) {
        subsOkCache.set(user.tgId, Date.now() + SUBS_CACHE_TTL_MS);
        // Subscription confirmed → this is what makes the user count towards
        // their referrer's points.
        await markChannelVerified(user.tgId);
        await ctx.answerCallbackQuery({ text: t(user.lang, "subs_ok_toast"), show_alert: true }).catch(() => {});
        // Remove the gate message instead of leaving it in the chat.
        const gateId = subsGateMsg.get(user.tgId) ?? ctx.callbackQuery.message?.message_id;
        if (gateId) {
          await ctx.api.deleteMessage(user.tgId, gateId).catch(() => {});
          subsGateMsg.delete(user.tgId);
        }
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
    if (data === "got") {
      const user = await getUser(ctx);
      await ctx.answerCallbackQuery({ text: t(user.lang, "got_it_toast") }).catch(() => {});
      // Drop the button so the confirmation reads as done and can't be tapped
      // again; the shop link is re-offered inside the review prompt anyway.
      await ctx.editMessageReplyMarkup({
        reply_markup: new InlineKeyboard().text(t(user.lang, "to_shop"), "m:0:all"),
      }).catch(() => {});
      // Confirmed working → now it's fair to ask. askForReview() still applies
      // its own throttle and the on/off switch, so a second tap changes nothing.
      await askForReview(user);
      return;
    }
    if (data === "rev:done") {
      const user = await getUser(ctx);
      const lang = user.lang;
      if (user.reviewClaimedAt) {
        return ctx.answerCallbackQuery({ text: t(lang, "review_already"), show_alert: true }).catch(() => {});
      }
      await db.botUser.update({ where: { id: user.id }, data: { reviewClaimedAt: new Date() } }).catch(() => {});
      const cfg = await reviewConfig();
      await ctx.answerCallbackQuery({
        text: cfg.reward > 0 ? t(lang, "review_thanks") : t(lang, "review_thanks_plain"),
        show_alert: true,
      }).catch(() => {});
      await ctx.editMessageReplyMarkup().catch(() => {});
      // A claim is a claim, not proof — route it to the admin to verify against
      // the actual comments and reward by hand. Auto-crediting here would be a
      // free-points button.
      if (ADMIN_ID) {
        await bot.api.sendMessage(
          ADMIN_ID,
          `📸 <b>Заявка на отзыв</b>\n\n` +
          `👤 ${esc(user.firstName ?? "—")} @${user.username ?? "—"}\n` +
          `ID: <code>${user.tgId}</code>\n\n` +
          `Проверьте комментарии под видео.\n` +
          (cfg.reward > 0 ? `Начислить: <code>/refgive ${user.tgId} ${cfg.reward}</code>` : `Награда не настроена.`),
          { parse_mode: "HTML" },
        ).catch(() => {});
      }
      return;
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
      // Only termsAcceptedAt here. channelVerifiedAt is deliberately NOT set:
      // this middleware runs before the subscription gate, so an unsubscribed
      // user can reach the terms screen. Stamping verification here would
      // credit their referrer without them ever joining the channel.
      await db.botUser.update({
        where: { id: user.id },
        data: { termsAcceptedAt: new Date() },
      }).catch(() => {});
      await ctx.answerCallbackQuery({ text: t(user.lang, "terms_accepted_toast") }).catch(() => {});
      await ctx.editMessageReplyMarkup().catch(() => {});
      await sendHome(ctx, user);
      // Onboarding is done — deliver what the deep link promised.
      const intent = pendingIntent.get(user.tgId);
      if (intent) {
        pendingIntent.delete(user.tgId);
        if (intent === "gifts") {
          await showGifts(ctx, false).catch(() => {});
        } else if (intent.startsWith("buy_")) {
          const vid = Number(intent.slice(4));
          if (vid > 0) await showQtyChooser(ctx, vid, 1, "0:all", false).catch(() => {});
        } else if (intent.startsWith("p_")) {
          const pid = Number(intent.slice(2));
          if (pid > 0) await showProduct(ctx, pid, "0:all").catch(() => {});
        } else if (intent === "promo") {
          await showMenu(ctx, 0, "all", false).catch(() => {});
        }
      }
      return;
    }
    const user = await getUser(ctx);
    const lang = user.lang;
    if (data === "ord") { const { text, kb } = await ordersView(lang, user.id); await sendOrEdit(ctx, text, { reply_markup: kb }); return ctx.answerCallbackQuery().catch(() => {}); }
    if (data === "ref") { const { text, kb } = referView(ctx, user); await sendOrEdit(ctx, text, { reply_markup: kb }); return ctx.answerCallbackQuery().catch(() => {}); }
    if (data === "topin") return ctx.answerCallbackQuery({ text: t(lang, "topup_retired"), show_alert: true }).catch(() => {});
    if (data === "promo") { pending.set(String(ctx.from?.id), { type: "promo" }); await ctx.answerCallbackQuery().catch(() => {}); return ctx.reply(t(lang, "promo_enter")); }
    if (data === "methods_show") { await ctx.answerCallbackQuery().catch(() => {}); return showMethods(ctx); }
    if (data === "gifts_show") { await ctx.answerCallbackQuery().catch(() => {}); return showGifts(ctx, true, false); }
    if (data === "support_show") { const { text, kb } = await supportView(lang); await sendOrEdit(ctx, text, { reply_markup: kb }); return ctx.answerCallbackQuery().catch(() => {}); }
    if (data === "lang_pick") { await ctx.answerCallbackQuery().catch(() => {}); return showLangPicker(ctx, true); }
    if (data === "profile_show") { const { text, kb } = await profileView(user); await sendOrEdit(ctx, text, { reply_markup: kb }); return ctx.answerCallbackQuery().catch(() => {}); }

    const [tag, ...rest] = data.split(":");
    if (tag === "m") { const page = Number(rest[0]) || 0; const sort = (SORTS.includes(rest[1] as Sort) ? rest[1] : "all") as Sort; await ctx.answerCallbackQuery().catch(() => {}); return showMenu(ctx, page, sort, true); }
    if (tag === "p") return showProduct(ctx, Number(rest[0]), `${Number(rest[1]) || 0}:${rest[2] ?? "all"}`);
    if (tag === "b") return showQtyChooser(ctx, Number(rest[0]), 1, `${rest[1] ?? "0"}:${rest[2] ?? "all"}`, true, true);
    if (tag === "q") return showQtyChooser(ctx, Number(rest[0]), Number(rest[1]) || 1, `${rest[2] ?? "0"}:${rest[3] ?? "all"}`, true);
    if (tag === "qi") { pending.set(String(ctx.from?.id), { type: "qty", variantId: Number(rest[0]), back: `${rest[1] ?? "0"}:${rest[2] ?? "all"}` }); await ctx.answerCallbackQuery().catch(() => {}); return ctx.reply(t(lang, "enter_qty_msg")); }
    if (tag === "bc") return doBuy(ctx, Number(rest[0]), Number(rest[1]) || 1);
    // Recipient confirmed → proceed to payment with it attached.
    if (tag === "un") {
      pending.delete(String(ctx.from?.id));
      const uname = checkUsername(rest[2] ?? "");
      if (!uname.ok) return ctx.answerCallbackQuery({ text: t(lang, "uname_bad_chars"), show_alert: true }).catch(() => {});
      return doBuy(ctx, Number(rest[0]), Number(rest[1]) || 1, uname.username);
    }
    if (tag === "unedit") {
      const v = await db.variant.findUnique({
        where: { id: Number(rest[0]) },
        include: { plan: { include: { product: true } } },
      });
      if (!v) return ctx.answerCallbackQuery().catch(() => {});
      return askTargetUsername(ctx, v, Number(rest[1]) || 1, lang);
    }
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
    // Balance top-ups are retired. Only the *_buy variants below survive: those
    // pay for one specific purchase and fulfil it, they do not credit anything.
    if (["top", "tpayme", "tstar", "tcheck", "tcard", "tman"].includes(tag)) {
      return ctx.answerCallbackQuery({ text: t(lang, "topup_retired"), show_alert: true }).catch(() => {});
    }
    if (tag === "tpayme_buy") return startPaymePayment(ctx, lang, Number(rest[0]), `buy:${rest[1]}:${rest[2]}${rest[3] ? `:${rest[3]}` : ""}`);
    if (tag === "tclick_buy") {
      // Click isn't integrated yet — show the button, but explain until approved.
      if (!clickReady(ctx)) {
        return ctx.answerCallbackQuery({ text: "⏳ Click подключим после одобрения. Пока оплатите через Payme.", show_alert: true }).catch(() => {});
      }
      // TODO(click): build the Click payment URL once merchant creds are set.
      return ctx.answerCallbackQuery({ text: "Click скоро.", show_alert: true }).catch(() => {});
    }
    // rest[3], when present, is the Stars/Premium recipient chosen before payment.
    if (tag === "tcheck_buy") return startReceiptPayment(ctx, lang, Number(rest[0]), `buy:${rest[1]}:${rest[2]}${rest[3] ? `:${rest[3]}` : ""}`);
    // rest[3] = username (may be empty), rest[4] = numeric recipient id. Built
    // via buildBuyNote so the recipient survives the payment round-trip — a
    // hand-built note here used to drop it and deliver to the buyer instead.
    if (tag === "tstar_buy") return starsInvoice(ctx, lang, Number(rest[0]), buildBuyNote(Number(rest[1]), Number(rest[2]) || 1, rest[3] || null, rest[4] || null));
    if (tag === "tman_buy") { await ctx.answerCallbackQuery().catch(() => {}); return requestTopUp(ctx, lang, Number(rest[0]), "manual", `buy:${rest[1]}:${rest[2]}${rest[3] ? `:${rest[3]}` : ""}`); }
    if (tag === "pvid") {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery().catch(() => {});
      pending.set(String(ctx.from?.id), { type: "set_product_video", productId: Number(rest[0]) });
      await ctx.answerCallbackQuery().catch(() => {});
      return ctx.reply("Пришлите видео для этого товара одним сообщением.\nЧтобы убрать видео — напишите: убрать").catch(() => {});
    }
    // Premium recipient: "себе" uses the buyer's own numeric id.
    if (tag === "premself") {
      return doBuy(ctx, Number(rest[0]), Number(rest[1]) || 1, undefined, String(ctx.from!.id));
    }
    // "другому" → native contact picker, which returns the recipient's real id.
    if (tag === "premgift") {
      return askPremiumSharedUser(ctx, Number(rest[0]), Number(rest[1]) || 1, lang);
    }
    if (tag === "starsq") {
      const vid = Number(rest[0]);
      const v = await db.variant.findUnique({ where: { id: vid }, include: { plan: { include: { product: true } } } });
      if (!v || !isVariantBuyable(v)) return ctx.answerCallbackQuery({ text: t(lang, "plan_unavailable"), show_alert: true });
      pending.set(String(ctx.from?.id), { type: "stars_custom_qty", variantId: vid, back: `${rest[1] ?? "0"}:${rest[2] ?? "all"}` });
      await ctx.answerCallbackQuery().catch(() => {});
      const eff = await effPriceFor(user.id, vid, v.priceUzs);
      return ctx.reply(
        t(lang, "stars_custom_ask", { min: STARS_MIN_QUANTITY, max: STARS_MAX_QUANTITY, price: money(eff.price, lang) }),
        { parse_mode: "HTML" },
      ).catch(() => {});
    }
    if (tag === "promo_v") {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery().catch(() => {});
      pending.set(String(ctx.from?.id), { type: "promo_price", variantId: Number(rest[0]) });
      await ctx.answerCallbackQuery().catch(() => {});
      return ctx.reply("Введите цену со скидкой и часы через пробел.\nНапример: <code>35000 1</code> — цена 35000, на 1 час.", { parse_mode: "HTML" }).catch(() => {});
    }
    if (tag === "promo_send") { if (!isAdmin(ctx)) return ctx.answerCallbackQuery().catch(() => {}); return sendPromoBroadcast(ctx); }
    if (tag === "promo_cancel") {
      promoDraft.delete(String(ctx.from?.id));
      await ctx.answerCallbackQuery({ text: "Отменено" }).catch(() => {});
      return ctx.editMessageText("❌ Акция отменена.").catch(() => {});
    }
    if (tag === "promo_tgl_chan") {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery().catch(() => {});
      const key = String(ctx.from?.id);
      const draft = promoDraft.get(key);
      if (!draft) return ctx.answerCallbackQuery({ text: "Черновик не найден. Начните заново: /promo", show_alert: true }).catch(() => {});
      const channel = await getPromoChannel();
      if (!draft.publishChannel && !channel) {
        return ctx.answerCallbackQuery({
          text: "Канал не задан! Укажите его командой: /promopost channel @имя_канала",
          show_alert: true,
        }).catch(() => {});
      }
      draft.publishChannel = !draft.publishChannel;
      promoDraft.set(key, draft);
      await ctx.answerCallbackQuery().catch(() => {});
      const setup = await buildPromoSetupView(draft);
      return ctx.editMessageText(setup.text, { parse_mode: "HTML", reply_markup: setup.kb }).catch(() => {});
    }
    if (tag === "promo_tgl_bc") {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery().catch(() => {});
      const key = String(ctx.from?.id);
      const draft = promoDraft.get(key);
      if (!draft) return ctx.answerCallbackQuery({ text: "Черновик не найден. Начните заново: /promo", show_alert: true }).catch(() => {});
      draft.sendBroadcast = !draft.sendBroadcast;
      promoDraft.set(key, draft);
      await ctx.answerCallbackQuery().catch(() => {});
      const setup = await buildPromoSetupView(draft);
      return ctx.editMessageText(setup.text, { parse_mode: "HTML", reply_markup: setup.kb }).catch(() => {});
    }
    if (tag === "promo_stop") {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery().catch(() => {});
      await ctx.answerCallbackQuery({ text: "Выключаю акцию..." }).catch(() => {});
      await ctx.editMessageText("🛑 Выключаю акцию и запускаю удаление сообщений…").catch(() => {});
      return stopPromo(true, String(ctx.from?.id));
    }
    if (tag === "promo_new") {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery().catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
      return showPromoVariantPicker(ctx);
    }
    if (tag === "promo_close") {
      await ctx.answerCallbackQuery().catch(() => {});
      return ctx.deleteMessage().catch(() => {});
    }
    if (tag === "askrev_send") { if (!isAdmin(ctx)) return ctx.answerCallbackQuery().catch(() => {}); return sendReviewToBuyers(ctx); }
    if (tag === "askrev_cancel") { await ctx.answerCallbackQuery({ text: "Отменено" }).catch(() => {}); return ctx.editMessageText("❌ Отменено.").catch(() => {}); }
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

  if (state.type === "set_product_video") {
    const txt = (ctx.message.text ?? "").trim().toLowerCase();
    if (["убрать", "убери", "удалить", "-", "reset", "o‘chir", "ochirish"].includes(txt)) {
      pending.delete(key);
      await db.product.update({ where: { id: state.productId }, data: { videoFileId: null } }).catch(() => {});
      return ctx.reply("♻️ Видео товара убрано.");
    }
    return ctx.reply("Пришлите видео сообщением, либо напишите: убрать");
  }

  // Username fallback for "gift Premium to someone else". A username is NOT a
  // delivery identifier: we resolve it to a numeric id if that person has used
  // this bot before, otherwise the order still goes through but can only be
  // fulfilled by hand — never auto-delivered on a username alone.
  if (state.type === "premium_pick_user") {
    const picker = await getUser(ctx);
    const res = checkUsername(ctx.message.text ?? "");
    if (!res.ok) {
      pending.set(key, state);
      return ctx.reply(t(picker.lang, `uname_bad_${res.reason}`), { parse_mode: "HTML" });
    }
    pending.delete(key);
    const known = await db.botUser.findFirst({
      where: { username: { equals: res.username, mode: "insensitive" } },
      select: { tgId: true },
    }).catch(() => null);
    await ctx.reply(
      known
        ? `✅ Получатель: @${res.username}`
        : `⚠️ @${res.username} ещё не пользовался ботом, поэтому его ID неизвестен.\n\n` +
          `Заказ оформим, но выдачу подтвердит администратор вручную.`,
      { reply_markup: { remove_keyboard: true } },
    ).catch(() => {});
    return doBuy(ctx, state.variantId, state.qty, res.username, known?.tgId ?? undefined);
  }

  // A freely typed Stars amount. Fragment refuses anything under 50, so the
  // check happens here rather than after the customer has paid.
  if (state.type === "stars_custom_qty") {
    const buyer = await getUser(ctx);
    const typed = Math.floor(Number((ctx.message.text ?? "").replace(/[^\d]/g, "")));
    if (!isValidStarsQuantity(typed)) {
      pending.set(key, state); // keep it, so a typo does not restart the flow
      return ctx.reply(t(buyer.lang, "stars_custom_bad", { min: STARS_MIN_QUANTITY, max: STARS_MAX_QUANTITY }));
    }
    pending.delete(key);
    // The per-star variant is priced for one star, so the ordinary quantity
    // machinery turns this into the right total with no special-case pricing.
    return showQtyChooser(ctx, state.variantId, typed, state.back, false);
  }

  if (state.type === "promo_price") {
    pending.delete(key);
    const parts = (ctx.message.text ?? "").trim().split(/\s+/);
    const price = Math.floor(Number(parts[0]));
    const hours = Math.max(1, Math.floor(Number(parts[1]) || 1));
    if (!Number.isFinite(price) || price <= 0) return ctx.reply("❌ Неверная цена. Пример: <code>35000 1</code>", { parse_mode: "HTML" });
    const v = await db.variant.findUnique({ where: { id: state.variantId }, include: { plan: { include: { product: true } } } });
    if (!v) return ctx.reply("❌ Товар не найден.");
    const name = v.plan.product.titleUz || v.plan.product.titleRu;
    const defaultChannel = await getPromoChannel();
    const draft: PromoDraft = {
      variantId: v.id,
      name,
      originalPrice: v.priceUzs,
      price,
      hours,
      sendBroadcast: true,
      publishChannel: Boolean(defaultChannel),
    };
    promoDraft.set(key, draft);

    const promoLeft = await lowStockLeft(v, await availableStock(v));
    const { text, kb: msgKb } = promoMessage(name, v.priceUzs, price, hours, v.id, promoLeft);
    await ctx.reply("👇 Так будет выглядеть текст предложения (на узбекском):").catch(() => {});
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: msgKb }).catch(() => {});

    const setup = await buildPromoSetupView(draft);
    return ctx.reply(setup.text, { parse_mode: "HTML", reply_markup: setup.kb });
  }

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

  if (state.type === "target_username") {
    const res = checkUsername(ctx.message.text ?? "");
    if (!res.ok) {
      // Keep the state so they can simply retype — losing it here would force
      // them back through the whole catalogue for a typo.
      pending.set(key, state);
      return ctx.reply(t(lang, `uname_bad_${res.reason}`), { parse_mode: "HTML" });
    }
    const v = await db.variant.findUnique({
      where: { id: state.variantId },
      include: { plan: { include: { product: true } } },
    });
    if (!v || !v.isActive) return ctx.reply(t(lang, "plan_unavailable"));

    const pt = await pick3(v.plan.product.titleRu, v.plan.product.titleEn, v.plan.product.titleUz, lang);
    const vt = await locName(v.titleRu, v.titleUz, lang);
    const item = `📦 <b>${esc(formatItemTitle(pt, vt))}</b>${state.qty > 1 ? ` ×${state.qty}` : ""}`;
    const kb = new InlineKeyboard()
      .text(t(lang, "uname_confirm_yes"), `un:${state.variantId}:${state.qty}:${res.username}`).row()
      .text(t(lang, "uname_confirm_edit"), `unedit:${state.variantId}:${state.qty}`).row();
    return ctx.reply(t(lang, "uname_confirm", { item, u: esc(res.username) }), { parse_mode: "HTML", reply_markup: kb });
  }

  if (state.type === "promo") {
    return redeemPromo(ctx, user, ctx.message.text);
  }

  const n = Math.floor(Number(ctx.message.text.replace(/[^\d]/g, "")));
  if (state.type === "qty") {
    if (!Number.isFinite(n) || n < 1) return ctx.reply(t(lang, "enter_number"));
    return showQtyChooser(ctx, state.variantId, n, state.back, false);
  }
  return ctx.reply(t(lang, "topup_retired"));
});

// ---------- receipt photo (card payment verification) ----------
// Save an admin-supplied file_id as the shop banner (photo or video).
async function saveShopBanner(ctx: Context, fileId: string, isVideo: boolean) {
  await db.setting.upsert({ where: { key: "shop_banner_file_id" }, create: { key: "shop_banner_file_id", valueRu: fileId }, update: { valueRu: fileId } });
  await db.setting.upsert({ where: { key: "shop_banner_is_video" }, create: { key: "shop_banner_is_video", valueRu: isVideo ? "1" : "0" }, update: { valueRu: isVideo ? "1" : "0" } });
  await ctx.reply(`✅ Баннер магазина обновлён (${isVideo ? "видео" : "фото"}). Откройте «Магазин» — проверьте.`).catch(() => {});
}
async function saveProductVideo(ctx: Context, productId: number, fileId: string) {
  await db.product.update({ where: { id: productId }, data: { videoFileId: fileId } }).catch(() => {});
  await ctx.reply("✅ Видео товара сохранено — оно показывается в карточке товара и при выдаче.").catch(() => {});
}
// Route an admin media upload to whatever /banner or /pvideo flow is pending.
// Returns true if it was consumed (so it isn't also treated as a receipt).
async function handleAdminMedia(ctx: Context, fileId: string | undefined, isVideo: boolean): Promise<boolean> {
  if (!isAdmin(ctx)) return false;
  const key = String(ctx.from?.id);
  const st = pending.get(key);
  if (st?.type === "set_banner") {
    pending.delete(key);
    if (fileId) await saveShopBanner(ctx, fileId, isVideo);
    return true;
  }
  if (st?.type === "set_product_video") {
    if (!isVideo) { await ctx.reply("Для товара пришлите именно видео.").catch(() => {}); return true; }
    pending.delete(key);
    if (fileId) await saveProductVideo(ctx, st.productId, fileId);
    return true;
  }
  return false;
}

// Native contact pick for "gift Premium to someone else". This is the good path:
// Telegram hands back the recipient's real numeric id, which is the only thing
// giftPremiumSubscription can deliver to — no typing, no typos, no impersonation.
bot.on("message:users_shared", async (ctx) => {
  const key = String(ctx.from?.id);
  const state = pending.get(key);
  if (state?.type !== "premium_pick_user") return;
  pending.delete(key);
  const picked = ctx.message.users_shared?.users?.[0];
  const user = await getUser(ctx);
  const lang = user.lang;
  // Drop the picker keyboard so the shop's normal keyboard comes back.
  await ctx.reply("✅ Получатель выбран.", { reply_markup: { remove_keyboard: true } }).catch(() => {});
  if (!picked?.user_id) {
    return ctx.reply("Не удалось определить получателя. Попробуйте ещё раз.").catch(() => {});
  }
  return doBuy(ctx, state.variantId, state.qty, picked.username ?? undefined, String(picked.user_id));
});

bot.on("message:photo", async (ctx) => {
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1]?.file_id; // largest size
  if (await handleAdminMedia(ctx, fileId, false)) return;
  if (fileId) await handleReceiptPhoto(ctx, fileId);
});
// Video (iPhone .MOV usually arrives as video or animation).
bot.on("message:video", async (ctx) => {
  await handleAdminMedia(ctx, ctx.message.video?.file_id, true);
});
bot.on("message:animation", async (ctx) => {
  await handleAdminMedia(ctx, ctx.message.animation?.file_id, true);
});
// Receipt sent as an image file (document); also catches a banner/video as a file.
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  if (await handleAdminMedia(ctx, doc.file_id, !!doc.mime_type?.startsWith("video/"))) return;
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

  // Subscription detected automatically → this is what makes the user count
  // towards their referrer's points.
  await markChannelVerified(tgId);

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
  const menu = await buildMenu(lang, 0, "all", user.id, false);
  const banner = await shopBanner();
  if (banner) {
    const send = banner.isVideo
      ? bot.api.sendVideo(tgId, banner.src, { caption: menu.text, parse_mode: "HTML", reply_markup: menu.kb })
      : bot.api.sendPhoto(tgId, banner.src, { caption: menu.text, parse_mode: "HTML", reply_markup: menu.kb });
    await send.catch(async () => {
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

  // Payload: topup:<amount>:<method>[:buy:<variantId>:<qty>:<username>:<refSpend>:<recipientTgId>]
  // Trailing segments may be empty; older payloads simply have fewer of them.
  const variantId = parts[3] === "buy" ? Number(parts[4]) : undefined;
  const qty = parts[3] === "buy" ? Number(parts[5]) : undefined;
  const uname = parts[3] === "buy" ? (parts[6] || undefined) : undefined;
  const discountCost = parts[3] === "buy" ? Number(parts[7] || 0) : 0;
  const recipientTgId = parts[3] === "buy" ? (parts[8] || undefined) : undefined;

  await creditPaidTopUp(ctx, amount, method || "stars", sp.telegram_payment_charge_id, variantId, qty, uname, discountCost, recipientTgId);
});

bot.catch((err) => console.error("[bot] error:", err.error));

// Strip every purely-decorative premium-emoji bit from an outgoing payload:
// button styles + icons, custom_emoji message entities, and <tg-emoji> tags in
// text/caption. Returns true if anything was removed. Used as a retry fallback:
// a single custom emoji that has become invalid (its creator deleted it, or the
// bot lost access) otherwise makes Telegram reject the WHOLE message with a 400,
// which silently blanks a screen. The content still sends — just without the
// cosmetic emoji.
function stripPremiumDecorations(payload: any): boolean {
  let changed = false;
  const rm = payload?.reply_markup;
  const scrub = (rows?: any[][]) => {
    if (!rows) return;
    for (const row of rows) for (const btn of row) {
      if (btn && typeof btn === "object") {
        if (btn.style) { delete btn.style; changed = true; }
        if (btn.icon_custom_emoji_id) { delete btn.icon_custom_emoji_id; changed = true; }
      }
    }
  };
  scrub(rm?.inline_keyboard);
  scrub(rm?.keyboard);

  const dropCustom = (ents?: any[]) => ents?.filter((e) => e?.type !== "custom_emoji");
  if (Array.isArray(payload?.entities) && payload.entities.some((e: any) => e?.type === "custom_emoji")) {
    payload.entities = dropCustom(payload.entities); changed = true;
  }
  if (Array.isArray(payload?.caption_entities) && payload.caption_entities.some((e: any) => e?.type === "custom_emoji")) {
    payload.caption_entities = dropCustom(payload.caption_entities); changed = true;
  }
  const tgEmoji = /<tg-emoji[^>]*>(.*?)<\/tg-emoji>/g;
  if (typeof payload?.text === "string" && tgEmoji.test(payload.text)) {
    payload.text = payload.text.replace(tgEmoji, "$1"); changed = true;
  }
  if (typeof payload?.caption === "string" && tgEmoji.test(payload.caption)) {
    payload.caption = payload.caption.replace(tgEmoji, "$1"); changed = true;
  }
  return changed;
}

// Auto-color every button (Bot API 9.4 `style`) + premium nav icons, with a
// safety net: if the send is rejected and the payload carried premium emoji,
// retry once without them so one bad emoji can't blank a whole screen.
bot.api.config.use(async (prev, method, payload, signal) => {
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
  try {
    return await prev(method, payload, signal);
  } catch (e) {
    if (stripPremiumDecorations(payload)) {
      console.error(`[bot] ${method} rejected with premium emoji, retrying plain:`, (e as { description?: string })?.description ?? (e as Error).message);
      return await prev(method, payload, signal);
    }
    throw e;
  }
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
    `ALTER TABLE "BotUser" ADD COLUMN IF NOT EXISTS "reviewAskedAt" TIMESTAMP(3)`,
    `ALTER TABLE "BotUser" ADD COLUMN IF NOT EXISTS "reviewClaimedAt" TIMESTAMP(3)`,
    `ALTER TABLE "Variant" ADD COLUMN IF NOT EXISTS "pointsCost" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "Variant" ADD COLUMN IF NOT EXISTS "bulkPrices" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Variant" ADD COLUMN IF NOT EXISTS "bulkBonus" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Variant" ADD COLUMN IF NOT EXISTS "needsUsername" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Variant" ADD COLUMN IF NOT EXISTS "fragmentKind" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Variant" ADD COLUMN IF NOT EXISTS "fragmentAmount" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "BotOrder" ADD COLUMN IF NOT EXISTS "targetUsername" TEXT`,
    `CREATE TABLE IF NOT EXISTS "BotPollVote" (
      "tgId" TEXT NOT NULL,
      "choice" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "BotPollVote_pkey" PRIMARY KEY ("tgId")
    )`,
    `CREATE INDEX IF NOT EXISTS "BotPollVote_choice_idx" ON "BotPollVote"("choice")`,
    `ALTER TABLE "TopUp" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3)`,
    `ALTER TABLE "TopUp" ADD COLUMN IF NOT EXISTS "refSpend" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "refDiscount" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "videoFileId" TEXT`,
    `CREATE TABLE IF NOT EXISTS "PaymeTransaction" (
      "id" TEXT NOT NULL,
      "paymeId" TEXT NOT NULL,
      "topUpId" INTEGER NOT NULL,
      "amountTiyin" INTEGER NOT NULL,
      "state" INTEGER NOT NULL DEFAULT 1,
      "createTime" BIGINT NOT NULL DEFAULT 0,
      "performTime" BIGINT NOT NULL DEFAULT 0,
      "cancelTime" BIGINT NOT NULL DEFAULT 0,
      "reason" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PaymeTransaction_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PaymeTransaction_paymeId_key" ON "PaymeTransaction"("paymeId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PaymeTransaction_topUpId_key" ON "PaymeTransaction"("topUpId")`,
    `CREATE INDEX IF NOT EXISTS "PaymeTransaction_state_idx" ON "PaymeTransaction"("state")`,
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
    `CREATE INDEX IF NOT EXISTS "BotUser_referredBy_verified_idx"
       ON "BotUser"("referredBy") WHERE "channelVerifiedAt" IS NOT NULL`,
    // Telegram Premium / Stars delivery tracking. All nullable / defaulted, so
    // existing orders (Gemini, CapCut, Canva …) are unaffected: they keep
    // deliveryState = "" and are never picked up by the Premium pipeline.
    `ALTER TABLE "BotOrder" ADD COLUMN IF NOT EXISTS "recipientTgId" TEXT`,
    `ALTER TABLE "BotOrder" ADD COLUMN IF NOT EXISTS "deliveryState" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "BotOrder" ADD COLUMN IF NOT EXISTS "deliveryAttempts" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "BotOrder" ADD COLUMN IF NOT EXISTS "deliveryError" TEXT`,
    `ALTER TABLE "BotOrder" ADD COLUMN IF NOT EXISTS "providerTxnId" TEXT`,
    `ALTER TABLE "BotOrder" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3)`,
    `ALTER TABLE "BotOrder" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT`,
    `ALTER TABLE "BotOrder" ADD COLUMN IF NOT EXISTS "paymentId" TEXT`,
    `CREATE INDEX IF NOT EXISTS "BotOrder_deliveryState_idx"
       ON "BotOrder"("deliveryState") WHERE "deliveryState" <> ''`,
    // Idempotency for Telegram Stars payments: externalId holds the
    // telegram_payment_charge_id, so the same payment can never be credited
    // twice. Partial (externalId IS NOT NULL) because Payme/Click rows leave it
    // empty and identify themselves via txnRef.
    //
    // SOURCE OF TRUTH: this index lives here, not in schema.prisma, and that is
    // deliberate on two counts. Prisma 5 cannot express a partial index, and
    // replacing it with a plain unique index would change its meaning (every
    // Payme/Click row has externalId NULL). Declaring it would also put it in
    // the `db push` diff, which runs on every boot and would abort the deploy if
    // legacy duplicates existed; as a raw statement it is non-fatal instead.
    //
    // Verified on a throwaway database (2026-08-24): `prisma db push` leaves
    // indexes it does not manage alone — pushing twice with these present
    // reported "already in sync" and both survived. So there is no drift risk
    // from keeping them here.
    `CREATE UNIQUE INDEX IF NOT EXISTS "TopUp_externalId_key"
       ON "TopUp"("externalId") WHERE "externalId" IS NOT NULL`,
    // Fragment / external supplier purchase idempotency record.
    // UNIQUE(orderId, supplier) guarantees one Fragment purchase per order.
    `CREATE TABLE IF NOT EXISTS "SupplierPurchase" (
      "id" SERIAL NOT NULL,
      "orderId" INTEGER NOT NULL,
      "supplier" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "recipient" TEXT NOT NULL,
      "fragmentReqId" TEXT,
      "confirmMethod" TEXT,
      "confirmParams" TEXT,
      "quotedTon" TEXT,
      "actualTon" TEXT,
      "bocHash" TEXT,
      "tonTxHash" TEXT,
      "state" TEXT NOT NULL DEFAULT 'PAID',
      "attempt" INTEGER NOT NULL DEFAULT 0,
      "lastError" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "confirmedAt" TIMESTAMP(3),
      CONSTRAINT "SupplierPurchase_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "SupplierPurchase_orderId_supplier_key" ON "SupplierPurchase"("orderId", "supplier")`,
    `CREATE INDEX IF NOT EXISTS "SupplierPurchase_state_idx" ON "SupplierPurchase"("state")`,
    `CREATE INDEX IF NOT EXISTS "SupplierPurchase_fragmentReqId_idx" ON "SupplierPurchase"("fragmentReqId")`,
    `CREATE TABLE IF NOT EXISTS "PromoBroadcastMessage" (
      "id" SERIAL NOT NULL,
      "tgId" TEXT NOT NULL,
      "messageId" INTEGER NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PromoBroadcastMessage_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "PromoBroadcastMessage_tgId_idx" ON "PromoBroadcastMessage"("tgId")`,
  ];
  for (const sql of statements) {
    try {
      await db.$executeRawUnsafe(sql);
    } catch (e) {
      console.error("[bot] ensureSchema failed:", (e as Error).message);
    }
  }
}

// Referral points now only count invitees with channelVerifiedAt set. Users who
// onboarded before that rule existed have it NULL, so their referrer would lose
// points they had already legitimately earned. Anyone who accepted the terms
// back then had to clear the subscription gate first, so their termsAcceptedAt
// is a safe stand-in.
//
// Runs exactly once, guarded by a marker row — re-running it after every
// restart would keep re-verifying people who accept the terms without ever
// subscribing, which is precisely what the new rule exists to prevent.
const REF_BACKFILL_KEY = "channel_verified_backfill_done";
async function backfillChannelVerified() {
  try {
    const done = await db.setting.findUnique({ where: { key: REF_BACKFILL_KEY } });
    if (done) return;
    const n = await db.$executeRawUnsafe(
      `UPDATE "BotUser" SET "channelVerifiedAt" = "termsAcceptedAt"
         WHERE "channelVerifiedAt" IS NULL AND "termsAcceptedAt" IS NOT NULL`,
    );
    await db.setting.upsert({
      where: { key: REF_BACKFILL_KEY },
      create: { key: REF_BACKFILL_KEY, valueRu: new Date().toISOString() },
      update: {},
    });
    console.info(`[bot] channelVerifiedAt backfill: ${n} row(s) updated (one-time)`);
  } catch (e) {
    console.error("[bot] backfillChannelVerified failed:", (e as Error).message);
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

// Delivery side of Payme: the webhook (Next.js process) already credited the
// balance and marked the TopUp approved; it cannot talk to Telegram or run
// fulfilment. This poller, in the bot process, notifies the user and runs any
// `buy:` auto-purchase, exactly once. It claims each row by stamping
// deliveredAt under a `deliveredAt IS NULL` guard, so overlapping ticks (or a
// restart mid-batch) never double-deliver. Money is never touched here.
async function deliverPaidPaymeTopUps() {
  const pendingDelivery = await db.topUp.findMany({
    where: { method: { in: ["payme", "click"] }, status: "approved", deliveredAt: null },
    take: 20,
  }).catch(() => [] as Array<{ id: number; userId: number; amount: number; note: string | null; refSpend: number }>);

  for (const topup of pendingDelivery) {
    // Atomic claim — only the tick that flips deliveredAt proceeds.
    const claim = await db.topUp.updateMany({
      where: { id: topup.id, method: { in: ["payme", "click"] }, status: "approved", deliveredAt: null },
      data: { deliveredAt: new Date() },
    }).catch(() => ({ count: 0 }));
    if (claim.count !== 1) continue;

    try {
      const user = await db.botUser.findUnique({ where: { id: topup.userId } });
      if (!user) continue;
      const lang = user.lang;
      const isDirectBuy = !!topup.note && topup.note.startsWith("buy:");

      // A direct purchase (bank picker) must NOT show a "баланс пополнен"
      // message — the balance is just internal plumbing here. Only a plain
      // top-up announces the balance. executePurchase() sends the delivery
      // message either way.
      if (!isDirectBuy) {
        await bot.api.sendMessage(
          user.tgId,
          t(lang, "paid_received", { v: money(topup.amount, lang), b: money(user.balance, lang) }),
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(t(lang, "to_shop"), "m:0:all") },
        ).catch(() => {});
      }
      if (ADMIN_ID) {
        await bot.api.sendMessage(ADMIN_ID, `💰 (${(topup as { method?: string }).method ?? "payme"}) ${money(topup.amount, lang)} — ${user.firstName ?? ""} @${user.username ?? "—"} (${user.tgId})`).catch(() => {});
      }
      // buy:variantId:qty[:username] → fulfil the purchase from the fresh balance.
      if (isDirectBuy) {
        const parsed = parseBuyNote(topup.note);
        if (parsed) {
          await executePurchase(
            user.tgId, parsed.variantId, parsed.qty, undefined,
            parsed.username ?? undefined, topup.refSpend ?? 0, parsed.recipientTgId ?? undefined,
            (topup as { method?: string }).method ?? "payme", String(topup.id),
          ).catch((e) => {
            console.error("[bot] payme auto-purchase fail:", (e as Error).message);
          });
        }
      }
    } catch (e) {
      console.error("[bot] payme delivery failed:", (e as Error).message);
    }
  }
}

async function bootstrap() {
  await ensureSchema();             // create missing tables before serving anything
  await backfillChannelVerified();  // one-time referral verification backfill (guarded)
  await maybeResetAdmins();         // one-time admin reset (guarded)
  // Poll for Payme top-ups the webhook credited, to notify + fulfil them.
  setInterval(() => { deliverPaidPaymeTopUps().catch(() => {}); checkPromoExpiry().catch(() => {}); }, 12_000);
  await bot.start({
    drop_pending_updates: false,
    allowed_updates: [
      "message", "callback_query", "chat_member", "chat_join_request",
      "pre_checkout_query",
    ],
    onStart: async (me) => {
      buttonEmoji = await setting("button_emoji", "");
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
