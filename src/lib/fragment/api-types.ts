// Types for fragment-api.com, transcribed from the vendor's own OpenAPI schema
// (https://api.fragment-api.com/api/schema.yaml). Nothing here is guessed: every
// field, enum value and constraint below appears in that document.
//
// Authentication is `Authorization: JWT <token>` — the schema says so verbatim
// ("Format: JWT <token>"), and the token is the Fragment Connection JWT from the
// vendor dashboard, NOT the account API key. The two are not interchangeable.

export const FRAGMENT_API_BASE = "https://api.fragment-api.com";

/** Settlement currency. `usdt_ton` also needs ~0.05 TON in the wallet for gas. */
export type FragmentCurrency = "ton" | "usdt_ton";

/** Premium durations the vendor accepts. Nothing else is valid. */
export const PREMIUM_MONTHS_ALLOWED = [3, 6, 12] as const;
export type PremiumMonths = (typeof PREMIUM_MONTHS_ALLOWED)[number];

/** Fragment refuses smaller Stars orders (schema: minimum 50, maximum 1000000). */
export const STARS_MIN_QUANTITY = 50;
export const STARS_MAX_QUANTITY = 1_000_000;

/** Recipient username rule, straight from the schema's regex. */
export const FRAGMENT_USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/;

export type FragmentOrderStatus =
  | "CREATED"
  | "PENDING"
  | "BLOCKCHAIN_SENT"
  | "COMPLETED"
  | "FAILED";

export type FragmentOrderType = "STARS" | "PREMIUM";

/**
 * Amounts arrive as decimal STRINGS ("8.0800000000"). They stay strings all the
 * way through: turning them into JS numbers to compare or add invites the
 * rounding drift that has no place anywhere near money.
 */
export interface MoneyAmount {
  currency: FragmentCurrency;
  amount: string;
}

export interface FragmentOrderResponse {
  success: boolean | null;
  id: string;                      // uuid — the supplier's order id
  receiver: string;
  goods_quantity: number | null;
  sender: unknown | null;
  price: MoneyAmount | null;
  fee: MoneyAmount | null;
  /** Vendor-assigned reference. Response-only — we cannot supply one. */
  ref_id: string | null;
  status: FragmentOrderStatus;
  type: FragmentOrderType;
  error: unknown | null;
  created_at: string;
}

export interface StarsOrderRequest {
  username: string;                // without "@"
  quantity: number;                // >= 50
  show_sender?: boolean;
  currency?: FragmentCurrency;
  /** Optional webhook. Omitted → the vendor processes the order synchronously. */
  response_url?: string;
}

export interface PremiumOrderRequest {
  username: string;
  months: PremiumMonths;
  show_sender?: boolean;
  currency?: FragmentCurrency;
  response_url?: string;
}

export interface WalletInfoResponse {
  balances: MoneyAmount[];
}

export interface UserInfoResponse {
  username: string;
  photo: string | null;
  name: string | null;
}

/** Stars are priced per single star; Premium per duration. */
export interface StarsPriceEntry {
  quantity: number;
  price: string;
  currency: FragmentCurrency;
  updated_at: string;
}
export interface PremiumPriceEntry {
  months: number;
  price: string;
  currency: FragmentCurrency;
  updated_at: string;
}
export interface PricesResponse {
  stars: StarsPriceEntry[];
  premium: PremiumPriceEntry[];
}

// ---------------------------------------------------------------------------
// Validation helpers (pure)
// ---------------------------------------------------------------------------

/** Strip "@" and surrounding whitespace. Case is left alone — Fragment matches
 *  case-insensitively, and preserving it keeps admin messages readable. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim();
}

export function isValidFragmentUsername(raw: string): boolean {
  return FRAGMENT_USERNAME_RE.test(normalizeUsername(raw));
}

export function isValidStarsQuantity(n: number): boolean {
  return Number.isInteger(n) && n >= STARS_MIN_QUANTITY && n <= STARS_MAX_QUANTITY;
}

export function isValidPremiumMonths(n: number): n is PremiumMonths {
  return (PREMIUM_MONTHS_ALLOWED as readonly number[]).includes(n);
}
