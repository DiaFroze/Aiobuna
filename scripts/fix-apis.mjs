process.env.BOT_DATABASE_URL ||= "file:E:/Ai Tools/sb.eu/prisma/bot/dev.db";
import { PrismaClient } from "../src/generated/bot-client/index.js";
const db = new PrismaClient();

async function main() {
  // Update Vex Reseller with correct URL and key
  const vex = await db.apiSource.findFirst({ where: { slug: "vex" } });
  if (vex) {
    await db.apiSource.update({
      where: { id: vex.id },
      data: {
        baseUrl: "https://eismrrkygprctnwxmkbw.supabase.co/functions/v1/reseller-api",
        apiKey: "vex_sk_fb1f39beeb67546d952bbd36393cf383974afb9bbeb79f911b95de4c2b3618d8",
        isActive: true,
      },
    });
    console.log("✅ Vex Reseller updated");
  } else {
    await db.apiSource.create({
      data: {
        slug: "vex",
        name: "Vex Reseller",
        baseUrl: "https://eismrrkygprctnwxmkbw.supabase.co/functions/v1/reseller-api",
        apiKey: "vex_sk_fb1f39beeb67546d952bbd36393cf383974afb9bbeb79f911b95de4c2b3618d8",
        format: "vex",
        isActive: true,
      },
    });
    console.log("✅ Vex Reseller created");
  }

  // Disable SoMaDeth (token expired/invalid)
  const soma = await db.apiSource.findFirst({ where: { slug: { contains: "soma" } } });
  if (!soma) {
    const soma2 = await db.apiSource.findFirst({ where: { name: { contains: "SoMaDeth" } } });
    if (soma2) {
      await db.apiSource.update({ where: { id: soma2.id }, data: { isActive: false } });
      console.log("⚠️ SoMaDeth disabled (token expired)");
    }
  } else {
    await db.apiSource.update({ where: { id: soma.id }, data: { isActive: false } });
    console.log("⚠️ SoMaDeth disabled (token expired)");
  }

  // List all sources
  const all = await db.apiSource.findMany();
  for (const s of all) {
    console.log(`  ${s.isActive ? "🟢" : "🔴"} ${s.name} (${s.slug}) → ${s.baseUrl.substring(0, 50)}...`);
  }
}

main().catch(console.error).finally(() => db.$disconnect());
