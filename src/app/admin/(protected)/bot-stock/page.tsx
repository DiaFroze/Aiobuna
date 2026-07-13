import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { importStockAction, deleteStockItemAction, clearVariantStockAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function BotStockPage() {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Склад" />
        <EmptyState>BOT_DATABASE_URL не задан в .env — не могу подключиться к базе бота.</EmptyState>
      </div>
    );
  }

  const variants = await botDb.variant.findMany({
    where: { isActive: true },
    include: { plan: { include: { product: true } } },
    orderBy: { id: "asc" },
  });

  // Stock counts per variant
  const stockCounts = await Promise.all(
    variants.map(async (v) => ({
      variantId: v.id,
      product: v.plan.product.titleRu,
      variant: v.titleRu,
      local: await botDb.stockItem.count({ where: { variantId: v.id, isSold: false } }),
      sold: await botDb.stockItem.count({ where: { variantId: v.id, isSold: true } }),
      apiStock: v.autoSupplier ? v.supplierStock : 0,
    }))
  );

  // Recent stock items (last 20 unsold per variant, limited)
  const recentItems = await botDb.stockItem.findMany({
    where: { isSold: false },
    orderBy: { id: "desc" },
    take: 50,
    include: { variant: { include: { plan: { include: { product: true } } } } },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="📦 Склад"
        subtitle="Загрузите ссылки на товары. Локальный склад продаётся первым, затем API."
      />

      {/* Stock overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {stockCounts.map((sc) => (
          <div key={sc.variantId} className="card p-4 space-y-2">
            <div className="font-semibold">{sc.product}</div>
            <div className="text-sm text-muted">{sc.variant}</div>
            <div className="grid grid-cols-3 gap-2 text-center text-sm mt-2">
              <div>
                <div className="text-2xl font-bold text-success">{sc.local}</div>
                <div className="text-muted">Свой склад</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-primary">{sc.apiStock}</div>
                <div className="text-muted">API</div>
              </div>
              <div>
                <div className="text-2xl font-bold">{sc.sold}</div>
                <div className="text-muted">Продано</div>
              </div>
            </div>
            {sc.local > 0 && (
              <form action={clearVariantStockAction}>
                <input type="hidden" name="variantId" value={sc.variantId} />
                <button
                  type="submit"
                  className="btn btn-sm btn-outline-danger w-full mt-2"
                >
                  🗑 Очистить склад
                </button>
              </form>
            )}
          </div>
        ))}
      </div>

      {/* Import form */}
      <div className="card p-5 space-y-4">
        <h3 className="font-semibold text-lg">📥 Загрузить ссылки на склад</h3>
        <form action={importStockAction} className="space-y-4">
          <div>
            <label className="text-sm text-muted">Вариант товара</label>
            <select name="variantId" required className="input mt-1">
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.plan.product.titleRu} — {v.titleRu}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm text-muted">
              Ссылки (каждая на новой строке)
            </label>
            <textarea
              name="links"
              required
              rows={10}
              className="input mt-1 font-mono text-xs"
              placeholder={"https://serviceactivation.google.com/...\nhttps://serviceactivation.google.com/...\nhttps://serviceactivation.google.com/..."}
            />
          </div>
          <button type="submit" className="btn btn-success">
            ✅ Импортировать на склад
          </button>
        </form>
      </div>

      {/* Recent stock items */}
      {recentItems.length > 0 && (
        <div className="card p-5 space-y-4">
          <h3 className="font-semibold text-lg">📋 Последние товары на складе (непроданные)</h3>
          <div className="overflow-x-auto">
            <table className="table w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left">ID</th>
                  <th className="text-left">Товар</th>
                  <th className="text-left">Ссылка</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recentItems.map((item) => (
                  <tr key={item.id}>
                    <td className="font-mono text-muted">{item.id}</td>
                    <td>{item.variant.plan.product.titleRu}</td>
                    <td className="font-mono text-xs max-w-xs truncate" title={item.payload}>
                      {item.payload.length > 60 ? item.payload.slice(0, 60) + "…" : item.payload}
                    </td>
                    <td>
                      <form action={deleteStockItemAction}>
                        <input type="hidden" name="id" value={item.id} />
                        <button type="submit" className="text-danger hover:underline text-xs">
                          ✕
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
