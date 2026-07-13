// Local dev Postgres via a prebuilt binary (no Docker, no source compile).
// Keeps running until stopped. Matches DATABASE_URL in .env:
//   postgresql://app:app@localhost:5432/digital_goods
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const databaseDir = join(root, ".pgdata");

const pg = new EmbeddedPostgres({
  databaseDir,
  user: "app",
  password: "app",
  port: 5432,
  persistent: true,
});

if (!existsSync(join(databaseDir, "PG_VERSION"))) {
  console.log("[dev-db] initialising cluster…");
  await pg.initialise();
}
console.log("[dev-db] starting postgres on :5432 …");
await pg.start();
try {
  await pg.createDatabase("digital_goods");
  console.log("[dev-db] created database digital_goods");
} catch {
  console.log("[dev-db] database digital_goods already exists (ok)");
}
console.log("[dev-db] READY postgresql://app:app@localhost:5432/digital_goods");

async function shutdown() {
  try {
    await pg.stop();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 1 << 30); // keep alive
