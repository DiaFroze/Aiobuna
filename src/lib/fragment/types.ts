// Fragment integration — shared type definitions.
//
// These types define the contract between the Fragment gateway, the TON wallet
// signer, and the rest of AI OBUNA. They are intentionally decoupled from any
// HTTP transport or database ORM so they can be tested in isolation.

// ---- Fragment purchase kinds ------------------------------------------------

export type FragmentKind = "stars" | "premium";

// ---- Order state machine ----------------------------------------------------
// Each state is a checkpoint. After a crash the reconciler picks up from the
// last persisted state and either retries (if before signing) or reconciles
// (if after broadcast).

export const FragmentOrderState = {
  // Pre-purchase
  PAID:                 "PAID",
  RECIPIENT_VERIFIED:   "RECIPIENT_VERIFIED",
  QUOTING:              "QUOTING",
  PURCHASE_CLAIMED:     "PURCHASE_CLAIMED",

  // Fragment request created
  REQ_CREATED:          "REQ_CREATED",

  // TON signing & broadcast
  SIGNING:              "SIGNING",
  BROADCAST:            "BROADCAST",

  // Fragment confirmation
  CONFIRMING:           "CONFIRMING",

  // Post-purchase
  RECONCILING:          "RECONCILING",
  COMPLETED:            "COMPLETED",

  // Failure states
  RECIPIENT_INVALID:    "RECIPIENT_INVALID",
  SUPPLIER_UNAVAILABLE: "SUPPLIER_UNAVAILABLE",
  AUTH_REQUIRED:        "AUTH_REQUIRED",
  WALLET_UNVERIFIED:    "WALLET_UNVERIFIED",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  PRICE_CHANGED:        "PRICE_CHANGED",
  PROTOCOL_UNHEALTHY:   "PROTOCOL_UNHEALTHY",
  MARGIN_TOO_LOW:       "MARGIN_TOO_LOW",
  REFUND_PENDING:       "REFUND_PENDING",
  REFUNDED:             "REFUNDED",
  FAILED:               "FAILED",
  MANUAL_REVIEW:        "MANUAL_REVIEW",
} as const;

export type FragmentOrderState = typeof FragmentOrderState[keyof typeof FragmentOrderState];

// States where it is safe to retry the purchase from scratch (no TON spent).
export const SAFE_RETRY_STATES: ReadonlySet<FragmentOrderState> = new Set([
  FragmentOrderState.PAID,
  FragmentOrderState.RECIPIENT_VERIFIED,
  FragmentOrderState.QUOTING,
  FragmentOrderState.PURCHASE_CLAIMED,
  FragmentOrderState.REQ_CREATED,
]);

// States where TON may have been broadcast — NEVER start a new purchase.
export const POST_SIGN_STATES: ReadonlySet<FragmentOrderState> = new Set([
  FragmentOrderState.SIGNING,
  FragmentOrderState.BROADCAST,
  FragmentOrderState.CONFIRMING,
  FragmentOrderState.RECONCILING,
  FragmentOrderState.COMPLETED,
]);

// Terminal states — no further processing.
export const TERMINAL_STATES: ReadonlySet<FragmentOrderState> = new Set([
  FragmentOrderState.COMPLETED,
  FragmentOrderState.REFUNDED,
  FragmentOrderState.FAILED,
  FragmentOrderState.RECIPIENT_INVALID,
  FragmentOrderState.MANUAL_REVIEW,
]);

// ---- Fragment mode ----------------------------------------------------------

export type FragmentMode = "off" | "shadow" | "canary" | "live";

// ---- Recipient --------------------------------------------------------------

export interface FragmentRecipient {
  username: string;          // normalized, no @
  displayName?: string;      // from Fragment lookup
  fragmentUserId?: string;   // internal Fragment user id
  isValid: boolean;
}

// ---- Quote ------------------------------------------------------------------

export interface FragmentQuote {
  fragmentReqId: string;     // Fragment request/invoice id
  kind: FragmentKind;
  recipient: string;
  quantity: number;           // Stars count or Premium months
  tonAmount: string;          // in TON, string to avoid float drift
  validUntil: number;         // unix timestamp
  quotedAt: number;           // unix timestamp
}

// ---- Transaction payload (from Fragment, before signing) --------------------

export interface FragmentTransaction {
  fragmentReqId: string;
  transaction: unknown;       // raw TON transaction payload from Fragment
  confirmMethod: string;      // dynamic — never hardcode
  confirmParams: Record<string, unknown>;
}

// ---- Signer request (Gateway → Signer) -------------------------------------

export interface SignerRequest {
  orderId: number;
  fragmentReqId: string;
  kind: FragmentKind;
  recipient: string;
  expectedTonAmount: string;
  transactionPayload: unknown;  // the raw transaction from Fragment
  validUntil: number;
  nonce: string;                // unique per attempt, for replay protection
  timestamp: number;            // unix ms
}

// ---- Signer response --------------------------------------------------------

export interface SignerResponse {
  boc: string;                  // base64 signed BOC
  bocHash: string;              // hex hash of the BOC for dedup
  tonTxHash?: string;           // filled after broadcast
}

// ---- Confirm request (to Fragment after broadcast) --------------------------

export interface FragmentConfirmRequest {
  confirmMethod: string;
  boc: string;
  confirmParams: Record<string, unknown>;
}

// ---- Reconciliation ---------------------------------------------------------

export interface ReconciliationResult {
  fragmentReqId: string;
  delivered: boolean;
  tonTxHash?: string;
  fragmentStatus?: string;
  error?: string;
}

// ---- Supplier adapter interface ---------------------------------------------

export interface FragmentSupplierAdapter {
  /** Check if a @username is a valid Stars/Premium recipient on Fragment. */
  validateRecipient(input: {
    kind: FragmentKind;
    username: string;
    quantity: number;
  }): Promise<FragmentRecipient>;

  /** Get a price quote from Fragment (creates a pending request). */
  quote(input: {
    kind: FragmentKind;
    username: string;
    quantity: number;
  }): Promise<FragmentQuote>;

  /** Execute a Stars purchase (sign + broadcast + confirm). */
  purchaseStars(input: {
    orderId: number;
    username: string;
    quantity: number;
  }): Promise<ReconciliationResult>;

  /** Execute a Premium purchase (sign + broadcast + confirm). */
  purchasePremium(input: {
    orderId: number;
    username: string;
    months: number;
  }): Promise<ReconciliationResult>;

  /** Check the status of a previously initiated purchase. */
  reconcile(input: {
    orderId: number;
    fragmentReqId: string;
  }): Promise<ReconciliationResult>;

  /** Health check — session, wallet, protocol, balance. */
  health(): Promise<FragmentHealthStatus>;
}

// ---- Health -----------------------------------------------------------------

export interface FragmentHealthStatus {
  sessionValid: boolean;
  protocolHealthy: boolean;
  signerReachable: boolean;
  tonRpcReachable: boolean;
  walletBalanceTon: string;
  fragmentMode: FragmentMode;
  pendingPurchases: number;
  reconcilingPurchases: number;
  failedPurchases: number;
  spendTodayTon: string;
}

// ---- Spend limits -----------------------------------------------------------

export interface FragmentSpendLimits {
  minHotWalletBalanceTon: number;
  maxSinglePurchaseTon: number;
  dailySpendLimitTon: number;
  minMarginUzs: number;
}
