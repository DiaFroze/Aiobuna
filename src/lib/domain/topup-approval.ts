// Approving a manual top-up (admin taps "✅ зачислить") both credits money and
// ships goods, so it must happen exactly once per top-up — including when the
// admin double-taps, when two admins act at the same time, or when Telegram
// redelivers the callback.
//
// The guarantee is a compare-and-set: the status transition itself is the lock.
// Only the caller whose UPDATE actually changed a row is allowed to credit the
// balance and fulfil the order; everyone else is told it was already processed.
// Reading the row first and then deciding is NOT enough — two callers can both
// read "pending" before either writes.

/** Statuses a top-up can legitimately be approved from. */
export const APPROVABLE_STATUSES = ["pending", "review", "awaiting_receipt"] as const;

export interface ClaimedTopUp {
  id: number;
  userId: number;
  amount: number;
  /** Purchase note, when this top-up was raised to pay for a specific item. */
  note: string | null;
}

export interface TopUpApprovalRepo {
  /**
   * Atomically move the top-up out of an approvable status AND credit the
   * balance, in one database transaction. Returns the claimed row, or null if
   * another caller got there first (or the id does not exist).
   *
   * Implementations MUST perform the status change as a conditional update
   * (`UPDATE … WHERE id = ? AND status IN (…)`) and treat "0 rows changed" as
   * "lost the race" — never as an error to retry.
   */
  claim(id: number): Promise<ClaimedTopUp | null>;
  /** Runs once, only for the caller that won the claim. */
  fulfil(claimed: ClaimedTopUp): Promise<void>;
}

export type ApprovalResult =
  | { kind: "approved"; claimed: ClaimedTopUp }
  /** Someone else already approved (or it was never approvable). */
  | { kind: "already_processed" };

/**
 * Approve a top-up exactly once. Fulfilment is deliberately kept outside the
 * claim transaction: it talks to Telegram and suppliers, and holding a database
 * transaction open across that would turn a slow supplier into a lock timeout.
 * Running it only after a won claim is what keeps it single-shot.
 */
export async function approveTopUp(id: number, repo: TopUpApprovalRepo): Promise<ApprovalResult> {
  const claimed = await repo.claim(id);
  if (!claimed) return { kind: "already_processed" };
  await repo.fulfil(claimed);
  return { kind: "approved", claimed };
}
