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
} from "../src/lib/domain/card-payment";
import {
  processBankMessage,
  isMatchingChatId,
  getHumoMonitorStatus,
} from "../src/lib/services/humo-monitor";

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

        if (matchesId && matchesStatus) {
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
      db.cardPaymentRequests.push({ id: 12, status: "pending" });
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
  });
});
