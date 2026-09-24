import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateCreatorCode,
  parseCreatorStartPayload,
  formatCreatorLink,
  getCreatorCommission,
  accrueOrderCommission,
  requestCreatorPayout,
  approveCreatorPayout,
  rejectCreatorPayout,
  MIN_CREATOR_PAYOUT_UZS,
} from "../src/lib/domain/creators";

describe("Creator Domain - Code & Payload Validation", () => {
  it("validates allowed creator slugs and extracts from full URLs", () => {
    expect(validateCreatorCode("alex")).toEqual({ valid: true, code: "alex" });
    expect(validateCreatorCode("c_alex")).toEqual({ valid: true, code: "alex" });
    expect(validateCreatorCode("MEDIA_STAR_1")).toEqual({ valid: true, code: "media_star_1" });
    expect(validateCreatorCode("top-blogger")).toEqual({ valid: true, code: "top-blogger" });
    expect(validateCreatorCode("https://aiobuna.vercel.app/go/meta_dcntjqbicwm_2026092")).toEqual({
      valid: true,
      code: "meta_dcntjqbicwm_2026092",
    });
    expect(validateCreatorCode("https://t.me/Aiobuna_bot?start=c_alex")).toEqual({
      valid: true,
      code: "alex",
    });
  });

  it("rejects invalid creator codes", () => {
    expect(validateCreatorCode("").valid).toBe(false);
    expect(validateCreatorCode("a").valid).toBe(false); // too short
    expect(validateCreatorCode("a".repeat(70)).valid).toBe(false); // too long
    expect(validateCreatorCode("hello world!").valid).toBe(false); // invalid chars
    expect(validateCreatorCode("user@name").valid).toBe(false);
  });

  it("correctly parses Telegram /start payloads", () => {
    expect(parseCreatorStartPayload("c_alex")).toBe("alex");
    expect(parseCreatorStartPayload("c_media_2026")).toBe("media_2026");
    expect(parseCreatorStartPayload("creator_vip")).toBe("vip");
    expect(parseCreatorStartPayload("c_")).toBe(null);
    expect(parseCreatorStartPayload("ref_12345")).toBe(null);
    expect(parseCreatorStartPayload("buy_10")).toBe(null);
    expect(parseCreatorStartPayload("deal_abc")).toBe(null);
    expect(parseCreatorStartPayload(null)).toBe(null);
  });

  it("formats referral link with correct start parameter", () => {
    expect(formatCreatorLink("Aiobuna_bot", "alex")).toBe("https://t.me/Aiobuna_bot?start=c_alex");
    expect(formatCreatorLink("Aiobuna_bot", "c_alex")).toBe("https://t.me/Aiobuna_bot?start=c_alex");
  });
});

describe("Creator Domain - Commission Calculation", () => {
  it("uses custom product rate when configured", async () => {
    const mockClient = {
      creatorProductRate: {
        findUnique: vi.fn().mockResolvedValue({ rewardUzs: 25000 }),
      },
      creator: {
        findUnique: vi.fn().mockResolvedValue({ defaultRateUzs: 10000, isActive: true }),
      },
    };

    const rate = await getCreatorCommission(mockClient, 1, 42);
    expect(rate).toBe(25000);
    expect(mockClient.creatorProductRate.findUnique).toHaveBeenCalledWith({
      where: { creatorId_variantId: { creatorId: 1, variantId: 42 } },
    });
  });

  it("falls back to default creator rate if no custom product rate exists", async () => {
    const mockClient = {
      creatorProductRate: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      creator: {
        findUnique: vi.fn().mockResolvedValue({ defaultRateUzs: 12000, isActive: true }),
      },
    };

    const rate = await getCreatorCommission(mockClient, 1, 42);
    expect(rate).toBe(12000);
  });

  it("returns 0 if creator is inactive or not found", async () => {
    const mockClient = {
      creatorProductRate: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      creator: {
        findUnique: vi.fn().mockResolvedValue({ defaultRateUzs: 12000, isActive: false }),
      },
    };

    const rate = await getCreatorCommission(mockClient, 1, 42);
    expect(rate).toBe(0);
  });
});

describe("Creator Domain - Commission Accrual & Financial Ledger", () => {
  it("atomically accrues commission and records ledger", async () => {
    let balance = 20000;
    let totalEarned = 20000;
    let ledgerRecords: any[] = [];
    let rewardRecords: any[] = [];

    const mockTx = {
      creatorOrderReward: {
        findUnique: vi.fn().mockImplementation(({ where }) => {
          return rewardRecords.find((r) => r.orderId === where.orderId) || null;
        }),
        create: vi.fn().mockImplementation(({ data }) => {
          const record = { id: 101, ...data };
          rewardRecords.push(record);
          return record;
        }),
      },
      creator: {
        findUnique: vi.fn().mockResolvedValue({
          id: 5,
          isActive: true,
          balanceUzs: balance,
          defaultRateUzs: 10000,
        }),
        update: vi.fn().mockImplementation(({ data }) => {
          balance += data.balanceUzs.increment;
          totalEarned += data.totalEarnedUzs.increment;
          return { id: 5, balanceUzs: balance, totalEarnedUzs: totalEarned };
        }),
      },
      creatorProductRate: {
        findUnique: vi.fn().mockResolvedValue({ rewardUzs: 15000 }),
      },
      creatorLedger: {
        create: vi.fn().mockImplementation(({ data }) => {
          ledgerRecords.push(data);
          return { id: ledgerRecords.length, ...data };
        }),
      },
      botOrder: {
        update: vi.fn().mockResolvedValue({}),
      },
    };

    const res = await accrueOrderCommission(mockTx, {
      orderId: 777,
      buyerId: 88,
      variantId: 10,
      orderTotalUzs: 120000,
      creatorId: 5,
    });

    expect(res.success).toBe(true);
    expect(res.amountUzs).toBe(15000);
    expect(res.rewardId).toBe(101);
    expect(balance).toBe(35000);
    expect(totalEarned).toBe(35000);

    // Ledger check
    expect(ledgerRecords).toHaveLength(1);
    expect(ledgerRecords[0].type).toBe("COMMISSION");
    expect(ledgerRecords[0].amountUzs).toBe(15000);
    expect(ledgerRecords[0].balanceBefore).toBe(20000);
    expect(ledgerRecords[0].balanceAfter).toBe(35000);
    expect(ledgerRecords[0].referenceId).toBe("777");

    // Idempotency test: repeating same orderId should return alreadyCredited without double increment
    const secondCall = await accrueOrderCommission(mockTx, {
      orderId: 777,
      buyerId: 88,
      variantId: 10,
      orderTotalUzs: 120000,
      creatorId: 5,
    });

    expect(secondCall.alreadyCredited).toBe(true);
    expect(balance).toBe(35000); // unchanged
    expect(ledgerRecords).toHaveLength(1); // no duplicate ledger
  });
});

describe("Creator Domain - Payout Lifecycle", () => {
  it("enforces minimum payout amount of 50,000 UZS", async () => {
    const res = await requestCreatorPayout({}, {
      creatorId: 1,
      amountUzs: 30000,
      cardNumber: "8600123412341234",
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe("AMOUNT_BELOW_MINIMUM");
  });

  it("validates card number length", async () => {
    const res = await requestCreatorPayout({}, {
      creatorId: 1,
      amountUzs: 60000,
      cardNumber: "1234",
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe("INVALID_CARD");
  });

  it("moves funds from balance to holdBalance on payout request", async () => {
    let balance = 100000;
    let hold = 0;
    let ledgers: any[] = [];

    const mockTx = {
      creator: {
        findUnique: vi.fn().mockResolvedValue({
          id: 1,
          isActive: true,
          balanceUzs: balance,
          holdBalanceUzs: hold,
        }),
        updateMany: vi.fn().mockImplementation(({ where, data }) => {
          if (where.balanceUzs?.gte && balance < where.balanceUzs.gte) {
            return { count: 0 };
          }
          balance -= data.balanceUzs.decrement;
          hold += data.holdBalanceUzs.increment;
          return { count: 1 };
        }),
      },
      creatorPayout: {
        create: vi.fn().mockResolvedValue({ id: 50 }),
      },
      creatorLedger: {
        create: vi.fn().mockImplementation(({ data }) => ledgers.push(data)),
      },
    };

    const res = await requestCreatorPayout(mockTx, {
      creatorId: 1,
      amountUzs: 60000,
      cardNumber: "8600 1234 5678 9012",
      cardHolder: "Test User",
    });

    expect(res.success).toBe(true);
    expect(res.payoutId).toBe(50);
    expect(balance).toBe(40000);
    expect(hold).toBe(60000);
    expect(ledgers[0].type).toBe("PAYOUT_REQUEST");
    expect(ledgers[0].amountUzs).toBe(-60000);

    // Overdraft attempt fails with INSUFFICIENT_BALANCE
    const overdraftRes = await requestCreatorPayout(mockTx, {
      creatorId: 1,
      amountUzs: 50000, // available is only 40000
      cardNumber: "8600 1234 5678 9012",
    });
    expect(overdraftRes.success).toBe(false);
    expect(overdraftRes.error).toBe("INSUFFICIENT_BALANCE");
  });

  it("approves payout: moves from hold to totalPaid", async () => {
    let hold = 60000;
    let paid = 0;
    let ledgers: any[] = [];

    const mockTx = {
      creatorPayout: {
        findUnique: vi.fn().mockResolvedValue({
          id: 50,
          creatorId: 1,
          amountUzs: 60000,
          status: "pending",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      creator: {
        update: vi.fn().mockImplementation(({ data }) => {
          hold -= data.holdBalanceUzs.decrement;
          paid += data.totalPaidUzs.increment;
        }),
        findUnique: vi.fn().mockResolvedValue({ balanceUzs: 40000 }),
      },
      creatorLedger: {
        create: vi.fn().mockImplementation(({ data }) => ledgers.push(data)),
      },
    };

    const res = await approveCreatorPayout(mockTx, {
      payoutId: 50,
      adminUser: "superadmin@sb.eu",
      note: "Humo txn #9991",
    });

    expect(res.success).toBe(true);
    expect(hold).toBe(0);
    expect(paid).toBe(60000);
    expect(ledgers[0].type).toBe("PAYOUT_APPROVED");
  });

  it("rejects payout: refunds hold back to balance", async () => {
    let balance = 40000;
    let hold = 60000;
    let ledgers: any[] = [];

    const mockTx = {
      creatorPayout: {
        findUnique: vi.fn().mockResolvedValue({
          id: 51,
          creatorId: 1,
          amountUzs: 60000,
          status: "pending",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      creator: {
        findUnique: vi.fn().mockResolvedValue({ balanceUzs: balance }),
        update: vi.fn().mockImplementation(({ data }) => {
          hold -= data.holdBalanceUzs.decrement;
          balance += data.balanceUzs.increment;
        }),
      },
      creatorLedger: {
        create: vi.fn().mockImplementation(({ data }) => ledgers.push(data)),
      },
    };

    const res = await rejectCreatorPayout(mockTx, {
      payoutId: 51,
      adminUser: "superadmin@sb.eu",
      reason: "Неверный номер карты",
    });

    expect(res.success).toBe(true);
    expect(hold).toBe(0);
    expect(balance).toBe(100000);
    expect(ledgers[0].type).toBe("PAYOUT_REJECTED");
    expect(ledgers[0].amountUzs).toBe(60000);
  });
});
