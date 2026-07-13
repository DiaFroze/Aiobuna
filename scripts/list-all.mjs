process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";
const db = new PrismaClient();
const products = await db.product.findMany({
  include: { plans: { include: { variants: true } } }
});
for (const p of products) {
  console.log(`Product: ID=${p.id}, titleRu=${p.titleRu}`);
  for (const pl of p.plans) {
    for (const v of pl.variants) {
      console.log(`  Variant: ID=${v.id}, titleRu=${v.titleRu}`);
    }
  }
}
await db.$disconnect();
