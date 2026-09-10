import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState, StatCard } from "@/components/admin/ui";
import { buildDealLinkUrl, calculateDealDiscount } from "@/lib/domain/deal-links";
import {
  createPromoLinkAction,
  togglePromoLinkAction,
  deletePromoLinkAction,
} from "./actions";

export const dynamic = "force-dynamic";

function money(n: number) {
  return `${n.toLocaleString("ru-RU")} сум`;
}

export default async function BotDealLinksPage({
  searchParams,
}: {
  searchParams: { error?: string; ok?: string };
}) {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Акционные ссылки" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || "Aiobunabot";

  const [products, links] = await Promise.all([
    botDb.product.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      include: {
        plans: {
          where: { isActive: true },
          orderBy: { sortOrder: "asc" },
          include: {
            variants: {
              where: { isActive: true },
              orderBy: { sortOrder: "asc" },
            },
          },
        },
      },
    }),
    botDb.promoLink.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        variant: {
          include: {
            plan: {
              include: {
                product: true,
              },
            },
          },
        },
        usages: {
          orderBy: { createdAt: "desc" },
          take: 10,
          include: {
            user: true,
          },
        },
      },
    }),
  ]);

  const variantOptions = products.flatMap((p) =>
    p.plans.flatMap((pl) =>
      pl.variants.map((v) => ({
        id: v.id,
        label: `${p.titleRu} — ${v.titleRu} (Обычная цена: ${money(v.priceUzs)})`,
        priceUzs: v.priceUzs,
      })),
    ),
  );

  const totalUsages = links.reduce((acc, l) => acc + l.usedCount, 0);
  const activeLinks = links.filter((l) => l.isActive).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="🏷 Акционные ссылки"
        subtitle="Генерация специальных ссылок для Telegram со спецценой на товар и ограничением по количеству покупателей."
      />

      {searchParams.error === "missing" && (
        <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">
          Заполните название, выберите товар и укажите спеццену.
        </div>
      )}
      {searchParams.error === "novariant" && (
        <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">
          Выбранный тариф товара не найден в базе.
        </div>
      )}
      {searchParams.ok === "created" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          ✅ Акционная ссылка успешно создана и готова к использованию!
        </div>
      )}

      <div className="grid sm:grid-cols-3 gap-4">
        <StatCard label="Всего акционных ссылок" value={String(links.length)} />
        <StatCard label="Активных акций" value={String(activeLinks)} />
        <StatCard label="Всего покупок по ссылкам" value={String(totalUsages)} />
      </div>

      {/* Creation form */}
      <form action={createPromoLinkAction} className="card p-5 space-y-4 max-w-4xl">
        <h2 className="font-semibold text-base">Создать новую акционную ссылку</h2>

        {variantOptions.length === 0 ? (
          <div className="card p-3 border-warning/30 bg-warning/5 text-warning text-sm">
            Нет активных товаров или тарифов для создания ссылок.
          </div>
        ) : (
          <>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-muted">Название акции / Метка</label>
                <input
                  name="title"
                  placeholder="напр. Скидка для Telegram-канала"
                  required
                  className="input mt-1 w-full"
                />
                <p className="text-xs text-muted mt-1">Отображается в боте в карточке акции и в админке.</p>
              </div>

              <div>
                <label className="text-sm font-medium text-muted">Товар и тариф</label>
                <select name="variantId" required className="input mt-1 w-full">
                  <option value="">— Выберите товар —</option>
                  {variantOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted mt-1">Товар, на который будет действовать специальная цена.</p>
              </div>

              <div>
                <label className="text-sm font-medium text-muted">Специальная цена (сум)</label>
                <input
                  name="priceUzs"
                  type="number"
                  placeholder="напр. 35000"
                  required
                  min={1}
                  step={100}
                  className="input mt-1 w-full"
                />
                <p className="text-xs text-muted mt-1">Цена в сумах при переходе по этой ссылке.</p>
              </div>

              <div>
                <label className="text-sm font-medium text-muted">Лимит покупателей (кол-во человек)</label>
                <input
                  name="maxUses"
                  type="number"
                  placeholder="напр. 10 (0 = безлимитно)"
                  defaultValue={10}
                  min={0}
                  className="input mt-1 w-full"
                />
                <p className="text-xs text-muted mt-1">Сколько всего человек могут купить по этой ссылке. 0 = без ограничений.</p>
              </div>

              <div>
                <label className="text-sm font-medium text-muted">Лимит на 1 пользователя</label>
                <input
                  name="perUserLimit"
                  type="number"
                  defaultValue={1}
                  min={1}
                  className="input mt-1 w-full"
                />
                <p className="text-xs text-muted mt-1">Сколько покупок может совершить один пользователь (по умолчанию 1).</p>
              </div>

              <div>
                <label className="text-sm font-medium text-muted">Срок действия (опционально)</label>
                <input
                  name="expiresAt"
                  type="datetime-local"
                  className="input mt-1 w-full"
                />
                <p className="text-xs text-muted mt-1">Оставьте пустым для бессрочного действия.</p>
              </div>

              <div className="sm:col-span-2">
                <label className="text-sm font-medium text-muted">Свой код ссылки (slug, опционально)</label>
                <input
                  name="customSlug"
                  placeholder="напр. deal_summer24 (если пусто — сгенерируется автоматически)"
                  className="input mt-1 w-full font-mono text-sm"
                />
                <p className="text-xs text-muted mt-1">
                  Ссылка в боте будет: <code>https://t.me/{botUsername}?start=&lt;slug&gt;</code>
                </p>
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button type="submit" className="btn-primary">
                ➕ Сгенерировать ссылку
              </button>
            </div>
          </>
        )}
      </form>

      {/* Links table */}
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold">Список сгенерированных ссылок ({links.length})</h2>
        </div>

        {links.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">
            Акционных ссылок пока нет. Сгенерируйте первую ссылку с помощью формы выше.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-surface-2 text-muted border-b border-border text-xs uppercase tracking-wider">
                <tr>
                  <th className="p-3">Акция</th>
                  <th className="p-3">Товар / Тариф</th>
                  <th className="p-3">Спеццена</th>
                  <th className="p-3">Использовано / Лимит</th>
                  <th className="p-3">Ссылка для Telegram</th>
                  <th className="p-3">Статус</th>
                  <th className="p-3 text-right">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {links.map((l) => {
                  const url = buildDealLinkUrl(botUsername, l.code);
                  const basePrice = l.variant?.priceUzs ?? 0;
                  const { discountPercent } = calculateDealDiscount(basePrice, l.priceUzs);
                  const isExpired = l.expiresAt && new Date(l.expiresAt).getTime() < Date.now();
                  const isExhausted = l.maxUses > 0 && l.usedCount >= l.maxUses;

                  return (
                    <tr key={l.id} className="hover:bg-surface-2/40 transition">
                      <td className="p-3 font-medium">
                        <div className="font-semibold text-text">{l.title}</div>
                        <div className="text-xs text-muted font-mono">{l.code}</div>
                      </td>

                      <td className="p-3">
                        <div className="text-text font-medium">
                          {l.variant?.plan?.product?.titleRu || "Товар удалён"}
                        </div>
                        <div className="text-xs text-muted">
                          {l.variant?.titleRu}
                        </div>
                      </td>

                      <td className="p-3">
                        <div className="font-semibold text-success">
                          {money(l.priceUzs)}
                        </div>
                        {basePrice > l.priceUzs && (
                          <div className="text-xs text-muted">
                            <s>{money(basePrice)}</s>{" "}
                            <span className="text-brand font-medium">(-{discountPercent}%)</span>
                          </div>
                        )}
                      </td>

                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-semibold ${
                              isExhausted
                                ? "text-danger"
                                : l.usedCount > 0
                                ? "text-warning"
                                : "text-text"
                            }`}
                          >
                            {l.usedCount}
                          </span>
                          <span className="text-muted">/</span>
                          <span className="text-muted">
                            {l.maxUses > 0 ? `${l.maxUses} шт.` : "∞"}
                          </span>
                        </div>
                        <div className="text-xs text-muted">
                          {isExhausted ? (
                            <span className="text-danger font-medium">Лимит исчерпан</span>
                          ) : l.maxUses > 0 ? (
                            `Осталось: ${Math.max(0, l.maxUses - l.usedCount)}`
                          ) : (
                            "Безлимитно"
                          )}
                        </div>
                      </td>

                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <code className="text-xs bg-surface-2 px-2 py-1 rounded select-all font-mono">
                            {url}
                          </code>
                        </div>
                        {l.expiresAt && (
                          <div className="text-xs text-muted mt-1">
                            До: {new Date(l.expiresAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </div>
                        )}
                      </td>

                      <td className="p-3">
                        {isExhausted ? (
                          <span className="badge border-danger/40 bg-danger/10 text-danger text-xs">
                            Исчерпан
                          </span>
                        ) : isExpired ? (
                          <span className="badge border-warning/40 bg-warning/10 text-warning text-xs">
                            Истёк срок
                          </span>
                        ) : l.isActive ? (
                          <span className="badge border-success/40 bg-success/10 text-success text-xs">
                            Активна
                          </span>
                        ) : (
                          <span className="badge border-muted/40 bg-muted/10 text-muted text-xs">
                            Отключена
                          </span>
                        )}
                      </td>

                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <form action={togglePromoLinkAction}>
                            <input type="hidden" name="id" value={l.id} />
                            <button
                              type="submit"
                              className="btn-ghost text-xs py-1 px-2 text-muted hover:text-text"
                              title={l.isActive ? "Деактивировать" : "Активировать"}
                            >
                              {l.isActive ? "Выкл" : "Вкл"}
                            </button>
                          </form>
                          <form action={deletePromoLinkAction}>
                            <input type="hidden" name="id" value={l.id} />
                            <button
                              type="submit"
                              className="btn-ghost text-xs py-1 px-2 text-danger hover:bg-danger/10"
                              title="Удалить ссылку"
                            >
                              ✕
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
