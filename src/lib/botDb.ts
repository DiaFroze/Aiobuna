import "server-only";
import { prisma } from "./db";
import { PrismaClient } from "@prisma/client";

type MergedPrismaClient = Omit<PrismaClient, "setting"> & {
  setting: PrismaClient["botSetting"];
};

// Merged bot database: botDb is now a proxy over the main PostgreSQL prisma instance.
// If code requests `botDb.setting`, it transparently maps to `prisma.botSetting`.
export const botDb = new Proxy(prisma as any, {
  get(target, prop, receiver) {
    if (prop === "setting") {
      return target.botSetting;
    }
    return Reflect.get(target, prop, receiver);
  },
}) as unknown as MergedPrismaClient;

export function botConfigured(): boolean {
  return true;
}
