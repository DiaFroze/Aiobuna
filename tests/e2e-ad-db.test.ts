import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  validateAdCode,
  parseAdStartPayload,
  isCrawlerBot,
  hashVisitorIp,
  buildAdRedirectUrl,
  calculateAdMetrics,
  buildFunnelSteps,
} from "../src/lib/domain/ad-attribution";

const prisma = new PrismaClient();

describe("E2E Live Database Simulation: Advertising Attribution", () => {
  it("executes full lifecycle: create link, click, start, orders, spend, analytics & cleanup", async () => {
    // 1. Create test AdLink
    const testCode = "test_meta_reels_" + Date.now();
    const validation = validateAdCode(testCode);
    expect(validation.valid).toBe(true);

    const adLink = await prisma.adLink.create({
      data: {
        name: "Test Reels Campaign",
        code: validation.code,
        platform: "Meta",
        campaignName: "Spring AI Promo",
        adGroupName: "Broad 18-35",
        adName: "Reels 5 Hook",
        creativeUrl: "https://instagram.com/reel/test",
        budget: 50,
        isActive: true,
      },
    });
    expect(adLink.id).toBeGreaterThan(0);

    // 2. Collision test
    const duplicate = await prisma.adLink.findUnique({ where: { code: testCode } });
    expect(duplicate?.id).toBe(adLink.id);

    // 3. Web click simulation
    const ip = "185.139.137.10";
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4)";
    const ipHash = hashVisitorIp(ip, ua);
    const isBot = isCrawlerBot(ua);
    expect(isBot).toBe(false);

    const click = await prisma.adClick.create({
      data: {
        adLinkId: adLink.id,
        ipHash,
        userAgent: ua,
        isUnique: true,
        isBot: false,
      },
    });
    expect(click.id).toBeGreaterThan(0);

    // 4. Bot /start simulation (First touch)
    const tgId = "test_tg_" + Date.now();
    const candidateCode = parseAdStartPayload(testCode);
    expect(candidateCode).toBe(testCode);

    const testUser = await prisma.botUser.create({
      data: {
        tgId,
        firstName: "TestBuyer",
        username: "testbuyer_" + Date.now(),
        firstAdId: adLink.id,
        firstAdCode: adLink.code,
        firstAdAt: new Date(),
        lastAdId: adLink.id,
        lastAdCode: adLink.code,
        lastAdAt: new Date(),
      },
    });
    expect(testUser.firstAdCode).toBe(adLink.code);

    await prisma.adStartEvent.create({
      data: {
        adLinkId: adLink.id,
        adCode: adLink.code,
        userId: testUser.id,
        isNewUser: true,
      },
    });

    // 5. Multi-touch test (User clicks another ad)
    const code2 = "campaign_2_" + Date.now();
    const adLink2 = await prisma.adLink.create({
      data: { name: "Campaign 2", code: code2, platform: "Instagram" },
    });

    const updatedUser = await prisma.botUser.update({
      where: { id: testUser.id },
      data: {
        lastAdId: adLink2.id,
        lastAdCode: adLink2.code,
        lastAdAt: new Date(),
      },
    });
    expect(updatedUser.firstAdCode).toBe(testCode); // FIRST TOUCH PRESERVED!
    expect(updatedUser.lastAdCode).toBe(code2);     // LAST TOUCH UPDATED!

    // 6. Creating Orders
    // Order 1: Paid order attributed to AdLink 1
    const order1 = await prisma.botOrder.create({
      data: {
        userId: testUser.id,
        titleRu: "Gemini Pro 1m",
        priceUsdt: 50000,
        priceUzs: 50000,
        costPriceUzs: 20000,
        payload: "key123",
        source: "hybrid",
        status: "delivered",
        firstAdCode: testUser.firstAdCode,
        lastAdCode: adLink.code,
        attributedAdId: adLink.id,
        attributedAdCode: adLink.code,
        adAttributedAt: new Date(),
      },
    });

    // Order 2: Failed / cancelled order
    const order2 = await prisma.botOrder.create({
      data: {
        userId: testUser.id,
        titleRu: "Failed Order",
        priceUsdt: 50000,
        priceUzs: 50000,
        costPriceUzs: 20000,
        payload: "",
        source: "hybrid",
        status: "failed", // Should NOT count as revenue!
        firstAdCode: testUser.firstAdCode,
        attributedAdId: adLink.id,
        attributedAdCode: adLink.code,
      },
    });

    // Order 3: Repeat paid order
    const order3 = await prisma.botOrder.create({
      data: {
        userId: testUser.id,
        titleRu: "CapCut Pro 1m",
        priceUsdt: 75000,
        priceUzs: 75000,
        costPriceUzs: 30000,
        payload: "capcut123",
        source: "hybrid",
        status: "delivered",
        firstAdCode: testUser.firstAdCode,
        attributedAdId: adLink.id,
        attributedAdCode: adLink.code,
        adAttributedAt: new Date(),
      },
    });

    // 7. Add actual ad spend
    const expense = await prisma.adExpense.create({
      data: {
        adLinkId: adLink.id,
        amount: 10,
        currency: "USD",
        amountUzs: 126000,
        startDate: new Date(Date.now() - 86400000),
        endDate: new Date(),
        comment: "Meta Ads 1-day spend",
      },
    });
    expect(expense.id).toBeGreaterThan(0);

    // 8. Verify Analytics Queries
    const paidOrders = await prisma.botOrder.findMany({
      where: {
        attributedAdId: adLink.id,
        status: { in: ["delivered", "completed", "awaiting_delivery", "processing", "course_ready", "awaiting_course_link"] },
        priceUsdt: { gt: 0 },
      },
    });

    expect(paidOrders.length).toBe(2);
    const revenue = paidOrders.reduce((sum, o) => sum + (o.priceUzs ?? o.priceUsdt), 0);
    const costPrice = paidOrders.reduce((sum, o) => sum + (o.costPriceUzs ?? 0), 0);

    expect(revenue).toBe(125000);
    expect(costPrice).toBe(50000);

    const metrics = calculateAdMetrics({
      clicks: 1,
      uniqueClicks: 1,
      starts: 1,
      newUsers: 1,
      payingUsers: 1,
      paidOrdersCount: 2,
      repeatBuyers: 1,
      revenueUzs: revenue,
      costPriceUzs: costPrice,
      hasIncompleteCostPrice: false,
      actualSpendUzs: 126000,
    });

    expect(metrics.profitBeforeAds).toBe(75000);
    expect(metrics.profitAfterAds).toBe(-51000);
    expect(metrics.roas).toBe(0.99);
    expect(metrics.aov).toBe(62500);
    expect(metrics.repeatOrdersCount).toBe(1);

    // 9. Deletion safety check
    const linkedOrders = await prisma.botOrder.count({ where: { attributedAdId: adLink.id } });
    expect(linkedOrders).toBe(3); // 2 paid + 1 failed

    // 10. Clean up
    await prisma.botOrder.deleteMany({ where: { userId: testUser.id } });
    await prisma.adStartEvent.deleteMany({ where: { userId: testUser.id } });
    await prisma.botUser.delete({ where: { id: testUser.id } });
    await prisma.adClick.deleteMany({ where: { adLinkId: adLink.id } });
    await prisma.adExpense.deleteMany({ where: { adLinkId: adLink.id } });
    await prisma.adLink.delete({ where: { id: adLink.id } });
    await prisma.adLink.delete({ where: { id: adLink2.id } });
  });
});
