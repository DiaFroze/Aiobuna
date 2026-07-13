import crypto from "crypto";

const SALT = "aio_secret_salt_order_verification_key";

/**
 * Generate a unique verification code for an order.
 * Format: SB-ID-HASH (e.g. SB-123-A4B7D2)
 */
export function generateVerificationCode(orderId: number): string {
  const hash = crypto
    .createHash("sha256")
    .update(String(orderId) + SALT)
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();
  return `SB-${orderId}-${hash}`;
}

/**
 * Parse and validate a verification code.
 */
export function parseVerificationCode(code: string): { orderId: number; isValid: boolean } {
  const clean = code.trim().toUpperCase();
  const parts = clean.split("-");
  if (parts.length !== 3 || parts[0] !== "SB") {
    return { orderId: 0, isValid: false };
  }
  const orderId = Number(parts[1]);
  if (!orderId || isNaN(orderId)) {
    return { orderId: 0, isValid: false };
  }
  const expectedHash = crypto
    .createHash("sha256")
    .update(String(orderId) + SALT)
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();

  return {
    orderId,
    isValid: parts[2] === expectedHash,
  };
}
