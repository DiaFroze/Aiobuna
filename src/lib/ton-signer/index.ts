// TON wallet signer — types and wallet version auto-detection.
//
// The signer is intentionally isolated from the Fragment gateway. It receives
// a validated purchase intent, checks all safety invariants, signs the TON
// transaction, and returns the signed BOC. It never initiates purchases.

import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV3R2, WalletContractV4, WalletContractV5R1, Address } from "@ton/ton";

// ---- Wallet version detection -----------------------------------------------
// Given a mnemonic and a known address, determine which wallet contract version
// was used to generate that address. This is necessary because the wallet is
// uninitialized on-chain and we can't inspect its code.

export type WalletVersion = "v3r2" | "v4r2" | "v5r1";

interface DetectionResult {
  version: WalletVersion;
  publicKey: Buffer;
  secretKey: Buffer;
  address: Address;
}

/**
 * Derive keypair from mnemonic and find which wallet version produces the
 * expected address. Returns null if no version matches — which means either
 * the mnemonic is wrong or the address was generated with a non-standard
 * contract.
 *
 * This function is pure and never touches the network.
 */
export async function detectWalletVersion(
  mnemonic: string[],
  expectedAddress: string,
): Promise<DetectionResult | null> {
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const publicKey = keyPair.publicKey;

  // Normalize expected address to raw form for comparison.
  const expected = Address.parse(expectedAddress).toRawString();

  const candidates: Array<{ version: WalletVersion; address: Address }> = [
    {
      version: "v4r2",
      address: WalletContractV4.create({ workchain: 0, publicKey }).address,
    },
    {
      version: "v3r2",
      address: WalletContractV3R2.create({ workchain: 0, publicKey }).address,
    },
    {
      version: "v5r1",
      address: WalletContractV5R1.create({ workchain: 0, publicKey }).address,
    },
  ];

  for (const c of candidates) {
    if (c.address.toRawString() === expected) {
      return {
        version: c.version,
        publicKey: Buffer.from(publicKey),
        secretKey: Buffer.from(keyPair.secretKey),
        address: c.address,
      };
    }
  }

  return null;
}

// ---- Signer safety checks ---------------------------------------------------

export interface SignerSafetyLimits {
  maxSinglePurchaseTon: number;
  dailySpendLimitTon: number;
  minWalletBalanceTon: number;
}

export interface SpendRecord {
  date: string;       // YYYY-MM-DD
  totalTon: number;
}

/**
 * Check whether a proposed signing request passes all safety invariants.
 * Returns null if safe, or an error message string if rejected.
 */
export function checkSignerSafety(
  requestedTon: number,
  walletBalanceTon: number,
  todaySpendTon: number,
  limits: SignerSafetyLimits,
): string | null {
  if (requestedTon <= 0) {
    return "Requested TON amount must be positive";
  }
  if (requestedTon > limits.maxSinglePurchaseTon) {
    return `Single purchase ${requestedTon} TON exceeds limit ${limits.maxSinglePurchaseTon} TON`;
  }
  if (todaySpendTon + requestedTon > limits.dailySpendLimitTon) {
    return `Daily spend would reach ${todaySpendTon + requestedTon} TON, limit is ${limits.dailySpendLimitTon} TON`;
  }
  if (walletBalanceTon - requestedTon < limits.minWalletBalanceTon) {
    return `Wallet balance after tx would be ${walletBalanceTon - requestedTon} TON, minimum reserve is ${limits.minWalletBalanceTon} TON`;
  }
  return null;
}

/**
 * Verify that a nonce has not been used before.
 * The caller must persist used nonces (in-memory set or DB).
 */
export function isNonceUsed(nonce: string, usedNonces: ReadonlySet<string>): boolean {
  return usedNonces.has(nonce);
}

/**
 * Check that a signing request timestamp is within an acceptable window.
 * Prevents replay of old requests.
 */
export function isTimestampValid(timestampMs: number, windowMs = 60_000): boolean {
  const diff = Math.abs(Date.now() - timestampMs);
  return diff <= windowMs;
}
