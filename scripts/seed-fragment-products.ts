// Seed script: Add Telegram Premium and Telegram Stars products to the catalog.
// Idempotent — safe to run multiple times. Skips if product code already exists.
//
// Usage: npx tsx scripts/seed-fragment-products.ts

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  // ---- Telegram Premium ----
  const premiumCode = "tg_premium";
  const existingPremium = await db.product.findUnique({ where: { code: premiumCode } });

  if (existingPremium) {
    console.log(`✅ Product "${premiumCode}" already exists (id=${existingPremium.id}), skipping.`);
  } else {
    const lastSort = await db.product.findFirst({ orderBy: { sortOrder: "desc" } });
    const nextSort = (lastSort?.sortOrder ?? 0) + 1;

    const premium = await db.product.create({
      data: {
        code: premiumCode,
        titleRu: "Telegram Premium",
        titleUz: "Telegram Premium",
        titleEn: "Telegram Premium",
        emoji: "⭐",
        descRu: "Подписка Telegram Premium — расширенные возможности, эксклюзивные стикеры, ускоренная загрузка и многое другое.",
        descUz: "Telegram Premium obunasi — kengaytirilgan imkoniyatlar, eksklyuziv stikerlar, tezlashtirilgan yuklab olish va boshqa ko'p narsalar.",
        descEn: "Telegram Premium subscription — expanded features, exclusive stickers, faster downloads and much more.",
        sortOrder: nextSort,
        isActive: true,
        plans: {
          create: {
            titleRu: "Срок подписки",
            titleUz: "Obuna muddati",
            sortOrder: 0,
            isActive: true,
            variants: {
              create: [
                {
                  titleRu: "3 месяца",
                  titleUz: "3 oy",
                  durationDays: 90,
                  priceUzs: 150000,
                  priceStars: 0,
                  priceUsdt: 0,
                  sortOrder: 0,
                  isActive: true,
                  manualDelivery: true,
                  manualStockLimit: -1,
                  needsUsername: true,
                  fragmentKind: "premium",
                  fragmentAmount: 3,
                },
                {
                  titleRu: "6 месяцев",
                  titleUz: "6 oy",
                  durationDays: 180,
                  priceUzs: 270000,
                  priceStars: 0,
                  priceUsdt: 0,
                  sortOrder: 1,
                  isActive: true,
                  manualDelivery: true,
                  manualStockLimit: -1,
                  needsUsername: true,
                  fragmentKind: "premium",
                  fragmentAmount: 6,
                },
                {
                  titleRu: "12 месяцев",
                  titleUz: "12 oy",
                  durationDays: 365,
                  priceUzs: 480000,
                  priceStars: 0,
                  priceUsdt: 0,
                  sortOrder: 2,
                  isActive: true,
                  manualDelivery: true,
                  manualStockLimit: -1,
                  needsUsername: true,
                  fragmentKind: "premium",
                  fragmentAmount: 12,
                },
              ],
            },
          },
        },
      },
      include: { plans: { include: { variants: true } } },
    });

    console.log(`✅ Created "Telegram Premium" (id=${premium.id}) with ${premium.plans[0].variants.length} variants:`);
    for (const v of premium.plans[0].variants) {
      console.log(`   - ${v.titleRu}: ${v.priceUzs} сум, fragmentKind=${v.fragmentKind}, fragmentAmount=${v.fragmentAmount}`);
    }
  }

  // ---- Telegram Stars ----
  const starsCode = "tg_stars";
  const existingStars = await db.product.findUnique({ where: { code: starsCode } });

  if (existingStars) {
    console.log(`✅ Product "${starsCode}" already exists (id=${existingStars.id}), skipping.`);
  } else {
    const lastSort = await db.product.findFirst({ orderBy: { sortOrder: "desc" } });
    const nextSort = (lastSort?.sortOrder ?? 0) + 1;

    const stars = await db.product.create({
      data: {
        code: starsCode,
        titleRu: "Telegram Stars",
        titleUz: "Telegram Stars",
        titleEn: "Telegram Stars",
        emoji: "🌟",
        descRu: "Звёзды Telegram — используй для подписок, подарков и покупок внутри Telegram.",
        descUz: "Telegram yulduzlari — obunalar, sovg'alar va Telegram ichidagi xaridlar uchun foydalaning.",
        descEn: "Telegram Stars — use for subscriptions, gifts and in-app purchases within Telegram.",
        sortOrder: nextSort,
        isActive: true,
        plans: {
          create: {
            titleRu: "Количество Stars",
            titleUz: "Stars soni",
            sortOrder: 0,
            isActive: true,
            variants: {
              create: [
                {
                  titleRu: "50 Stars",
                  titleUz: "50 Stars",
                  durationDays: 0,
                  priceUzs: 13000,
                  priceStars: 0,
                  priceUsdt: 0,
                  sortOrder: 0,
                  isActive: true,
                  manualDelivery: true,
                  manualStockLimit: -1,
                  needsUsername: true,
                  fragmentKind: "stars",
                  fragmentAmount: 50,
                },
                {
                  titleRu: "100 Stars",
                  titleUz: "100 Stars",
                  durationDays: 0,
                  priceUzs: 26000,
                  priceStars: 0,
                  priceUsdt: 0,
                  sortOrder: 1,
                  isActive: true,
                  manualDelivery: true,
                  manualStockLimit: -1,
                  needsUsername: true,
                  fragmentKind: "stars",
                  fragmentAmount: 100,
                },
                {
                  titleRu: "250 Stars",
                  titleUz: "250 Stars",
                  durationDays: 0,
                  priceUzs: 65000,
                  priceStars: 0,
                  priceUsdt: 0,
                  sortOrder: 2,
                  isActive: true,
                  manualDelivery: true,
                  manualStockLimit: -1,
                  needsUsername: true,
                  fragmentKind: "stars",
                  fragmentAmount: 250,
                },
                {
                  titleRu: "500 Stars",
                  titleUz: "500 Stars",
                  durationDays: 0,
                  priceUzs: 130000,
                  priceStars: 0,
                  priceUsdt: 0,
                  sortOrder: 3,
                  isActive: true,
                  manualDelivery: true,
                  manualStockLimit: -1,
                  needsUsername: true,
                  fragmentKind: "stars",
                  fragmentAmount: 500,
                },
                {
                  titleRu: "1000 Stars",
                  titleUz: "1000 Stars",
                  durationDays: 0,
                  priceUzs: 260000,
                  priceStars: 0,
                  priceUsdt: 0,
                  sortOrder: 4,
                  isActive: true,
                  manualDelivery: true,
                  manualStockLimit: -1,
                  needsUsername: true,
                  fragmentKind: "stars",
                  fragmentAmount: 1000,
                },
              ],
            },
          },
        },
      },
      include: { plans: { include: { variants: true } } },
    });

    console.log(`✅ Created "Telegram Stars" (id=${stars.id}) with ${stars.plans[0].variants.length} variants:`);
    for (const v of stars.plans[0].variants) {
      console.log(`   - ${v.titleRu}: ${v.priceUzs} сум, fragmentKind=${v.fragmentKind}, fragmentAmount=${v.fragmentAmount}`);
    }
  }

  console.log("\n🎉 Done! Both products are now in the catalog.");
  console.log("Toggle isActive in admin to show/hide them from the bot menu.");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
