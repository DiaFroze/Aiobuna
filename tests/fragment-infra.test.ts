// Tests for Fragment infrastructure: session encryption, error classifier, HMAC auth.

import { describe, it, expect } from "vitest";
import {
  encryptSession,
  decryptSession,
  serializeSession,
  deserializeSession,
  isSessionFresh,
  type FragmentSessionData,
} from "../src/lib/fragment/session";
import {
  FragmentError,
  FragmentErrorCategory,
  classifyFragmentError,
} from "../src/lib/fragment/errors";
import {
  FragmentOrderState,
  SAFE_RETRY_STATES,
  POST_SIGN_STATES,
  TERMINAL_STATES,
} from "../src/lib/fragment/types";
import {
  signRequest,
  verifyRequest,
  hashBody,
} from "../src/lib/fragment/hmac";
import {
  checkSignerSafety,
  isNonceUsed,
  isTimestampValid,
} from "../src/lib/ton-signer/index";
import crypto from "node:crypto";

// ---- Session encryption -----------------------------------------------------

describe("Fragment session encryption", () => {
  const testKey = crypto.randomBytes(32).toString("hex");

  it("encrypts and decrypts a session round-trip", () => {
    const plain = JSON.stringify({ cookies: ["a=b"], createdAt: 1 });
    const encrypted = encryptSession(plain, testKey);
    expect(encrypted).not.toBe(plain);
    expect(encrypted.split(".")).toHaveLength(3);
    const decrypted = decryptSession(encrypted, testKey);
    expect(decrypted).toBe(plain);
  });

  it("rejects a wrong key", () => {
    const plain = "secret-data";
    const encrypted = encryptSession(plain, testKey);
    const wrongKey = crypto.randomBytes(32).toString("hex");
    expect(() => decryptSession(encrypted, wrongKey)).toThrow();
  });

  it("rejects a malformed blob", () => {
    expect(() => decryptSession("not.valid", testKey)).toThrow("Malformed");
    expect(() => decryptSession("", testKey)).toThrow("Malformed");
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => encryptSession("x", "abcd")).toThrow("32 bytes");
    expect(() => decryptSession("a.b.c", "abcd")).toThrow("32 bytes");
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const plain = "same-input";
    const a = encryptSession(plain, testKey);
    const b = encryptSession(plain, testKey);
    expect(a).not.toBe(b);
    expect(decryptSession(a, testKey)).toBe(plain);
    expect(decryptSession(b, testKey)).toBe(plain);
  });
});

describe("Fragment session data", () => {
  it("serializes and deserializes", () => {
    const data: FragmentSessionData = {
      cookies: ["stel_token=abc", "stel_ssid=xyz"],
      createdAt: Date.now(),
      lastValidatedAt: Date.now(),
      accountHint: "+998*****42",
    };
    const json = serializeSession(data);
    const back = deserializeSession(json);
    expect(back.cookies).toEqual(data.cookies);
    expect(back.accountHint).toBe(data.accountHint);
  });

  it("rejects invalid session data", () => {
    expect(() => deserializeSession("{}")).toThrow("Invalid");
    expect(() => deserializeSession("{\"cookies\":\"not-array\"}")).toThrow("Invalid");
  });

  it("isSessionFresh returns true for recent session", () => {
    const data: FragmentSessionData = {
      cookies: ["x=y"],
      createdAt: Date.now(),
      lastValidatedAt: Date.now(),
      accountHint: "test",
    };
    expect(isSessionFresh(data)).toBe(true);
  });

  it("isSessionFresh returns false for expired session", () => {
    const data: FragmentSessionData = {
      cookies: ["x=y"],
      createdAt: Date.now() - 24 * 60 * 60_000,
      lastValidatedAt: Date.now() - 24 * 60 * 60_000,
      accountHint: "test",
    };
    expect(isSessionFresh(data)).toBe(false);
  });

  it("isSessionFresh returns false for empty cookies", () => {
    const data: FragmentSessionData = {
      cookies: [],
      createdAt: Date.now(),
      lastValidatedAt: Date.now(),
      accountHint: "test",
    };
    expect(isSessionFresh(data)).toBe(false);
  });
});

// ---- Error classifier -------------------------------------------------------

describe("Fragment error classifier", () => {
  it("passes through existing FragmentError", () => {
    const orig = new FragmentError(FragmentErrorCategory.AUTH_EXPIRED, "test");
    expect(classifyFragmentError(orig)).toBe(orig);
  });

  it("classifies 401 as AUTH_EXPIRED", () => {
    const err = classifyFragmentError(new Error("HTTP 401 Unauthorized"));
    expect(err.category).toBe(FragmentErrorCategory.AUTH_EXPIRED);
    expect(err.retryable).toBe(true);
    expect(err.postSign).toBe(false);
  });

  it("classifies rate limit as RATE_LIMIT", () => {
    const err = classifyFragmentError(new Error("429 Too Many Requests"));
    expect(err.category).toBe(FragmentErrorCategory.RATE_LIMIT);
    expect(err.retryable).toBe(true);
  });

  it("classifies hash mismatch as HASH_STALE", () => {
    const err = classifyFragmentError(new Error("hash invalid or stale"));
    expect(err.category).toBe(FragmentErrorCategory.HASH_STALE);
    expect(err.retryable).toBe(true);
  });

  it("classifies recipient not found", () => {
    const err = classifyFragmentError(new Error("Recipient not found"));
    expect(err.category).toBe(FragmentErrorCategory.RECIPIENT_NOT_FOUND);
    expect(err.retryable).toBe(false);
  });

  it("classifies broadcast failure as post-sign", () => {
    const err = classifyFragmentError(new Error("send_boc failed"));
    expect(err.category).toBe(FragmentErrorCategory.TON_BROADCAST_FAILED);
    expect(err.postSign).toBe(true);
    expect(err.retryable).toBe(false);
  });

  it("classifies unknown errors", () => {
    const err = classifyFragmentError(new Error("something weird"));
    expect(err.category).toBe(FragmentErrorCategory.UNKNOWN);
    expect(err.retryable).toBe(false);
  });

  it("classifies string errors", () => {
    const err = classifyFragmentError("auth failed 401");
    expect(err.category).toBe(FragmentErrorCategory.AUTH_EXPIRED);
  });
});

// ---- Order state sets -------------------------------------------------------

describe("Fragment order state sets", () => {
  it("SAFE_RETRY_STATES does not overlap with POST_SIGN_STATES", () => {
    for (const s of SAFE_RETRY_STATES) {
      expect(POST_SIGN_STATES.has(s)).toBe(false);
    }
  });

  it("TERMINAL_STATES does not include any SAFE_RETRY state", () => {
    for (const s of TERMINAL_STATES) {
      expect(SAFE_RETRY_STATES.has(s)).toBe(false);
    }
  });

  it("COMPLETED is both POST_SIGN and TERMINAL", () => {
    expect(POST_SIGN_STATES.has(FragmentOrderState.COMPLETED)).toBe(true);
    expect(TERMINAL_STATES.has(FragmentOrderState.COMPLETED)).toBe(true);
  });
});

// ---- HMAC auth --------------------------------------------------------------

describe("HMAC auth", () => {
  const secret = "test-shared-secret-for-hmac";
  const body = JSON.stringify({ orderId: 1, amount: "1.5" });

  it("sign and verify round-trip succeeds", () => {
    const nonces = new Set<string>();
    const header = signRequest(body, secret);
    const result = verifyRequest(header, body, secret, nonces);
    expect(result).toBeNull();
  });

  it("rejects wrong secret", () => {
    const nonces = new Set<string>();
    const header = signRequest(body, secret);
    const result = verifyRequest(header, body, "wrong-secret", nonces);
    expect(result).toBe("Signature mismatch");
  });

  it("rejects altered body", () => {
    const nonces = new Set<string>();
    const header = signRequest(body, secret);
    const result = verifyRequest(header, '{"orderId":2}', secret, nonces);
    expect(result).toBe("Signature mismatch");
  });

  it("rejects replayed nonce", () => {
    const nonces = new Set<string>();
    const nonce = "fixed-nonce";
    const ts = Date.now();
    const header = signRequest(body, secret, nonce, ts);
    // First use succeeds
    expect(verifyRequest(header, body, secret, nonces)).toBeNull();
    // Replay fails
    expect(verifyRequest(header, body, secret, nonces)).toBe("Nonce already used");
  });

  it("rejects expired timestamp", () => {
    const nonces = new Set<string>();
    const nonce = "old-nonce";
    const ts = Date.now() - 120_000; // 2 minutes ago
    const header = signRequest(body, secret, nonce, ts);
    const result = verifyRequest(header, body, secret, nonces);
    expect(result).toContain("replay window");
  });

  it("rejects invalid auth scheme", () => {
    const nonces = new Set<string>();
    const result = verifyRequest("Bearer xyz", body, secret, nonces);
    expect(result).toBe("Invalid auth scheme");
  });

  it("hashBody produces consistent output", () => {
    const h1 = hashBody("test");
    const h2 = hashBody("test");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex
  });
});

// ---- Signer safety checks ---------------------------------------------------

describe("Signer safety checks", () => {
  const limits = {
    maxSinglePurchaseTon: 50,
    dailySpendLimitTon: 200,
    minWalletBalanceTon: 1,
  };

  it("accepts a valid request", () => {
    expect(checkSignerSafety(10, 100, 50, limits)).toBeNull();
  });

  it("rejects zero amount", () => {
    expect(checkSignerSafety(0, 100, 0, limits)).toContain("positive");
  });

  it("rejects exceeding single purchase limit", () => {
    expect(checkSignerSafety(51, 100, 0, limits)).toContain("Single purchase");
  });

  it("rejects exceeding daily spend limit", () => {
    expect(checkSignerSafety(10, 100, 195, limits)).toContain("Daily spend");
  });

  it("rejects dropping below minimum balance", () => {
    expect(checkSignerSafety(10, 10.5, 0, limits)).toContain("reserve");
  });

  it("nonce tracking works", () => {
    const used = new Set(["abc"]);
    expect(isNonceUsed("abc", used)).toBe(true);
    expect(isNonceUsed("xyz", used)).toBe(false);
  });

  it("timestamp validation works", () => {
    expect(isTimestampValid(Date.now())).toBe(true);
    expect(isTimestampValid(Date.now() - 120_000)).toBe(false);
    expect(isTimestampValid(Date.now() + 120_000)).toBe(false);
  });
});
