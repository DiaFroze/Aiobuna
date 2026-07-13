import "server-only";
import { prisma } from "../db";
import { env } from "../env";

// Global settings with sane defaults. Stored as JSON in Setting table.

export interface GlobalSettings {
  globalMarkupPercent: number;
  defaultRoundingMode: "NONE" | "NEAREST_05" | "NEAREST_10" | "NEAREST_1000" | "PSYCHOLOGICAL";
  sellCurrency: string;
}

const DEFAULTS: GlobalSettings = {
  globalMarkupPercent: 30,
  defaultRoundingMode: "NEAREST_05",
  sellCurrency: "USDT",
};

export async function getGlobalSettings(): Promise<GlobalSettings> {
  const row = await prisma.setting.findUnique({ where: { key: "global" } });
  return { ...DEFAULTS, ...((row?.value as Partial<GlobalSettings>) ?? {}) };
}

export async function setGlobalSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
  const current = await getGlobalSettings();
  const next = { ...current, ...patch };
  await prisma.setting.upsert({
    where: { key: "global" },
    create: { key: "global", value: next },
    update: { value: next },
  });
  return next;
}

/** USDT->UZS rate: DB CurrencyRate wins, else env fallback. */
export async function getUsdtUzsRate(): Promise<number> {
  const rate = await prisma.currencyRate.findUnique({
    where: { base_quote: { base: "USDT", quote: "UZS" } },
  });
  return rate ? Number(rate.rate) : env.usdtUzsRate();
}
