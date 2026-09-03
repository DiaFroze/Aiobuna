import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { saveApiSourceAction, deleteApiSourceAction, toggleApiSourceAction, migrateSourceAction } from "./actions";

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

  // Count linked variants per slug for migration display
  const variantCounts = await botDb.variant.groupBy({
    by: ["supplierKey"],
    where: { supplierKey: { not: null } },
    _count: { supplierKey: true },
  });
  const countBySlug: Record<string, number> = {};
  for (const row of variantCounts) {
    if (row.supplierKey) countBySlug[row.supplierKey] = row._count.supplierKey;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="API-источники товаров"
        subtitle="Управление поставщиками. Обновите ключ прямо здесь — все товары продолжат работать автоматически."
      />

      {sources.length === 0 && <EmptyState>Источников пока нет. Добавьте первый ниже.</EmptyState>}

      {/* Existing sources — edit in place */}
      <div className="space-y-4">
        {sources.map((s) => {
          const linkedCount = countBySlug[s.slug] ?? 0;
          const otherSources = sources.filter((x) => x.slug !== s.slug);
          return (
            <details key={s.id} className="card p-5">
              <summary className="cursor-pointer flex items-center gap-3 select-none">
                <span className="font-semibold text-foreground flex-1">{s.name}</span>
                <span className="badge font-mono text-xs">{s.slug}</span>
                <span className="badge font-mono text-xs">формат: {s.format}</span>
                {s.isActive ? (
                  <span className="badge badge-success">активен</span>
                ) : (
                  <span className="badge badge-warning">отключён</span>
                )}
                {linkedCount > 0 && (
                  <span className="badge bg-brand/10 text-brand text-xs">{linkedCount} товар(ов)</span>
                )}
              </summary>

              <div className="mt-4 space-y-4 border-t pt-4">
                {/* Current URL */}
                <div className="text-xs text-muted font-mono break-all">{s.baseUrl}</div>

                {/* Edit key/url form */}
                <form action={saveApiSourceAction} className="space-y-3">
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="name" value={s.name} />
                  <input type="hidden" name="format" value={s.format} />
                  <input type="hidden" name="isActive" value={s.isActive ? "on" : ""} />
                  <div className="grid md:grid-cols-2 gap-3">
                    <div>
                      <label className="text-sm text-muted">Новый Base URL (оставьте пустым чтобы не менять)</label>
                      <input
                        name="baseUrl"
                        defaultValue={s.baseUrl}
                        className="input mt-1 font-mono text-xs"
                        placeholder="https://api.vexoran.app"
                      />
                    </div>
                    <div>
                      <label className="text-sm text-muted">Новый API ключ (сейчас: {mask(s.apiKey)})</label>
                      <input
                        name="apiKey"
                        className="input mt-1 font-mono text-xs"
                        placeholder="vex_sk_... или vxr_... — оставьте пустым чтобы не менять"
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-primary text-sm">💾 Сохранить ключ / URL</button>
                    <form action={toggleApiSourceAction} className="inline">
                      <input type="hidden" name="id" value={s.id} />
                      <input type="hidden" name="active" value={s.isActive ? "0" : "1"} />
                      <button className="btn-secondary text-sm">
                        {s.isActive ? "⏸ Отключить" : "▶ Включить"}
                      </button>
                    </form>
                    <form action={deleteApiSourceAction} className="inline">
                      <input type="hidden" name="id" value={s.id} />
                      <button className="btn-danger text-sm">🗑 Удалить источник</button>
                    </form>
                  </div>
                </form>

                {/* Migrate products to another source */}
                {otherSources.length > 0 && linkedCount > 0 && (
                  <div className="border-t pt-3 space-y-2">
                    <div className="text-sm font-medium">
                      🔄 Перенести {linkedCount} товар(ов) в другой источник
                    </div>
                    <p className="text-xs text-muted">
                      Все товары, цены и настройки сохранятся — меняется только привязка к API-источнику.
                      Используйте это, если вы добавили новый ключ как отдельный источник.
                    </p>
                    <form action={migrateSourceAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="fromSlug" value={s.slug} />
                      <select name="toSlug" className="input text-sm w-auto">
                        {otherSources.map((o) => (
                          <option key={o.slug} value={o.slug}>
                            {o.name} ({o.slug})
                          </option>
                        ))}
                      </select>
                      <button className="btn-primary text-sm">🔄 Перенести все товары</button>
                    </form>
                  </div>
                )}
              </div>
            </details>
          );
        })}
      </div>

      {/* Add a new source */}
      <details className="card p-5">
        <summary className="cursor-pointer font-semibold">＋ Добавить новый API-источник</summary>
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
            <input name="apiKey" className="input mt-1 font-mono text-xs" placeholder="vex_sk_..." />
          </div>
          <button className="btn-primary">Добавить</button>
        </form>
      </details>
    </div>
  );
}
