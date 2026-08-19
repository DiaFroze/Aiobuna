import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { creditUserBalanceAction, debitUserBalanceAction, addReferralsAction } from "./actions";

export const dynamic = "force-dynamic";

function money(amount: number) {
  return `${amount.toLocaleString()} сум`;
}

export default async function BotUsersPage({
  searchParams,
}: {
  searchParams: { search?: string; page?: string };
}) {
  const search = (searchParams.search ?? "").trim();
  const PAGE_SIZE = 100;
  const page = Math.max(1, Math.floor(Number(searchParams.page) || 1));

  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Пользователи бота" />
        <EmptyState>BOT_DATABASE_URL не задан в .env — не могу подключиться к базе бота.</EmptyState>
      </div>
    );
  }

  const where = search
    ? {
        OR: [
          { tgId: { contains: search } },
          { username: { contains: search } },
          { firstName: { contains: search } },
        ],
      }
    : undefined;
  const [totalUsers, users] = await Promise.all([
    botDb.botUser.count({ where }),
    botDb.botUser.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE));

  // Invited counts (referredBy = referrer's tgId), aggregated in one query.
  // Only invitees who passed the channel-subscription gate count — this must
  // stay in sync with countVerifiedRefs() in the bot, or the admin panel would
  // show more points than a user can actually spend.
  const refGroups = await botDb.botUser.groupBy({
    by: ["referredBy"],
    where: { referredBy: { not: null }, channelVerifiedAt: { not: null } },
    _count: { _all: true },
  });
  const realRefMap = new Map<string, number>();
  for (const g of refGroups) if (g.referredBy) realRefMap.set(g.referredBy, g._count._all);

  // Purchase stats per user (all orders, matching the dashboard's revenue convention).
  const orderGroups = await botDb.botOrder.groupBy({
    by: ["userId"],
    _count: { _all: true },
    _sum: { priceUsdt: true },
  });
  const orderStatsMap = new Map<number, { count: number; total: number }>();
  for (const g of orderGroups) orderStatsMap.set(g.userId, { count: g._count._all, total: g._sum.priceUsdt ?? 0 });

  // Top 10 buyers by total spent, across ALL users (not just the current search page).
  const topBuyerIds = [...orderStatsMap.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  const topBuyers =
    topBuyerIds.length > 0
      ? await botDb.botUser.findMany({ where: { id: { in: topBuyerIds.map(([id]) => id) } } })
      : [];
  const topBuyersById = new Map(topBuyers.map((u) => [u.id, u]));

  // Top 10 referrers by verified invite count (channel-subscribed invitees only).
  const refGroupsAll = await botDb.botUser.groupBy({
    by: ["referredBy"],
    where: { referredBy: { not: null }, channelVerifiedAt: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { referredBy: "desc" } },
    take: 10,
  });
  const topReferrerTgIds = refGroupsAll.map((g) => g.referredBy!).filter(Boolean);
  const topReferrerUsers =
    topReferrerTgIds.length > 0
      ? await botDb.botUser.findMany({ where: { tgId: { in: topReferrerTgIds } } })
      : [];
  const topReferrerByTgId = new Map(topReferrerUsers.map((u) => [u.tgId, u]));

  // Top 10 users by balance, with their unspent referral points. Unspent =
  // verified invitees + admin bonus − already spent (same formula as the bot's
  // availableReferralPoints, clamped at 0).
  const topBalanceUsers = await botDb.botUser.findMany({
    where: { balance: { gt: 0 } },
    orderBy: { balance: "desc" },
    take: 10,
  });
  const topBalance = topBalanceUsers.map((u) => {
    const verified = realRefMap.get(u.tgId) ?? 0;
    const unspent = Math.max(0, verified + (u.bonusReferrals ?? 0) - (u.spentReferrals ?? 0));
    return { user: u, unspent };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="👤 Пользователи бота"
        subtitle="Просмотр профилей пользователей, управление балансами и правами доступа."
      />

      {/* Top balances + unspent referrals */}
      <div className="card p-5">
        <h3 className="text-lg font-semibold mb-1">💰 Топ по балансу</h3>
        <p className="text-sm text-muted mb-4">У кого сколько денег на балансе и сколько нетраченных рефералов.</p>
        {topBalance.length === 0 ? (
          <p className="text-sm text-muted">Пока ни у кого нет баланса.</p>
        ) : (
          <ol className="space-y-2">
            {topBalance.map(({ user: u, unspent }, i) => (
              <li key={u.id} className="flex items-center justify-between text-sm border-b last:border-0 pb-2">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-muted w-5 shrink-0">{i + 1}.</span>
                  <span className="font-semibold truncate">{u.firstName || "—"}</span>
                  {u.username && <span className="text-xs text-muted shrink-0">@{u.username}</span>}
                  <span className="text-xs text-muted font-mono shrink-0">{u.tgId}</span>
                </span>
                <span className="flex items-center gap-3 shrink-0">
                  {unspent > 0 && <span className="text-xs text-muted">🤝 {unspent} реф.</span>}
                  <span className="font-bold text-success">{Math.round(u.balance).toLocaleString("ru-RU")} сум</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Top referrers leaderboard */}
      <div className="card p-5">
        <h3 className="text-lg font-semibold mb-4">🤝 Топ рефереров</h3>
        {refGroupsAll.length === 0 ? (
          <p className="text-sm text-muted">Пока нет приглашённых пользователей.</p>
        ) : (
          <ol className="space-y-2">
            {refGroupsAll.map((g, i) => {
              const u = topReferrerByTgId.get(g.referredBy!);
              const count = g._count._all;
              return (
                <li key={g.referredBy} className="flex items-center justify-between text-sm border-b last:border-0 pb-2">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-muted w-5 shrink-0">{i + 1}.</span>
                    <span className="font-semibold truncate">{u?.firstName || "—"}</span>
                    {u?.username && <span className="text-xs text-muted shrink-0">@{u.username}</span>}
                    {!u && <span className="text-xs text-muted font-mono shrink-0">{g.referredBy}</span>}
                  </span>
                  <span className="font-bold text-primary">{count} чел.</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Top buyers leaderboard */}
      <div className="card p-5">
        <h3 className="text-lg font-semibold mb-4">🏆 Топ покупателей</h3>
        {topBuyerIds.length === 0 ? (
          <p className="text-sm text-muted">Пока нет покупок.</p>
        ) : (
          <ol className="space-y-2">
            {topBuyerIds.map(([userId, stats], i) => {
              const u = topBuyersById.get(userId);
              if (!u) return null;
              return (
                <li key={userId} className="flex items-center justify-between text-sm border-b last:border-0 pb-2">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-muted w-5 shrink-0">{i + 1}.</span>
                    <span className="font-semibold truncate">{u.firstName || "—"}</span>
                    {u.username && <span className="text-xs text-muted shrink-0">@{u.username}</span>}
                  </span>
                  <span className="text-right shrink-0 pl-2">
                    <span className="font-bold text-success">{money(stats.total)}</span>
                    <span className="text-xs text-muted ml-2">{stats.count} покупок</span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Search Input Form */}
      <div className="card p-5">
        <form method="GET" className="space-y-2">
          <label className="text-sm font-medium text-muted block">
            Поиск пользователей
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              name="search"
              defaultValue={search}
              placeholder="Введите Telegram ID, @username или имя..."
              className="input flex-1 text-sm"
            />
            <button type="submit" className="btn btn-primary">
              🔎 Найти
            </button>
          </div>
        </form>
      </div>

      {/* Users List Table */}
      <div className="card p-5 overflow-x-auto">
        {users.length === 0 ? (
          <EmptyState>
            {search
              ? "По вашему запросу ничего не найдено."
              : "В базе данных бота пока нет пользователей."}
          </EmptyState>
        ) : (
          <table className="table-auto w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b text-muted uppercase text-xs">
                <th className="pb-3">Пользователь</th>
                <th className="pb-3">Telegram ID</th>
                <th className="pb-3 text-center">Рефералы</th>
                <th className="pb-3 text-center">Покупки</th>
                <th className="pb-3 text-right">Текущий баланс</th>
                <th className="pb-3 text-center">Действия с балансом</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b last:border-0 hover:bg-surface-2/20">
                  <td className="py-3">
                    <span className="font-semibold block">{u.firstName || "—"}</span>
                    {u.username && (
                      <a
                        href={`https://t.me/${u.username}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-brand underline"
                      >
                        @{u.username}
                      </a>
                    )}
                  </td>
                  <td className="py-3 font-mono text-xs text-muted">{u.tgId}</td>
                  <td className="py-3 text-center">
                    {(() => {
                      const real = realRefMap.get(u.tgId) ?? 0;
                      const bonus = u.bonusReferrals ?? 0;
                      return (
                        <div className="flex flex-col items-center gap-1">
                          <span className="font-semibold">🤝 {real + bonus}</span>
                          <span className="text-[10px] text-muted">
                            {real} реал.{bonus ? ` + ${bonus} бонус` : ""}
                          </span>
                          <form action={addReferralsAction} className="flex gap-1 items-center">
                            <input type="hidden" name="userId" value={u.id} />
                            <input
                              type="number"
                              name="amount"
                              placeholder="+N"
                              required
                              className="input text-xs w-16 py-1"
                              title="Сколько рефералов добавить (можно отрицательное)"
                            />
                            <button type="submit" className="btn btn-sm px-2 text-xs" title="Добавить рефералов">
                              ➕
                            </button>
                          </form>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="py-3 text-center">
                    {(() => {
                      const stats = orderStatsMap.get(u.id);
                      return stats ? (
                        <div className="flex flex-col items-center">
                          <span className="font-semibold">{stats.count}</span>
                          <span className="text-[10px] text-muted">{money(stats.total)}</span>
                        </div>
                      ) : (
                        <span className="text-muted">—</span>
                      );
                    })()}
                  </td>
                  <td className="py-3 text-right font-bold text-success">
                    {money(u.balance)}
                  </td>
                  <td className="py-3">
                    <div className="flex justify-end gap-3 items-center">
                      {/* Add funds form */}
                      <form action={creditUserBalanceAction} className="flex gap-1 items-center">
                        <input type="hidden" name="userId" value={u.id} />
                        <input
                          type="number"
                          name="amount"
                          min="1"
                          placeholder="Сумма"
                          required
                          className="input text-xs w-24 py-1"
                        />
                        <button
                          type="submit"
                          className="btn btn-sm btn-success px-2 text-xs"
                          title="Начислить деньги"
                        >
                          ➕ Начислить
                        </button>
                      </form>

                      {/* Deduct funds form */}
                      <form action={debitUserBalanceAction} className="flex gap-1 items-center">
                        <input type="hidden" name="userId" value={u.id} />
                        <input
                          type="number"
                          name="amount"
                          min="1"
                          placeholder="Сумма"
                          required
                          className="input text-xs w-24 py-1"
                        />
                        <button
                          type="submit"
                          className="btn btn-sm btn-danger px-2 text-xs"
                          title="Списать деньги"
                        >
                          ➖ Списать
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {totalUsers > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="text-muted">
              Всего: <b>{totalUsers}</b>
              {totalPages > 1 && (
                <>
                  {" "}· страница <b>{page}</b> из <b>{totalPages}</b>
                </>
              )}
            </div>
            {totalPages > 1 && (
              <div className="flex gap-2">
                {page > 1 && (
                  <a
                    href={`?${new URLSearchParams({ ...(search && { search }), page: String(page - 1) }).toString()}`}
                    className="btn btn-sm"
                  >
                    ← Назад
                  </a>
                )}
                {page < totalPages && (
                  <a
                    href={`?${new URLSearchParams({ ...(search && { search }), page: String(page + 1) }).toString()}`}
                    className="btn btn-sm"
                  >
                    Вперёд →
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
