import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { saveApiSourceAction, deleteApiSourceAction } from "./actions";

export const dynamic = "force-dynamic";

const mask = (k: string) => (k.length > 6 ? `••••${k.slice(-4)}` : "••••");

export default async function BotApisPage() {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="API-источники" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  // Auto-provision the built-in Vex source from .env on first visit.
  const hasVex = await botDb.apiSource.findUnique({ where: { slug: "vex" } });
  if (!hasVex && process.env.VEX_API_URL && process.env.VEX_API_KEY) {
    await botDb.apiSource.create({
      data: { slug: "vex", name: "Vex Reseller", baseUrl: process.env.VEX_API_URL, apiKey: process.env.VEX_API_KEY, format: "vex", isActive: true },
    });
  }

  const sources = await botDb.apiSource.findMany({ orderBy: { id: "asc" } });

  return (
    <div className="space-y-6">
      <PageHeader
        title="API-источники"
        subtitle="Поставщики товаров через API. Добавляйте новые источники — импорт и автовыдача работают с любым из них."
      />

      <div className="card p-3 text-sm text-muted">
        Формат <code>vex</code> — контракт как у Vex (<code>?action=products/balance/order</code>, ключ в заголовке
        <code> Authorization: Bearer</code>). Если ваш новый API устроен иначе — пришлите его документацию, добавлю формат.
      </div>

      {sources.map((s) => (
        <form key={s.id} action={saveApiSourceAction} className="card p-5 space-y-3">
          <input type="hidden" name="id" value={s.id} />
          <div className="flex items-center justify-between gap-3">
            <div className="font-semibold">
              {s.name} <span className="font-mono text-xs text-muted">({s.slug})</span>
            </div>
            <span className={`badge ${s.isActive ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>
              {s.isActive ? "активен" : "выключен"}
            </span>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-muted">Название</label>
              <input name="name" defaultValue={s.name} className="input mt-1" />
            </div>
            <div>
              <label className="text-sm text-muted">Формат</label>
              <input name="format" defaultValue={s.format} className="input mt-1" placeholder="vex" />
            </div>
          </div>
          <div>
            <label className="text-sm text-muted">Base URL</label>
            <input name="baseUrl" defaultValue={s.baseUrl} className="input mt-1 font-mono text-xs" />
          </div>
          <div>
            <label className="text-sm text-muted">API ключ (сейчас: {mask(s.apiKey)}) — впишите новый, чтобы заменить</label>
            <input name="apiKey" className="input mt-1 font-mono text-xs" placeholder="оставьте пустым, чтобы не менять" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={s.isActive} /> Активен
          </label>
          <div className="flex gap-2">
            <button className="btn-primary text-sm">Сохранить</button>
            <button formAction={deleteApiSourceAction} className="btn-danger text-sm">Удалить</button>
          </div>
        </form>
      ))}

      {/* Add a new source */}
      <details className="card p-5">
        <summary className="cursor-pointer font-semibold">＋ Добавить API-источник</summary>
        <form action={saveApiSourceAction} className="mt-4 space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-muted">Название</label>
              <input name="name" required className="input mt-1" placeholder="напр. Reseller X" />
            </div>
            <div>
              <label className="text-sm text-muted">Формат</label>
              <input name="format" className="input mt-1" defaultValue="vex" />
            </div>
          </div>
          <div>
            <label className="text-sm text-muted">Base URL</label>
            <input name="baseUrl" required className="input mt-1 font-mono text-xs" placeholder="https://.../reseller-api" />
          </div>
          <div>
            <label className="text-sm text-muted">API ключ</label>
            <input name="apiKey" className="input mt-1 font-mono text-xs" placeholder="sk_..." />
          </div>
          <button className="btn-primary">Добавить</button>
        </form>
      </details>

      {sources.length === 0 && <EmptyState>Источников пока нет. Добавьте первый.</EmptyState>}
    </div>
  );
}
