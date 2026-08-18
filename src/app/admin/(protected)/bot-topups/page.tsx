import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, Table, EmptyState, StatCard } from "@/components/admin/ui";
import { approveTopUpAction, rejectTopUpAction, manualCreditAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  pending: "bg-warning/10 text-warning",
  approved: "bg-success/10 text-success",
  rejected: "bg-danger/10 text-danger",
};

export default async function BotTopUpsPage() {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Пополнения бота" />
        <EmptyState>BOT_DATABASE_URL не задан в .env — не могу подключиться к базе бота.</EmptyState>
      </div>
    );
  }

  const [topups, users, totalBalanceAgg, paymeTxns] = await Promise.all([
    // Pending first (that's what needs attention and what a Payme test needs to
    // find), then newest — so a fresh pending row never falls past the limit.
    botDb.topUp.findMany({ orderBy: [{ createdAt: "desc" }], take: 150, include: { user: true } }),
    botDb.botUser.count(),
    botDb.botUser.aggregate({ _sum: { balance: true } }),
    botDb.paymeTransaction.findMany({ select: { topUpId: true, state: true, paymeId: true } }).catch(() => []),
  ]);
  const pending = topups.filter((t) => t.status === "pending").length;
  const paymeByTopUp = new Map(paymeTxns.map((p) => [p.topUpId, p]));
  const sorted = [...topups].sort((a, b) => {
    if ((a.status === "pending") !== (b.status === "pending")) return a.status === "pending" ? -1 : 1;
    return b.id - a.id;
  });
  // Payme transaction state → human label.
  const PAYME_STATE: Record<number, string> = { 1: "создана", 2: "оплачена", "-1": "отменена", "-2": "возврат" };
  const methodLabel = (m: string) => (m === "payme" ? "💳 Payme" : m === "stars" ? "⭐ Stars" : m === "receipt" ? "🧾 Чек" : m === "card" ? "💳 Карта" : m === "manual" ? "✍️ Вручную" : m);

  return (
    <div className="space-y-6">
      <PageHeader title="Пополнения бота" subtitle="Запросы на пополнение баланса из Telegram-бота и ручная корректировка." />

      <div className="grid sm:grid-cols-3 gap-4">
        <StatCard label="Ожидают подтверждения" value={String(pending)} tone={pending ? "warning" : "default"} />
        <StatCard label="Пользователей бота" value={String(users)} />
        <StatCard label="Сумма балансов" value={`${Math.round(totalBalanceAgg._sum.balance ?? 0).toLocaleString("ru-RU")} сум`} />
      </div>

      {/* Manual credit / debit */}
      <details className="card p-5">
        <summary className="cursor-pointer font-semibold">＋ Изменить баланс вручную (по Telegram ID)</summary>
        <form action={manualCreditAction} className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="text-sm text-muted">Telegram ID пользователя</label>
            <input name="tgId" required className="input mt-1 font-mono" placeholder="напр. 7797972248" />
          </div>
          <div>
            <label className="text-sm text-muted">Сумма в сумах (можно со знаком −)</label>
            <input name="amount" required className="input mt-1" placeholder="напр. 10 или -5" />
          </div>
          <button className="btn-primary">Применить</button>
        </form>
        <p className="text-xs text-muted mt-2">
          Пользователь появляется здесь после первого <code>/start</code> в боте.
        </p>
      </details>

      {topups.length === 0 ? (
        <EmptyState>Запросов на пополнение пока нет.</EmptyState>
      ) : (
        <Table head={["#", "Пользователь", "Telegram ID", "Сумма", "Способ", "Статус", "Дата", ""]}>
          {sorted.map((t) => {
            const pt = paymeByTopUp.get(t.id);
            return (
            <tr key={t.id} className="border-b last:border-0">
              <td className="px-4 py-3 font-mono">{t.id}</td>
              <td className="px-4 py-3">
                {t.user.firstName ?? "—"} {t.user.username ? `@${t.user.username}` : ""}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-muted">{t.user.tgId}</td>
              <td className="px-4 py-3 font-medium">{Math.round(t.amount).toLocaleString("ru-RU")} сум</td>
              <td className="px-4 py-3 text-xs">
                {methodLabel(t.method)}
                {pt && <span className="block text-muted">Payme: {PAYME_STATE[pt.state] ?? pt.state}</span>}
              </td>
              <td className="px-4 py-3">
                <span className={`badge ${STATUS[t.status] ?? ""}`}>{t.status}</span>
              </td>
              <td className="px-4 py-3 text-xs text-muted">{t.createdAt.toLocaleString("ru-RU")}</td>
              <td className="px-4 py-3">
                {t.status === "pending" && (
                  <div className="flex items-center gap-1">
                    <form action={approveTopUpAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <button className="btn-ghost text-xs text-success">Подтвердить</button>
                    </form>
                    <form action={rejectTopUpAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <button className="btn-danger text-xs">Отклонить</button>
                    </form>
                  </div>
                )}
              </td>
            </tr>
            );
          })}
        </Table>
      )}
    </div>
  );
}
