import { geminiSupportReply, type SupportAiContext } from "../src/lib/gemini";
import {
  detectMessageLanguage,
  quickGreetingReply,
  directEscalationReply,
  unclearQueryReply,
  isUnclearQuery,
  isEscalationQuery,
} from "../src/lib/domain/support-ai";

const context: SupportAiContext = {
  language: "uz",
  customerName: "TestUser",
  supportUsername: "Abdulloh_Zokirov",
  botUsername: "Aiobunabot",
  catalog: [
    { product: "Gemini AI Pro 18m", plan: "Тарифы", durationDays: 540, priceUzs: 6048 },
    { product: "Telegram Premium", plan: "3 месяца", durationDays: 90, priceUzs: 150000 },
  ],
  recentOrders: [],
  recentPayments: [],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const customerScenarios = [
  { q: "salom aka", desc: "Быстрое приветствие на узбекском" },
  { q: "Assalomu alaykum", desc: "Классическое приветствие" },
  { q: "Привет", desc: "Приветствие на русском" },
  { q: "Gemini bormi narxi qancha?", desc: "Вопрос о наличии и цене" },
  { q: "Qanday sotib olaman?", desc: "Вопрос о процессе покупки" },
  { q: "O'z akkauntimga ulasa bo'ladimi?", desc: "Вопрос о привязке к личному аккаунту" },
  { q: "Parol berishim kerakmi?", desc: "Вопрос о безопасности и пароле" },
  { q: "Aktivatsiya qanday bo'ladi?", desc: "Инструкция по активации" },
  { q: "Link ochilmayapti, xato beryapti", desc: "Проблема с активационной ссылкой" },
  { q: "Hamkorlik qilmoqchiman", desc: "Сотрудничество / партнёрство" },
  { q: "Как купить Gemini?", desc: "Покупка на русском языке" },
  { q: "Подключается к моей почте или даёте готовый аккаунт?", desc: "Личный или готовый аккаунт (RU)" },
  { q: "Пароль от почты нужен?", desc: "Вопрос о пароле (RU)" },
  { q: "Как проходит активация?", desc: "Процесс активации (RU)" },
  { q: "Оплата не прошла, деньги списались", desc: "Проблема с оплатой (RU)" },
  { q: "How can I buy Gemini?", desc: "Покупка на английском" },
  { q: "Do I need to give you my Google password?", desc: "Вопрос о пароле на английском" },
  { q: "???", desc: "Непонятный запрос" },
];

async function runBenchmark() {
  console.log("================================================================================");
  console.log("       AI SUPPORT BENCHMARK & STYLE EVALUATION (Live Gemini Model)             ");
  console.log("================================================================================");

  for (let i = 0; i < customerScenarios.length; i++) {
    const item = customerScenarios[i];
    const t0 = Date.now();
    const lang = detectMessageLanguage(item.q, "uz");
    const ctx = { ...context, language: lang };

    let reply = "";
    let method = "";

    const quick = quickGreetingReply(item.q, lang);
    if (quick) {
      reply = quick;
      method = "fast_greeting";
    } else {
      const direct = directEscalationReply(item.q, lang, ctx.supportUsername || "Abdulloh_Zokirov");
      if (direct) {
        reply = direct;
        method = "direct_escalation";
      } else if (isUnclearQuery(item.q)) {
        reply = unclearQueryReply(lang, ctx.supportUsername || "Abdulloh_Zokirov");
        method = "unclear_query";
      } else {
        reply = (await geminiSupportReply(item.q, [], ctx)) || "";
        method = "gemini_model";
        await sleep(2500); // Respect free-tier rate limits (15 RPM) between live model requests
      }
    }
    const elapsed = Date.now() - t0;
    const escalated = isEscalationQuery(item.q, reply);

    console.log(`\n[${i + 1}/${customerScenarios.length}] ${item.desc}`);
    console.log(`👤 Клиент: "${item.q}" (${lang})`);
    console.log(`🤖 AI:     "${reply}"`);
    console.log(`⏱️ Время:  ${elapsed}ms | Метод: ${method} | Передано админу: ${escalated ? "ДА" : "нет"}`);
  }
  console.log("\n================================================================================");
  console.log("                              BENCHMARK FINISHED                                ");
  console.log("================================================================================");
}

runBenchmark().catch((err) => console.error("Benchmark failed:", err));
