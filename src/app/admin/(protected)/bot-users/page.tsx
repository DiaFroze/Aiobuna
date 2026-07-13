import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { creditUserBalanceAction, debitUserBalanceAction } from "./actions";

export const dynamic = "force-dynamic";

function money(amount: number) {
  return `${amount.toLocaleString()} сум`;
}

export default async function BotUsersPage({
  searchParams,
}: {
  searchParams: { search?: string };
}) {
  const search = (searchParams.search ?? "").trim();

  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Пользователи бота" />
        <EmptyState>BOT_DATABASE_URL не задан в .env — не могу подключиться к базе бота.</EmptyState>
      </div>
    );
  }

  // Retrieve users matching search query (all users if search is empty, limit to 50 for performance)
  const users = await botDb.botUser.findMany({
    where: search
      ? {
          OR: [
            { tgId: { contains: search } },
            { username: { contains: search } },
            { firstName: { contains: search } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="👤 Пользователи бота"
        subtitle="Просмотр профилей пользователей, управление балансами и правами доступа."
      />

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
      </div>
    </div>
  );
}
