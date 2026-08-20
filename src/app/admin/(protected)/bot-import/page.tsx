import Link from "next/link";
import { PageHeader, Table, EmptyState, StatCard } from "@/components/admin/ui";
import { botDb, botConfigured } from "@/lib/botDb";
import { sourceProducts, sourceBalance, envVexSource, envBuyerSource, type Source, type SupplierProduct } from "@/lib/supplier";
import { importSourceProductAction } from "./actions";

export const dynamic = "force-dynamic";

type SrcRow = { id: number; slug: string; name: string; baseUrl: string; apiKey: string; format: string };

export default async function BotImportPage({ searchParams }: { searchParams: { src?: string } }) {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Импорт из API" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const dbSources = await botDb.apiSource.findMany({ where: { isActive: true }, orderBy: { id: "asc" } });
  // Env-only sources (key in Railway, not the DB) appear here too, unless a DB
  // row already claims the same slug.
  const envRows: SrcRow[] = [envBuyerSource(), envVexSource()]
    .filter((s): s is Source => !!s)
    .map((s, i) => ({ id: -1 - i, slug: s.slug, name: s.slug === "somadeth" ? "SoMaDeth" : s.slug.toUpperCase(), baseUrl: s.baseUrl, apiKey: s.apiKey, format: s.format }))
    .filter((es) => !dbSources.some((d) => d.slug === es.slug));
  const sources: SrcRow[] = [
    ...dbSources.map((d) => ({ id: d.id, slug: d.slug, name: d.name, baseUrl: d.baseUrl, apiKey: d.apiKey, format: d.format })),
    ...envRows,
  ];
  if (sources.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader title="Импорт из API" action={<Link href="/admin/bot-apis" className="btn-primary text-sm">API-источники</Link>} />
        <EmptyState>
          Нет активных API-источников. Добавьте источник в разделе{" "}
          <Link href="/admin/bot-apis" className="text-brand underline">API-источники</Link>.
        </EmptyState>
      </div>
    );
  }

  const current = sources.find((s) => s.slug === searchParams.src) ?? sources[0];
  const src: Source = { slug: current.slug, baseUrl: current.baseUrl, apiKey: current.apiKey, format: current.format };

  let products: SupplierProduct[] = [];
  let balance = 0;
  let error = "";
  try {
    [products, balance] = await Promise.all([sourceProducts(src), sourceBalance(src)]);
  } catch (e) {
    error = (e as Error).message;
  }

  const linked = await botDb.variant.findMany({ where: { supplierKey: current.slug }, select: { supplierExternalId: true } });
  const imported = new Set(linked.map((l) => l.supplierExternalId));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Импорт из API"
        subtitle="Выберите источник и товары, поставьте на автопродажу — при покупке бот заказывает у поставщика и выдаёт сразу."
        action={<Link href="/admin/bot-apis" className="btn-ghost text-sm">⚙ API-источники</Link>}
      />

      {/* Source switcher */}
      <div className="flex flex-wrap gap-2">
        {sources.map((s) => (
          <Link
            key={s.id}
            href={`/admin/bot-import?src=${s.slug}`}
            className={`badge ${s.slug === current.slug ? "bg-brand text-brand-fg" : "bg-surface-2 text-muted"}`}
          >
            {s.name}
          </Link>
        ))}
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <StatCard label={`Баланс (${current.name})`} value={`${balance.toFixed(2)} USDT`} tone={balance <= 0 ? "danger" : "default"} />
        <StatCard label="Товаров в API" value={String(products.length)} />
        <StatCard label="Импортировано" value={String(imported.size)} />
      </div>

      {error && <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">Ошибка API: {error}</div>}
      {balance <= 0 && !error && (
        <div className="card p-3 border-warning/30 bg-warning/5 text-warning text-sm">
          ⚠ Баланс поставщика ≈ {balance.toFixed(2)} USDT. Пока не пополнен, автозаказы проходить не будут.
        </div>
      )}

      {products.length === 0 ? (
        <EmptyState>Список товаров пуст.</EmptyState>
      ) : (
        <Table head={["Товар", "Категория", "Закупка", "Сток", "Наличие", "Наценка %", ""]}>
          {products.map((p) => {
            const done = imported.has(p.id);
            return (
              <tr key={p.id} className="border-b last:border-0 align-top">
                <td className="px-4 py-3">
                  <div className="font-medium">{p.name}</div>
                  {p.premiumEmojiCode && <div className="font-mono text-[10px] text-muted">ce:{p.premiumEmojiCode}</div>}
                </td>
                <td className="px-4 py-3 text-xs text-muted">{p.category ?? "—"}</td>
                <td className="px-4 py-3">{p.price.toFixed(2)} USDT</td>
                <td className="px-4 py-3">{p.stock}</td>
                <td className="px-4 py-3">
                  <span className={`badge ${p.available ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>
                    {p.available ? "да" : "нет"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {done ? (
                    <span className="badge bg-brand/10 text-brand">импортировано</span>
                  ) : (
                    <form action={importSourceProductAction} className="flex items-center gap-2">
                      <input type="hidden" name="slug" value={current.slug} />
                      <input type="hidden" name="extId" value={p.id} />
                      <input name="markup" type="number" step="1" min="0" defaultValue={20} className="input w-20 text-sm" />
                      <button className="btn-primary text-xs whitespace-nowrap">На продажу</button>
                    </form>
                  )}
                </td>
                <td className="px-4 py-3">
                  {done && <Link href="/admin/bot-products" className="btn-ghost text-xs">Открыть</Link>}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </div>
  );
}
