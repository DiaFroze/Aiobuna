import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState, StatCard } from "@/components/admin/ui";
import { setUserPriceAction, deleteUserPriceAction } from "./actions";

export const dynamic = "force-dynamic";

function money(n: number) {
  return `${n.toLocaleString("ru-RU")} сум`;
}

const LABEL_PRESETS = ["VIP-клиент", "Только для вас", "Оптовая цена", "Специальная цена", "Постоянный клиент"];

export default async function BotVipPricesPage({
  searchParams,
}: {
  searchParams: { error?: string; ok?: string };
}) {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Индивидуальные цены" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const [users, products, overrides] = await Promise.all([
    botDb.botUser.findMany({ orderBy: { createdAt: "desc" }, take: 500 }),
    botDb.product.findMany({ orderBy: { sortOrder: "asc" }, include: { plans: { include: { variants: true } } } }),
    botDb.userVariantPrice.findMany({
      orderBy: { updatedAt: "desc" },
      include: { user: true, variant: { include: { plan: { include: { product: true } } } } },
    }),
  ]);

  const variantOptions = products.flatMap((p) =>
    p.plans.flatMap((pl) =>
      pl.variants.map((v) => ({
        id: v.id,
        label: `${p.titleRu} — ${v.titleRu} (${money(v.priceUzs)})`,
      })),
    ),
  );

  const userLabel = (u: { firstName: string | null; username: string | null; tgId: string }) =>
    `${u.firstName || "—"}${u.username ? ` (@${u.username})` : ""} · ${u.tgId}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="💎 Индивидуальные цены"
        subtitle="Своя цена на товар для конкретного пользователя — её видит и платит только он. Ярлык показывается пользователю в боте."
      />

      {searchParams.error === "missing" && (
        <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">
          Выберите товар и укажите корректную цену.
        </div>
      )}
      {searchParams.error === "nouser" && (
        <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">
          Выберите пользователя из списка или введите его Telegram ID.
        </div>
      )}
      {searchParams.ok && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">Индивидуальная цена сохранена.</div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        <StatCard label="Активных переопределений" value={String(overrides.length)} />
        <StatCard label="Пользователей в базе" value={String(users.length)} />
      </div>

      {/* Set form */}
      <form action={setUserPriceAction} className="card p-5 space-y-4 max-w-3xl">
        <h2 className="font-semibold">Задать индивидуальную цену</h2>

        {variantOptions.length === 0 || users.length === 0 ? (
          <div className="card p-3 border-warning/30 bg-warning/5 text-warning text-sm">
            Нужен хотя бы один пользователь и один вариант товара.
          </div>
        ) : (
          <>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-muted">Пользователь (из списка)</label>
                <select name="userId" className="input mt-1">
                  <option value="">— выберите —</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{userLabel(u)}</option>
                  ))}
                </select>
                <p className="text-xs text-muted mt-1">Показаны последние 500. Нет в списке — введите ID справа.</p>
              </div>
              <div>
                <label className="text-sm text-muted">…или Telegram ID вручную</label>
                <input name="tgId" inputMode="numeric" placeholder="напр. 5464638349" className="input mt-1 font-mono" />
                <p className="text-xs text-muted mt-1">Приоритетнее списка. Если такого пользователя ещё нет — цена применится, как только он откроет бота.</p>
              </div>
              <div>
                <label className="text-sm text-muted">Товар / вариант</label>
                <select name="variantId" required className="input mt-1">
                  <option value="">— выберите —</option>
                  {variantOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-muted">Индивидуальная цена (сум)</label>
                <input name="priceUzs" type="number" min="0" required placeholder="40000" className="input mt-1" />
                <p className="text-xs text-muted mt-1">Можно ниже или выше обычной цены. 0 — бесплатно для этого пользователя.</p>
              </div>
              <div>
                <label className="text-sm text-muted">Ярлык (виден пользователю)</label>
                <input name="label" list="label-presets" placeholder="VIP-клиент" className="input mt-1" />
                <datalist id="label-presets">
                  {LABEL_PRESETS.map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
              </div>
            </div>
            <button className="btn btn-primary">Сохранить цену</button>
          </>
        )}
      </form>

      {/* List */}
      {overrides.length === 0 ? (
        <EmptyState>Индивидуальных цен пока нет.</EmptyState>
      ) : (
        <div className="card p-5 overflow-x-auto">
          <table className="table-auto w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b text-muted uppercase text-xs">
                <th className="pb-3">Пользователь</th>
                <th className="pb-3">Товар / вариант</th>
                <th className="pb-3 text-right">Обычная</th>
                <th className="pb-3 text-right">Индивидуальная</th>
                <th className="pb-3">Ярлык</th>
                <th className="pb-3 text-right">Действия</th>
              </tr>
            </thead>
            <tbody>
              {overrides.map((o) => {
                const base = o.variant.priceUzs;
                const diff = o.priceUzs - base;
                return (
                  <tr key={o.id} className="border-b last:border-0 hover:bg-surface-2/20">
                    <td className="py-3">
                      <span className="font-semibold block">{o.user.firstName || "—"}</span>
                      <span className="text-xs text-muted font-mono">
                        {o.user.username ? `@${o.user.username} · ` : ""}{o.user.tgId}
                      </span>
                    </td>
                    <td className="py-3">
                      {o.variant.plan.product.titleRu} — {o.variant.titleRu}
                    </td>
                    <td className="py-3 text-right text-muted">{money(base)}</td>
                    <td className="py-3 text-right font-bold">
                      {money(o.priceUzs)}
                      {diff !== 0 && (
                        <span className={`block text-xs ${diff < 0 ? "text-success" : "text-warning"}`}>
                          {diff < 0 ? "▼" : "▲"} {money(Math.abs(diff))}
                        </span>
                      )}
                    </td>
                    <td className="py-3">
                      {o.label ? <span className="text-brand">💎 {o.label}</span> : <span className="text-muted">—</span>}
                    </td>
                    <td className="py-3">
                      <div className="flex justify-end">
                        <form action={deleteUserPriceAction}>
                          <input type="hidden" name="id" value={o.id} />
                          <button className="btn btn-sm btn-danger px-2 text-xs" title="Удалить">🗑</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
