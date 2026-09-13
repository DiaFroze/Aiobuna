import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(url); } }));
vi.mock("@/lib/auth/session", () => ({ requirePermission: vi.fn(async () => ({ id: "test", email: "test@example.invalid" })) }));
vi.mock("@/lib/security/audit", () => ({ audit: vi.fn() }));
import { botDb as db } from "../src/lib/botDb";
import { prismaPaymeRepo } from "../src/lib/services/payme-repo";
import { prismaClickRepo } from "../src/lib/services/click-repo";
import { handlePayme } from "../src/lib/domain/payme";
import { approveTopUpAction, rejectTopUpAction, resetTestTopupAction } from "../src/app/admin/(protected)/bot-topups/actions";
import { creditUserBalanceAction, debitUserBalanceAction } from "../src/app/admin/(protected)/bot-users/actions";
import { createGiveawayAction, publishGiveawayAction, drawGiveawayAction, toggleGiveawayAction } from "../src/app/admin/(protected)/bot-giveaways/actions";
import { deliverManualOrderAction } from "../src/app/admin/(protected)/bot-verify/actions";

const enabled = !!process.env.AUDIT_DATABASE_URL;
if (enabled) {
  const u = new URL(process.env.DATABASE_URL!);
  if (u.searchParams.get("schema") !== "audit_regression" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new Error("Unsafe test database");
}
function form(values: Record<string, unknown>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, String(v));
  return f;
}
describe.skipIf(!enabled)("real PostgreSQL payment and admin regressions", () => {
  let userId: number;
  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    userId = (await db.botUser.create({ data: { tgId: `test-${randomUUID()}`, balance: 5000 } })).id;
  });
  afterAll(async () => { vi.unstubAllEnvs(); await db.$disconnect(); });
  async function topup(method = "payme", status = "pending") {
    return db.topUp.create({ data: { userId, amount: 1000, method, status } });
  }
  async function payme() {
    const t = await topup();
    const repo = prismaPaymeRepo();
    const id = randomUUID();
    await repo.createTxn({ paymeId: id, topUpId: t.id, amountTiyin: 100000, createTime: Date.now() });
    return { t, repo, id };
  }
  async function balance() { return (await db.botUser.findUniqueOrThrow({ where: { id: userId } })).balance; }
  it("Payme simultaneous perform credits once", async () => {
    const { repo, id } = await payme();
    await Promise.all(Array.from({ length: 6 }, () => repo.performTxn(id, Date.now())));
    expect(await balance()).toBe(6000);
  });
  it("Payme simultaneous refunds debit once and retain one cancel timestamp", async () => {
    const { repo, id } = await payme();
    await repo.performTxn(id, Date.now());
    const results = await Promise.all(Array.from({ length: 6 }, (_, n) => repo.cancelPerformed(id, Date.now() + n, 1)));
    expect(await balance()).toBe(5000);
    expect(new Set(results.map(r => r?.cancelTime)).size).toBe(1);
    expect(results.every(r => r?.state === -2)).toBe(true);
  });
  it("Payme stale cancel-created does not overwrite completed payment", async () => {
    const { repo, id } = await payme();
    await repo.performTxn(id, Date.now());
    expect((await repo.cancelCreated(id, Date.now(), 1)).state).toBe(2);
    expect(await balance()).toBe(6000);
  });
  it("Payme simultaneous perform and cancel leave no unbacked balance", async () => {
    const { repo, id } = await payme();
    await Promise.all([
      handlePayme({ method: "PerformTransaction", params: { id } }, repo, true),
      handlePayme({ method: "CancelTransaction", params: { id, reason: 1 } }, repo, true),
    ]);
    expect(await balance()).toBe(5000);
    expect([-1, -2]).toContain((await repo.findTxnByPaymeId(id))?.state);
  });
  it("Payme rejected invoice cannot be credited", async () => {
    const { t, repo, id } = await payme();
    await db.topUp.update({ where: { id: t.id }, data: { status: "rejected" } });
    const r = await handlePayme({ method: "PerformTransaction", params: { id } }, repo, true);
    expect("error" in r && r.error.code).toBe(-31008);
    expect(await balance()).toBe(5000);
  });
  it("Click competing prepare requests cannot replace transaction ownership", async () => {
    const t = await topup("click"); const r = prismaClickRepo();
    const result = await Promise.all([r.savePrepare(t.id, "one"), r.savePrepare(t.id, "two")]);
    expect(result.filter(Boolean)).toHaveLength(1);
  });
  it("Click rejects cancelled invoices and stale transaction IDs", async () => {
    const t = await topup("click"); const r = prismaClickRepo();
    await r.savePrepare(t.id, "one");
    expect(await r.complete(t.id, "two")).toBe("missing");
    await r.cancel(t.id, "one");
    expect(await r.complete(t.id, "one")).toBe("cancelled");
    expect(await balance()).toBe(5000);
  });
  it("Click concurrent completion credits once and late cancellation preserves approval", async () => {
    const t = await topup("click"); const r = prismaClickRepo();
    await r.savePrepare(t.id, "one");
    await Promise.all(Array.from({ length: 6 }, () => r.complete(t.id, "one")));
    await r.cancel(t.id, "one");
    expect(await balance()).toBe(6000);
    expect((await db.topUp.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("approved");
  });
  it.each(["pending", "review", "awaiting_receipt"])("admin approves %s once and queues delivery", async status => {
    const t = await topup("receipt", status);
    await Promise.all(Array.from({ length: 5 }, () => approveTopUpAction(form({ id: t.id }))));
    expect(await balance()).toBe(6000);
    expect(await db.topUp.findUnique({ where: { id: t.id } })).toMatchObject({ externalId: "admin-panel", deliveredAt: null });
    await rejectTopUpAction(form({ id: t.id }));
    expect((await db.topUp.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("approved");
  });
  it("admin cannot approve or reset an actual provider invoice", async () => {
    const t = await topup();
    await approveTopUpAction(form({ id: t.id }));
    await resetTestTopupAction(form({ id: t.id }));
    expect(await balance()).toBe(5000);
    expect((await db.topUp.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("pending");
  });
  it("concurrent admin balance adjustments retain both changes", async () => {
    await Promise.all([creditUserBalanceAction(form({ userId, amount: 500 })), creditUserBalanceAction(form({ userId, amount: 600 }))]);
    expect(await balance()).toBe(6100);
    await Promise.all([debitUserBalanceAction(form({ userId, amount: 500 })), debitUserBalanceAction(form({ userId, amount: 600 }))]);
    expect(await balance()).toBe(5000);
    await expect(debitUserBalanceAction(form({ userId, amount: 6000 }))).rejects.toThrow("Недостаточно");
    expect(await balance()).toBe(5000);
  });
  async function giveaway() {
    const p = await db.product.create({ data: { code: randomUUID(), titleRu: "Тест", titleUz: "Test", plans: { create: { titleRu: "План", titleUz: "Plan", variants: { create: { titleRu: "Приз", titleUz: "Prize", priceUzs: 1000 } } } } }, include: { plans: { include: { variants: true } } } });
    return db.giveaway.create({ data: { variantId: p.plans[0].variants[0].id, title: "Тест", postText: "<b>Тест</b>", channelTarget: "@test", status: "active", winnersCount: 1, participants: { create: { userId, isEligible: true } } } });
  }
  it("successful giveaway publication redirects to success, not publishexception", async () => {
    const gw = await giveaway();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ok: true, result: { message_id: 42 } }) })));
    await expect(publishGiveawayAction(form({ id: gw.id }))).rejects.toThrow("?ok=published");
    expect(await db.giveaway.findUnique({ where: { id: gw.id } })).toMatchObject({ postedMessageId: 42, status: "active" });
  });
  it("Telegram publication error remains visible and does not activate draft", async () => {
    const gw = await giveaway(); await db.giveaway.update({ where: { id: gw.id }, data: { status: "draft" } });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ok: false, description: "Forbidden" }) })));
    await expect(publishGiveawayAction(form({ id: gw.id }))).rejects.toThrow("?error=Forbidden");
    expect((await db.giveaway.findUniqueOrThrow({ where: { id: gw.id } })).status).toBe("draft");
  });
  it("simultaneous draws commit exactly one winner and claim; completed draw cannot reopen", async () => {
    const gw = await giveaway();
    const results = await Promise.allSettled([drawGiveawayAction(form({ id: gw.id })), drawGiveawayAction(form({ id: gw.id }))]);
    expect(results.filter(r => r.status === "rejected" && String(r.reason).includes("ok=drawn"))).toHaveLength(1);
    const winners = await db.giveawayWinner.findMany({ where: { giveawayId: gw.id } });
    expect(winners).toHaveLength(1);
    expect(await db.userDealClaim.count({ where: { promoLinkId: winners[0].promoLinkId! } })).toBe(1);
    await expect(toggleGiveawayAction(form({ id: gw.id }))).rejects.toThrow("alreadydrawn");
  });
  it("rejects fractional winner counts before writing", async () => {
    const gw = await giveaway();
    await expect(createGiveawayAction(form({ title: "Bad", variantId: gw.variantId, postText: "Test", winnersCount: 1.5 }))).rejects.toThrow("error=invalid");
  });
  it("failure saving a claim rolls back winners, promo link and giveaway completion", async () => {
    const gw = await giveaway();
    const transaction = db.$transaction.bind(db);
    const spy = vi.spyOn(db, "$transaction").mockImplementation(((callback: any, options: any) =>
      transaction(async (tx: any) => callback(new Proxy(tx, {
        get(target, prop) {
          if (prop === "userDealClaim") return { create: async () => { throw new Error("injected claim failure"); } };
          return target[prop];
        },
      })), options)) as any);
    try { await expect(drawGiveawayAction(form({ id: gw.id }))).rejects.toThrow("injected claim failure"); }
    finally { spy.mockRestore(); }
    expect((await db.giveaway.findUniqueOrThrow({ where: { id: gw.id } })).status).toBe("active");
    expect(await db.giveawayWinner.count({ where: { giveawayId: gw.id } })).toBe(0);
    expect(await db.promoLink.count({ where: { variantId: gw.variantId } })).toBe(0);
  });
  it("failed Telegram notifications preserve draw and show a warning", async () => {
    const gw = await giveaway();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ok: false, description: "Forbidden" }) })));
    await expect(drawGiveawayAction(form({ id: gw.id }))).rejects.toThrow("warning=notifyfailed");
    expect((await db.giveaway.findUniqueOrThrow({ where: { id: gw.id } })).status).toBe("completed");
    expect(await db.giveawayWinner.count({ where: { giveawayId: gw.id } })).toBe(1);
  });
  it("manual delivery preserves special characters in Telegram HTML", async () => {
    const order = await db.botOrder.create({ data: { userId, titleRu: "A & B", priceUsdt: 1000, payload: "", status: "awaiting_delivery" } });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    const send = vi.fn(async () => ({})); vi.stubGlobal("fetch", send);
    await deliverManualOrderAction(form({ orderId: order.id, payload: "pass<&>word" }));
    const body = JSON.parse((send.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.text).toContain("A &amp; B");
    expect(body.text).toContain("pass&lt;&amp;&gt;word");
  });
  it("manual delivery rejects a completed order even with stale legacy status", async () => {
    const order = await db.botOrder.create({ data: { userId, titleRu: "Prize", priceUsdt: 1000, payload: "existing", status: "awaiting_delivery", deliveryState: "COMPLETED" } });
    await expect(deliverManualOrderAction(form({ orderId: order.id, payload: "duplicate" }))).rejects.toThrow("уже выдан");
    expect((await db.botOrder.findUniqueOrThrow({ where: { id: order.id } })).payload).toBe("existing");
  });
});
