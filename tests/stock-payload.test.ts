import { describe, it, expect } from "vitest";
import {
  parseStockPayload,
  detectStockPayloadType,
  formatSingleStockPayloadForTelegram,
  renderDeliveryGoods,
  formatStockPayloadForFile,
  serializeStockPayload,
  escHtml,
} from "../src/lib/domain/stock-payload";

describe("escHtml", () => {
  it("escapes dangerous HTML characters", () => {
    expect(escHtml('<script>alert("xss&win")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&amp;win&quot;)&lt;/script&gt;"
    );
  });
});

describe("parseStockPayload", () => {
  it("parses structured JSON account", () => {
    const json = serializeStockPayload({
      type: "account",
      login: "user@example.com",
      password: "SecretPassword123!",
      extra: "2FA: ABCDEF",
    });
    const parsed = parseStockPayload(json);
    expect(parsed).toEqual({
      type: "account",
      login: "user@example.com",
      password: "SecretPassword123!",
      extra: "2FA: ABCDEF",
    });
  });

  it("parses structured JSON link_promo", () => {
    const json = serializeStockPayload({
      type: "link_promo",
      link: "https://serviceactivation.google.com/redeem",
      promo: "PROMO-2026-XYZ",
    });
    const parsed = parseStockPayload(json);
    expect(parsed).toEqual({
      type: "link_promo",
      link: "https://serviceactivation.google.com/redeem",
      promo: "PROMO-2026-XYZ",
    });
  });

  it("parses structured JSON link", () => {
    const json = serializeStockPayload({
      type: "link",
      link: "https://invite.t.me/mygroup",
    });
    const parsed = parseStockPayload(json);
    expect(parsed).toEqual({
      type: "link",
      link: "https://invite.t.me/mygroup",
    });
  });

  it("parses structured JSON text with noMono flag", () => {
    const json = serializeStockPayload({
      type: "text",
      text: "Обычный текст без моно шрифта",
      noMono: true,
    });
    const parsed = parseStockPayload(json);
    expect(parsed).toEqual({
      type: "text",
      text: "Обычный текст без моно шрифта",
      noMono: true,
    });
  });

  it("auto-detects plain URL as link", () => {
    const parsed = parseStockPayload("https://serviceactivation.google.com/activate?id=123");
    expect(parsed).toEqual({
      type: "link",
      link: "https://serviceactivation.google.com/activate?id=123",
    });
  });

  it("auto-detects URL + Promo delimiter as link_promo", () => {
    const parsed1 = parseStockPayload("https://service.com/redeem : PROMO-ABC-123");
    expect(parsed1).toEqual({
      type: "link_promo",
      link: "https://service.com/redeem",
      promo: "PROMO-ABC-123",
    });

    const parsed2 = parseStockPayload("https://service.com/redeem | PROMO-ABC-123");
    expect(parsed2).toEqual({
      type: "link_promo",
      link: "https://service.com/redeem",
      promo: "PROMO-ABC-123",
    });
  });

  it("auto-detects email:password line as account", () => {
    const parsed = parseStockPayload("user@gmail.com:MySuperPassword!2026");
    expect(parsed).toEqual({
      type: "account",
      login: "user@gmail.com",
      password: "MySuperPassword!2026",
    });
  });

  it("auto-detects login:password:extra line as account with 2FA", () => {
    const parsed = parseStockPayload("alex_pro:Secret123:JBSWY3DPEHPK3PXP");
    expect(parsed).toEqual({
      type: "account",
      login: "alex_pro",
      password: "Secret123",
      extra: "JBSWY3DPEHPK3PXP",
    });
  });

  it("auto-detects alphanumeric key as code", () => {
    const parsed = parseStockPayload("VEX-PROMO-2026-9999");
    expect(parsed).toEqual({
      type: "code",
      code: "VEX-PROMO-2026-9999",
    });
  });
});

describe("detectStockPayloadType", () => {
  it("returns correct category for badges", () => {
    expect(detectStockPayloadType("https://google.com")).toBe("link");
    expect(detectStockPayloadType("https://google.com : CODE")).toBe("link_promo");
    expect(detectStockPayloadType("admin@test.com:123456")).toBe("account");
    expect(detectStockPayloadType("KEY-ABC-DEF")).toBe("code");
    expect(detectStockPayloadType("Произвольный длинный текст с пробелами и точками.")).toBe("text");
  });
});

describe("formatSingleStockPayloadForTelegram", () => {
  it("formats account with two separate <code> blocks", () => {
    const html = formatSingleStockPayloadForTelegram(
      { type: "account", login: "john@example.com", password: "p@ssword<123>" },
      "ru"
    );
    expect(html).toContain("<code>john@example.com</code>");
    expect(html).toContain("<code>p@ssword&lt;123&gt;</code>");
    expect(html).toContain("📧 <b>Логин / Email:</b>");
    expect(html).toContain("🔑 <b>Пароль:</b>");
    expect(html).toContain("(нажмите на логин или пароль, чтобы скопировать)");
  });

  it("formats link_promo with clickable URL and mono promo code", () => {
    const html = formatSingleStockPayloadForTelegram(
      {
        type: "link_promo",
        link: "https://activation.service.com",
        promo: "CODE-XYZ",
      },
      "ru"
    );
    expect(html).toContain("https://activation.service.com");
    // Link is NOT wrapped in code, so Telegram makes it a clickable blue link
    expect(html).not.toContain("<code>https://activation.service.com</code>");
    // Promo IS in code, so tapping it copies the code
    expect(html).toContain("<code>CODE-XYZ</code>");
  });

  it("formats text without mono when noMono is true", () => {
    const html = formatSingleStockPayloadForTelegram(
      { type: "text", text: "Просто текст без рамок", noMono: true },
      "ru"
    );
    expect(html).toBe("Просто текст без рамок");
    expect(html).not.toContain("<code>");
  });

  it("formats text with mono when noMono is false", () => {
    const html = formatSingleStockPayloadForTelegram(
      { type: "text", text: "Текст в рамке", noMono: false },
      "ru"
    );
    expect(html).toBe("<code>Текст в рамке</code>");
  });

  it("supports Uzbek and English languages", () => {
    const htmlUz = formatSingleStockPayloadForTelegram(
      { type: "account", login: "uzbek@test.uz", password: "password" },
      "uz"
    );
    expect(htmlUz).toContain("📧 <b>Login / Email:</b>");
    expect(htmlUz).toContain("🔑 <b>Parol:</b>");
    expect(htmlUz).toContain("(nusxalash uchun login yoki parol ustiga bosing)");

    const htmlEn = formatSingleStockPayloadForTelegram(
      { type: "account", login: "english@test.com", password: "password" },
      "en"
    );
    expect(htmlEn).toContain("📧 <b>Login / Email:</b>");
    expect(htmlEn).toContain("🔑 <b>Password:</b>");
    expect(htmlEn).toContain("(tap login or password to copy)");
  });
});

describe("renderDeliveryGoods", () => {
  it("formats single account item", () => {
    const raw = serializeStockPayload({
      type: "account",
      login: "alice@gmail.com",
      password: "mypassword",
    });
    const rendered = renderDeliveryGoods(raw, "ru");
    expect(rendered).toContain("🎁 <b>Ваш товар:</b>");
    expect(rendered).toContain("<code>alice@gmail.com</code>");
    expect(rendered).toContain("<code>mypassword</code>");
  });

  it("formats multi-item orders with numbering", () => {
    const item1 = serializeStockPayload({
      type: "account",
      login: "user1@mail.com",
      password: "pass1",
    });
    const item2 = serializeStockPayload({
      type: "account",
      login: "user2@mail.com",
      password: "pass2",
    });
    const multiPayload = `${item1}\n${item2}`;

    const rendered = renderDeliveryGoods(multiPayload, "ru");
    expect(rendered).toContain("📦 <b>Товар #1:</b>");
    expect(rendered).toContain("<code>user1@mail.com</code>");
    expect(rendered).toContain("📦 <b>Товар #2:</b>");
    expect(rendered).toContain("<code>user2@mail.com</code>");
  });

  it("passes legacy HTML through safely", () => {
    const legacy = "<code>legacy-token-here</code>";
    const rendered = renderDeliveryGoods(legacy, "ru");
    expect(rendered).toContain("<code>legacy-token-here</code>");
  });
});

describe("formatStockPayloadForFile", () => {
  it("formats accounts cleanly for .txt file export", () => {
    const item1 = serializeStockPayload({
      type: "account",
      login: "user1@mail.com",
      password: "pass1",
    });
    const item2 = serializeStockPayload({
      type: "link_promo",
      link: "https://site.com",
      promo: "ABC-123",
    });
    const file = formatStockPayloadForFile(`${item1}\n${item2}`);
    expect(file).toContain("[#1] Логин: user1@mail.com | Пароль: pass1");
    expect(file).toContain("[#2] Ссылка: https://site.com | Промокод: ABC-123");
  });
});
