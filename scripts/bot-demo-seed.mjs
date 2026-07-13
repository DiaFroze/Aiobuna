// Seeds a few DEMO products (NexaStore-style) with stock into the bot catalog so
// the store bot is testable end-to-end. All demo codes are prefixed "demo_".
// Remove later:  node scripts/bot-demo-seed.mjs --clear
process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";

const db = new PrismaClient();
const clear = process.argv.includes("--clear");

const DEMO = [
  {
    code: "demo_chatgpt_plus",
    emoji: "🤖",
    titleRu: "ChatGPT Plus — 30 дней",
    descRu: "Личный аккаунт ChatGPT Plus на 30 дней. Выдаётся сразу после оплаты.",
    variants: [{ titleRu: "1 месяц", days: 30, usdt: 3.5, stock: ["chatgpt: demo1@mail.io / Pass#A1", "chatgpt: demo2@mail.io / Pass#B2", "chatgpt: demo3@mail.io / Pass#C3"] }],
  },
  {
    code: "demo_tg_premium",
    emoji: "⭐",
    titleRu: "Telegram Premium",
    descRu: "Активация Telegram Premium на ваш аккаунт.",
    variants: [
      { titleRu: "1 месяц", days: 30, usdt: 4.0, stock: ["TGP-1M-AAAA", "TGP-1M-BBBB"] },
      { titleRu: "3 месяца", days: 90, usdt: 10.0, stock: ["TGP-3M-CCCC"] },
    ],
  },
  {
    code: "demo_steam_5",
    emoji: "🎮",
    titleRu: "Steam Wallet $5 (Global)",
    descRu: "Код пополнения кошелька Steam на $5.",
    variants: [{ titleRu: "$5 код", days: 0, usdt: 5.49, stock: ["STEAM-5USD-1111", "STEAM-5USD-2222", "STEAM-5USD-3333", "STEAM-5USD-4444"] }],
  },
];

try {
  if (clear) {
    const del = await db.product.deleteMany({ where: { code: { startsWith: "demo_" } } });
    console.log(`Removed ${del.count} demo products.`);
  } else {
    let n = 0;
    for (const [i, d] of DEMO.entries()) {
      if (await db.product.findUnique({ where: { code: d.code } })) continue;
      const product = await db.product.create({
        data: {
          code: d.code,
          emoji: d.emoji,
          titleRu: d.titleRu,
          titleUz: d.titleRu,
          descRu: d.descRu,
          sortOrder: i + 1,
          isActive: true,
          plans: { create: { titleRu: "Тарифы", titleUz: "Tariflar" } },
        },
        include: { plans: true },
      });
      const planId = product.plans[0].id;
      for (const v of d.variants) {
        const variant = await db.variant.create({
          data: { planId, titleRu: v.titleRu, titleUz: v.titleRu, durationDays: v.days, priceUsdt: v.usdt, priceUzs: Math.round(v.usdt * 12600), isActive: true },
        });
        await db.stockItem.createMany({ data: v.stock.map((payload) => ({ variantId: variant.id, payload })) });
      }
      n++;
    }
    console.log(`Seeded ${n} demo products.`);
  }
  const products = await db.product.count();
  const stock = await db.stockItem.count({ where: { isSold: false } });
  console.log(JSON.stringify({ products, unsoldStock: stock }));
} finally {
  await db.$disconnect();
}
