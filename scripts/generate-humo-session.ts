// One-off CLI tool to generate a GramJS StringSession for HUMO Card MTProto monitor.
// Usage: npm run humo:session
// Interactive prompt: phone number, telegram login code, 2FA password.
// Outputs: TELEGRAM_SESSION="..." for .env.
// NEVER logs or saves credentials or session to files or Git.

import readline from "node:readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
} catch {
  // .env is optional
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  console.log("\n=======================================================");
  console.log("  AI OBUNA — Генератор Telegram MTProto Сессии (GramJS) ");
  console.log("=======================================================\n");

  // Read from environment (supporting Appapi_id / Appapi_hash fallback)
  let rawApiId = process.env.TELEGRAM_API_ID || (process.env as any).Appapi_id;
  let rawApiHash = process.env.TELEGRAM_API_HASH || (process.env as any).Appapi_hash;

  let apiId = Number.parseInt(String(rawApiId || "").trim(), 10);
  let apiHash = String(rawApiHash || "").trim();

  if (!apiId || isNaN(apiId)) {
    const inputId = await ask("Введите TELEGRAM_API_ID (число из https://my.telegram.org): ");
    apiId = Number.parseInt(inputId.trim(), 10);
  }

  if (!apiHash) {
    const inputHash = await ask("Введите TELEGRAM_API_HASH (строка из https://my.telegram.org): ");
    apiHash = inputHash.trim();
  }

  if (!apiId || isNaN(apiId) || !apiHash) {
    console.error("❌ Ошибка: Не указан корректный TELEGRAM_API_ID или TELEGRAM_API_HASH.");
    rl.close();
    process.exit(1);
  }

  console.log("\nПодключение к серверам Telegram...");

  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.start({
      phoneNumber: async () => {
        const phone = await ask("\n📱 Введите номер телефона (в международном формате, напр. +998901234567): ");
        return phone.trim();
      },
      phoneCode: async () => {
        const code = await ask("\n💬 Введите проверочный код, полученный в Telegram: ");
        return code.trim();
      },
      password: async () => {
        const pass = await ask("\n🔐 Введите пароль двухфакторной аутентификации (2FA), если установлен: ");
        return pass.trim();
      },
      onError: (err: any) => {
        console.error("⚠️ Ошибка авторизации:", err.message || err);
      },
    });

    const savedSession = client.session.save() as unknown as string;

    console.log("\n=======================================================");
    console.log("✅ Успешная авторизация!");
    console.log("Скопируйте строку ниже и добавьте её в файл .env или переменные Railway:");
    console.log("=======================================================\n");
    console.log(`TELEGRAM_SESSION="${savedSession}"\n`);
    console.log("=======================================================");
    console.log("⚠️ Заметка: Никому не передавайте эту строку сессии.");
  } catch (err: any) {
    console.error("\n❌ Ошибка создания сессии:", err.message || err);
  } finally {
    rl.close();
    try {
      await client.disconnect();
    } catch {}
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("Критическая ошибка:", e.message || e);
  process.exit(1);
});
