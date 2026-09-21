import { describe, it, expect } from "vitest";
import {
  parseHumoNotification,
  extractAmount,
  extractCardLast4,
  extractOperationTime,
  sanitizeNotificationText,
} from "../src/lib/domain/humo-parser";

describe("HUMO Notification Parser", () => {
  describe("Text Sanitization", () => {
    it("masks full 16-digit card numbers into masked format", () => {
      const raw = "Karta 9860 1234 5678 9012 to'ldirildi. Summa: 50 000 so'm";
      const sanitized = sanitizeNotificationText(raw);
      expect(sanitized).not.toContain("1234 5678");
      expect(sanitized).toContain("**** **** **** 9012");
    });

    it("truncates long text to max 250 characters safely", () => {
      const longText = "A".repeat(300);
      const sanitized = sanitizeNotificationText(longText);
      expect(sanitized.length).toBeLessThanOrEqual(250);
      expect(sanitized.endsWith("...")).toBe(true);
    });
  });

  describe("Card Number Extraction", () => {
    it("extracts 4 digits from *1234 format", () => {
      expect(extractCardLast4("HUMO *5678: Kirim 50000 UZS")).toBe("5678");
    });

    it("extracts 4 digits from **** 1234 format", () => {
      expect(extractCardLast4("Karta **** 4321 ga mablag' tushdi")).toBe("4321");
    });

    it("extracts 4 digits from Russian notification", () => {
      expect(extractCardLast4("Карта: *9988. Пополнение на сумму 100 000 сум")).toBe("9988");
    });

    it("returns null when no card number is present", () => {
      expect(extractCardLast4("Просто сообщение без карты 50000 сум")).toBeNull();
    });
  });

  describe("Amount Extraction", () => {
    it("parses amount with space separators and UZS suffix", () => {
      expect(extractAmount("Summa: 50 017 UZS")).toBe(50017);
    });

    it("parses amount with decimal zeros (.00)", () => {
      expect(extractAmount("Kirim: 150 000.00 so'm")).toBe(150000);
    });

    it("parses amount with comma decimal (,00)", () => {
      expect(extractAmount("Зачисление: 75,025.00 сум")).toBe(75025);
    });

    it("parses leading plus (+50 017)", () => {
      expect(extractAmount("+50 017 сум")).toBe(50017);
    });

    it("parses raw number without spaces", () => {
      expect(extractAmount("Пополнение карты на 50017 сум")).toBe(50017);
    });
  });

  describe("Operation Time Extraction (Asia/Tashkent UTC+5)", () => {
    it("parses DD.MM.YYYY HH:mm into valid Date", () => {
      const text = "Karta: *1234\nVaqt: 22.09.2026 14:30\nSumma: +50 000";
      const dt = extractOperationTime(text);
      expect(dt).toBeInstanceOf(Date);
      expect(!isNaN(dt.getTime())).toBe(true);
      // Tashkent 14:30 UTC+5 is 09:30 UTC
      expect(dt.getUTCHours()).toBe(9);
      expect(dt.getUTCMinutes()).toBe(30);
    });

    it("falls back to messageDate when no explicit timestamp in text", () => {
      const fallback = new Date("2026-09-22T02:00:00Z");
      const dt = extractOperationTime("Karta *1234 to'ldirildi", fallback);
      expect(dt.getTime()).toBe(fallback.getTime());
    });
  });

  describe("Full Notification Parsing (Deposit vs Debit)", () => {
    it("parses standard Uzbek HUMO deposit notification", () => {
      const text = "HumoCard *4567: Kirim 50 017.00 UZS. Qoldiq: 250 000 UZS. 22.09.2026 10:15";
      const parsed = parseHumoNotification(text);

      expect(parsed.isDeposit).toBe(true);
      expect(parsed.operationType).toBe("deposit");
      expect(parsed.amount).toBe(50017);
      expect(parsed.cardLast4).toBe("4567");
      expect(parsed.error).toBeUndefined();
    });

    it("parses standard Russian HUMO deposit notification", () => {
      const text = "Пополнение HUMO *7890 на сумму 100 055 сум. Баланс: 300 000 сум.";
      const parsed = parseHumoNotification(text);

      expect(parsed.isDeposit).toBe(true);
      expect(parsed.operationType).toBe("deposit");
      expect(parsed.amount).toBe(100055);
      expect(parsed.cardLast4).toBe("7890");
    });

    it("parses notification with 'kelib tushdi' (deposit)", () => {
      const text = "Karta *1122 ga 50 005 UZS mablag' kelib tushdi";
      const parsed = parseHumoNotification(text);

      expect(parsed.isDeposit).toBe(true);
      expect(parsed.operationType).toBe("deposit");
      expect(parsed.amount).toBe(50005);
      expect(parsed.cardLast4).toBe("1122");
    });

    it("REJECTS debit / purchase notifications (Chiqim)", () => {
      const text = "HumoCard *4567: Chiqim 50 017.00 UZS. Oplata tovarov. Qoldiq: 100 000 UZS";
      const parsed = parseHumoNotification(text);

      expect(parsed.isDeposit).toBe(false);
      expect(parsed.operationType).toBe("debit");
      expect(parsed.amount).toBe(50017);
      expect(parsed.cardLast4).toBe("4567");
    });

    it("REJECTS debit / card transfer notifications (O'tkazma / Spisanie)", () => {
      const text = "Списание с карты *4567: 50 000 сум. Перевод на карту";
      const parsed = parseHumoNotification(text);

      expect(parsed.isDeposit).toBe(false);
      expect(parsed.operationType).toBe("debit");
    });

    it("handles ambiguous text with error if card or amount missing", () => {
      const text = "Непонятный текст от банка без данных";
      const parsed = parseHumoNotification(text);

      expect(parsed.isDeposit).toBe(false);
      expect(parsed.cardLast4).toBe("");
      expect(parsed.error).toBe("card_not_found");
    });
  });
});
