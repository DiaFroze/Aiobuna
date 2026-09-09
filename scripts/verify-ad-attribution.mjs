// Local database only; the fixture is always rolled back.
import { PrismaClient } from '@prisma/client';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.loadEnvFile('.env');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname));
const db = new PrismaClient();
const rollback = new Error('rollback fixture');
try {
  await db.$transaction(async tx => {
    const user = await tx.botUser.create({ data: { tgId: `test-ad-${Date.now()}` } });
    const data = { userId: user.id, source: 'test_meta_a', isNewUser: true };
    await tx.botAdStart.createMany({ data: [data], skipDuplicates: true });
    await tx.botAdStart.createMany({ data: [{ ...data, isNewUser: false }], skipDuplicates: true });
    assert.equal(await tx.botAdStart.count({ where: { userId: user.id } }), 1);
    assert.equal((await tx.botAdStart.findUnique({ where: { userId_source: { userId: user.id, source: data.source } } })).isNewUser, true);
    // Execute the exact read-only report queries, including timezone conversion.
    const page = readFileSync('src/app/admin/(protected)/bot-ads/page.tsx', 'utf8');
    const queries = [...page.matchAll(/>>`([\s\S]*?)`;/g)].map(m => m[1]);
    assert.equal(queries.length, 2);
    await tx.$queryRawUnsafe(queries[0]);
    const rows = await tx.$queryRawUnsafe(queries[1]);
    const row = rows.find(r => r.source === data.source);
    assert.equal(row.visitors, 1n);
    assert.equal(row.newUsers, 1n);
    assert.equal(row.subscribed, 0n);
    assert.equal(row.accepted, 0n);
    await tx.botUser.update({ where: { id: user.id }, data: { channelVerifiedAt: new Date(), termsAcceptedAt: new Date() } });
    const passed = (await tx.$queryRawUnsafe(queries[1])).find(r => r.source === data.source);
    assert.equal(passed.subscribed, 1n);
    assert.equal(passed.accepted, 1n);
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
  console.log('PASS: deduplication, first-start classification, onboarding counts and report SQL; fixture rolled back.');
} finally {
  await db.$disconnect();
}
