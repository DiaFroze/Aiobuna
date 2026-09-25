// Pure domain logic for Support AI assistant.
// Tested in isolation: no DB, no network, no grammY dependencies.
// Handles language detection, fast greeting replies, escalation triggers,
// PII redaction, and response normalization.

export type Lang = "ru" | "uz" | "en";

export interface SupportAiCatalogItem {
  id?: number;
  product: string;
  plan: string;
  durationDays: number;
  priceUzs: number;
}

export interface SupportAiContext {
  language: Lang;
  customerName?: string | null;
  supportUsername?: string | null;
  cooperationUsername?: string | null;
  paymentCard?: string | null;
  paymentCardHolder?: string | null;
  botUsername?: string | null;
  catalog: SupportAiCatalogItem[];
  recentOrders: { title: string; status: string; priceUzs: number; createdAt: string }[];
  recentPayments: { amount: number; method: string; status: string; createdAt: string }[];
}

export interface SupportAiMessage {
  role: "user" | "assistant";
  text: string;
}

const UZ_LATIN_WORDS = new Set([
  "salom",
  "assalomu",
  "assalom",
  "alaykum",
  "aleykum",
  "valaykum",
  "kerak",
  "edi",
  "qanday",
  "qanaqa",
  "qancha",
  "nechpul",
  "narxi",
  "narx",
  "sotib",
  "olish",
  "olmoqchiman",
  "olmoqchi",
  "olaman",
  "olsam",
  "olaylik",
  "bormi",
  "bor",
  "ishlaydimi",
  "ishlamayapti",
  "to'lov",
  "tolov",
  "to‘lov",
  "pul",
  "kartaga",
  "karta",
  "plastik",
  "cheki",
  "chek",
  "menga",
  "bizga",
  "sizga",
  "sizda",
  "sizdan",
  "obuna",
  "obunasi",
  "akkaunt",
  "akkauntga",
  "akkauntim",
  "aka",
  "uka",
  "opa",
  "bro",
  "yordam",
  "iltimos",
  "rahmat",
  "hop",
  "mayli",
  "hozir",
  "tushunarli",
  "berasizmi",
  "bering",
  "mumkinmi",
  "boladimi",
  "bo'ladimi",
  "bo‘ladimi",
  "boladi",
  "bo'ladi",
  "bo‘ladi",
  "hamkorlik",
  "sheriklik",
  "ulgurji",
  "ha",
  "yoq",
  "yo'q",
  "yo‘q",
]);

const EN_WORDS = new Set([
  "hello",
  "hi",
  "hey",
  "how",
  "what",
  "where",
  "when",
  "can",
  "could",
  "buy",
  "purchase",
  "price",
  "cost",
  "need",
  "want",
  "subscription",
  "payment",
  "card",
  "help",
  "please",
  "thanks",
  "thank",
  "account",
  "issue",
  "problem",
  "order",
  "available",
  "partnership",
  "wholesale",
  "refund",
]);

/**
 * Detect language strictly from the current incoming message.
 * Falls back to profile language only when the current text is language-neutral
 * (e.g. only numbers, punctuation, or generic product names).
 */
export function detectMessageLanguage(text: string, fallback: Lang = "uz"): Lang {
  const clean = text.trim();
  if (!clean) return fallback;

  // Uzbek Cyrillic letters check: ў, қ, ғ, ҳ
  if (/[ўқғҳ]/i.test(clean)) return "uz";

  // Uzbek Cyrillic common words without relying on ASCII \b
  const lower = clean.toLowerCase();
  if (
    /(?:^|[^a-zа-яё0-9_])(ассалому|алайкум|салом|керак|қандай|қанча|нархи|сотиб|борми|тўлов|толов|ёрдам|илтимос|раҳмат|менга|сизга)(?:$|[^a-zа-яё0-9_])/i.test(
      lower,
    )
  ) {
    return "uz";
  }

  // General Russian Cyrillic
  if (/[а-яё]/i.test(clean)) return "ru";

  // Tokenize Latin words
  const tokens = lower
    .replace(/[^a-z0-9'‘’ʻ`]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  let uzScore = 0;
  let enScore = 0;

  for (const token of tokens) {
    if (UZ_LATIN_WORDS.has(token)) {
      uzScore += 2;
    } else if (
      token.includes("o'") ||
      token.includes("o‘") ||
      token.includes("oʻ") ||
      token.includes("g'") ||
      token.includes("g‘") ||
      token.includes("gʻ")
    ) {
      uzScore += 2;
    } else if (
      /(?:moqchiman|aylik|yapti|mizmi|sizmi|dami|dagi|imiz|ingiz|larda)$/i.test(token)
    ) {
      uzScore += 2;
    }

    if (EN_WORDS.has(token)) {
      enScore += 2;
    }
  }

  if (uzScore > 0 && uzScore >= enScore) return "uz";
  if (enScore > 0 && enScore > uzScore) return "en";

  return fallback;
}

/**
 * Check if the message is purely a greeting without a question or product request.
 */
export function isPureGreeting(text: string): boolean {
  const norm = text
    .trim()
    .toLowerCase()
    .replace(/[!?.,:;]+$/g, "")
    .trim();

  if (!norm) return false;

  // If text contains inquiry keywords, it's NOT a pure greeting
  if (
    /(?:kerak|sotib|narx|qancha|qanday|qanaqa|bormi|to'?lov|obuna|купить|цена|сколько|как|подписк|оплат|buy|price|cost|how|need|subscription)/i.test(
      norm,
    )
  ) {
    return false;
  }

  // Pure Uzbek greetings
  if (/^(?:salom|assalomu\s+alaykum|assalomu\s+aleykum|assalom\s+alaykum|va\s+alaykum\s+assalom|salom\s+aka|salom\s+bro|assalomu\s+alaykum\s+aka)$/i.test(norm)) {
    return true;
  }

  // Pure Russian greetings
  if (/^(?:привет|здравствуйте|здравствуй|добрый\s+день|добрый\s+вечер|доброе\s+утро|салам|салют)$/i.test(norm)) {
    return true;
  }

  // Pure English greetings
  if (/^(?:hello|hi|hey|good\s+morning|good\s+afternoon|good\s+evening)$/i.test(norm)) {
    return true;
  }

  return false;
}

/**
 * Instant natural greeting reply without waiting for Gemini or DB.
 */
export function quickGreetingReply(text: string, lang: Lang): string | null {
  if (!isPureGreeting(text)) return null;

  if (lang === "uz") {
    if (/assalom/i.test(text)) {
      return "Va alaykum assalom! Qaysi obuna kerak edi?";
    }
    return "Assalomu alaykum! Qaysi obuna yoki xizmat bo'yicha yordam beray?";
  }

  if (lang === "en") {
    return "Hi! Which subscription are you interested in? I can help with pricing and setup.";
  }

  const clean = text.trim().toLowerCase();
  if (/^привет(?:$|[^а-яё0-9_])/i.test(clean)) {
    return "Привет! Какая подписка интересует?";
  }
  return "Здравствуйте! Какая подписка вас интересует? Подскажу по тарифам и подключению.";
}

/**
 * Checks for partnership, wholesale, or business collaboration requests.
 */
export function isCooperationQuery(text: string): boolean {
  return /(?:сотруднич|партнёр|партнер|коллаб|опт\b|оптом|оптовые|hamkorlik|sheriklik|ulgurji|partnership|cooperation|wholesale|collab)/i.test(
    text,
  );
}

/**
 * Checks for payment problems, disputes, missing deliveries, or refunds.
 * Does not trigger on general questions about available payment methods.
 */
export function isPaymentIssueQuery(text: string): boolean {
  const norm = text.toLowerCase();

  // Exclude general "how to pay" questions
  if (
    /(?:to'?lov qanday|qanday to'?lov|to'?lov usullari|как оплатить|способы оплаты|как проходит оплата|how to pay|payment methods)/i.test(
      norm,
    )
  ) {
    return false;
  }

  return /(?:оплата не прошла|не прошла оплата|деньги списались|не приш|не получил|возврат|спорн|чек отправил|плат[её]ж не|to'lov o'tmadi|to‘lov o‘tmadi|pul yechildi|tushmadi|kelmadi|qaytar|qaytarib|refund|payment failed|paid but)/i.test(
    norm,
  );
}

/**
 * Checks if the text has no meaningful letters or expresses complete confusion.
 */
export function isUnclearQuery(text: string): boolean {
  const norm = text.trim();
  if (!norm) return true;
  // Only punctuation, symbols, or numbers
  if (!/[a-zа-яё]/i.test(norm)) return true;
  // Single letter
  if (norm.length <= 1) return true;
  return false;
}

/**
 * Checks whether an incoming message or AI response requires escalation to human admin.
 */
export function isEscalationQuery(text: string, answer?: string | null): boolean {
  if (isCooperationQuery(text)) return true;
  if (isPaymentIssueQuery(text)) return true;
  if (isUnclearQuery(text)) return true;
  if (
    answer &&
    /(?:не уверен|не знаю|не могу ответить|обратитесь к администратору|admin bilan bog'laning|administratorga yozing|not sure|contact the administrator)/i.test(
      answer,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Returns immediate deterministic escalation reply if query directly matches cooperation or payment issue.
 */
export function directEscalationReply(
  text: string,
  lang: Lang,
  cooperationUsername: string = "Abdulloh_ZokirovN",
): string | null {
  const cleanCoop = cooperationUsername.replace(/^@/, "").trim() || "Abdulloh_ZokirovN";

  if (isCooperationQuery(text)) {
    if (lang === "uz") {
      return `Hamkorlik va ulgurji savdo bo'yicha shaxsiy profilim @${cleanCoop} ga yozing, barcha shartlarni kelishamiz.`;
    }
    if (lang === "en") {
      return `For partnership and wholesale inquiries, please message me directly at @${cleanCoop}.`;
    }
    return `По вопросам сотрудничества и опта напишите мне в личку @${cleanCoop} — всё обсудим.`;
  }

  if (isPaymentIssueQuery(text)) {
    if (lang === "uz") {
      return `To'lov chekini shu yerga yuboring, hozir tekshirib darhol yordam beraman.`;
    }
    if (lang === "en") {
      return `Please send your payment receipt right here in this chat, and I will check and resolve it for you immediately.`;
    }
    return `Пожалуйста, отправьте чек об оплате прямо сюда в чат — я сразу проверю платёж и помогу.`;
  }

  return null;
}

/**
 * Response for completely unclear queries.
 */
export function unclearQueryReply(lang: Lang, _adminUsername?: string): string {
  if (lang === "uz") {
    return `Savolingizni aniqroq yozsangiz, yordam berishga harakat qilaman.`;
  }
  if (lang === "en") {
    return `Could you please clarify your question? I'll be glad to help.`;
  }
  return `Уточните, пожалуйста, ваш вопрос — с радостью подскажу.`;
}

/**
 * Polite fallback when Gemini API times out or is temporarily unavailable.
 */
export function fallbackSupportReply(lang: Lang, _adminUsername?: string): string {
  if (lang === "uz") {
    return `Hozir xabaringizni ko'rib chiqib, tezda javob beraman.`;
  }
  if (lang === "en") {
    return `I'll review your message and reply shortly.`;
  }
  return `Сейчас посмотрю ваше сообщение и скоро отвечу.`;
}

/**
 * Redacts personal identifiable data (emails, passwords, cards, phones, tokens)
 * before transmitting to external AI models or writing to admin logs.
 */
export function redactSupportText(text: string): string {
  return text
    // Account credentials: user@mail.com:password
    .replace(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*(?:----|::|\/)\s*\S+/gi, "[account-data]")
    // Emails
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    // 16-digit bank cards FIRST (before phone numbers capture 4-digit groups)
    .replace(/\b(?:\d{4}[\s-]?){3}\d{4}\b/g, "[card]")
    // Passwords, login codes
    .replace(/((?:парол\w*|password|pass|parol|код входа|login code|kod)\s*[:=]?\s*)\S+/gi, "$1[secret]")
    // Uzbek and international phone numbers
    .replace(/(?:\+?998[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/g, "[phone]")
    .replace(/\+\d{10,14}\b/g, "[phone]")
    // Links / URLs
    .replace(/https?:\/\/\S+/gi, "[link]");
}

/**
 * Strips role prefixes (Клиент:, Помощник:, Assistant:) or markdown quotes
 * accidentally produced by LLMs.
 */
export function cleanSupportReply(raw: string): string {
  return raw
    .replace(/^(?:клиент|помощник|оператор|ответ|assistant|customer|agent|bot|admin)\s*:\s*/gim, "")
    .replace(/^["'«»]+|["'«»]+$/g, "")
    .trim();
}
