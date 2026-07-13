import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { addFormatterUserAction, removeFormatterUserAction } from "./actions";
import FormatterToolClient from "./FormatterToolClient";

export const dynamic = "force-dynamic";

export default async function LinkFormatterPage() {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="🔗 Форматирование ссылок" />
        <EmptyState>BOT_DATABASE_URL не задан в .env — не могу подключиться к базе бота.</EmptyState>
      </div>
    );
  }

  const allowedUsers = await botDb.botUser.findMany({
    where: { isFormatterAllowed: true },
    select: { tgId: true, username: true, firstName: true },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="🔗 Форматирование ссылок"
        subtitle="Утилита для нумерации и преобразования ссылок в моноширинный формат для Telegram."
      />

      <FormatterToolClient />

      {/* Allowed users panel */}
      <div className="card p-5 space-y-4">
        <div>
          <h3 className="font-semibold text-lg">🔑 Доступ к команде /code в боте</h3>
          <p className="text-xs text-muted">
            По умолчанию главный администратор имеет доступ. Здесь вы можете разрешить доступ другим пользователям по их Telegram ID.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 pt-2">
          {/* Add form */}
          <div>
            <form action={addFormatterUserAction} className="space-y-3">
              <div>
                <label className="text-xs text-muted block mb-1">Telegram ID пользователя</label>
                <input
                  type="text"
                  name="tgId"
                  required
                  placeholder="напр. 123456789"
                  className="input text-sm"
                />
              </div>
              <button className="btn-primary text-sm">Разрешить доступ</button>
            </form>
          </div>

          {/* Users list */}
          <div>
            <h4 className="text-xs text-muted font-bold block mb-2 uppercase tracking-wider">
              Разрешенные пользователи ({allowedUsers.length})
            </h4>
            {allowedUsers.length === 0 ? (
              <p className="text-sm text-muted">Никому, кроме вас, доступ не выдан.</p>
            ) : (
              <div className="space-y-2 max-h-[200px] overflow-y-auto border rounded-xl p-3 bg-surface-2/40">
                {allowedUsers.map((user) => (
                  <div
                    key={user.tgId}
                    className="flex items-center justify-between text-sm py-1 border-b last:border-b-0"
                  >
                    <div>
                      <span className="font-mono text-xs font-semibold mr-2 bg-surface-2 px-1.5 py-0.5 rounded text-muted">
                        {user.tgId}
                      </span>
                      <span className="font-medium text-xs">{user.firstName || "—"}</span>
                      {user.username && (
                        <span className="text-xs text-muted ml-1">(@{user.username})</span>
                      )}
                    </div>
                    <form action={removeFormatterUserAction}>
                      <input type="hidden" name="tgId" value={user.tgId} />
                      <button className="text-danger text-xs hover:underline">Забрать доступ</button>
                    </form>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
