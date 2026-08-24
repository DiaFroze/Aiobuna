import "server-only";

/**
 * Central, validated access to environment variables. Server-only — importing
 * this into a client component is a build error, which keeps secrets off the
 * frontend by construction.
 */
function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const env = {
  databaseUrl: () => required("DATABASE_URL"),
  redisUrl: () => process.env.REDIS_URL ?? "redis://localhost:6379",
  appUrl: () => process.env.APP_URL ?? "http://localhost:3000",
  sessionSecret: () => required("AUTH_SESSION_SECRET"),
  credentialsEncKey: () => required("CREDENTIALS_ENC_KEY"),
  supplierMode: (): "mock" | "live" =>
    (process.env.SUPPLIER_MODE as "mock" | "live") ?? "mock",
  telegramToken: () => process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: () => process.env.TELEGRAM_ADMIN_CHAT_ID ?? "",
  seedAdminEmail: () => process.env.SEED_ADMIN_EMAIL ?? "admin@sb.eu",
  seedAdminPassword: () => process.env.SEED_ADMIN_PASSWORD ?? "admin12345",
  // Optional: auto-provision the Vex reseller supplier on seed.
  vexApiUrl: () => process.env.VEX_API_URL ?? "",
  vexApiKey: () => process.env.VEX_API_KEY ?? "",

  // --- Payme Merchant API (bot balance top-ups, UZS) ---
  // PAYME_ENABLED gates the whole feature: while "0"/unset the bot shows no
  // Payme button and the webhook rejects everything, so half-configured
  // credentials can never take a real payment.
  paymeEnabled: () => process.env.PAYME_ENABLED === "1",
  // Cashbox (merchant) id from your Payme merchant cabinet.
  paymeMerchantId: () => process.env.PAYME_MERCHANT_ID ?? "",
  // Merchant KEY used for webhook Basic-auth (username is literally "Paycom").
  // Payme issues a separate test key and production key — set the one that
  // matches PAYME_CHECKOUT_URL. Never logged.
  paymeKey: () => process.env.PAYME_KEY ?? "",
  // https://checkout.paycom.uz for production, https://checkout.test.paycom.uz
  // for the sandbox. Trailing slash optional.
  paymeCheckoutUrl: () =>
    (process.env.PAYME_CHECKOUT_URL ?? "https://checkout.paycom.uz").replace(/\/+$/, ""),

  // --- Click Merchant (SHOP-API) ---
  clickEnabled: () => process.env.CLICK_ENABLED === "1",
  clickServiceId: () => process.env.CLICK_SERVICE_ID ?? "",
  clickMerchantId: () => process.env.CLICK_MERCHANT_ID ?? "",
  // Secret key from the Click merchant cabinet — used to verify the callback
  // signature. Never logged.
  clickSecretKey: () => process.env.CLICK_SECRET_KEY ?? "",

  // --- Fragment Direct Gateway ---
  // FRAGMENT_ENABLED gates the entire Fragment fulfillment pipeline.
  // While false the bot shows Fragment items as manual-delivery only.
  fragmentEnabled: () => process.env.FRAGMENT_ENABLED === "1",
  // Mode: "off" | "shadow" | "canary" | "live"
  fragmentMode: (): "off" | "shadow" | "canary" | "live" =>
    (process.env.FRAGMENT_MODE as "off" | "shadow" | "canary" | "live") ?? "off",
  // Phone number for the dedicated Fragment Telegram account.
  fragmentLoginPhone: () => process.env.FRAGMENT_LOGIN_PHONE ?? "",
  // 32-byte hex key (64 chars) for encrypting Fragment session cookies at rest.
  fragmentSessionEncKey: () => process.env.FRAGMENT_SESSION_ENCRYPTION_KEY ?? "",
  // Internal URL of the Wallet Signer service (Railway private network).
  fragmentSignerUrl: () => process.env.FRAGMENT_SIGNER_URL ?? "",
  // Shared secret for HMAC auth between Gateway and Signer.
  fragmentSignerSecret: () => process.env.FRAGMENT_SIGNER_SHARED_SECRET ?? "",
  // Username allowed for canary purchases — only this user gets real purchases
  // in canary mode.
  fragmentCanaryUsername: () => process.env.FRAGMENT_CANARY_USERNAME ?? "",

  // --- TON Wallet Signer ---
  // Public address of the hot wallet. Used for balance checks and address
  // verification. Never contains secrets.
  tonHotWalletAddress: () => process.env.TON_HOT_WALLET_ADDRESS ?? "",
  // Wallet version override. Auto-detected from mnemonic if not set.
  tonWalletVersion: () => process.env.TON_WALLET_VERSION ?? "",
  // TON RPC endpoint — toncenter, tonapi, or custom.
  tonRpcEndpoint: () =>
    process.env.TON_RPC_ENDPOINT ?? "https://toncenter.com/api/v2/jsonRPC",
  // Optional API key for the TON RPC endpoint.
  tonRpcApiKey: () => process.env.TON_RPC_API_KEY ?? "",

  // Spend limits (TON, as strings — parsed to numbers at runtime).
  fragmentMinHotWalletBalanceTon: () =>
    Number(process.env.FRAGMENT_MIN_HOT_WALLET_BALANCE_TON ?? "0.5"),
  fragmentMaxSinglePurchaseTon: () =>
    Number(process.env.FRAGMENT_MAX_SINGLE_PURCHASE_TON ?? "50"),
  fragmentDailySpendLimitTon: () =>
    Number(process.env.FRAGMENT_DAILY_SPEND_LIMIT_TON ?? "200"),
};
