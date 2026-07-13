// Merged bot database client pointing to the shared PostgreSQL instance.
// Maps `db.setting` queries to `prisma.botSetting` via Proxy.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

type MergedPrismaClient = Omit<PrismaClient, "setting"> & {
  setting: PrismaClient["botSetting"];
};

export const db = new Proxy(prisma as any, {
  get(target, prop, receiver) {
    if (prop === "setting") {
      return target.botSetting;
    }
    return Reflect.get(target, prop, receiver);
  },
}) as unknown as MergedPrismaClient;
