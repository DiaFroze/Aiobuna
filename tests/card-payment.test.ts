import { describe, it, expect, beforeEach } from "vitest";
import {
  canAccessCardPayment,
  generateUniqueAmount,
  claimPaymentConfirmation,
  claimPaymentExpiration,
  claimPaymentCancellation,
  claimManualReview,
  getCardPaymentConfig,
  getEnvTolerant,
  maskCardNumber,
  maskChatId,
  calculatePaymentExpiry,
  CARD_PREMIUM_EMOJI_1,
  CARD_PREMIUM_EMOJI_2,
  CARD_PAY_BUTTON_TEXT,
  CARD_PAY_BUTTON_HTML,
  renderCardPayButtonHtml,
  buildCardPaymentSupportText,
  buildCardPaymentSupportUrl,
  formatAmountUzs,
} from "../src/lib/domain/card-payment";
import {
  processBankMessage,
  isMatchingChatId,
  getHumoMonitorStatus,
  triggerImmediateCheck,
} from "../src/lib/services/humo-monitor";
import { t } from "../src/bot/i18n";

// In-memory fake database simulating Prisma transactions, CAS, and BotSetting storage
class FakeCardDb {
  cardPaymentRequests: any[] = [];
  bankNotifications: any[] = [];
  settings: Map<string, string> = new Map();

  botSetting = {
    findUnique: async ({ where }: any) => {
      const val = this.settings.get(where.key);
      return val ? { key: where.key, valueRu: val } : null;
    },
    upsert: async ({ where, create, update }: any) => {
      const val = update?.valueRu || create?.valueRu;
      this.settings.set(where.key, val);
      return { key: where.key, valueRu: val };
    },
  };
  setting = this.botSetting;

  cardPaymentRequest = {
    findMany: async (args: any) => {
      let list = [...this.cardPaymentRequests];
      if (args.where) {
        list = list.filter((r) => {
          if (args.where.cardLast4 && r.cardLast4 !== args.where.cardLast4) return false;
          if (args.where.status && r.status !== args.where.status) return false;
          if (args.where.expiresAt?.gt && r.expiresAt <= args.where.expiresAt.gt) return false;
          return true;
        });
      }
      return list;
    },
    findUnique: async (args: any) => {
      return this.cardPaymentRequests.find((r) => r.id === args.where.id) || null;
    },
    findFirst: async (args: any) => {
      return (
        this.cardPaymentRequests.find((r) => {
          if (args.where.cardLast4 && r.cardLast4 !== args.where.cardLast4) return false;
          if (args.where.totalAmount && r.totalAmount !== args.where.totalAmount) return false;
          if (args.where.status && r.status !== args.where.status) return false;
          if (args.where.expiresAt?.gt && r.expiresAt <= args.where.expiresAt.gt) return false;
          return true;
        }) || null
      );
    },
    updateMany: async (args: any) => {
      let count = 0;
      for (const r of this.cardPaymentRequests) {
        const matchesId = r.id === args.where.id;
        const matchesStatus =
          args.where.status?.in
            ? args.where.status.in.includes(r.status)
            : args.where.status
            ? r.status === args.where.status
            : true;
        const matchesExpires =
          args.where.expiresAt?.lte
            ? r.expiresAt <= args.where.expiresAt.lte
            : true;
        const matchesExpirationNotified =
          "expirationNotifiedAt" in args.where
            ? (r.expirationNotifiedAt ?? null) === args.where.expirationNotifiedAt
            : true;

        if (matchesId && matchesStatus && matchesExpires && matchesExpirationNotified) {
          Object.assign(r, args.data);
          count++;
        }
      }
      return { count };
    },
    update: async (args: any) => {
      const r = this.cardPaymentRequests.find((item) => item.id === args.where.id);
      if (r) Object.assign(r, args.data);
      return r;
    },
  };

  bankNotification = {
    findUnique: async (args: any) => {
      if (args.where.chatId_messageId) {
        return (
          this.bankNotifications.find(
            (n) =>
              n.chatId === args.where.chatId_messageId.chatId &&
              n.messageId === args.where.chatId_messageId.messageId
          ) || null
        );
      }
      return this.bankNotifications.find((n) => n.id === args.where.id) || null;
    },
    create: async (args: any) => {
      const item = {
        id: this.bankNotifications.length + 1,
        ...args.data,
      };
      this.bankNotifications.push(item);
      return item;
    },
    updateMany: async (args: any) => {
      let count = 0;
      for (const n of this.bankNotifications) {
        if (n.id === args.where.id && n.status === args.where.status) {
          Object.assign(n, args.data);
          count++;
        }
      }
      return { count };
    },
    update: async (args: any) => {
      const n = this.bankNotifications.find((item) => item.id === args.where.id);
      if (n) Object.assign(n, args.data);
      return n;
    },
  };

  async $transaction(callback: any) {
    return callback(this);
  }
}

describe("Card Payment Domain & Service", () => {
  let db: FakeCardDb;

  beforeEach(() => {
    db = new FakeCardDb();
    // Clean up all related env vars
    const keys = [
      "PAYMENT_MONITOR_MODE", "payment_monitor_mode",
      "PAYMENT_ADMIN_IDS", "payment_admin_ids", "TELEGRAM_ADMIN_CHAT_ID",
      "HUMO_CARD_NUMBER", "humo_card_number", "CARD_NUMBER",
      "HUMO_CARD_LAST4", "humo_card_last4", "CARD_LAST4",
      "HUMO_CHAT_ID", "humo_chat_id",
      "TELEGRAM_API_ID", "telegram_api_id", "Appapi_id", "appapi_id",
      "TELEGRAM_API_HASH", "telegram_api_hash", "Appapi_hash", "appapi_hash",
      "TELEGRAM_SESSION", "telegram_session",
      "CARD_PAYMENT_TTL_SECONDS", "CARD_PAYMENT_MIN_EXTRA", "CARD_PAYMENT_MAX_EXTRA",
    ];
    for (const k of keys) {
      delete process.env[k];
    }
  });

  describe("Configuration & Env Tolerant Loading", () => {
    it("loads configuration from canonical env variables", () => {
      process.env.PAYMENT_MONITOR_MODE = "all";
      process.env.HUMO_CARD_NUMBER = "9860 1234 5678 9012";
      process.env.HUMO_CARD_LAST4 = "9012";
      process.env.HUMO_CHAT_ID = "-1001234567890";
      process.env.TELEGRAM_API_ID = "123456";
      process.env.TELEGRAM_API_HASH = "abcdef0123456789abcdef0123456789";
      process.env.TELEGRAM_SESSION = "1ApW...valid_session_string";

      const cfg = getCardPaymentConfig();
      expect(cfg.mode).toBe("all");
      expect(cfg.cardLast4).toBe("9012");
      expect(cfg.cardNumber).toBe("9860 1234 5678 9012");
      expect(cfg.cardDigitsOnly).toBe("9860123456789012");
      expect(cfg.humoChatId).toBe("-1001234567890");
      expect(cfg.apiId).toBe(123456);
      expect(cfg.hasApiId).toBe(true);
      expect(cfg.hasApiHash).toBe(true);
      expect(cfg.hasSession).toBe(true);
      expect(cfg.isConfigured).toBe(true);
    });

    it("falls back to Appapi_id and Appapi_hash when canonical keys are absent", () => {
      process.env.Appapi_id = "778899";
      process.env.Appapi_hash = "secret_hash_value_778899";
      process.env.HUMO_CARD_NUMBER = "9860 0000 1111 2222";

      const cfg = getCardPaymentConfig();
      expect(cfg.apiId).toBe(778899);
      expect(cfg.hasApiId).toBe(true);
      expect(cfg.hasApiHash).toBe(true);
      expect(cfg.cardLast4).toBe("2222"); // Auto-derived from cardNumber!
    });

    it("handles whitespace, surrounding quotes, and formatting cleanly", () => {
      process.env.HUMO_CARD_NUMBER = '  "9860 5555 6666 7777" \r';
      process.env.HUMO_CARD_LAST4 = " '7777' ";
      process.env.HUMO_CHAT_ID = ' "-1009876543210" ';

      const cfg = getCardPaymentConfig();
      expect(cfg.cardDigitsOnly).toBe("9860555566667777");
      expect(cfg.cardLast4).toBe("7777");
      expect(cfg.humoChatId).toBe("-1009876543210");
    });

    it("handles empty or missing values safely without throwing", () => {
      process.env.HUMO_CARD_NUMBER = "   ";
      process.env.HUMO_CARD_LAST4 = "";
      process.env.HUMO_CHAT_ID = "   ";

      const cfg = getCardPaymentConfig();
      expect(cfg.cardDigitsOnly).toBe("");
      expect(cfg.cardLast4).toBe("");
      expect(cfg.humoChatId).toBe("");
      expect(cfg.isConfigured).toBe(false);
      expect(cfg.mode).toBe("admin_only"); // Safe default
    });
  });

  describe("Safe Masking & No Secret Leakage", () => {
    it("masks card number showing only last 4 digits", () => {
      expect(maskCardNumber("9860123456789012")).toBe("**** **** **** 9012");
      expect(maskCardNumber("", "9012")).toBe("**** **** **** 9012");
      expect(maskCardNumber("")).toBe("Не задана");
    });

    it("masks bank chatId safely", () => {
      expect(maskChatId("-1001234567890")).toBe("-100*****7890");
      expect(maskChatId("1234567890")).toBe("12*****7890");
      expect(maskChatId("")).toBe("Не настроен");
    });

    it("never includes API hash, full card, or session string in diagnostics status", async () => {
      process.env.TELEGRAM_API_HASH = "SUPER_SECRET_API_HASH";
      process.env.TELEGRAM_SESSION = "SUPER_SECRET_SESSION_STRING";
      process.env.HUMO_CARD_NUMBER = "9860 1234 5678 9012";

      const status = await getHumoMonitorStatus();
      const str = JSON.stringify(status);

      expect(str).not.toContain("SUPER_SECRET_API_HASH");
      expect(str).not.toContain("SUPER_SECRET_SESSION_STRING");
      expect(str).not.toContain("1234 5678");
      expect(status.cardNumberMasked).toBe("**** **** **** 9012");
      expect(status.hasApiHash).toBe(true);
      expect(status.hasSession).toBe(true);
    });
  });

  describe("Access Control (canAccessCardPayment)", () => {
    it("denies all when mode is 'disabled'", () => {
      process.env.PAYMENT_MONITOR_MODE = "disabled";
      process.env.PAYMENT_ADMIN_IDS = "111,222";
      expect(canAccessCardPayment("111")).toBe(false);
      expect(canAccessCardPayment("999")).toBe(false);
    });

    it("allows only admin IDs when mode is 'admin_only' (default)", () => {
      process.env.PAYMENT_MONITOR_MODE = "admin_only";
      process.env.PAYMENT_ADMIN_IDS = "12345, 67890";
      expect(canAccessCardPayment("12345")).toBe(true);
      expect(canAccessCardPayment("67890")).toBe(true);
      expect(canAccessCardPayment("99999")).toBe(false);
      expect(canAccessCardPayment(null)).toBe(false);
    });

    it("strictly compares against PAYMENT_ADMIN_IDS, NOT TELEGRAM_ADMIN_CHAT_ID", () => {
      process.env.PAYMENT_MONITOR_MODE = "admin_only";
      process.env.PAYMENT_ADMIN_IDS = "55555";
      process.env.TELEGRAM_ADMIN_CHAT_ID = "77777";

      // 55555 is in PAYMENT_ADMIN_IDS -> allowed
      expect(canAccessCardPayment("55555")).toBe(true);
      // 77777 is only in TELEGRAM_ADMIN_CHAT_ID -> NOT allowed
      expect(canAccessCardPayment("77777")).toBe(false);
    });

    it("allows everyone when mode is 'all'", () => {
      process.env.PAYMENT_MONITOR_MODE = "all";
      expect(canAccessCardPayment("99999")).toBe(true);
      expect(canAccessCardPayment("12345")).toBe(true);
    });
  });

  describe("HUMO_CHAT_ID Matching (Numeric Chat ID verification)", () => {
    it("matches exact -100 format and bare numeric format", () => {
      const target = "-1001234567890";
      // Incoming with -100
      expect(isMatchingChatId("-1001234567890", null, target)).toBe(true);
      // Incoming as BigInt or bare number
      expect(isMatchingChatId("1234567890", null, target)).toBe(true);
      expect(isMatchingChatId(1234567890, null, target)).toBe(true);
      // Incoming via peerId
      expect(isMatchingChatId(null, { channelId: "1234567890" }, target)).toBe(true);
    });

    it("rejects non-matching chat IDs strictly", () => {
      const target = "-1001234567890";
      expect(isMatchingChatId("-1009999999999", null, target)).toBe(false);
      expect(isMatchingChatId("9999999999", null, target)).toBe(false);
      expect(isMatchingChatId(null, { channelId: "9999999999" }, target)).toBe(false);
    });
  });

  describe("Persisted Status & Invalid Session Reporting", () => {
    it("reads persisted monitor status from database when offline", async () => {
      await db.botSetting.upsert({
        where: { key: "humo_monitor_status" },
        create: {
          key: "humo_monitor_status",
          valueRu: JSON.stringify({
            isRunning: false,
            isConfigured: true,
            lastError: "invalid session",
            processedCount: 12,
          }),
        },
      });

      const status = await getHumoMonitorStatus(db);
      expect(status.isRunning).toBe(false);
      expect(status.isConfigured).toBe(true);
      expect(status.lastError).toBe("invalid session");
      expect(status.processedCount).toBe(12);
    });
  });

  describe("Unique Amount Generation", () => {
    it("generates unique total amount and avoids collision on same card", async () => {
      const now = new Date();
      db.cardPaymentRequests.push(
        { id: 1, cardLast4: "1234", baseAmount: 50000, extraAmount: 1, totalAmount: 50001, status: "pending", expiresAt: new Date(now.getTime() + 10000) },
        { id: 2, cardLast4: "1234", baseAmount: 50000, extraAmount: 2, totalAmount: 50002, status: "pending", expiresAt: new Date(now.getTime() + 10000) },
        { id: 3, cardLast4: "1234", baseAmount: 50000, extraAmount: 3, totalAmount: 50003, status: "pending", expiresAt: new Date(now.getTime() + 10000) },
      );

      const res = await generateUniqueAmount(50000, "1234", db, now);
      expect([1, 2, 3]).not.toContain(res.extraAmount);
      expect([50001, 50002, 50003]).not.toContain(res.totalAmount);
      expect(res.totalAmount).toBe(50000 + res.extraAmount);
    });

    it("ignores expired requests when checking for collisions", async () => {
      const now = new Date();
      db.cardPaymentRequests.push({
        id: 1,
        cardLast4: "1234",
        baseAmount: 50000,
        extraAmount: 1,
        totalAmount: 50001,
        status: "pending",
        expiresAt: new Date(now.getTime() - 1000), // Expired!
      });

      process.env.CARD_PAYMENT_MIN_EXTRA = "1";
      process.env.CARD_PAYMENT_MAX_EXTRA = "1";
      const res = await generateUniqueAmount(50000, "1234", db, now);
      expect(res.extraAmount).toBe(1);
    });
  });

  describe("Atomic CAS State Transitions", () => {
    it("confirms pending request atomically and prevents double confirmation", async () => {
      db.cardPaymentRequests.push({
        id: 10,
        status: "pending",
        totalAmount: 50017,
        cardLast4: "9988",
      });
      db.bankNotifications.push({
        id: 50,
        status: "unmatched",
        amount: 50017,
        cardLast4: "9988",
      });

      const first = await claimPaymentConfirmation(db, 10, 50);
      expect(first).toBe(true);
      expect(db.cardPaymentRequests[0].status).toBe("confirmed");
      expect(db.bankNotifications[0].status).toBe("matched");

      const second = await claimPaymentConfirmation(db, 10, 50);
      expect(second).toBe(false);
    });

    it("prevents confirmation if request already expired", async () => {
      db.cardPaymentRequests.push({
        id: 11,
        status: "expired",
        totalAmount: 50017,
        cardLast4: "9988",
      });
      db.bankNotifications.push({
        id: 51,
        status: "unmatched",
        amount: 50017,
        cardLast4: "9988",
      });

      const res = await claimPaymentConfirmation(db, 11, 51);
      expect(res).toBe(false);
      expect(db.cardPaymentRequests[0].status).toBe("expired");
    });

    it("expires pending request atomically", async () => {
      db.cardPaymentRequests.push({ id: 12, status: "pending", expiresAt: new Date(Date.now() - 1000) });
      const first = await claimPaymentExpiration(db, 12);
      expect(first).toBe(true);
      expect(db.cardPaymentRequests[0].status).toBe("expired");

      const second = await claimPaymentExpiration(db, 12);
      expect(second).toBe(false);
    });

    it("cancels pending request atomically", async () => {
      db.cardPaymentRequests.push({ id: 13, status: "pending" });
      const first = await claimPaymentCancellation(db, 13);
      expect(first).toBe(true);
      expect(db.cardPaymentRequests[0].status).toBe("cancelled");

      const second = await claimPaymentCancellation(db, 13);
      expect(second).toBe(false);
    });

    it("handles manual review confirm/reject idempotently", async () => {
      db.cardPaymentRequests.push({ id: 14, status: "pending" });
      const confirmed = await claimManualReview(db, 14, "confirm", "Approved by admin");
      expect(confirmed).toBe(true);
      expect(db.cardPaymentRequests[0].status).toBe("manual_confirmed");

      const rejected = await claimManualReview(db, 14, "reject", "Rejected");
      expect(rejected).toBe(false);
    });
  });

  describe("Bank Message Processing & Matching", () => {
    it("idempotently ignores duplicate bank notification (same chatId + messageId)", async () => {
      db.cardPaymentRequests.push({
        id: 100,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 50017,
        cardLast4: "1234",
        status: "pending",
        expiresAt: new Date(Date.now() + 60000),
      });

      const message = "Karta *1234: Kirim +50 017 UZS";
      const first = await processBankMessage(db, "-100123", 999, message, new Date());
      expect(first.matched).toBe(true);
      expect(first.requestId).toBe(100);

      const second = await processBankMessage(db, "-100123", 999, message, new Date());
      expect(second.matched).toBe(true);
      expect(db.bankNotifications.length).toBe(1);
    });

    it("records late notification when payment arrives after expiration", async () => {
      db.cardPaymentRequests.push({
        id: 101,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 60025,
        cardLast4: "5678",
        status: "expired",
        expiresAt: new Date(Date.now() - 10000),
      });

      const message = "Karta *5678: Kirim +60 025 UZS";
      const res = await processBankMessage(db, "-100123", 1001, message, new Date());

      expect(res.matched).toBe(false);
      expect(db.bankNotifications[0].status).toBe("late");
      expect(db.bankNotifications[0].adminReviewNote).toContain("Received after expiration");
    });

    it("records unmatched notification when amount does not match any active request", async () => {
      db.cardPaymentRequests.push({
        id: 102,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 70000,
        cardLast4: "5678",
        status: "pending",
        expiresAt: new Date(Date.now() + 60000),
      });

      const message = "Karta *5678: Kirim +70 050 UZS";
      const res = await processBankMessage(db, "-100123", 1002, message, new Date());

      expect(res.matched).toBe(false);
      expect(db.bankNotifications[0].status).toBe("unmatched");
      expect(db.cardPaymentRequests[0].status).toBe("pending");
    });

    it("incorrect amount (+1 or -1 UZS) does not confirm request and leaves it pending", async () => {
      db.cardPaymentRequests.push({
        id: 1021,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 50017,
        cardLast4: "5678",
        status: "pending",
        expiresAt: new Date(Date.now() + 60000),
      });

      // +1 UZS difference
      const msgPlus1 = "Karta *5678: Kirim +50 018 UZS";
      const resPlus1 = await processBankMessage(db, "-100123", 1021, msgPlus1, new Date());
      expect(resPlus1.matched).toBe(false);
      const reqAfterPlus1 = db.cardPaymentRequests.find((r) => r.id === 1021);
      expect(reqAfterPlus1.status).toBe("pending");

      // -1 UZS difference
      const msgMinus1 = "Karta *5678: Kirim +50 016 UZS";
      const resMinus1 = await processBankMessage(db, "-100123", 1022, msgMinus1, new Date());
      expect(resMinus1.matched).toBe(false);
      const reqAfterMinus1 = db.cardPaymentRequests.find((r) => r.id === 1021);
      expect(reqAfterMinus1.status).toBe("pending");
    });

    it("records unmatched notification when card does not match", async () => {
      db.cardPaymentRequests.push({
        id: 103,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 50017,
        cardLast4: "1111",
        status: "pending",
        expiresAt: new Date(Date.now() + 60000),
      });

      const message = "Karta *2222: Kirim +50 017 UZS";
      const res = await processBankMessage(db, "-100123", 1003, message, new Date());

      expect(res.matched).toBe(false);
      expect(db.bankNotifications[0].status).toBe("unmatched");
    });

    it("ignores debits completely and never confirms requests", async () => {
      db.cardPaymentRequests.push({
        id: 104,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 50017,
        cardLast4: "1234",
        status: "pending",
        expiresAt: new Date(Date.now() + 60000),
      });

      const message = "Karta *1234: Chiqim 50 017 UZS. Oplata tovarov";
      const res = await processBankMessage(db, "-100123", 1004, message, new Date());

      expect(res.matched).toBe(false);
      expect(db.cardPaymentRequests[0].status).toBe("pending");
      expect(db.bankNotifications[0].status).toBe("ignored");
      expect(db.bankNotifications[0].operationType).toBe("debit");
    });

    it("matches bank notification using fallbackCardLast4 when card is not mentioned in message text", async () => {
      process.env.HUMO_CARD_LAST4 = "8767";
      db.cardPaymentRequests.push({
        id: 105,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 50077,
        cardLast4: "8767",
        status: "pending",
        expiresAt: new Date(Date.now() + 60000),
      });

      // SMS text from bank without explicit card number (e.g. personal SMS forwarded to channel)
      const message = "Kirim: 50 077 UZS. Balans: 1 500 000 UZS";
      const res = await processBankMessage(db, "-100123", 1005, message, new Date());

      expect(res.matched).toBe(true);
      expect(res.requestId).toBe(105);
      expect(db.cardPaymentRequests[0].status).toBe("confirmed");
      expect(db.bankNotifications[0].cardLast4).toBe("8767");
    });

    it("correctly extracts amount from Zoomrad P2P notification with non-breaking space and comma decimals", async () => {
      process.env.HUMO_CARD_LAST4 = "8767";
      db.cardPaymentRequests.push({
        id: 106,
        userId: 1,
        variantId: 34,
        qty: 1,
        totalAmount: 6056,
        cardLast4: "8767",
        status: "pending",
        expiresAt: new Date(Date.now() + 60000),
      });

      // Exact Zoomrad P2P text with \u00A0 non-breaking space and ,00 decimals
      const zoomradMsg = "🎉 Пополнение + 6\u00A0056,00 UZS 📍 ZOOMRAD P2P Перевод с карты на карту *8767";
      const res = await processBankMessage(db, "-100123", 1006, zoomradMsg, new Date());

      expect(res.matched).toBe(true);
      expect(res.requestId).toBe(106);
      expect(db.cardPaymentRequests[0].status).toBe("confirmed");
      expect(db.bankNotifications[0].amount).toBe(6056);
      expect(db.bankNotifications[0].cardLast4).toBe("8767");
    });
  });

  describe("Fixed-time Expiration & Strict 5-Minute TTL", () => {
    it("strictly calculates expiresAt as createdAt + ttlSeconds * 1000", () => {
      const createdAt = new Date("2026-09-22T10:00:00.000Z");
      const expiresAt = calculatePaymentExpiry(createdAt, 300);
      expect(expiresAt.getTime() - createdAt.getTime()).toBe(300 * 1000);
      expect(expiresAt.toISOString()).toBe("2026-09-22T10:05:00.000Z");
    });

    it("leaves request as pending after 1 minute (60s)", async () => {
      const createdAt = new Date("2026-09-22T10:00:00.000Z");
      const expiresAt = calculatePaymentExpiry(createdAt, 300);

      db.cardPaymentRequests.push({
        id: 201,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 50020,
        cardLast4: "5678",
        status: "pending",
        createdAt,
        expiresAt,
      });

      // 1 minute later
      const timeAt1Min = new Date(createdAt.getTime() + 60 * 1000);
      const expired = await claimPaymentExpiration(db, 201, timeAt1Min);

      expect(expired).toBe(false);
      expect(db.cardPaymentRequests[0].status).toBe("pending");
    });

    it("leaves request as pending after 4 minutes 59 seconds (299s)", async () => {
      const createdAt = new Date("2026-09-22T10:00:00.000Z");
      const expiresAt = calculatePaymentExpiry(createdAt, 300);

      db.cardPaymentRequests.push({
        id: 202,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 50020,
        cardLast4: "5678",
        status: "pending",
        createdAt,
        expiresAt,
      });

      // 4 minutes 59 seconds later
      const timeAt4m59s = new Date(createdAt.getTime() + 299 * 1000);
      const expired = await claimPaymentExpiration(db, 202, timeAt4m59s);

      expect(expired).toBe(false);
      expect(db.cardPaymentRequests[0].status).toBe("pending");
    });

    it("atomically transitions request to expired after 5 minutes 1 second (301s)", async () => {
      const createdAt = new Date("2026-09-22T10:00:00.000Z");
      const expiresAt = calculatePaymentExpiry(createdAt, 300);

      db.cardPaymentRequests.push({
        id: 203,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 50020,
        cardLast4: "5678",
        status: "pending",
        createdAt,
        expiresAt,
      });

      // 5 minutes 1 second later
      const timeAt5m1s = new Date(createdAt.getTime() + 301 * 1000);
      const expired = await claimPaymentExpiration(db, 203, timeAt5m1s);

      expect(expired).toBe(true);
      expect(db.cardPaymentRequests[0].status).toBe("expired");
      expect(db.cardPaymentRequests[0].expirationNotifiedAt).toEqual(timeAt5m1s);
    });

    it("confirmed request never transitions to expired even after TTL expires", async () => {
      const createdAt = new Date("2026-09-22T10:00:00.000Z");
      const expiresAt = calculatePaymentExpiry(createdAt, 300);

      db.cardPaymentRequests.push({
        id: 204,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 50020,
        cardLast4: "5678",
        status: "confirmed",
        createdAt,
        expiresAt,
      });

      const timeAt10m = new Date(createdAt.getTime() + 600 * 1000);
      const expired = await claimPaymentExpiration(db, 204, timeAt10m);

      expect(expired).toBe(false);
      expect(db.cardPaymentRequests[0].status).toBe("confirmed");
      expect(db.cardPaymentRequests[0].expirationNotifiedAt).toBeUndefined();
    });

    it("two parallel timers send only one message (claimPaymentExpiration returns true once, false second time)", async () => {
      const createdAt = new Date("2026-09-22T10:00:00.000Z");
      const expiresAt = calculatePaymentExpiry(createdAt, 300);

      db.cardPaymentRequests.push({
        id: 207,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 50020,
        cardLast4: "5678",
        status: "pending",
        createdAt,
        expiresAt,
      });

      const timePastTtl = new Date(createdAt.getTime() + 301 * 1000);
      const [first, second] = await Promise.all([
        claimPaymentExpiration(db, 207, timePastTtl),
        claimPaymentExpiration(db, 207, timePastTtl),
      ]);

      expect([first, second].filter(Boolean).length).toBe(1);
      const req = db.cardPaymentRequests.find((r) => r.id === 207);
      expect(req.status).toBe("expired");
      expect(req.expirationNotifiedAt).toBeDefined();
    });

    it("repeated timer run does not modify already expired request", async () => {
      const createdAt = new Date("2026-09-22T10:00:00.000Z");
      const expiresAt = calculatePaymentExpiry(createdAt, 300);

      db.cardPaymentRequests.push({
        id: 205,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 50020,
        cardLast4: "5678",
        status: "pending",
        createdAt,
        expiresAt,
      });

      const timeAt5m1s = new Date(createdAt.getTime() + 301 * 1000);
      const firstRun = await claimPaymentExpiration(db, 205, timeAt5m1s);
      expect(firstRun).toBe(true);
      expect(db.cardPaymentRequests[0].status).toBe("expired");

      // Repeated run
      const secondRun = await claimPaymentExpiration(db, 205, timeAt5m1s);
      expect(secondRun).toBe(false);
      expect(db.cardPaymentRequests[0].status).toBe("expired");
    });

    it("process restart does not shorten deadline", () => {
      const createdAt = new Date("2026-09-22T10:00:00.000Z");
      const expiresAt = calculatePaymentExpiry(createdAt, 300);

      // Simulate state re-loaded from database in a fresh process instance
      const freshDb = new FakeCardDb();
      freshDb.cardPaymentRequests.push({
        id: 206,
        status: "pending",
        createdAt,
        expiresAt,
      });

      const checkTimeAt2m = new Date(createdAt.getTime() + 120 * 1000);
      const remainingMs = expiresAt.getTime() - checkTimeAt2m.getTime();

      expect(remainingMs).toBe(180 * 1000); // exactly 3 minutes remaining
      expect(expiresAt.getTime() - createdAt.getTime()).toBe(300 * 1000);
    });

    it("supports CARD_PAYMENT_TTL_SECOND backward compatibility alias", () => {
      delete process.env.CARD_PAYMENT_TTL_SECONDS;
      process.env.CARD_PAYMENT_TTL_SECOND = "250";
      expect(getCardPaymentConfig().ttlSeconds).toBe(250);

      process.env.CARD_PAYMENT_TTL_SECONDS = "350";
      expect(getCardPaymentConfig().ttlSeconds).toBe(350);

      delete process.env.CARD_PAYMENT_TTL_SECOND;
      delete process.env.CARD_PAYMENT_TTL_SECONDS;
      expect(getCardPaymentConfig().ttlSeconds).toBe(300); // default
    });
  });

  describe("Confirmation vs Expiration Race Condition", () => {
    it("if confirmed first, claimPaymentExpiration fails", async () => {
      const createdAt = new Date("2026-09-22T10:00:00.000Z");
      const expiresAt = calculatePaymentExpiry(createdAt, 300);

      db.cardPaymentRequests.push({
        id: 301,
        status: "pending",
        createdAt,
        expiresAt,
      });

      db.bankNotifications.push({
        id: 501,
        status: "unmatched",
      });

      // Confirm succeeds
      const confirmed = await claimPaymentConfirmation(db, 301, 501);
      expect(confirmed).toBe(true);

      // Now timer tries to expire
      const timePastTtl = new Date(createdAt.getTime() + 350 * 1000);
      const expired = await claimPaymentExpiration(db, 301, timePastTtl);

      expect(expired).toBe(false);
      expect(db.cardPaymentRequests[0].status).toBe("confirmed");
    });

    it("if expired first, claimPaymentConfirmation fails", async () => {
      const createdAt = new Date("2026-09-22T10:00:00.000Z");
      const expiresAt = calculatePaymentExpiry(createdAt, 300);

      db.cardPaymentRequests.push({
        id: 302,
        status: "pending",
        createdAt,
        expiresAt,
      });

      db.bankNotifications.push({
        id: 502,
        status: "unmatched",
      });

      // Expire succeeds past TTL
      const timePastTtl = new Date(createdAt.getTime() + 301 * 1000);
      const expired = await claimPaymentExpiration(db, 302, timePastTtl);
      expect(expired).toBe(true);

      // Now confirmation fails because request is no longer pending
      const confirmed = await claimPaymentConfirmation(db, 302, 502);
      expect(confirmed).toBe(false);
      expect(db.cardPaymentRequests[0].status).toBe("expired");
    });
  });

  describe("User On-Demand Check (triggerImmediateCheck)", () => {
    it("returns active message without remaining minutes when payment not found yet", async () => {
      const now = Date.now();
      const expiresAt = new Date(now + 240 * 1000); // 4 minutes left

      db.cardPaymentRequests.push({
        id: 401,
        status: "pending",
        createdAt: new Date(now - 60 * 1000),
        expiresAt,
      });

      const resRu = await triggerImmediateCheck(401, db, "ru");
      expect(resRu.isConfirmed).toBe(false);
      expect(resRu.message).toBe("Платёж пока не найден. Заявка активна, повторно переводить деньги не нужно.");

      const resUz = await triggerImmediateCheck(401, db, "uz");
      expect(resUz.isConfirmed).toBe(false);
      expect(resUz.message).toBe("To‘lov hozircha topilmadi. Ariza faol, pulni qayta o‘tkazish shart emas.");

      const resEn = await triggerImmediateCheck(401, db, "en");
      expect(resEn.isConfirmed).toBe(false);
      expect(resEn.message).toBe("Payment not found yet. Request is active, no need to send money again.");

      // Verify expiresAt was not modified / extended
      expect(db.cardPaymentRequests[0].expiresAt.getTime()).toBe(expiresAt.getTime());
      expect(db.cardPaymentRequests[0].status).toBe("pending");
    });

    it("returns expired message if request expired", async () => {
      const now = Date.now();
      db.cardPaymentRequests.push({
        id: 402,
        status: "expired",
        createdAt: new Date(now - 400 * 1000),
        expiresAt: new Date(now - 100 * 1000),
      });

      const res = await triggerImmediateCheck(402, db, "ru");
      expect(res.isConfirmed).toBe(false);
      expect(res.message).toContain("истёк");
    });

    it("returns confirmed message if request is already confirmed", async () => {
      db.cardPaymentRequests.push({
        id: 403,
        status: "confirmed",
        expiresAt: new Date(Date.now() + 100000),
      });

      const res = await triggerImmediateCheck(403, db, "ru");
      expect(res.isConfirmed).toBe(true);
      expect(res.message).toContain("подтверждена");
    });

    it("repeated clicking 'Я оплатил' does not alter confirmed or expired state", async () => {
      const now = Date.now();
      db.cardPaymentRequests.push(
        {
          id: 404,
          status: "confirmed",
          expiresAt: new Date(now + 60000),
        },
        {
          id: 405,
          status: "expired",
          expiresAt: new Date(now - 60000),
        },
        {
          id: 406,
          status: "pending",
          expiresAt: new Date(now + 120000),
        }
      );

      // Multiple clicks on confirmed
      for (let i = 0; i < 5; i++) {
        const res = await triggerImmediateCheck(404, db, "ru");
        expect(res.isConfirmed).toBe(true);
      }
      expect(db.cardPaymentRequests.find((r) => r.id === 404).status).toBe("confirmed");

      // Multiple clicks on expired
      for (let i = 0; i < 5; i++) {
        const res = await triggerImmediateCheck(405, db, "ru");
        expect(res.isConfirmed).toBe(false);
      }
      expect(db.cardPaymentRequests.find((r) => r.id === 405).status).toBe("expired");

      // Multiple clicks on pending
      const initialExpires = db.cardPaymentRequests.find((r) => r.id === 406).expiresAt.getTime();
      for (let i = 0; i < 5; i++) {
        const res = await triggerImmediateCheck(406, db, "ru");
        expect(res.isConfirmed).toBe(false);
      }
      const pendingReq = db.cardPaymentRequests.find((r) => r.id === 406);
      expect(pendingReq.status).toBe("pending");
      expect(pendingReq.expiresAt.getTime()).toBe(initialExpires);
    });
  });

  describe("Ready-Made Admin Support Link & Secrets Protection", () => {
    it("generates correct support text with all required fields when request is active", () => {
      const createdAt = new Date("2026-09-22T12:00:00.000Z");
      const expiresAt = new Date("2026-09-22T12:05:00.000Z");
      const now = new Date("2026-09-22T12:01:00.000Z"); // 4 min remaining

      const text = buildCardPaymentSupportText({
        adminUsername: "Aiobuna_support",
        requestId: 123,
        itemTitle: "Sinov Mahsuloti",
        totalAmount: 6053,
        createdAt,
        expiresAt,
        status: "pending",
        now,
      });

      expect(text).toContain("Здравствуйте! У меня проблема с оплатой на карту.");
      expect(text).toContain("Номер заявки: #123");
      expect(text).toContain("Товар: Sinov Mahsuloti");
      expect(text).toContain("Сумма: 6 053 сум");
      expect(text).toContain("Время создания: 2026-09-22");
      expect(text).toContain("Статус: платёж отправлен, но автоматически не подтверждён.");
      expect(text).toContain("Прошу проверить оплату.");
    });

    it("generates correct support text when request is expired", () => {
      const createdAt = new Date("2026-09-22T12:00:00.000Z");
      const expiresAt = new Date("2026-09-22T12:05:00.000Z");
      const now = new Date("2026-09-22T12:06:00.000Z"); // expired

      const text = buildCardPaymentSupportText({
        adminUsername: "Aiobuna_support",
        requestId: 124,
        itemTitle: "Telegram Premium 12 oy",
        totalAmount: 350050,
        createdAt,
        expiresAt,
        status: "expired",
        now,
      });

      expect(text).toContain("Номер заявки: #124");
      expect(text).toContain("Товар: Telegram Premium 12 oy");
      expect(text).toContain("Сумма: 350 050 сум");
      expect(text).toContain("Статус: время оплаты истекло, но платёж отправлен.");
    });

    it("generates url-encoded telegram link without secrets", () => {
      const createdAt = new Date("2026-09-22T12:00:00.000Z");
      const expiresAt = new Date("2026-09-22T12:05:00.000Z");

      const url = buildCardPaymentSupportUrl({
        adminUsername: "@custom_admin",
        requestId: 125,
        itemTitle: "Gemini AI Pro",
        totalAmount: 50077,
        createdAt,
        expiresAt,
        status: "pending",
      });

      expect(url).toMatch(/^https:\/\/t\.me\/custom_admin\?text=/);
      expect(url).toContain(encodeURIComponent("Номер заявки: #125"));
      expect(url).toContain(encodeURIComponent("Товар: Gemini AI Pro"));

      // NEVER leak secrets in link or message
      expect(url).not.toContain("9860");
      expect(url).not.toContain("session");
      expect(url).not.toContain("api_hash");
      expect(url).not.toContain("token");
    });

    it("uses default fallback username when admin username is not configured", () => {
      const url = buildCardPaymentSupportUrl({
        adminUsername: "",
        requestId: 126,
        itemTitle: "Test",
        totalAmount: 10000,
        createdAt: new Date(),
        expiresAt: new Date(),
        status: "pending",
      });

      expect(url).toMatch(/^https:\/\/t\.me\/Aiobuna_support\?text=/);
    });
  });

  describe("Payment Instructions & Button Formatting", () => {
    it("instruction text in uz contains exact total without formula", () => {
      const text = t("uz", "card_pay_instructions", {
        item: "Gemini AI Pro",
        qty: "1",
        cardNumber: "9860 6067 5671 8767",
        totalAmount: "50 077",
        baseAmount: "50 000",
        extraAmount: "77",
      });

      expect(text).toContain("To‘lov uchun aniq summa: 50 077 so‘m");
      expect(text).toContain("Faqat <b>50 077 so‘m</b> yuboring.");
      expect(text).toContain("<b>50 000 so‘m yubormang</b>");
      expect(text).not.toContain("50 000 + 77");
      expect(text).not.toContain("extraAmount");
    });

    it("instruction text in ru contains exact total without formula", () => {
      const text = t("ru", "card_pay_instructions", {
        item: "Gemini AI Pro",
        qty: "1",
        cardNumber: "9860 6067 5671 8767",
        totalAmount: "50 077",
        baseAmount: "50 000",
        extraAmount: "77",
      });

      expect(text).toContain("Точная сумма к оплате: 50 077 сум");
      expect(text).toContain("Переводите ровно <b>50 077 сум</b>.");
      expect(text).toContain("<b>Не отправляйте 50 000 сум</b>");
      expect(text).not.toContain("50 000 + 77");
      expect(text).not.toContain("extraAmount");
    });

    it("instruction text in en contains exact total without formula", () => {
      const text = t("en", "card_pay_instructions", {
        item: "Gemini AI Pro",
        qty: "1",
        cardNumber: "9860 6067 5671 8767",
        totalAmount: "50 077",
        baseAmount: "50 000",
        extraAmount: "77",
      });

      expect(text).toContain("Exact amount to pay: 50 077 UZS");
      expect(text).toContain("Transfer strictly <b>50 077 UZS</b>.");
      expect(text).toContain("<b>Do not send 50 000 UZS</b>");
      expect(text).not.toContain("50 000 + 77");
    });

    it("button text and premium custom emojis are properly configured", () => {
      expect(CARD_PREMIUM_EMOJI_1).toBe("5472296756152644790");
      expect(CARD_PREMIUM_EMOJI_2).toBe("5346328681075712891");

      // Buttons in Telegram Bot API must be plain text (no raw <tg-emoji> tags)
      expect(t("uz", "btn_pay_card")).toBe("Karta orqali to‘lash 💳 / 💳");
      expect(t("ru", "btn_pay_card")).toBe("Оплата картой 💳 / 💳");
      expect(t("en", "btn_pay_card")).toBe("Pay by card 💳 / 💳");

      expect(t("uz", "btn_pay_card")).not.toContain("<tg-emoji");
      expect(t("ru", "btn_pay_card")).not.toContain("<tg-emoji");
      expect(t("en", "btn_pay_card")).not.toContain("<tg-emoji");

      // HTML renderer provides the <tg-emoji> tags for rich message contexts
      const htmlUz = renderCardPayButtonHtml("uz");
      expect(htmlUz).toBe('Karta orqali to‘lash <tg-emoji emoji-id="5472296756152644790">💳</tg-emoji> / <tg-emoji emoji-id="5346328681075712891">💳</tg-emoji>');
    });
  });
});
