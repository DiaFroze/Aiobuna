import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { deleteStockItemAction, clearVariantStockAction } from "./actions";
import { StockUploader } from "./stock-uploader";
import { detectStockPayloadType, formatStockPayloadForFile } from "@/lib/domain/stock-payload";

export const dynamic = "force-dynamic";

function FormatBadge({ type }: { type: string }) {
  switch (type) {
    case "account":
      return <span className="badge bg-purple-500/10 text-purple-400 border border-purple-500/20 text-[11px]">👤🔑 Аккаунт</span>;
    case "link_promo":
      return <span className="badge bg-sky-500/10 text-sky-400 border border-sky-500/20 text-[11px]">🔗🎟 Ссылка+Код</span>;
    case "link":
      return <span className="badge bg-blue-500/10 text-blue-400 border border-blue-500/20 text-[11px]">🔗 Ссылка</span>;
    case "code":
      return <span className="badge bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[11px]">🎟 Код / Ключ</span>;
    default:
      return <span className="badge bg-neutral-500/10 text-neutral-400 border border-neutral-500/20 text-[11px]">📝 Текст</span>;
  }
}

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

  // Recent stock items (last 50 unsold per variant, limited)
  const recentItems = await botDb.stockItem.findMany({
    where: { isSold: false },
    orderBy: { id: "desc" },
    take: 50,
    include: { variant: { include: { plan: { include: { product: true } } } } },
  });

  const variantOptions = variants.map((v) => ({
    id: v.id,
    label: `${v.plan.product.titleRu} — ${v.titleRu}`,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="📦 Склад"
        subtitle="Загрузка и управление товарами: раздельные поля для email и ссылок, двойной моно (тап для копирования), промокоды и живое превью."
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

      {/* Smart Stock Uploader with Live Preview */}
      <StockUploader variants={variantOptions} />

      {/* Recent stock items */}
      {recentItems.length > 0 && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg">📋 Последние товары на складе (непроданные)</h3>
            <span className="text-xs text-muted">Показано: {recentItems.length}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="table w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left w-16">ID</th>
                  <th className="text-left">Товар</th>
                  <th className="text-left w-32">Формат</th>
                  <th className="text-left">Содержимое для выдачи</th>
                  <th className="w-12"></th>
                </tr>
              </thead>
              <tbody>
                {recentItems.map((item) => {
                  const formatType = detectStockPayloadType(item.payload);
                  const previewText = formatStockPayloadForFile(item.payload);
                  return (
                    <tr key={item.id}>
                      <td className="font-mono text-muted text-xs">{item.id}</td>
                      <td className="font-medium text-xs whitespace-nowrap">
                        {item.variant.plan.product.titleRu}
                        <span className="text-muted block text-[11px] font-normal">{item.variant.titleRu}</span>
                      </td>
                      <td>
                        <FormatBadge type={formatType} />
                      </td>
                      <td className="font-mono text-xs max-w-md truncate" title={previewText}>
                        {previewText.length > 70 ? previewText.slice(0, 70) + "…" : previewText}
                      </td>
                      <td className="text-right">
                        <form action={deleteStockItemAction}>
                          <input type="hidden" name="id" value={item.id} />
                          <button
                            type="submit"
                            className="text-danger hover:underline text-xs p-1"
                            title="Удалить позицию"
                          >
                            ✕
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
