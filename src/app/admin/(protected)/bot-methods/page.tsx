import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import {
  createMethodAction,
  updateMethodAction,
  toggleMethodAction,
  deleteMethodAction,
} from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  missing: "Укажите как минимум код и название (RU).",
  duplicate: "Метод с таким кодом уже существует.",
};

export default async function BotMethodsPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Методы / Гайды" />
        <EmptyState>BOT_DATABASE_URL не задан в .env — не могу подключиться к базе бота.</EmptyState>
      </div>
    );
  }

  const methods = await botDb.method.findMany({
    orderBy: { sortOrder: "asc" },
    include: { _count: { select: { purchases: true } } },
  });
  const errorMsg = searchParams.error ? ERRORS[searchParams.error] : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Методы / Гайды"
        subtitle="Инструкции «как получить сервис» (напр. Gemini Plus на 12 мес легально). Кнопку можно включать/выключать, ставить цену или делать бесплатной. Изменения применяются в боте сразу."
      />

      {errorMsg && (
        <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">{errorMsg}</div>
      )}

      {/* Создать метод */}
      <details className="card p-5">
        <summary className="cursor-pointer font-semibold">+ Добавить метод / гайд</summary>
        <form action={createMethodAction} className="mt-4 space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-muted">Код (уникальный, латиница)</label>
              <input name="code" required className="input mt-1 font-mono" placeholder="напр. gemini_12m_free" />
            </div>
            <div>
              <label className="text-sm text-muted">Эмодзи или Premium ID</label>
              <input name="emoji" className="input mt-1" defaultValue="📘" />
            </div>
            <div>
              <label className="text-sm text-muted">Название (RU)</label>
              <input name="titleRu" required className="input mt-1" placeholder="Gemini Plus на 12 месяцев бесплатно" />
            </div>
            <div>
              <label className="text-sm text-muted">Название (UZ) — необязательно</label>
              <input name="titleUz" className="input mt-1" placeholder="авто-перевод, если пусто" />
            </div>
          </div>
          <div>
            <label className="text-sm text-muted">Инструкция / содержимое (RU) — что делать, куда нажать</label>
            <textarea name="descRu" rows={4} className="input mt-1" placeholder="Пошагово: зайдите на …, нажмите …, введите свои настоящие данные и т.д." />
          </div>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="md:col-span-1">
              <label className="text-sm text-muted">Ссылка «нажать сюда» (необязательно)</label>
              <input name="url" className="input mt-1" placeholder="https://…" />
            </div>
            <div>
              <label className="text-sm text-muted">Цена, сум (0 = бесплатно)</label>
              <input name="priceUzs" type="number" min={0} className="input mt-1" defaultValue={0} />
            </div>
            <div>
              <label className="text-sm text-muted">Цена в Stars (0 = нет)</label>
              <input name="priceStars" type="number" min={0} className="input mt-1" defaultValue={0} />
            </div>
          </div>
          <button className="btn btn-primary" type="submit">Создать</button>
        </form>
      </details>

      {/* Список методов */}
      {methods.length === 0 ? (
        <EmptyState>Пока нет ни одного метода. Добавьте первый выше.</EmptyState>
      ) : (
        <div className="space-y-3">
          {methods.map((m) => (
            <div key={m.id} className="card p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="font-semibold">
                  {m.emoji} {m.titleRu}{" "}
                  <span className="text-muted font-mono text-xs">#{m.code}</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs px-2 py-1 rounded ${m.priceUzs > 0 ? "bg-warning/10 text-warning" : "bg-success/10 text-success"}`}>
                    {m.priceUzs > 0 ? `${m.priceUzs.toLocaleString("ru-RU")} сум` : "Бесплатно"}
                  </span>
                  <span className={`text-xs px-2 py-1 rounded ${m.isActive ? "bg-success/10 text-success" : "bg-muted/10 text-muted"}`}>
                    {m.isActive ? "🟢 в боте" : "⚪ выключен"}
                  </span>
                  {m._count.purchases > 0 && (
                    <span className="text-xs text-muted">получили: {m._count.purchases}</span>
                  )}
                  {/* Тумблер вкл/выкл */}
                  <form action={toggleMethodAction} className="inline">
                    <input type="hidden" name="id" value={m.id} />
                    <button className="btn btn-ghost text-xs" type="submit">
                      {m.isActive ? "Выключить" : "Включить"}
                    </button>
                  </form>
                </div>
              </div>

              {/* Редактирование */}
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-muted">Редактировать</summary>
                <form action={updateMethodAction} className="mt-3 space-y-3">
                  <input type="hidden" name="id" value={m.id} />
                  <div className="grid md:grid-cols-2 gap-3">
                    <div>
                      <label className="text-sm text-muted">Название (RU)</label>
                      <input name="titleRu" defaultValue={m.titleRu} className="input mt-1" />
                    </div>
                    <div>
                      <label className="text-sm text-muted">Эмодзи / Premium ID</label>
                      <input name="emoji" defaultValue={m.premiumEmoji || m.emoji} className="input mt-1" />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm text-muted">Инструкция (RU)</label>
                    <textarea name="descRu" rows={4} defaultValue={m.descRu} className="input mt-1" />
                  </div>
                  <div className="grid md:grid-cols-3 gap-3">
                    <div>
                      <label className="text-sm text-muted">Ссылка</label>
                      <input name="url" defaultValue={m.url ?? ""} className="input mt-1" placeholder="https://…" />
                    </div>
                    <div>
                      <label className="text-sm text-muted">Цена, сум</label>
                      <input name="priceUzs" type="number" min={0} defaultValue={m.priceUzs} className="input mt-1" />
                    </div>
                    <div>
                      <label className="text-sm text-muted">Цена, Stars</label>
                      <input name="priceStars" type="number" min={0} defaultValue={m.priceStars} className="input mt-1" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="isActive" defaultChecked={m.isActive} />
                    Кнопка активна в боте
                  </label>
                  <div className="flex items-center gap-2">
                    <button className="btn btn-primary" type="submit">Сохранить</button>
                  </div>
                </form>
                <form action={deleteMethodAction} className="mt-2">
                  <input type="hidden" name="id" value={m.id} />
                  <button className="btn btn-ghost text-danger text-xs" type="submit">Удалить метод</button>
                </form>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
