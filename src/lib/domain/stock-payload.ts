/**
 * Domain logic for stock payloads (goods uploaded to warehouse / delivered to buyer).
 * Supports:
 * - account (Login/Email + Password in separate mono blocks for 1-tap copying)
 * - link_promo (Clickable link + Promo code in mono)
 * - link (Clickable activation / invite link)
 * - code (Single promo code or license key in mono)
 * - text (Custom text, with or without mono)
 */

export type StockPayloadType = "account" | "link_promo" | "link" | "code" | "text";

export interface AccountPayload {
  type: "account";
  login: string;
  password: string;
  extra?: string;
}

export interface LinkPromoPayload {
  type: "link_promo";
  link: string;
  promo: string;
}

export interface LinkPayload {
  type: "link";
  link: string;
}

export interface CodePayload {
  type: "code";
  code: string;
}

export interface TextPayload {
  type: "text";
  text: string;
  noMono?: boolean;
}

export type StructuredStockPayload =
  | AccountPayload
  | LinkPromoPayload
  | LinkPayload
  | CodePayload
  | TextPayload;

/** Basic HTML entity escaping for Telegram HTML parse mode. */
export function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const I18N_LABELS = {
  ru: {
    login: "📧 <b>Логин / Email:</b>",
    password: "🔑 <b>Пароль:</b>",
    extra: "ℹ️ <b>Дополнительно:</b>",
    link: "🔗 <b>Ссылка для активации:</b>",
    promo: "🎟 <b>Промокод / Ключ:</b>",
    code: "🔑 <b>Ключ / Код активации:</b>",
    tapToCopyAccount: "<i>(нажмите на логин или пароль, чтобы скопировать)</i>",
    tapToCopyCode: "<i>(нажмите на промокод, чтобы скопировать)</i>",
    yourGoods: "🎁 <b>Ваш товар:</b>",
    itemNum: "📦 <b>Товар #{n}:</b>",
  },
  uz: {
    login: "📧 <b>Login / Email:</b>",
    password: "🔑 <b>Parol:</b>",
    extra: "ℹ️ <b>Qo‘shimcha:</b>",
    link: "🔗 <b>Faollashtirish havolasi:</b>",
    promo: "🎟 <b>Promokod / Kalit:</b>",
    code: "🔑 <b>Kalit / Faollashtirish kodi:</b>",
    tapToCopyAccount: "<i>(nusxalash uchun login yoki parol ustiga bosing)</i>",
    tapToCopyCode: "<i>(nusxalash uchun promokod ustiga bosing)</i>",
    yourGoods: "🎁 <b>Mahsulotingiz:</b>",
    itemNum: "📦 <b>Mahsulot #{n}:</b>",
  },
  en: {
    login: "📧 <b>Login / Email:</b>",
    password: "🔑 <b>Password:</b>",
    extra: "ℹ️ <b>Additional info:</b>",
    link: "🔗 <b>Activation link:</b>",
    promo: "🎟 <b>Promo code / Key:</b>",
    code: "🔑 <b>Key / Activation code:</b>",
    tapToCopyAccount: "<i>(tap login or password to copy)</i>",
    tapToCopyCode: "<i>(tap promo code to copy)</i>",
    yourGoods: "🎁 <b>Your item:</b>",
    itemNum: "📦 <b>Item #{n}:</b>",
  },
};

function getLabels(lang = "ru") {
  if (lang === "uz") return I18N_LABELS.uz;
  if (lang === "en") return I18N_LABELS.en;
  return I18N_LABELS.ru;
}

/**
 * Serializes a structured payload into a compact JSON string for database storage.
 */
export function serializeStockPayload(payload: StructuredStockPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parses a raw stock payload from DB or input string.
 * Supports:
 * - Structured JSON strings (`{"type": "account", ...}`)
 * - Plain links (`https://...`)
 * - Link + Promo combinations (`https://... : PROMO123` or `https://... | PROMO123`)
 * - Account lines (`email:password` or `login | password`)
 * - Plain codes / keys (`XXXX-YYYY-ZZZZ`)
 * - Plain raw text
 */
export function parseStockPayload(raw: string): StructuredStockPayload {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { type: "text", text: "" };
  }

  // 1. Try structured JSON
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        switch (parsed.type) {
          case "account":
            return {
              type: "account",
              login: String(parsed.login ?? "").trim(),
              password: String(parsed.password ?? "").trim(),
              extra: parsed.extra ? String(parsed.extra).trim() : undefined,
            };
          case "link_promo":
            return {
              type: "link_promo",
              link: String(parsed.link ?? "").trim(),
              promo: String(parsed.promo ?? "").trim(),
            };
          case "link":
            return {
              type: "link",
              link: String(parsed.link ?? "").trim(),
            };
          case "code":
            return {
              type: "code",
              code: String(parsed.code ?? "").trim(),
            };
          case "text":
            return {
              type: "text",
              text: String(parsed.text ?? ""),
              noMono: Boolean(parsed.noMono),
            };
        }
      }
    } catch {
      // Fall through to plain text parsing
    }
  }

  // 2. Link + Promo pattern: e.g. "https://domain.com/redeem : PROMO123" or "https://domain.com/redeem | PROMO123"
  // Must have a space or clear separator like : or | so URL paths aren't treated as delimiters
  const urlPromoMatch = trimmed.match(/^(https?:\/\/\S+?)\s*(?:[:|]|\s--\s|\t)\s*(\S.*)$/i);
  if (urlPromoMatch) {
    const link = urlPromoMatch[1].trim();
    const promo = urlPromoMatch[2].trim();
    if (link && promo) {
      return { type: "link_promo", link, promo };
    }
  }

  // 3. Pure URL link
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {
    return { type: "link", link: trimmed };
  }

  // 4. Account pattern: "email@domain.com:password", "login:password", "login | password", "login;password"
  // Needs to contain a delimiter and no spaces in login (or email format)
  const accountDelimMatch = trimmed.match(/^([^\s:@;]+@[^\s:@;]+\.[^\s:@;]+|[^:\s|;]{2,50})\s*[:|;]\s*([^\r\n]+)$/);
  if (accountDelimMatch && !trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    const login = accountDelimMatch[1].trim();
    const rest = accountDelimMatch[2].trim();
    // Check if rest contains extra like ":2FA_KEY"
    const subMatch = rest.match(/^([^:\s]+)\s*[:|]\s*(.+)$/);
    if (subMatch) {
      return {
        type: "account",
        login,
        password: subMatch[1].trim(),
        extra: subMatch[2].trim(),
      };
    }
    return { type: "account", login, password: rest };
  }

  // 5. Code pattern: alphanumeric key, e.g. "XXXX-YYYY-ZZZZ" or single word code without spaces (6 to 64 chars)
  if (/^[A-Za-z0-9_\-]{6,64}$/.test(trimmed)) {
    return { type: "code", code: trimmed };
  }

  // 6. Default: plain text
  return { type: "text", text: trimmed };
}

/**
 * Detects the category of a payload for badges / UI display.
 */
export function detectStockPayloadType(raw: string): StockPayloadType {
  return parseStockPayload(raw).type;
}

/**
 * Formats a single item for Telegram HTML message display.
 */
export function formatSingleStockPayloadForTelegram(
  item: StructuredStockPayload,
  lang = "ru"
): string {
  const lbl = getLabels(lang);

  switch (item.type) {
    case "account": {
      const parts: string[] = [];
      parts.push(`${lbl.login}\n<code>${escHtml(item.login)}</code>`);
      parts.push(`${lbl.password}\n<code>${escHtml(item.password)}</code>`);
      if (item.extra) {
        parts.push(`${lbl.extra}\n<code>${escHtml(item.extra)}</code>`);
      }
      parts.push(lbl.tapToCopyAccount);
      return parts.join("\n\n");
    }

    case "link_promo": {
      const parts: string[] = [];
      parts.push(`${lbl.link}\n${escHtml(item.link)}`);
      parts.push(`${lbl.promo}\n<code>${escHtml(item.promo)}</code>`);
      parts.push(lbl.tapToCopyCode);
      return parts.join("\n\n");
    }

    case "link": {
      return `${lbl.link}\n${escHtml(item.link)}`;
    }

    case "code": {
      return `${lbl.code}\n<code>${escHtml(item.code)}</code>\n\n${lbl.tapToCopyCode}`;
    }

    case "text": {
      if (item.noMono) {
        return escHtml(item.text);
      }
      return `<code>${escHtml(item.text)}</code>`;
    }
  }
}

/**
 * Formats a raw payload (which could be single or multi-item string joined by newlines)
 * into a complete, beautiful HTML block ready to send to the customer in Telegram.
 */
export function renderDeliveryGoods(rawPayload: string, lang = "ru"): string {
  const trimmed = String(rawPayload ?? "").trim();
  if (!trimmed) return "";

  const lbl = getLabels(lang);

  // If the payload already contains explicit HTML markup (e.g. legacy bot template with <code>), return as is
  if (trimmed.includes("<code>") || trimmed.includes("<b>") || trimmed.includes("<a ")) {
    return `${lbl.yourGoods}\n\n${trimmed}`;
  }

  // Split items by newline
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return "";

  if (lines.length === 1) {
    const parsed = parseStockPayload(lines[0]);
    return `${lbl.yourGoods}\n\n${formatSingleStockPayloadForTelegram(parsed, lang)}`;
  }

  // If there are multiple items, format each one cleanly
  const items = lines.map((line) => parseStockPayload(line));
  const renderedItems = items.map((item, idx) => {
    const header = lbl.itemNum.replace("{n}", String(idx + 1));
    const body = formatSingleStockPayloadForTelegram(item, lang);
    return `${header}\n${body}`;
  });

  return `${lbl.yourGoods}\n\n${renderedItems.join("\n\n────────────────\n\n")}`;
}

/**
 * Formats a raw payload into clean plain-text lines for the .txt file export (orders > 5 items).
 */
export function formatStockPayloadForFile(rawPayload: string): string {
  const trimmed = String(rawPayload ?? "").trim();
  if (!trimmed) return "";

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  return lines
    .map((line, idx) => {
      const parsed = parseStockPayload(line);
      const prefix = lines.length > 1 ? `[#${idx + 1}] ` : "";

      switch (parsed.type) {
        case "account":
          return `${prefix}Логин: ${parsed.login} | Пароль: ${parsed.password}${parsed.extra ? ` | Доп: ${parsed.extra}` : ""}`;
        case "link_promo":
          return `${prefix}Ссылка: ${parsed.link} | Промокод: ${parsed.promo}`;
        case "link":
          return `${prefix}Ссылка: ${parsed.link}`;
        case "code":
          return `${prefix}Код: ${parsed.code}`;
        case "text":
          return `${prefix}${parsed.text}`;
      }
    })
    .join("\n");
}
