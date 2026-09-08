import { sanitizeTextCustomEmojis, EMOJI_CHAR_TO_PREMIUM } from "@/lib/emoji/rich-text";

// Gemini vision client: verifies a payment receipt screenshot (Uzcard/Humo
// transfers) — extracts amount, recipient card, status, transaction id, and an
// authenticity/tamper assessment, then decides if it matches the expected payment.
// Requires GEMINI_API_KEY. No system is 100% fake-proof — anything not clearly
// valid is routed to manual admin review by the caller.

export interface ReceiptCheck {
  is_receipt: boolean;
  amount: number | null;
  recipient_card_last4: string | null;
  recipient_name: string | null;
  datetime: string | null;
  status_success: boolean;
  txn_id: string | null;
  looks_authentic: boolean;
  tamper_signs: string;
  confidence: number;
}

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

const LANG_NAME: Record<string, string> = { en: "английский", uz: "узбекский", ru: "русский" };

export interface Localized {
  titleRu: string;
  titleEn: string;
  titleUz: string;
  descRu: string;
  descEn: string;
  descUz: string;
}

/**
 * Produce a clean, human-readable product card in RU / EN / UZ from a supplier
 * title + description (which may be in any language). Returns null on failure so
 * the caller can fall back to the raw text.
 */
export async function geminiLocalize(name: string, description: string): Promise<Localized | null> {
  const key = process.env.GEMINI_API_KEY ?? "";
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  if (!key) return null;
  const prompt =
    `Ты — редактор карточек товаров цифрового магазина. Дан товар (название и описание, язык любой). ` +
    `Внимательно разбери смысл, условия и важные примечания. Сделай КРАСИВОЕ, понятное, аккуратно оформленное ` +
    `описание на трёх языках: русском, английском и узбекском (латиница). ` +
    `Сохрани все условия и предупреждения, оформи короткими строками/пунктами, можно <b>жирный</b> для подзаголовков. ` +
    `Названия брендов/продуктов (Gemini, ChatGPT, Steam и т.п.) НЕ переводи. Ничего не выдумывай и не добавляй от себя. ` +
    `Верни СТРОГО JSON: {"titleRu","titleEn","titleUz","descRu","descEn","descUz"}.\n\n` +
    `Название: ${name}\nОписание: ${description}`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      signal: AbortSignal.timeout(12000), // don't hang the bot on a slow Gemini
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const o = JSON.parse(text) as Partial<Localized>;
    return {
      titleRu: (o.titleRu || name).trim(),
      titleEn: (o.titleEn || name).trim(),
      titleUz: (o.titleUz || name).trim(),
      descRu: (o.descRu || description).trim(),
      descEn: (o.descEn || description).trim(),
      descUz: (o.descUz || description).trim(),
    };
  } catch {
    return null;
  }
}

/** Translate text (RU source) to a target language via Gemini. Returns "" on failure. */
export async function geminiTranslate(text: string, target: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY ?? "";
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  if (!key || !text.trim()) return "";
  const prompt =
    `Переведи текст на ${LANG_NAME[target] ?? target} язык. ` +
    `Верни ТОЛЬКО перевод, без пояснений и без кавычек. ` +
    `Сохрани HTML-теги (<b>, <i> и т.п.) и эмодзи как есть.\n\nТекст:\n${text}`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      signal: AbortSignal.timeout(12000), // don't hang the bot on a slow Gemini
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
    });
    if (!res.ok) return "";
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return (j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
  } catch {
    return "";
  }
}

export interface AiProductFormat {
  titleRu: string;
  titleUz: string;
  descRu: string;
  descUz: string;
  emoji: string;
  premiumEmoji: string;
}

function fixTgEmojiTags(text: string): string {
  if (!text) return "";
  const normalized = text.replace(/<tg-emoji\s+emoji-id="([^"]+)">([^<]+)<\/tg-emoji>/gi, (match, idAttr, inner) => {
    const idTrim = idAttr.trim();
    const innerTrim = inner.trim();
    if (/^\d{6,}$/.test(idTrim)) {
      return `<tg-emoji emoji-id="${idTrim}">${innerTrim}</tg-emoji>`;
    }
    if (/^\d{6,}$/.test(innerTrim)) {
      return `<tg-emoji emoji-id="${innerTrim}">${idTrim}</tg-emoji>`;
    }
    return match;
  });
  return sanitizeTextCustomEmojis(normalized);
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * AI-powered product card formatter using Gemini.
 * Generates beautiful, structured Telegram HTML descriptions with official
 * Telegram Premium animated emojis (<tg-emoji>) in both RU and UZ,
 * and picks or preserves the best matching emoji and custom_emoji_id.
 */
export async function geminiAiFormatProduct(
  name: string,
  description: string,
  currentEmoji?: string,
): Promise<AiProductFormat | null> {
  const key = process.env.GEMINI_API_KEY ?? "";
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  if (!key) return null;

  const allowedEmojis = `
- 5372917041193828849: 🚀 (Telegram Premium, скорость, буст)
- 5424972470023104089: 💎 (Diamond, Stars, премиум)
- 5375464961822695044: 🖤 или 🎬 (CapCut, видеомонтаж, темная тема)
- 5927026418616636353: 🧠 (ИИ, Gemini, ChatGPT, Claude, нейросети)
- 5359512328003941083: ⭐ (Звезда, подписка)
- 5895708410447401643: 🌟 (Telegram Stars)
- 5467512909909214089: 🎓 (Курсы, обучение, гайды)
- 5197288647275071607: 🛡 (VPN, безопасность, защита, гарантия)
- 5256251637646787356: 🎨 (Дизайн, Canva)
- 5256131095094652290: 🎯 (Цель, ключевые функции)
- 6283073379184415506: 🎁 (Подарок, бонус)
- 5278711610775457808: ✨ (Качество, магия, блеск)
- 5472164874886846427: 🔥 (Огонь, хит, популярное)
- 5231102735817918643: 👇 (Стрелка вниз к выбору тарифа)
`;

  const emojiHint = currentEmoji && currentEmoji !== "✨" ? `Текущий выбранный эмодзи: "${currentEmoji}". ОБЯЗАТЕЛЬНО сохрани его!` : "";

  const prompt = `Ты — профессиональный контент-маркетолог и редактор каталога цифровых товаров в Telegram-боте.
Твоя задача — красиво оформить карточку товара на русском (RU) и узбекском (UZ, латиница) языках с официальными анимированными Telegram Premium эмодзи (<tg-emoji>).

ДЛЯ ТЕКСТА РАЗРЕШЕНО ИСПОЛЬЗОВАТЬ ТОЛЬКО ЭТИ ОФИЦИАЛЬНЫЕ АНИМИРОВАННЫЕ EMOJI ID:
${allowedEmojis}

СТРОГИЕ ПРАВИЛА:
1. Теги эмодзи оформляй СТРОГО в виде: <tg-emoji emoji-id="ID">СИМВОЛ</tg-emoji>.
   Примеры:
   <tg-emoji emoji-id="5927026418616636353">🧠</tg-emoji>
   <tg-emoji emoji-id="5375464961822695044">🖤</tg-emoji>
   <tg-emoji emoji-id="5278711610775457808">✨</tg-emoji>
   <tg-emoji emoji-id="5197288647275071607">🛡</tg-emoji>
   <tg-emoji emoji-id="5231102735817918643">👇</tg-emoji>
2. Форматирование только HTML: <b>жирный</b>, <i>курсив</i>, <code>код</code>. НИКАКОГО Markdown (никаких **, ##, *, -)!
3. Переносы строк делай обычным \\n (никаких <p>, <br>).
4. Структура описания:
   - Заголовок с анимированным эмодзи.
   - Пункты преимуществ с красивыми эмодзи в начале каждой строки.
   - Условия/гарантия (если применимо).
   - В самом конце обязательный призыв выбрать тариф:
     На RU: <tg-emoji emoji-id="5231102735817918643">👇</tg-emoji> <b>Выберите нужный тариф ниже:</b>
     На UZ: <tg-emoji emoji-id="5231102735817918643">👇</tg-emoji> <b>Quyidan kerakli tarifni tanlang:</b>
5. Поля titleRu и titleUz должны быть ЧИСТЫМ текстом БЕЗ HTML-тегов и без <tg-emoji>.
6. Поле emoji должно быть 1 основным unicode-символом (например 🖤, 🧠, 🚀, 🛡).
7. Поле premiumEmoji должно быть соответствующим ID из списка выше.
8. Верни СТРОГО валидный JSON:
{
  "titleRu": "название на русском",
  "titleUz": "nomi o'zbekcha",
  "descRu": "красивое описание на русском с HTML и <tg-emoji>",
  "descUz": "o'zbekcha chiroyli tavsif HTML va <tg-emoji> bilan",
  "emoji": "основной эмодзи",
  "premiumEmoji": "ID кастомного эмодзи"
}

${emojiHint}
Название товара: ${name}
Исходное описание:
${description || name}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      signal: AbortSignal.timeout(18000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as Partial<AiProductFormat>;

    const cleanEmoji = (parsed.emoji || currentEmoji || "✨").trim();
    let premId = (parsed.premiumEmoji || "").trim();
    if (!premId && EMOJI_CHAR_TO_PREMIUM[cleanEmoji]) {
      premId = EMOJI_CHAR_TO_PREMIUM[cleanEmoji].id;
    }

    return {
      titleRu: stripHtml(parsed.titleRu || name),
      titleUz: stripHtml(parsed.titleUz || name),
      descRu: fixTgEmojiTags(parsed.descRu || description),
      descUz: fixTgEmojiTags(parsed.descUz || description),
      emoji: cleanEmoji,
      premiumEmoji: premId,
    };
  } catch (err) {
    console.error("geminiAiFormatProduct failed:", err);
    return null;
  }
}

export interface VerifyResult {
  raw: ReceiptCheck | null;
  ok: boolean;
  reason: string;
}

export async function verifyReceipt(
  imageBase64: string,
  mime: string,
  expected: { amount: number; cardLast4: string; cardName?: string },
): Promise<VerifyResult> {
  const key = process.env.GEMINI_API_KEY ?? "";
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  if (!key) return { raw: null, ok: false, reason: "no_key" };

  const prompt =
    `Ты — строгий проверяющий платёжные чеки (переводы Uzcard/Humo, узбекские банки/приложения). ` +
    `На изображении скриншот/фото перевода. Верни СТРОГО JSON (без markdown, без пояснений) с полями: ` +
    `is_receipt(boolean — это действительно чек перевода), amount(number — сумма в сумах, только цифры), ` +
    `recipient_card_last4(string|null — последние 4 цифры карты ПОЛУЧАТЕЛЯ), recipient_name(string|null), ` +
    `datetime(string|null — дата и время операции), status_success(boolean — перевод помечен как успешный/выполнен), ` +
    `txn_id(string|null — номер чека/транзакции), looks_authentic(boolean — похоже на настоящий неотредактированный скриншот), ` +
    `tamper_signs(string — конкретные признаки подделки/редактирования или ""), confidence(number 0..1). ` +
    `Ожидается: сумма ${expected.amount} сум, карта получателя оканчивается на ${expected.cardLast4}` +
    (expected.cardName ? `, получатель ${expected.cardName}` : "") +
    `. Ищи подделки очень внимательно: несовпадение шрифтов/выравнивания, артефакты редактирования, странные цифры, отсутствие статуса успеха, повторно использованный старый чек.`;

  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: imageBase64 } }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  };

  let raw: ReceiptCheck;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      signal: AbortSignal.timeout(12000), // don't hang the bot on a slow Gemini
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      error?: { message?: string };
    };
    if (!res.ok) return { raw: null, ok: false, reason: `api_${res.status}: ${j?.error?.message ?? ""}`.slice(0, 200) };
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    raw = JSON.parse(text) as ReceiptCheck;
  } catch (e) {
    return { raw: null, ok: false, reason: `error: ${(e as Error).message}` };
  }

  const amountOk = raw.amount != null && Math.abs(Number(raw.amount) - expected.amount) < 1;
  const cardOk = !!raw.recipient_card_last4 && raw.recipient_card_last4.replace(/\D/g, "").endsWith(expected.cardLast4);
  const ok =
    !!raw.is_receipt && !!raw.status_success && !!raw.looks_authentic && (Number(raw.confidence) || 0) >= 0.8 && amountOk && cardOk;
  const reason = ok
    ? "ok"
    : [
        !raw.is_receipt && "не чек",
        !raw.status_success && "нет статуса успеха",
        !raw.looks_authentic && "подозрение на подделку",
        (Number(raw.confidence) || 0) < 0.8 && "низкая уверенность",
        !amountOk && "сумма не совпадает",
        !cardOk && "карта не совпадает",
      ]
        .filter(Boolean)
        .join(", ");
  return { raw, ok, reason };
}
