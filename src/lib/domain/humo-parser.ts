// Parser for HUMO Card notifications from Telegram chat/channel
// Extracts operation type (deposit vs debit), amount in UZS, cardLast4, timestamp, and sanitized summary.

export interface ParsedHumoNotification {
  isDeposit: boolean;
  operationType: "deposit" | "debit" | "unknown";
  amount: number; // in UZS (integer)
  cardLast4: string; // 4 digits
  operationTime: Date; // In Asia/Tashkent timezone
  rawSummary: string; // Sanitized string up to 250 chars
  error?: string;
}

const DEPOSIT_KEYWORDS = [
  "kirim",
  "hisob to'ldirish",
  "hisob toldirish",
  "to'ldirildi",
  "toldirildi",
  "qabul qilindi",
  "kelib tushdi",
  "tushdi",
  "tushum",
  "popolnenie",
  "пополнение",
  "zachislenie",
  "зачисление",
  "prihod",
  "приход",
  "postuplenie",
  "поступление",
  "kiruvchi",
  "vnesenie",
  "внесение",
];

const DEBIT_KEYWORDS = [
  "chiqim",
  "to'lov",
  "tolov",
  "xarid",
  "yechildi",
  "echildi",
  "o'tkazma",
  "otkazma",
  "spisanie",
  "списание",
  "oplata",
  "оплата",
  "pokupka",
  "покупка",
  "snyatie",
  "снятие",
  "perevod",
  "перевод",
  "avtospisanie",
  "автосписание",
  "komissiya",
  "комиссия",
];

/**
 * Sanitize text by masking full card numbers and removing any sensitive info.
 * Limits length to max 250 chars.
 */
export function sanitizeNotificationText(text: string): string {
  if (!text) return "";
  // Mask 16-digit PANs: 8600 1234 5678 9012 -> **** **** **** 9012 or 8600********9012 -> ************9012
  let sanitized = text.replace(/\b(\d{4})[\s-]?\d{4}[\s-]?\d{4}[\s-]?(\d{4})\b/g, "**** **** **** $2");
  sanitized = sanitized.replace(/\b\d{12,19}\b/g, (match) => "*".repeat(match.length - 4) + match.slice(-4));
  // Replace consecutive whitespace/newlines
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  if (sanitized.length > 250) {
    return sanitized.slice(0, 247) + "...";
  }
  return sanitized;
}

/**
 * Extracts card last 4 digits from notification text.
 */
export function extractCardLast4(text: string): string | null {
  // Patterns like:
  // *1234, **** 1234, **1234
  // karta ...1234, card: ...1234
  // 8600 **** **** 1234
  const patterns = [
    /(?:карта|karta|card|humo|humocard)[^\d\n]*?(?:[*xX•·]+\s*)+(\d{4})\b/i,
    /(?:[*xX•·]{2,}\s*)(\d{4})\b/,
    /(?:\b\d{4}[\s-]?\*{4,}[\s-]?\*{4,}[\s-]?|\*{6,})(\d{4})\b/,
    /(?:карта|karta|card|humo)[^\d\n]*(\d{4})\b/i,
    /[*•](\d{4})\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Extracts amount in UZS from notification text.
 * Examples:
 * "Summa: +50 017 UZS" -> 50017
 * "50 017.00 so'm" -> 50017
 * "Kirim: 50,017.00" -> 50017
 * "50 017 UZS" -> 50017
 */
export function extractAmount(rawText: string): number | null {
  if (!rawText) return null;
  // Normalize unicode spaces (NBSP, narrow NBSP, etc.) to standard ASCII space
  const text = rawText.replace(/[\u00A0\u202F\u2007\u200B\uFEFF]/g, " ");

  const CURRENCY_SUFFIX = `(?:so['’\`]?m|uzs|сум|sum)(?![a-zA-Zа-яА-ЯёЁ0-9])`;
  const PLUS_PREFIX = `(?:[+\\u2795\\uFE62\\uFF0B]|\\bplus\\b)`;

  // Match amount with thousand separators:
  // 1. Dot thousands, comma decimals: 6.014,00 or 304.246,75
  // 2. Comma thousands, dot decimals: 6,014.00 or 75,025.00
  // 3. Space thousands, dot or comma decimals: 6 014,00 or 6 014.00 or 50 077
  // 4. Dot thousands without decimals: 6.014 or 10.000
  // 5. Plain integer or decimal: 6014 or 6014.00 or 6014,00
  const AMOUNT_CAPTURE = `(` +
    `\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|` +
    `\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|` +
    `\\d{1,3}(?:[ \\t]\\d{3})+(?:[.,]\\d{1,2})?|` +
    `\\d{1,3}(?:\\.\\d{3})+|` +
    `\\d+(?:[.,]\\d{1,2})?` +
  `)`;

  const amountPatterns = [
    // Pattern 1: Explicit '+' or '➕' followed by amount:
    // e.g. "➕ 6.014,00 UZS", "+ 6 056,00 UZS", "+50 017 UZS", "+50017"
    new RegExp(`${PLUS_PREFIX}\\s*${AMOUNT_CAPTURE}\\s*(?:${CURRENCY_SUFFIX})?`, "i"),

    // Pattern 2: Keyword followed by amount (excluding balance):
    // e.g. "Пополнение: 6.014,00", "Зачисление: 75,025.00", "Kirim: 50 017.00"
    new RegExp(`(?:kirim|кирим|miqdor|пополнение|зачисление)[\\s:]*${PLUS_PREFIX}?\\s*${AMOUNT_CAPTURE}\\s*(?:${CURRENCY_SUFFIX})?`, "i"),

    // Pattern 3: Amount followed by currency suffix on a line without balance markers:
    new RegExp(`(?<!(?:💰|баланс|balance|qoldiq|ostatok)[^\\n]*)${AMOUNT_CAPTURE}\\s*${CURRENCY_SUFFIX}`, "i"),

    // Pattern 4: "Summa: 50 017,00" or "Сумма: 50000"
    new RegExp(`(?:summa|сумма)[\\s:]*${PLUS_PREFIX}?\\s*${AMOUNT_CAPTURE}`, "i"),
  ];

  for (const pattern of amountPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const parsed = parseAmountString(match[1]);
      if (parsed !== null && parsed > 0) {
        return parsed;
      }
    }
  }

  // Fallback: search on lines that are NOT balance lines
  const nonBalanceLines = text
    .split("\n")
    .filter((line) => !/[💰]|\b(?:баланс|balance|qoldiq|ostatok)\b/i.test(line))
    .join("\n");

  const cleanedForFallback = nonBalanceLines.replace(/(?:karta|карта|card|humo)[^\d\n]*?[*xX•·\d]+/gi, " ");
  const fallbackMatch = cleanedForFallback.match(/(?<![*•\d])\b(\d{1,3}(?:[ \t,.]\d{3})+(?:[.,]\d{1,2})?|\d{4,9})\b(?![*•\d])/);
  if (fallbackMatch && fallbackMatch[1]) {
    const parsed = parseAmountString(fallbackMatch[1]);
    if (parsed !== null && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

/**
 * Normalizes number string like "6.014,00", "50 017.00", "6 056,00", "6,014.00" or "50017" into integer UZS.
 */
export function parseAmountString(raw: string): number | null {
  if (!raw) return null;
  let cleaned = raw.replace(/[\u00A0\u202F\u2007\u200B\uFEFF]/g, " ").trim();
  // Strip leading plus/minus symbols
  cleaned = cleaned.replace(/^[+\u2795\uFE62\uFF0B\-➖\u2796\uFE63\uFF0D\s]+/, "").trim();

  // Case 1: Dot as thousand separator, comma as decimal: e.g. "6.014,00" or "304.246,75" or "1.000.000,50"
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "").replace(/,/, ".");
  }
  // Case 2: Comma as thousand separator, dot as decimal: e.g. "6,014.00" or "75,025.00"
  else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/,/g, "");
  }
  // Case 3: Dot as thousand separator without decimal: e.g. "6.014" or "50.077" or "10.000"
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "");
  }
  // Case 4: Space/tab as thousand separator with comma or dot decimal: e.g. "6 014,00" or "6 014.00" or "50 077"
  else {
    cleaned = cleaned.replace(/[.,]00$/, "");
    cleaned = cleaned.replace(/,(\d{1,2})$/, ".$1");
    cleaned = cleaned.replace(/[\s'`_,]/g, "");
  }

  const num = Math.round(Number.parseFloat(cleaned));
  if (Number.isFinite(num) && num > 0) {
    return num;
  }
  return null;
}

/**
 * Extracts timestamp or falls back to messageDate.
 * Converts to Date in Asia/Tashkent context.
 */
export function extractOperationTime(text: string, fallbackDate: Date = new Date()): Date {
  // Support both "HH:mm[:ss] DD.MM.YYYY" (e.g. "05:01 22.09.2026") and "DD.MM.YYYY HH:mm[:ss]"
  const timeFirstMatch = text.match(/\b(\d{2}):(\d{2})(?::(\d{2}))?\s+(\d{2})[./](\d{2})[./](\d{4})\b/);
  if (timeFirstMatch) {
    const [, h, min, sec, d, m, y] = timeFirstMatch;
    const s = sec || "00";
    const isoString = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${min.padStart(2, "0")}:${s.padStart(2, "0")}+05:00`;
    const parsed = new Date(isoString);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const dateFirstMatch = text.match(/\b(\d{2})[./](\d{2})[./](\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\b/);
  if (dateFirstMatch) {
    const [, d, m, y, h, min, sec] = dateFirstMatch;
    const s = sec || "00";
    const isoString = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${min.padStart(2, "0")}:${s.padStart(2, "0")}+05:00`;
    const parsed = new Date(isoString);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  // Time only pattern: HH:mm:ss or HH:mm
  const timeMatch = text.match(/\b(\d{2}):(\d{2})(?::(\d{2}))?\b/);
  if (timeMatch) {
    const [, h, min, sec] = timeMatch;
    const tzFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tashkent",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = tzFormatter.formatToParts(fallbackDate);
    const partMap: Record<string, string> = {};
    for (const p of parts) partMap[p.type] = p.value;
    const y = partMap.year;
    const m = partMap.month;
    const d = partMap.day;
    const s = sec || "00";
    const isoString = `${y}-${m}-${d}T${h.padStart(2, "0")}:${min.padStart(2, "0")}:${s.padStart(2, "0")}+05:00`;
    const parsed = new Date(isoString);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return fallbackDate;
}

/**
 * Main parser function: parse raw text from HUMO Card Telegram message.
 */
export function parseHumoNotification(
  rawText: string,
  messageDate: Date = new Date(),
  fallbackCardLast4?: string
): ParsedHumoNotification {
  const sanitized = sanitizeNotificationText(rawText);
  const lower = rawText.toLowerCase();

  // Check debit first: if debit keywords are found, it cannot be a deposit
  const hasDebitKeyword = DEBIT_KEYWORDS.some((kw) => lower.includes(kw));
  const hasDepositKeyword = DEPOSIT_KEYWORDS.some((kw) => lower.includes(kw));
  const hasPlusSymbol = /[+\u2795\uFE62\uFF0B]/.test(rawText);
  const hasMinusSymbol = /[-\u2796\uFE63\uFF0D]/.test(rawText);

  let isDeposit = false;
  let operationType: "deposit" | "debit" | "unknown" = "unknown";

  if (hasDebitKeyword && !hasDepositKeyword) {
    operationType = "debit";
    isDeposit = false;
  } else if (hasDepositKeyword && !hasDebitKeyword) {
    operationType = "deposit";
    isDeposit = true;
  } else if (hasDepositKeyword && hasDebitKeyword) {
    if (hasPlusSymbol) {
      operationType = "deposit";
      isDeposit = true;
    } else if (hasMinusSymbol) {
      operationType = "debit";
      isDeposit = false;
    } else {
      operationType = "unknown";
      isDeposit = false;
    }
  } else {
    if (hasPlusSymbol) {
      operationType = "deposit";
      isDeposit = true;
    } else {
      operationType = "unknown";
      isDeposit = false;
    }
  }

  const cardLast4 = extractCardLast4(rawText) || (fallbackCardLast4 ? String(fallbackCardLast4).trim() : null);
  const amount = extractAmount(rawText);
  const operationTime = extractOperationTime(rawText, messageDate);

  if (!cardLast4) {
    return {
      isDeposit: false,
      operationType,
      amount: amount || 0,
      cardLast4: "",
      operationTime,
      rawSummary: sanitized,
      error: "card_not_found",
    };
  }

  if (!amount || amount <= 0) {
    return {
      isDeposit: false,
      operationType,
      amount: 0,
      cardLast4,
      operationTime,
      rawSummary: sanitized,
      error: "amount_not_found",
    };
  }

  return {
    isDeposit,
    operationType,
    amount,
    cardLast4,
    operationTime,
    rawSummary: sanitized,
  };
}
