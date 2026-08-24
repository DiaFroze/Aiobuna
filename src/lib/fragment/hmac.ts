// HMAC authentication for internal Gateway → Signer communication.
//
// Every request from the Fragment Gateway to the Wallet Signer is signed with
// HMAC-SHA256 using a shared secret (FRAGMENT_SIGNER_SHARED_SECRET). The signer
// verifies the signature before processing any signing request.
//
// This prevents an attacker who gains network access from issuing arbitrary
// signing requests — they would need the shared secret too.

import crypto from "node:crypto";

const ALGORITHM = "sha256";
const REPLAY_WINDOW_MS = 60_000; // 60 seconds

/**
 * Build the HMAC signature payload. The signature covers the timestamp, nonce,
 * and a SHA-256 hash of the request body — so altering any field invalidates it.
 */
function buildSignaturePayload(timestamp: number, nonce: string, bodyHash: string): string {
  return `${timestamp}.${nonce}.${bodyHash}`;
}

/**
 * Hash the request body for inclusion in the HMAC payload.
 */
export function hashBody(body: string): string {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Sign a request. Returns the Authorization header value.
 * Format: `HMAC-SHA256 ts=<timestamp>,nonce=<nonce>,sig=<hex>`
 */
export function signRequest(body: string, sharedSecret: string, nonce?: string, timestamp?: number): string {
  const ts = timestamp ?? Date.now();
  const n = nonce ?? crypto.randomBytes(16).toString("hex");
  const bh = hashBody(body);
  const payload = buildSignaturePayload(ts, n, bh);
  const sig = crypto.createHmac(ALGORITHM, sharedSecret).update(payload).digest("hex");
  return `HMAC-SHA256 ts=${ts},nonce=${n},sig=${sig}`;
}

/**
 * Parse and verify an HMAC-signed request.
 * Returns null if valid, or an error message if rejected.
 */
export function verifyRequest(
  authHeader: string,
  body: string,
  sharedSecret: string,
  usedNonces: Set<string>,
  replayWindowMs = REPLAY_WINDOW_MS,
): string | null {
  // Parse header
  if (!authHeader.startsWith("HMAC-SHA256 ")) {
    return "Invalid auth scheme";
  }
  const parts = authHeader.slice("HMAC-SHA256 ".length);
  const fields: Record<string, string> = {};
  for (const pair of parts.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    fields[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }

  const ts = Number(fields.ts);
  const nonce = fields.nonce;
  const sig = fields.sig;

  if (!ts || !nonce || !sig) {
    return "Missing ts, nonce, or sig";
  }

  // Replay window
  const age = Math.abs(Date.now() - ts);
  if (age > replayWindowMs) {
    return `Timestamp outside replay window (${age}ms > ${replayWindowMs}ms)`;
  }

  // Nonce uniqueness
  if (usedNonces.has(nonce)) {
    return "Nonce already used";
  }

  // Recompute signature
  const bh = hashBody(body);
  const payload = buildSignaturePayload(ts, nonce, bh);
  const expected = crypto.createHmac(ALGORITHM, sharedSecret).update(payload).digest("hex");

  // Constant-time comparison
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return "Signature mismatch";
  }

  // Accept — record nonce
  usedNonces.add(nonce);

  // Prune old nonces periodically (keep set bounded)
  if (usedNonces.size > 10_000) {
    const iter = usedNonces.values();
    for (let i = 0; i < 5_000; i++) iter.next();
    // Can't efficiently prune a Set by age without timestamps, so just clear
    // the oldest half. The replay window protects against actual replays.
    const keep = new Set<string>();
    for (const v of iter) keep.add(v);
    usedNonces.clear();
    for (const v of keep) usedNonces.add(v);
  }

  return null;
}
