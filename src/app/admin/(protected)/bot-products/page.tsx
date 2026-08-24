import Link from "next/link";
import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, Table, EmptyState } from "@/components/admin/ui";
import { createBotProductAction, deleteBotProductAction, toggleBotProductActiveAction, uploadBannerAction, deleteBannerAction } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  missing: "Укажите как минимум код и название (RU).",
  duplicate: "Товар с таким кодом уже существует.",
};

export default async function BotProductsPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Товары бота" />
        <EmptyState>BOT_DATABASE_URL не задан в .env — не могу подключиться к базе бота.</EmptyState>
      </div>
    );
  }

  const products = await botDb.product.findMany({
    orderBy: { sortOrder: "asc" },
    include: { plans: { include: { variants: true } } },
  });

  const errorMsg = searchParams.error ? ERRORS[searchParams.error] : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Товары бота"
        subtitle="Каталог, который показывается в Telegram-боте. Изменения применяются в боте сразу."
      />

      {errorMsg && (
        <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">{errorMsg}</div>
      )}

      {/* Manual product creation — the admin owns the catalog, no auto-import */}
      <details className="card p-5">
        <summary className="cursor-pointer font-semibold">+ Добавить товар вручную</summary>
        <form action={createBotProductAction} className="mt-4 space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-muted">Код (уникальный, латиница)</label>
              <input name="code" required className="input mt-1 font-mono" placeholder="напр. telegram_premium" />
            </div>
            <div>
              <label className="text-sm text-muted">Эмодзи или Premium ID</label>
              <input name="emoji" className="input mt-1" defaultValue="✨" />
            </div>
            <div>
              <label className="text-sm text-muted">Название (RU)</label>
              <input name="titleRu" required className="input mt-1" placeholder="Telegram Premium" />
            </div>
            <div>
              <label className="text-sm text-muted">Название (UZ)</label>
              <input name="titleUz" className="input mt-1" placeholder="необязательно" />
            </div>
            <div>
              <label className="text-sm text-muted">Premium Emoji code</label>
              <input name="premiumEmoji" className="input mt-1 font-mono" placeholder="напр. 5278711610775457808" />
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-muted">Описание (RU)</label>
              <textarea name="descRu" rows={2} className="input mt-1 text-sm" />
            </div>
            <div>
              <label className="text-sm text-muted">Описание (UZ)</label>
              <textarea name="descUz" rows={2} className="input mt-1 text-sm" />
            </div>
          </div>
          <p className="text-xs text-muted">
            После создания откроется карточка товара — там добавите варианты (сроки и цены).
          </p>
          <button className="btn-primary">Создать товар</button>
        </form>
      </details>

      {products.length === 0 ? (
        <EmptyState>В боте нет товаров. Добавьте товар вручную формой выше.</EmptyState>
      ) : (
        <Table head={["", "Название", "Код", "Карточка", "Вариантов", "Активен", ""]}>
          {products.map((p) => {
            const variants = p.plans.flatMap((pl) => pl.variants);
            const active = variants.filter((v) => v.isActive).length;
            return (
              <tr key={p.id} className="border-b last:border-0">
                <td className="px-4 py-3 text-lg">{p.emoji}</td>
                <td className="px-4 py-3 font-medium">{p.titleRu}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted">{p.code}</td>
                <td className="px-4 py-3">
                  {p.bannerFileId ? (
                    <div className="flex items-center gap-2">
                      <span className="badge bg-success/10 text-success">✅ Есть</span>
                      <form action={deleteBannerAction}>
                        <input type="hidden" name="productId" value={p.id} />
                        <button className="text-danger text-xs hover:underline">✕</button>
                      </form>
                    </div>
                  ) : (
                    <form action={uploadBannerAction} encType="multipart/form-data" className="flex items-center gap-1">
                      <input type="hidden" name="productId" value={p.id} />
                      <input type="file" name="file" accept="image/*" className="text-xs w-24" />
                      <button className="btn-ghost text-xs">📤</button>
                    </form>
                  )}
                </td>
                <td className="px-4 py-3">
                  {active}/{variants.length}
                </td>
                <td className="px-4 py-3">
                  {/* One click to hide or show the product in the bot. Kept on the
                      list because this is the lever you reach for in a hurry —
                      a supplier is down, a wallet is empty — and hunting through
                      the edit form for a checkbox is too slow for that. */}
                  <form action={toggleBotProductActiveAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <button
                      className={`badge cursor-pointer ${p.isActive ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}
                      title={p.isActive ? "Нажмите, чтобы скрыть товар в боте" : "Нажмите, чтобы показать товар в боте"}
                    >
                      {p.isActive ? "✅ Включён" : "🚫 Выключен"}
                    </button>
                  </form>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <Link href={`/admin/bot-products/${p.id}`} className="btn-ghost text-xs">
                      Редактировать
                    </Link>
                    <form action={deleteBotProductAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <button className="btn-danger text-xs">Удалить</button>
                    </form>
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </div>
  );
}
