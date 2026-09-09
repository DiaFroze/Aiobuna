import { botDb } from "@/lib/botDb";
import { PageHeader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function BotAdsPage() {
  // Keep the report usable during a rolling deploy even if the web process
  // receives a request before the bot's startup schema guard has completed.
  await botDb.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "BotAdStart" (
    "userId" INTEGER NOT NULL REFERENCES "BotUser"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "source" TEXT NOT NULL,
    "isNewUser" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotAdStart_pkey" PRIMARY KEY ("userId", "source")
  )`);
  await botDb.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BotAdStart_createdAt_idx" ON "BotAdStart"("createdAt")`);
  const registrations = await botDb.$queryRaw<Array<{ day: string; users: bigint }>>`
    SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS day,
      COUNT(*) AS users FROM "BotUser"
    WHERE "createdAt" >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tashkent')::date - 6)::timestamp AT TIME ZONE 'Asia/Tashkent' AT TIME ZONE 'UTC'
    GROUP BY day ORDER BY day DESC
  `;
  const rows = await botDb.$queryRaw<Array<{
    source: string; visitors: bigint; newUsers: bigint; subscribed: bigint; accepted: bigint;
  }>>`
    SELECT a."source", COUNT(*) AS "visitors",
      COUNT(*) FILTER (WHERE a."isNewUser") AS "newUsers",
      COUNT(*) FILTER (WHERE a."isNewUser" AND u."channelVerifiedAt" IS NOT NULL) AS "subscribed",
      COUNT(*) FILTER (WHERE a."isNewUser" AND u."termsAcceptedAt" IS NOT NULL) AS "accepted"
    FROM "BotAdStart" a JOIN "BotUser" u ON u."id" = a."userId"
    GROUP BY a."source" ORDER BY COUNT(*) DESC
  `;
  return <div className="space-y-6">
    <PageHeader title="Реклама: реальные запуски бота" />
    <div className="card p-4 space-y-2">
      <h2 className="font-semibold">Новые регистрации за последние 7 дней</h2>
      <p className="text-sm text-muted">Все источники, включая органику и рефералов. Это не число пользователей из рекламы. Даты — Ташкент (UTC+5); сегодняшний день ещё не завершён.</p>
      {registrations.map(row => <p key={row.day}>{row.day}: <strong>{row.users.toString()}</strong></p>)}
      {registrations.length === 0 && <p>Новых регистраций за этот период нет.</p>}
    </div>
    <p className="text-sm text-muted">За всё время с момента включения учёта. Здесь считаются пользователи, отправившие /start по рекламной ссылке, а не клики Meta и не просмотры страницы Telegram. Один человек учитывается один раз для каждого источника; складывать аудитории разных источников нельзя.</p>
    <div className="card overflow-x-auto p-4">
      <table className="w-full text-sm text-left">
        <thead><tr>{["Источник", "Запустили бота", "Новые пользователи", "Из новых: прошли подписку", "Из новых: приняли условия"].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.source} className="border-t border-border">
          <td className="p-3">{row.source}</td>
          {[row.visitors, row.newUsers, row.subscribed, row.accepted].map((n, i) => <td className="p-3" key={i}>{n.toString()}</td>)}
        </tr>)}</tbody>
      </table>
      {rows.length === 0 && <p className="p-3 text-muted">Запусков по помеченным ссылкам пока нет. Старые переходы без метки восстановить нельзя.</p>}
    </div>
    <div className="card p-4 space-y-2">
      <h2 className="font-semibold">Ссылки для объявлений</h2>
      <p>D1-A: <code>https://t.me/Aiobunabot?start=ad_meta_d1a</code></p>
      <p>D1-B: <code>https://t.me/Aiobunabot?start=ad_meta_d1b</code></p>
      <p className="text-sm text-muted">Статус подписки и принятия условий показан на текущий момент. «Новые» — те, кто впервые зарегистрировался в боте через этот источник.</p>
    </div>
  </div>;
}
