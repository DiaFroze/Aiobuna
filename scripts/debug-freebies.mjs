process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";

const db = new PrismaClient();

async function main() {
  // ALL products, including inactive
  const products = await db.product.findMany({
    orderBy: { id: "desc" },
    include: {
      plans: {
        include: {
          variants: true, // all variants, including inactive
        },
      },
    },
  });

  console.log(`Total products in DB: ${products.length}\n`);

  for (const p of products) {
    const variants = p.plans.flatMap((pl) => pl.variants);
    console.log(`[id=${p.id}] ${p.emoji} "${p.titleRu}" | active=${p.isActive} | sortOrder=${p.sortOrder}`);
    if (variants.length === 0) {
      console.log(`  ⚠️  NO VARIANTS`);
    }
    for (const v of variants) {
      const localStock = await db.stockItem.count({ where: { variantId: v.id, isSold: false } });
      const effectiveStock = v.manualDelivery ? 999999 : v.autoSupplier ? v.supplierStock : localStock;
      console.log(`  Variant [id=${v.id}] "${v.titleRu}" | active=${v.isActive} | priceUzs=${v.priceUzs} | priceUsdt=${v.priceUsdt} | stock=${effectiveStock} | autoSupplier=${v.autoSupplier} | manualDelivery=${v.manualDelivery}`);
    }
    console.log();
  }
}

main().catch(console.error).finally(() => db.$disconnect());
