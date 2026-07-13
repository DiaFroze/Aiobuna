import { spawn } from "child_process";

// Run DB migrations/sync on start
console.log("⚙️ Syncing database schema...");
const pushMain = spawn("npx", ["prisma", "db", "push", "--accept-data-loss"], { stdio: "inherit", shell: true });

pushMain.on("close", (code) => {
  if (code !== 0) {
    console.error("❌ Failed to sync database schema");
    process.exit(1);
  }

  console.log("🚀 Starting both Next.js App and Telegram Bot...");

  // Start Next.js App
  const nextApp = spawn("npx", ["next", "start", "-p", process.env.PORT || "3000"], { stdio: "inherit", shell: true });

  // Start Telegram Bot
  const tgBot = spawn("npx", ["tsx", "--conditions=react-server", "src/bot/index.ts"], { stdio: "inherit", shell: true });

  // Handle termination
  const terminate = () => {
    console.log("👋 Shutting down...");
    nextApp.kill();
    tgBot.kill();
    process.exit(0);
  };

  process.on("SIGINT", terminate);
  process.on("SIGTERM", terminate);
});
