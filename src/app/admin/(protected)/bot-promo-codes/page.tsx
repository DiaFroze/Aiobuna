import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState, StatCard } from "@/components/admin/ui";
import { createPromoAction, togglePromoAction, deletePromoAction } from "./actions";

export const dynamic = "force-dynamic";

function money(n: number) {
  return `${n.toLocaleString("ru-RU")} сум`;
}

export default async function BotPromoCodesPage({
  searchParams,
}: {
  searchParams: { error?: string; ok?: string };
}) {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Промокоды" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const codes = await botDb.promoCode.findMany({ orderBy: { createdAt: "desc" } });
  const active = codes.filter((c) => c.isActive).length;
  const totalRedeemed = codes.reduce((s, c) => s + c.usedCount, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="🎟 Промокоды"
        subtitle="Коды, пополняющие баланс пользователя на фиксированную сумму. Активируются в разделе «Баланс» бота."
      />

      {searchParams.error === "duplicate" && (
        <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">Такой код уже существует.</div>
      )}
      {searchParams.error === "missing" && (
        <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">Укажите код и сумму больше 0.</div>
      )}
      {searchParams.ok && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">Промокод создан.</div>
      )}

      <div className="grid sm:grid-cols-3 gap-4">
        <StatCard label="Всего кодов" value={String(codes.length)} />
        <StatCard label="Активных" value={String(active)} tone={active ? "success" : "default"} />
        <StatCard label="Активаций всего" value={String(totalRedeemed)} />
      </div>

      {/* Create form */}
      <form action={createPromoAction} className="card p-5 space-y-4 max-w-3xl">
        <h2 className="font-semibold">Новый промокод</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-muted">Код</label>
            <input name="code" required placeholder="BONUS50" className="input mt-1 uppercase" />
            <p className="text-xs text-muted mt-1">Сохраняется в верхнем регистре.</p>
          </div>
          <div>
            <label className="text-sm text-muted">Сумма пополнения (сум)</label>
            <input name="amountUzs" type="number" min="1" required placeholder="50000" className="input mt-1" />
          </div>
          <div>
            <label className="text-sm text-muted">Лимит активаций (всего)</label>
            <input name="maxUses" type="number" min="0" defaultValue="0" className="input mt-1" />
            <p className="text-xs text-muted mt-1">0 — без ограничения.</p>
          </div>
          <div>
            <label className="text-sm text-muted">Лимит на пользователя</label>
            <input name="perUserLimit" type="number" min="0" defaultValue="1" className="input mt-1" />
            <p className="text-xs text-muted mt-1">0 — без ограничения.</p>
          </div>
          <div>
            <label className="text-sm text-muted">Действует до (необязательно)</label>
            <input name="expiresAt" type="datetime-local" className="input mt-1" />
          </div>
          <div>
            <label className="text-sm text-muted">Заметка (необязательно)</label>
            <input name="note" placeholder="Для рекламной кампании" className="input mt-1" />
          </div>
        </div>
        <button className="btn btn-primary">Создать промокод</button>
      </form>

      {/* List */}
      {codes.length === 0 ? (
        <EmptyState>Промокодов пока нет.</EmptyState>
      ) : (
        <div className="card p-5 overflow-x-auto">
          <table className="table-auto w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b text-muted uppercase text-xs">
                <th className="pb-3">Код</th>
                <th className="pb-3 text-right">Сумма</th>
                <th className="pb-3 text-center">Использовано</th>
                <th className="pb-3 text-center">На юзера</th>
                <th className="pb-3">Действует до</th>
                <th className="pb-3 text-center">Статус</th>
                <th className="pb-3 text-right">Действия</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-surface-2/20">
                  <td className="py-3">
                    <span className="font-mono font-semibold">{c.code}</span>
                    {c.note && <span className="block text-xs text-muted">{c.note}</span>}
                  </td>
                  <td className="py-3 text-right font-bold text-success">{money(c.amountUzs)}</td>
                  <td className="py-3 text-center">
                    {c.usedCount}
                    {c.maxUses > 0 ? ` / ${c.maxUses}` : ""}
                  </td>
                  <td className="py-3 text-center">{c.perUserLimit === 0 ? "∞" : c.perUserLimit}</td>
                  <td className="py-3 text-xs text-muted">
                    {c.expiresAt ? new Date(c.expiresAt).toLocaleString("ru-RU") : "—"}
                  </td>
                  <td className="py-3 text-center">
                    <span className={c.isActive ? "text-success" : "text-muted"}>
                      {c.isActive ? "активен" : "выключен"}
                    </span>
                  </td>
                  <td className="py-3">
                    <div className="flex justify-end gap-2">
                      <form action={togglePromoAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <button className="btn btn-sm px-2 text-xs" title={c.isActive ? "Выключить" : "Включить"}>
                          {c.isActive ? "⏸ Выкл" : "▶ Вкл"}
                        </button>
                      </form>
                      <form action={deletePromoAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <button className="btn btn-sm btn-danger px-2 text-xs" title="Удалить">🗑</button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
