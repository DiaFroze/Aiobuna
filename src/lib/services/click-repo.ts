import "server-only";
import { botDb } from "@/lib/botDb";
import type { ClickRepo, ClickTopUp } from "@/lib/domain/click";

// Prisma-backed ClickRepo. Reuses the TopUp row (method="click"): the Click
// transaction id lives in txnRef, and complete() credits the balance in one
// row-locked transaction so a Complete retry can never double-credit.
export function prismaClickRepo(): ClickRepo {
  return {
    async findTopUp(topUpId): Promise<ClickTopUp | null> {
      const t = await botDb.topUp.findUnique({ where: { id: topUpId } }).catch(() => null);
      if (!t || t.method !== "click") return null;
      return { topUpId, amountSum: t.amount, status: t.status, clickTransId: t.txnRef ?? null };
    },

    async savePrepare(topUpId, clickTransId) {
      await botDb.topUp.update({ where: { id: topUpId }, data: { txnRef: clickTransId } }).catch(() => {});
    },

    async complete(topUpId, _clickTransId) {
      return botDb.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ status: string; userId: number; amount: number }>>`
          SELECT "status", "userId", "amount" FROM "TopUp" WHERE "id" = ${topUpId} FOR UPDATE`;
        const cur = locked[0];
        if (!cur) return "already" as const; // nothing to do
        if (cur.status === "approved") return "already" as const;
        await tx.topUp.update({ where: { id: topUpId }, data: { status: "approved" } });
        await tx.botUser.update({ where: { id: cur.userId }, data: { balance: { increment: cur.amount } } });
        return "ok" as const;
      });
    },

    async cancel(topUpId, _clickTransId) {
      await botDb.topUp.update({ where: { id: topUpId }, data: { status: "rejected" } }).catch(() => {});
    },
  };
}
