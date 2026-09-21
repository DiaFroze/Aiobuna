import { describe, it, expect, beforeEach } from "vitest";
import {
  canAccessCardPayment,
  generateUniqueAmount,
  claimPaymentConfirmation,
  claimPaymentExpiration,
  claimPaymentCancellation,
  claimManualReview,
} from "../src/lib/domain/card-payment";
import { processBankMessage } from "../src/lib/services/humo-monitor";

// In-memory fake database simulating Prisma transactions and CAS
class FakeCardDb {
  cardPaymentRequests: any[] = [];
  bankNotifications: any[] = [];
  fulfilledRequests: number[] = [];

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
    delete process.env.PAYMENT_MONITOR_MODE;
    delete process.env.PAYMENT_ADMIN_IDS;
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

    it("allows everyone when mode is 'all'", () => {
      process.env.PAYMENT_MONITOR_MODE = "all";
      expect(canAccessCardPayment("99999")).toBe(true);
      expect(canAccessCardPayment("12345")).toBe(true);
    });
  });

  describe("Unique Amount Generation", () => {
    it("generates unique total amount and avoids collision on same card", async () => {
      const now = new Date();
      // Pre-occupy offsets 1, 2, 3 on card 1234
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
      // Offset 1 is on an EXPIRED request
      db.cardPaymentRequests.push({
        id: 1,
        cardLast4: "1234",
        baseAmount: 50000,
        extraAmount: 1,
        totalAmount: 50001,
        status: "pending",
        expiresAt: new Date(now.getTime() - 1000), // Expired!
      });

      // Offset 1 is free to use now
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

      // First confirmation succeeds
      const first = await claimPaymentConfirmation(db, 10, 50);
      expect(first).toBe(true);
      expect(db.cardPaymentRequests[0].status).toBe("confirmed");
      expect(db.bankNotifications[0].status).toBe("matched");

      // Second concurrent/retry confirmation fails (money moves once!)
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

      // Subsequent reject fails because status is already manual_confirmed
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

      // Second identical message
      const second = await processBankMessage(db, "-100123", 999, message, new Date());
      expect(second.matched).toBe(true);
      expect(db.bankNotifications.length).toBe(1); // No duplicate notification created
    });

    it("records late notification when payment arrives after expiration", async () => {
      db.cardPaymentRequests.push({
        id: 101,
        userId: 1,
        variantId: 10,
        qty: 1,
        totalAmount: 60025,
        cardLast4: "5678",
        status: "expired", // Already expired!
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

      // Someone transferred 70 050 instead of 70 000
      const message = "Karta *5678: Kirim +70 050 UZS";
      const res = await processBankMessage(db, "-100123", 1002, message, new Date());

      expect(res.matched).toBe(false);
      expect(db.bankNotifications[0].status).toBe("unmatched");
      expect(db.cardPaymentRequests[0].status).toBe("pending"); // Not confirmed
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

      // Payment on card 2222
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
