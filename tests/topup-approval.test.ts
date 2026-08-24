import { describe, it, expect } from "vitest";
import {
  approveTopUp,
  APPROVABLE_STATUSES,
  type ClaimedTopUp,
  type TopUpApprovalRepo,
} from "../src/lib/domain/topup-approval";
import { buildBuyNote, parseBuyNote } from "../src/lib/domain/premium-delivery";

/**
 * Stand-in for the database. `claim` mirrors what Postgres gives us: an await
 * (latency) and then an indivisible compare-and-set. JavaScript is
 * single-threaded, so the synchronous section below is atomic in exactly the
 * way `UPDATE … WHERE status IN (…)` is atomic — while the await in front of it
 * lets two concurrent callers interleave, which is what makes these tests able
 * to catch a check-then-act mistake.
 */
class FakeRepo implements TopUpApprovalRepo {
  rows = new Map<number, { id: number; userId: number; amount: number; status: string; note: string | null }>();
  balances = new Map<number, number>();
  credits: Array<{ userId: number; amount: number }> = [];
  fulfilled: ClaimedTopUp[] = [];
  /** Set to make fulfilment throw, to check credit/fulfil ordering. */
  fulfilShouldThrow = false;

  constructor(rows: Array<{ id: number; userId: number; amount: number; status: string; note?: string | null }>) {
    for (const r of rows) {
      this.rows.set(r.id, { ...r, note: r.note ?? null });
      this.balances.set(r.userId, 0);
    }
  }

  async claim(id: number): Promise<ClaimedTopUp | null> {
    await Promise.resolve(); // latency: lets concurrent callers interleave here
    const row = this.rows.get(id);
    if (!row) return null;
    if (!(APPROVABLE_STATUSES as readonly string[]).includes(row.status)) return null;
    // --- atomic section: status flip + credit, as one transaction would be ---
    row.status = "approved";
    this.balances.set(row.userId, (this.balances.get(row.userId) ?? 0) + row.amount);
    this.credits.push({ userId: row.userId, amount: row.amount });
    return { id: row.id, userId: row.userId, amount: row.amount, note: row.note };
  }

  async fulfil(claimed: ClaimedTopUp): Promise<void> {
    await Promise.resolve();
    if (this.fulfilShouldThrow) throw new Error("supplier down");
    this.fulfilled.push(claimed);
  }
}

const mkRepo = (status = "pending", note: string | null = null) =>
  new FakeRepo([{ id: 1, userId: 42, amount: 50_000, status, note }]);

describe("approveTopUp — happy path", () => {
  it("credits and fulfils exactly once", async () => {
    const repo = mkRepo("pending", "buy:7:1");
    const res = await approveTopUp(1, repo);

    expect(res.kind).toBe("approved");
    expect(repo.credits).toEqual([{ userId: 42, amount: 50_000 }]);
    expect(repo.fulfilled).toHaveLength(1);
    expect(repo.balances.get(42)).toBe(50_000);
    expect(repo.rows.get(1)!.status).toBe("approved");
  });

  it("approves from every approvable status", async () => {
    for (const status of APPROVABLE_STATUSES) {
      const repo = mkRepo(status);
      const res = await approveTopUp(1, repo);
      expect(res.kind, `status ${status}`).toBe("approved");
      expect(repo.credits).toHaveLength(1);
    }
  });
});

describe("approveTopUp — double approval", () => {
  it("ignores a sequential second approval", async () => {
    const repo = mkRepo();
    const first = await approveTopUp(1, repo);
    const second = await approveTopUp(1, repo);

    expect(first.kind).toBe("approved");
    expect(second.kind).toBe("already_processed");
    expect(repo.credits).toHaveLength(1);
    expect(repo.fulfilled).toHaveLength(1);
    expect(repo.balances.get(42)).toBe(50_000);
  });

  it("CONCURRENT: two simultaneous approvals credit and fulfil once", async () => {
    const repo = mkRepo();

    // The exact scenario from the audit: admin double-taps, or two admins tap
    // at the same moment, and both requests are in flight together.
    const [a, b] = await Promise.all([approveTopUp(1, repo), approveTopUp(1, repo)]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["already_processed", "approved"]);
    expect(repo.credits).toHaveLength(1);
    expect(repo.fulfilled).toHaveLength(1);
    expect(repo.balances.get(42)).toBe(50_000); // NOT 100 000
  });

  it("CONCURRENT: five simultaneous approvals still credit once", async () => {
    const repo = mkRepo();
    const results = await Promise.all(Array.from({ length: 5 }, () => approveTopUp(1, repo)));

    expect(results.filter((r) => r.kind === "approved")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "already_processed")).toHaveLength(4);
    expect(repo.credits).toHaveLength(1);
    expect(repo.fulfilled).toHaveLength(1);
    expect(repo.balances.get(42)).toBe(50_000);
  });
});

describe("approveTopUp — nothing to approve", () => {
  it("refuses a top-up that is already approved", async () => {
    const repo = mkRepo("approved");
    const res = await approveTopUp(1, repo);
    expect(res.kind).toBe("already_processed");
    expect(repo.credits).toHaveLength(0);
    expect(repo.fulfilled).toHaveLength(0);
  });

  it("refuses a rejected top-up", async () => {
    const repo = mkRepo("rejected");
    expect((await approveTopUp(1, repo)).kind).toBe("already_processed");
    expect(repo.credits).toHaveLength(0);
  });

  it("refuses an unknown id without crediting anyone", async () => {
    const repo = mkRepo();
    const res = await approveTopUp(999, repo);
    expect(res.kind).toBe("already_processed");
    expect(repo.credits).toHaveLength(0);
    expect(repo.fulfilled).toHaveLength(0);
  });
});

describe("admin approval preserves the Premium recipient", () => {
  // Regression: the admin-approval path parsed the note with a hand-rolled
  // split() that only read the username, so a Premium subscription paid for via
  // "оплата администратору" was delivered to the BUYER instead of the person it
  // was bought for. The note is built and read by the same helpers everywhere.
  const claimNote = async (note: string | null) => {
    const repo = new FakeRepo([{ id: 1, userId: 42, amount: 10, status: "pending", note }]);
    const res = await approveTopUp(1, repo);
    expect(res.kind).toBe("approved");
    return parseBuyNote(repo.fulfilled[0].note);
  };

  it("Premium for yourself — keeps the buyer's own numeric id", async () => {
    const parsed = await claimNote(buildBuyNote(31, 1, null, "7797972248"));
    expect(parsed).toEqual({ variantId: 31, qty: 1, username: null, recipientTgId: "7797972248" });
  });

  it("Premium for someone else — keeps the picked contact's id, not the buyer's", async () => {
    const parsed = await claimNote(buildBuyNote(31, 1, "friend", "555000111"));
    expect(parsed?.recipientTgId).toBe("555000111");
    expect(parsed?.username).toBe("friend");
  });

  it("username fallback with no resolvable id — never invents one", async () => {
    const parsed = await claimNote(buildBuyNote(31, 1, "stranger", null));
    expect(parsed?.username).toBe("stranger");
    expect(parsed?.recipientTgId).toBeNull();
  });

  it("ordinary products (Gemini/CapCut/Canva) still parse unchanged", async () => {
    expect(await claimNote("buy:12:2")).toEqual({ variantId: 12, qty: 2, username: null, recipientTgId: null });
    expect(await claimNote(buildBuyNote(12, 3))).toEqual({ variantId: 12, qty: 3, username: null, recipientTgId: null });
  });

  it("a plain balance top-up carries no purchase at all", async () => {
    expect(await claimNote(null)).toBeNull();
  });
});

describe("approveTopUp — fulfilment failure", () => {
  it("keeps the money credited and does not silently re-approve", async () => {
    // A supplier failure must not roll the credit back (the customer paid) and
    // must not leave the top-up re-approvable, or a retry would double-credit.
    const repo = mkRepo();
    repo.fulfilShouldThrow = true;

    await expect(approveTopUp(1, repo)).rejects.toThrow("supplier down");
    expect(repo.credits).toHaveLength(1);
    expect(repo.rows.get(1)!.status).toBe("approved");

    repo.fulfilShouldThrow = false;
    const retry = await approveTopUp(1, repo);
    expect(retry.kind).toBe("already_processed");
    expect(repo.credits).toHaveLength(1); // still once
  });
});
