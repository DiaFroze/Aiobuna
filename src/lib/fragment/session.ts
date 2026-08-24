// Fragment session — encrypted storage for Fragment cookies/session data.
//
// Fragment authenticates via session cookies. Those cookies are sensitive —
// anyone who has them can make purchases on our Fragment account. They are
// encrypted at rest with AES-256-GCM using a dedicated key separate from the
// supplier credential key.
//
// The session is stored in the BotSetting table as an encrypted blob.
// It is never logged, never committed, never printed.

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const SETTING_KEY = "fragment_session";

// ---- Encryption / decryption (standalone, no server-only import) ------------
// These are pure functions that take the key as a parameter so they can be
// tested without process.env.

export function encryptSession(plaintext: string, keyHex: string): string {
  const keyBuf = Buffer.from(keyHex, "hex");
  if (keyBuf.length !== 32) {
    throw new Error("FRAGMENT_SESSION_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyBuf, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSession(blob: string, keyHex: string): string {
  const keyBuf = Buffer.from(keyHex, "hex");
  if (keyBuf.length !== 32) {
    throw new Error("FRAGMENT_SESSION_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }
  const [ivB64, tagB64, dataB64] = blob.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted session blob");
  }
  const decipher = crypto.createDecipheriv(ALGO, keyBuf, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

// ---- Session data structure -------------------------------------------------

export interface FragmentSessionData {
  /** Cookie jar — raw Set-Cookie header values from Fragment auth. */
  cookies: string[];
  /** When this session was created / last refreshed. */
  createdAt: number;
  /** When the session was last validated (successful API call). */
  lastValidatedAt: number;
  /** The Fragment account username or phone, for audit. */
  accountHint: string;
}

export function serializeSession(data: FragmentSessionData): string {
  return JSON.stringify(data);
}

export function deserializeSession(json: string): FragmentSessionData {
  const parsed = JSON.parse(json);
  if (!parsed || !Array.isArray(parsed.cookies)) {
    throw new Error("Invalid session data structure");
  }
  return parsed as FragmentSessionData;
}

// ---- DB persistence helpers -------------------------------------------------
// These read/write the encrypted session blob via the BotSetting table.
// The db parameter is typed loosely to avoid importing Prisma here.

type BotSettingStore = {
  findUnique(args: { where: { key: string } }): Promise<{ valueRu: string } | null>;
  upsert(args: {
    where: { key: string };
    create: { key: string; valueRu: string };
    update: { valueRu: string };
  }): Promise<unknown>;
};

export async function loadSession(
  db: { botSetting: BotSettingStore },
  encryptionKey: string,
): Promise<FragmentSessionData | null> {
  const row = await db.botSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row || !row.valueRu) return null;
  try {
    const json = decryptSession(row.valueRu, encryptionKey);
    return deserializeSession(json);
  } catch {
    // Corrupt or wrong key — treat as no session.
    return null;
  }
}

export async function saveSession(
  db: { botSetting: BotSettingStore },
  encryptionKey: string,
  data: FragmentSessionData,
): Promise<void> {
  const json = serializeSession(data);
  const encrypted = encryptSession(json, encryptionKey);
  await db.botSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, valueRu: encrypted },
    update: { valueRu: encrypted },
  });
}

export async function clearSession(
  db: { botSetting: BotSettingStore },
): Promise<void> {
  await db.botSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, valueRu: "" },
    update: { valueRu: "" },
  });
}

// ---- Session health ---------------------------------------------------------

/** Returns true if the session looks fresh enough to use without re-auth. */
export function isSessionFresh(data: FragmentSessionData, maxAgeMs = 12 * 60 * 60_000): boolean {
  if (!data.cookies.length) return false;
  const age = Date.now() - data.lastValidatedAt;
  return age < maxAgeMs;
}
