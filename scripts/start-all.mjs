import { spawn } from "child_process";
import { decideOnChildExit, decideOnChildError } from "./supervisor.mjs";

// Bring the database in line with the schema before serving anything.
//
// NOTE: this deliberately does NOT pass --accept-data-loss. Auto-accepting
// destructive changes means a schema drift can silently drop a column (and the
// data in it) on an ordinary deploy. Without the flag, Prisma refuses instead,
// this script exits non-zero, and the deploy fails loudly — fail closed, not
// fail silent. If a genuinely destructive migration is ever intended, run it
// deliberately and once, not from the container's start command.
console.log("⚙️ Syncing database schema...");
const pushMain = spawn("npx", ["prisma", "db", "push"], { stdio: "inherit", shell: true });

pushMain.on("close", (code) => {
  if (code !== 0) {
    console.error(
      "❌ Failed to sync database schema.\n" +
      "   If Prisma reported a destructive change, do NOT re-run this with\n" +
      "   --accept-data-loss: inspect the drift first, it can drop data.",
    );
    process.exit(1);
  }

  console.log("🚀 Starting both Next.js App and Telegram Bot...");

  let shuttingDown = false;

  const nextApp = spawn("npx", ["next", "start", "-p", process.env.PORT || "3000"], { stdio: "inherit", shell: true });
  const tgBot = spawn("npx", ["tsx", "--conditions=react-server", "src/bot/index.ts"], { stdio: "inherit", shell: true });

  const children = [
    { name: "next", proc: nextApp },
    { name: "bot", proc: tgBot },
  ];

  // Supervise both children. Previously nothing listened here: if the bot
  // crashed, the parent and the web server stayed up, so the platform kept
  // reporting a healthy deploy while the shop quietly stopped selling.
  for (const { name, proc } of children) {
    proc.on("exit", (code, signal) => {
      const d = decideOnChildExit({ name, code, signal, shuttingDown });
      if (d.action === "ignore") return;
      console.error(`❌ ${d.reason} — shutting down so the platform can restart us.`);
      shuttingDown = true;
      for (const other of children) if (other.proc !== proc) other.proc.kill("SIGTERM");
      process.exit(d.code);
    });
    proc.on("error", (err) => {
      const d = decideOnChildError({ name, message: err.message, shuttingDown });
      if (d.action === "ignore") return;
      console.error(`❌ ${d.reason}`);
      shuttingDown = true;
      for (const other of children) if (other.proc !== proc) other.proc.kill("SIGTERM");
      process.exit(d.code);
    });
  }

  // Platform shutdown: pass the signal on so each child can close its database
  // and Redis connections, then leave. The exit handlers above stay quiet
  // because shuttingDown is set first.
  const terminate = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`👋 ${signal} received — shutting down...`);
    for (const { proc } of children) proc.kill(signal);
    // Give the children a moment to exit cleanly, then stop regardless.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGINT", () => terminate("SIGINT"));
  process.on("SIGTERM", () => terminate("SIGTERM"));
});
