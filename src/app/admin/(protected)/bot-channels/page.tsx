import { botDb } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import {
  addRequiredChannelAction,
  toggleRequiredChannelAction,
  deleteRequiredChannelAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function RequiredChannelsPage() {
  const channels = await botDb.requiredChannel.findMany({
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="📢 Обязательная подписка (OP)"
        subtitle="Управление Telegram-каналами, на которые обязаны подписаться новые пользователи для использования бота."
      />

      <div className="grid md:grid-cols-3 gap-6">
        {/* Left Side: Add Channel Form */}
        <div className="md:col-span-1">
          <div className="card p-5 space-y-4">
            <h3 className="text-lg font-semibold">Добавить канал</h3>
            <form action={addRequiredChannelAction} className="space-y-3">
              <div>
                <label className="text-xs text-muted block mb-1">Название канала</label>
                <input
                  name="name"
                  type="text"
                  required
                  placeholder="Например: Канал скидок"
                  className="input text-sm"
                />
              </div>

              <div>
                <label className="text-xs text-muted block mb-1">Ссылка на канал</label>
                <input
                  name="url"
                  type="url"
                  required
                  placeholder="https://t.me/mychannel"
                  className="input text-sm"
                />
              </div>

              <div>
                <label className="text-xs text-muted block mb-1">Telegram Chat ID канала</label>
                <input
                  name="chatId"
                  type="text"
                  required
                  placeholder="Например: -100123456789"
                  className="input text-sm font-mono text-xs"
                />
                <span className="text-[10px] text-muted leading-tight mt-1 block">
                  Для работы проверки бот <b>обязан</b> быть добавлен в канал в качестве администратора с правом приглашать/читать участников.
                </span>
              </div>

              <button type="submit" className="btn btn-primary w-full text-sm mt-2">
                ➕ Добавить канал
              </button>
            </form>
          </div>
        </div>

        {/* Right Side: Channels List */}
        <div className="md:col-span-2 space-y-4">
          <div className="card p-5">
            <h3 className="text-lg font-semibold mb-4">Список каналов</h3>

            {channels.length === 0 ? (
              <EmptyState>
                Пока нет обязательных каналов. Бот открыт для всех без обязательной подписки.
              </EmptyState>
            ) : (
              <div className="space-y-4">
                {channels.map((ch) => (
                  <div
                    key={ch.id}
                    className="flex flex-col sm:flex-row items-start sm:items-center justify-between border rounded-lg p-4 bg-surface-2/10 gap-3"
                  >
                    <div className="space-y-1">
                      <div className="font-semibold text-sm flex items-center gap-2">
                        {ch.name}
                        <span
                          className={`badge text-[10px] ${
                            ch.isActive
                              ? "bg-success/10 text-success"
                              : "bg-muted/10 text-muted"
                          }`}
                        >
                          {ch.isActive ? "Активен" : "Выключен"}
                        </span>
                      </div>
                      <div className="text-xs">
                        <a
                          href={ch.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand hover:underline block"
                        >
                          {ch.url}
                        </a>
                        <code className="text-muted text-[10px] block mt-0.5">
                          ID: {ch.chatId}
                        </code>
                      </div>
                    </div>

                    <div className="flex gap-2 items-center sm:self-center">
                      {/* Toggle status form */}
                      <form action={toggleRequiredChannelAction}>
                        <input type="hidden" name="id" value={ch.id} />
                        <button
                          type="submit"
                          className={`btn btn-sm text-xs ${
                            ch.isActive ? "btn-ghost text-muted border" : "btn-primary"
                          }`}
                        >
                          {ch.isActive ? "⏸ Выключить" : "▶ Включить"}
                        </button>
                      </form>

                      {/* Delete form */}
                      <form action={deleteRequiredChannelAction}>
                        <input type="hidden" name="id" value={ch.id} />
                        <button
                          type="submit"
                          className="btn btn-sm btn-danger text-xs"
                          title="Удалить канал"
                        >
                          🗑 Удалить
                        </button>
                      </form>
                    </div>
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
