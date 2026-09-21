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
export function extractAmount(text: string): number | null {
  const CURRENCY_SUFFIX = `(?:so['’\`]?m|uzs|сум|sum)(?![а-яёa-z0-9])`;
  const amountPatterns = [
    // "+50 017 UZS", "+ 50 017 so'm", "+50017"
    new RegExp(`[+]\\s*(\\d{1,3}(?:[ \\t,]\\d{3})*(?:\\.\\d{2})?|\\d+)\\s*${CURRENCY_SUFFIX}?`, "i"),
    // "50 017.00 UZS", "50 017 so'm", "50017 сум", "100 055 сум"
    new RegExp(`(\\d{1,3}(?:[ \\t,]\\d{3})*(?:\\.\\d{2})?|\\d+)\\s*${CURRENCY_SUFFIX}`, "i"),
    // "Summa: 50 017", "Kirim: 50 017.00", "Сумма: 50000"
    /(?:summa|сумма|kirim|кирим|miqdor)[\s:]*([+]?\d{1,3}(?:[ \t,]\d{3})*(?:\.\d{2})?|[+]?\d+)/i,
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

  // Fallback: look for 4 to 8 digits with possible thousand separators
  const fallbackMatch = text.match(/\b(\d{1,3}(?:[ \t]\d{3})+(?:\.\d{2})?|\d{4,9})\b/);
  if (fallbackMatch && fallbackMatch[1]) {
    const parsed = parseAmountString(fallbackMatch[1]);
    if (parsed !== null && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

/**
 * Normalizes number string like "50 017.00" or "50,017" or "50017" into integer UZS.
 */
function parseAmountString(raw: string): number | null {
  let cleaned = raw.trim();
  // Strip leading '+'
  if (cleaned.startsWith("+")) {
    cleaned = cleaned.slice(1).trim();
  }
  // Strip decimals like .00 or ,00
  cleaned = cleaned.replace(/[.,]00$/, "");
  // Replace comma decimal with dot if decimal part exists
  cleaned = cleaned.replace(/,(\d{2})$/, ".$1");
  // Remove spaces, tabs, apostrophes used as thousand separators
  cleaned = cleaned.replace(/[\s'`_]/g, "");
  // If there is still a comma, remove it
  cleaned = cleaned.replace(/,/g, "");

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
  // Try to find DD.MM.YYYY HH:mm[:ss] or YYYY-MM-DD HH:mm
  const dateMatch = text.match(/\b(\d{2})[./](\d{2})[./](\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\b/);
  if (dateMatch) {
    const [, d, m, y, h, min, sec] = dateMatch;
    // Tashkent is UTC+5. Construct an ISO string with +05:00
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
    // Use fallbackDate's date part in Tashkent
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

  let isDeposit = false;
  let operationType: "deposit" | "debit" | "unknown" = "unknown";

  if (hasDebitKeyword && !hasDepositKeyword) {
    operationType = "debit";
    isDeposit = false;
  } else if (hasDepositKeyword && !hasDebitKeyword) {
    operationType = "deposit";
    isDeposit = true;
  } else if (hasDepositKeyword && hasDebitKeyword) {
    // If both keywords exist, check if '+' or '-' is in the message
    if (rawText.includes("+")) {
      operationType = "deposit";
      isDeposit = true;
    } else if (rawText.includes("-")) {
      operationType = "debit";
      isDeposit = false;
    } else {
      // Ambiguous
      operationType = "unknown";
      isDeposit = false;
    }
  } else {
    // Neither keyword found, check for explicit '+'
    if (rawText.includes("+")) {
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
