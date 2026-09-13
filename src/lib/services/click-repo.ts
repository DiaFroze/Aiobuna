import "server-only";
import { botDb } from "@/lib/botDb";
import type { ClickRepo, ClickTopUp } from "@/lib/domain/click";

// Prisma-backed ClickRepo. Reuses the TopUp row (method="click"): the Click
// transaction id lives in txnRef, and complete() credits the balance in one
// row-locked transaction so a Complete retry can never double-credit.
export function prismaClickRepo(): ClickRepo {
  return {
    async findTopUp(topUpId): Promise<ClickTopUp | null> {
      const t = await botDb.topUp.findUnique({ where: { id: topUpId } });
      if (!t || t.method !== "click") return null;
      return { topUpId, amountSum: t.amount, status: t.status, clickTransId: t.txnRef ?? null };
    },

    async savePrepare(topUpId, clickTransId) {
      const changed = await botDb.topUp.updateMany({
        where: { id: topUpId, method: "click", status: "pending", OR: [{ txnRef: null }, { txnRef: clickTransId }] },
        data: { txnRef: clickTransId },
      });
      return changed.count === 1;
    },

    async complete(topUpId, clickTransId) {
      return botDb.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ status: string; userId: number; amount: number; txnRef: string | null; method: string }>>`
          SELECT "status", "userId", "amount", "txnRef", "method" FROM "TopUp" WHERE "id" = ${topUpId} FOR UPDATE`;
        const cur = locked[0];
        if (!cur || cur.method !== "click" || cur.txnRef !== clickTransId) return "missing" as const;
        if (cur.status === "approved") return "already" as const;
        if (cur.status !== "pending") return "cancelled" as const;
        await tx.topUp.update({ where: { id: topUpId }, data: { status: "approved" } });
        await tx.botUser.update({ where: { id: cur.userId }, data: { balance: { increment: cur.amount } } });
        return "ok" as const;
      });
    },

    async cancel(topUpId, clickTransId) {
      await botDb.topUp.updateMany({
        where: { id: topUpId, method: "click", txnRef: clickTransId, status: "pending" },
        data: { status: "rejected" },
      });
    },
  };
}
