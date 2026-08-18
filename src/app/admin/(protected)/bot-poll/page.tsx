import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState, StatCard } from "@/components/admin/ui";
import { AutoRefresh } from "./AutoRefresh";

export const dynamic = "force-dynamic";

// Must match BANK_POLL in src/bot/index.ts.
const BANKS: { key: string; label: string; emoji: string }[] = [
  { key: "payme", label: "Payme", emoji: "💸" },
  { key: "click", label: "Click", emoji: "⭐️" },
  { key: "paynet", label: "PAYNET", emoji: "🍇" },
  { key: "uzum", label: "Uzum Bank", emoji: "💸" },
];

export default async function BotPollPage() {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Опрос" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const grouped = await botDb.botPollVote.groupBy({ by: ["choice"], _count: { _all: true } }).catch(() => []);
  const counts = new Map(grouped.map((g) => [g.choice, g._count._all]));
  const total = grouped.reduce((s, g) => s + g._count._all, 0);
  const rows = BANKS.map((b) => ({ ...b, count: counts.get(b.key) ?? 0 }))
    .sort((a, b) => b.count - a.count);
  const leader = rows[0]?.count ? rows[0] : null;

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={60} />
      <PageHeader
        title="📊 Опрос: каким банком пользуетесь"
        subtitle="Голоса из Telegram-бота. Обновляется автоматически раз в минуту."
      />

      <div className="grid sm:grid-cols-3 gap-4">
        <StatCard label="Всего голосов" value={String(total)} tone={total ? "success" : "default"} />
        <StatCard label="Лидер" value={leader ? `${leader.emoji} ${leader.label}` : "—"} />
        <StatCard label="Вариантов" value={String(BANKS.length)} />
      </div>

      {total === 0 ? (
        <EmptyState>
          Голосов пока нет. Отправьте опрос: в боте <code className="font-mono">/poll</code> (превью себе), затем{" "}
          <code className="font-mono">/pollsend</code> (всем).
        </EmptyState>
      ) : (
        <div className="card p-5 space-y-4">
          {rows.map((r) => {
            const pct = total ? Math.round((r.count / total) * 100) : 0;
            return (
              <div key={r.key}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-medium">{r.emoji} {r.label}</span>
                  <span className="text-muted"><b className="text-text">{r.count}</b> · {pct}%</span>
                </div>
                <div className="h-3 rounded-full bg-surface-2 overflow-hidden">
                  <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted">
        Команды бота: <code className="font-mono">/poll</code> — превью только вам ·{" "}
        <code className="font-mono">/pollsend</code> — рассылка всем (в фоне, бот не зависает).
      </p>
    </div>
  );
}
