// Run database regressions in a separate schema on the local development DB.
// Never starts the Telegram bot or contacts a payment provider.
import { spawnSync } from "node:child_process";
import { loadEnvFile } from "node:process";
try { loadEnvFile(); } catch {}
const url = new URL(process.env.DATABASE_URL || "");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  throw new Error("Audit tests require a local PostgreSQL database");
}
url.searchParams.set("schema", "audit_regression");
const env = { ...process.env, DATABASE_URL: url.toString(), AUDIT_DATABASE_URL: url.toString(), TELEGRAM_BOT_TOKEN: "", TELEGRAM_ADMIN_CHAT_ID: "" };
for (const args of [
  ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"],
  ["node_modules/vitest/vitest.mjs", "run", "tests/audit-db.test.ts"],
]) {
  const r = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
}
