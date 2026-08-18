import "server-only";
import { botDb } from "@/lib/botDb";
import type { PaymeRepo, TxnView } from "@/lib/domain/payme";
import { PaymeState, sumToTiyin } from "@/lib/domain/payme";

// Prisma-backed PaymeRepo. All the money-moving happens here, inside DB
// transactions with row locks, so the pure protocol core stays deterministic
// and the "credit exactly once" guarantee holds even under Payme's retries and
// simultaneous PerformTransaction calls.

// Payme times are ms-epoch and fit safely in a JS number (< 2^53); the DB
// column is BigInt to be exact on write.
const toNum = (b: bigint | number | null): number => (b === null ? 0 : Number(b));

function toView(row: {
  id: string; paymeId: string; topUpId: number; amountTiyin: number; state: number;
  createTime: bigint | number; performTime: bigint | number; cancelTime: bigint | number; reason: number | null;
}): TxnView {
  return {
    id: row.id, paymeId: row.paymeId, topUpId: row.topUpId, amountTiyin: row.amountTiyin, state: row.state,
    createTime: toNum(row.createTime), performTime: toNum(row.performTime), cancelTime: toNum(row.cancelTime),
    reason: row.reason,
  };
}

export function prismaPaymeRepo(): PaymeRepo {
  return {
    now: () => Date.now(),

    async findTopUp(topUpId) {
      const t = await botDb.topUp.findUnique({ where: { id: topUpId } });
      if (!t) return null;
      const notExpired = !t.expiresAt || t.expiresAt.getTime() > Date.now();
      const payable = t.method === "payme" && t.status === "pending" && notExpired;
      return { topUpId, amountTiyin: sumToTiyin(t.amount), payable };
    },

    async findTxnByPaymeId(paymeId) {
      const r = await botDb.paymeTransaction.findUnique({ where: { paymeId } });
      return r ? toView(r) : null;
    },

    async findTxnByTopUp(topUpId) {
      const r = await botDb.paymeTransaction.findUnique({ where: { topUpId } });
      return r ? toView(r) : null;
    },

    async createTxn({ paymeId, topUpId, amountTiyin, createTime }) {
      const r = await botDb.paymeTransaction.create({
        data: { paymeId, topUpId, amountTiyin, state: PaymeState.CREATED, createTime: BigInt(createTime) },
      });
      return toView(r);
    },

    // CREATED -> PERFORMED + approve TopUp + credit balance, atomically. The
    // FOR UPDATE lock plus the `state = CREATED` guard means two concurrent
    // PerformTransaction calls (or a Payme retry) credit the balance once.
    async performTxn(paymeId, performTime) {
      return botDb.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ state: number; topUpId: number }>>`
          SELECT "state", "topUpId" FROM "PaymeTransaction" WHERE "paymeId" = ${paymeId} FOR UPDATE`;
        const cur = locked[0];
        if (cur && cur.state === PaymeState.CREATED) {
          await tx.paymeTransaction.update({
            where: { paymeId },
            data: { state: PaymeState.PERFORMED, performTime: BigInt(performTime) },
          });
          const topup = await tx.topUp.update({
            where: { id: cur.topUpId },
            data: { status: "approved" },
          });
          await tx.botUser.update({
            where: { id: topup.userId },
            data: { balance: { increment: topup.amount } },
          });
        }
        const fresh = await tx.paymeTransaction.findUnique({ where: { paymeId } });
        return toView(fresh!);
      });
    },

    async cancelCreated(paymeId, cancelTime, reason) {
      const r = await botDb.$transaction(async (tx) => {
        const txn = await tx.paymeTransaction.update({
          where: { paymeId },
          data: { state: PaymeState.CANCELLED, cancelTime: BigInt(cancelTime), reason: reason ?? undefined },
        });
        // A cancelled top-up must never be delivered or re-used.
        await tx.topUp.update({ where: { id: txn.topUpId }, data: { status: "rejected" } });
        return txn;
      });
      return toView(r);
    },

    // Refund a performed transaction only if the credited сум are still on the
    // balance. If the customer already spent them, the money is gone into a
    // delivered order and we cannot silently claw it back — report completed
    // (-31007) and let it be handled by hand.
    async cancelPerformed(paymeId, cancelTime, reason) {
      return botDb.$transaction(async (tx) => {
        const txn = await tx.paymeTransaction.findUnique({ where: { paymeId } });
        if (!txn) return null;
        const topup = await tx.topUp.findUnique({ where: { id: txn.topUpId } });
        if (!topup) return null;
        const locked = await tx.$queryRaw<Array<{ balance: number }>>`
          SELECT "balance" FROM "BotUser" WHERE "id" = ${topup.userId} FOR UPDATE`;
        const balance = locked[0]?.balance ?? 0;
        if (balance < topup.amount) return null; // already spent → not auto-refundable
        await tx.botUser.update({ where: { id: topup.userId }, data: { balance: { decrement: topup.amount } } });
        await tx.topUp.update({ where: { id: topup.id }, data: { status: "rejected" } });
        const updated = await tx.paymeTransaction.update({
          where: { paymeId },
          data: { state: PaymeState.CANCELLED_AFTER_PERFORM, cancelTime: BigInt(cancelTime), reason: reason ?? undefined },
        });
        return toView(updated);
      });
    },

    async listByRange(fromMs, toMs) {
      // GetStatement is for reconciliation; a DB hiccup must not throw a 500 —
      // return an empty statement, which is a valid response.
      try {
        const rows = await botDb.paymeTransaction.findMany({
          where: { createTime: { gte: BigInt(Math.trunc(fromMs)), lte: BigInt(Math.trunc(toMs)) } },
        });
        return rows.map(toView);
      } catch (e) {
        console.error("[payme] listByRange failed:", (e as Error).message);
        return [];
      }
    },
  };
}
