import "server-only";
import { prisma } from "../db";

// Global settings with sane defaults. Stored as JSON in Setting table.
// The shop only ever deals in UZS ("сум") — no markup-percent engine or
// USDT/currency-rate conversion is applied anywhere in pricing.

export interface GlobalSettings {
  defaultRoundingMode: "NONE" | "NEAREST_05" | "NEAREST_10" | "NEAREST_1000" | "PSYCHOLOGICAL";
}

const DEFAULTS: GlobalSettings = {
  defaultRoundingMode: "NEAREST_05",
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
