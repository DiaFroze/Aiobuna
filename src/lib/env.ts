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
  defaultCurrency: () => process.env.DEFAULT_CURRENCY ?? "USDT",
  usdtUzsRate: () => Number(process.env.USDT_UZS_RATE ?? "12600"),
  telegramToken: () => process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: () => process.env.TELEGRAM_ADMIN_CHAT_ID ?? "",
  seedAdminEmail: () => process.env.SEED_ADMIN_EMAIL ?? "admin@sb.eu",
  seedAdminPassword: () => process.env.SEED_ADMIN_PASSWORD ?? "admin12345",
  // Optional: auto-provision the Vex reseller supplier on seed.
  vexApiUrl: () => process.env.VEX_API_URL ?? "",
  vexApiKey: () => process.env.VEX_API_KEY ?? "",
};
