import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { saveApiSourceAction, deleteApiSourceAction, toggleApiSourceAction } from "./actions";

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

  // Auto-provision the built-in Vexoran source from .env on first visit.
  const hasVex = await botDb.apiSource.findUnique({ where: { slug: "vex" } });
  if (!hasVex && process.env.VEX_API_URL && process.env.VEX_API_KEY) {
    await botDb.apiSource.create({
      data: { slug: "vex", name: "Vexoran Reseller", baseUrl: process.env.VEX_API_URL, apiKey: process.env.VEX_API_KEY, format: "vex", isActive: true },
    });
  }

  const sources = await botDb.apiSource.findMany({ orderBy: { id: "asc" } });

  return (
    <div className="space-y-6">
      <PageHeader
        title="API-источники товаров"
        subtitle="Подключение внешних поставщиков для авто-выдачи и импорта товаров (Vexoran, SoMaDeth и др.)."
      />

      {/* Existing sources */}
      {sources.length > 0 && (
        <div className="space-y-3">
          {sources.map((s) => (
            <div key={s.id} className="card p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground">{s.name}</span>
                  <span className="badge font-mono text-xs">{s.slug}</span>
                  <span className="badge font-mono text-xs">формат: {s.format}</span>
                  {s.isActive ? (
                    <span className="badge badge-success">активен</span>
                  ) : (
                    <span className="badge badge-warning">отключён</span>
                  )}
                </div>
                <div className="text-xs text-muted font-mono mt-1 break-all">{s.baseUrl}</div>
              </div>
              <div className="flex items-center gap-2">
                <form action={toggleApiSourceAction}>
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="active" value={s.isActive ? "0" : "1"} />
                  <button className="btn-secondary text-xs">
                    {s.isActive ? "Отключить" : "Включить"}
                  </button>
                </form>
                <form action={deleteApiSourceAction}>
                  <input type="hidden" name="id" value={s.id} />
                  <button className="btn-danger text-xs">Удалить</button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add a new source */}
      <details className="card p-5">
        <summary className="cursor-pointer font-semibold">＋ Добавить API-источник</summary>
        <form action={saveApiSourceAction} className="mt-4 space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-muted">Название</label>
              <input name="name" required className="input mt-1" placeholder="напр. Vexoran Reseller" />
            </div>
            <div>
              <label className="text-sm text-muted">Формат</label>
              <input name="format" className="input mt-1" defaultValue="vex" />
            </div>
          </div>
          <div>
            <label className="text-sm text-muted">Base URL</label>
            <input name="baseUrl" required className="input mt-1 font-mono text-xs" placeholder="https://api.vexoran.app" />
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
