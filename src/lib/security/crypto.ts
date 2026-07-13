import "server-only";
import crypto from "node:crypto";
import { env } from "../env";

// AES-256-GCM encryption for supplier API keys at rest.
// Format: base64(iv).base64(authTag).base64(ciphertext)

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const hex = env.credentialsEncKey();
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error("CREDENTIALS_ENC_KEY must be 32 bytes (64 hex chars)");
  }
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const [ivB64, tagB64, dataB64] = blob.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted secret");
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

export function last4(secret: string): string {
  return secret.length <= 4 ? "••••" : `…${secret.slice(-4)}`;
}

/** Remove anything that looks like an API key/token from a string before logging. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(api[_-]?key|token|authorization|bearer)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[REDACTED]");
}
