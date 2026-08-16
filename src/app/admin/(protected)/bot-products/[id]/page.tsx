import { notFound } from "next/navigation";
import Link from "next/link";
import { botDb } from "@/lib/botDb";
import { PageHeader } from "@/components/admin/ui";
import {
  updateBotProductAction,
  retranslateProductAction,
  testEmojiAction,
  addVariantAction,
  updateVariantAction,
  deleteVariantAction,
  addPlanAction,
  addStockAction,
  clearStockAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function BotProductEditPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  const product = await botDb.product.findUnique({
    where: { id },
    include: { plans: { orderBy: { sortOrder: "asc" }, include: { variants: { orderBy: { sortOrder: "asc" } } } } },
  });
  if (!product) notFound();

  // Unsold stock count per variant (shown as "Остаток" and sold in the bot).
  const variantIds = product.plans.flatMap((pl) => pl.variants.map((v) => v.id));
  const stockRows = variantIds.length
    ? await botDb.stockItem.groupBy({
        by: ["variantId"],
        where: { variantId: { in: variantIds }, isSold: false },
        _count: { _all: true },
      })
    : [];
  const stockByVariant = new Map(stockRows.map((r) => [r.variantId, r._count._all]));

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title={`Товар бота: ${product.titleRu}`}
        subtitle={`Код: ${product.code} • изменения применяются в боте сразу`}
        action={
          <div className="flex gap-2">
            <form action={retranslateProductAction}>
              <input type="hidden" name="id" value={product.id} />
              <button className="btn-primary text-sm">🌍 Перевести (RU/EN/UZ)</button>
            </form>
            <Link href="/admin/bot-products" className="btn-ghost text-sm">← Назад</Link>
          </div>
        }
      />

      <div className="card p-3 text-xs text-muted">
        Описание переводится на 3 языка через Gemini при импорте. Нажмите «🌍 Перевести», чтобы (пере)создать
        аккуратные RU/EN/UZ версии из текущего текста.
      </div>

      <form action={updateBotProductAction} className="card p-5 space-y-4">
        <input type="hidden" name="id" value={product.id} />

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-muted">Название (RU)</label>
            <input name="titleRu" defaultValue={product.titleRu} required className="input mt-1" />
          </div>
          <div>
            <label className="text-sm text-muted">Название (UZ)</label>
            <input name="titleUz" defaultValue={product.titleUz} className="input mt-1" />
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-muted">Эмодзи или Premium ID</label>
            <input name="emoji" defaultValue={product.emoji} className="input mt-1" inputMode="text" />
            <p className="text-xs text-muted mt-1">Обычный эмодзи ИЛИ длинный премиум-ID (≈19 цифр) — распознается автоматически.</p>
          </div>
          <div>
            <label className="text-sm text-muted">Premium Emoji code (custom_emoji_id)</label>
            <input name="premiumEmoji" defaultValue={product.premiumEmoji ?? ""} className="input mt-1 font-mono" placeholder="напр. 5278711610775457808" />
            <p className="text-xs text-muted mt-1">Длинный числовой код. Показывается как иконка товара в боте.</p>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-muted">Описание (RU)</label>
            <textarea name="descRu" defaultValue={product.descRu} rows={4} className="input mt-1 text-sm" />
          </div>
          <div>
            <label className="text-sm text-muted">Описание (UZ)</label>
            <textarea name="descUz" defaultValue={product.descUz} rows={4} className="input mt-1 text-sm" />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isActive" defaultChecked={product.isActive} />
          Товар активен (показывается в боте)
        </label>

        <div className="flex gap-2">
          <button className="btn-primary">Сохранить</button>
        </div>
      </form>

      {/* Premium emoji preview: send a real message to Telegram */}
      <form action={testEmojiAction} className="card p-5 space-y-3">
        <h3 className="font-semibold">Проверить отображение Premium Emoji</h3>
        <p className="text-sm text-muted">
          Отправит тестовое сообщение вам в Telegram с этим премиум-эмодзи. Сначала сохраните код выше.
        </p>
        <input type="hidden" name="titleRu" value={product.titleRu} />
        <input type="hidden" name="emoji" value={product.emoji} />
        <input type="hidden" name="premiumEmoji" value={product.premiumEmoji ?? ""} />
        <button className="btn-ghost text-sm" disabled={!product.premiumEmoji}>
          Отправить превью в Telegram
        </button>
      </form>

      {product.plans.map((plan) => (
        <div key={plan.id} className="card p-5 space-y-3">
          <h3 className="font-semibold">Тариф: {plan.titleRu} — варианты (сроки и цены)</h3>
          {/* Editable variants — price is set in сум (UZS) per item */}
          {plan.variants.length === 0 ? (
            <p className="text-sm text-muted">Нет вариантов. Добавьте ниже.</p>
          ) : (
            <div className="space-y-2">
              {plan.variants.map((v) => {
                const st = stockByVariant.get(v.id) ?? 0;
                const stockText = v.manualDelivery
                  ? (v.manualStockLimit >= 0 ? `${v.manualStockLimit} (руч)` : "∞")
                  : (v.autoSupplier ? `API: ${v.supplierStock}` : String(st));
                return (
                  <form
                    key={v.id}
                    action={updateVariantAction}
                    className="rounded-xl border bg-surface-2/40 p-3 grid grid-cols-2 md:grid-cols-12 gap-2 items-end"
                  >
                    <input type="hidden" name="variantId" value={v.id} />
                    <input type="hidden" name="productId" value={product.id} />
                    <div className="col-span-2 md:col-span-3">
                      <label className="text-[11px] text-muted">Вариант</label>
                      <input name="titleRu" defaultValue={v.titleRu} className="input mt-1 text-sm" />
                    </div>
                    <div className="md:col-span-1">
                      <label className="text-[11px] text-muted">Дней</label>
                      <input name="durationDays" type="number" min="0" defaultValue={v.durationDays} className="input mt-1 text-sm" />
                    </div>
                    <div className="md:col-span-2">
                      <label className="text-[11px] text-muted">Цена (сум) 💰</label>
                      <input name="priceUzs" type="number" step="1" min="0" defaultValue={v.priceUzs} className="input mt-1 text-sm" />
                    </div>
                    <div className="md:col-span-1">
                      <label className="text-[11px] text-muted">Stars</label>
                      <input name="priceStars" type="number" step="1" min="0" defaultValue={v.priceStars} className="input mt-1 text-sm" />
                    </div>
                    <div className="md:col-span-1">
                      <label className="text-[11px] text-muted" title="Цена в рефералах. 0 = нельзя купить за рефералы.">Реф.🤝</label>
                      <input name="pointsCost" type="number" step="1" min="0" defaultValue={v.pointsCost} className="input mt-1 text-sm" placeholder="0" />
                    </div>
                    <div className="md:col-span-1">
                      <label className="text-[11px] text-muted" title="Для ручной выдачи. -1 = безлимит">Лимит</label>
                      <input name="manualStockLimit" type="number" min="-1" defaultValue={v.manualStockLimit} className="input mt-1 text-sm font-mono" placeholder="∞" />
                    </div>
                    <div className="md:col-span-1">
                      <label className="text-[11px] text-muted">Остаток</label>
                      <div className="mt-1 text-sm">📦 {stockText}</div>
                    </div>
                    <div className="md:col-span-2 flex flex-col gap-1 text-xs">
                      <label className="flex items-center gap-1">
                        <input type="checkbox" name="isActive" defaultChecked={v.isActive} /> вкл
                      </label>
                      <label className="flex items-center gap-1" title="Выдаёте логин/пароль вручную после оплаты через /give">
                        <input type="checkbox" name="manual" defaultChecked={v.manualDelivery} /> выдача админом
                      </label>
                    </div>
                    <div className="col-span-2 md:col-span-1 flex gap-1 justify-end">
                      <button className="btn-primary text-xs px-3">💾</button>
                      <button formAction={deleteVariantAction} className="btn-danger text-xs px-3">✕</button>
                    </div>

                    {/* Quantity deals — full width under the main row */}
                    <div className="col-span-2 md:col-span-12 grid md:grid-cols-2 gap-2 pt-2 mt-1 border-t">
                      <div>
                        <label className="text-[11px] text-muted">
                          🔥 Цены за набор
                          <span className="ml-1 opacity-60">— «2=55000,3=80000»</span>
                        </label>
                        <input
                          name="bulkPrices"
                          defaultValue={v.bulkPrices}
                          className="input mt-1 text-sm font-mono"
                          placeholder="2=55000,3=80000"
                        />
                        <p className="text-[10px] text-muted mt-1">
                          Итоговая цена за это количество. Пример: 1 шт. — {v.priceUzs.toLocaleString("ru-RU")} сум,
                          2 шт. — 55 000, 3 шт. — 80 000. Свыше самого большого набора цена считается по его же ставке за штуку.
                        </p>
                      </div>
                      <div>
                        <label className="text-[11px] text-muted">
                          🎁 Подарок за количество
                          <span className="ml-1 opacity-60">— «2+1»</span>
                        </label>
                        <input
                          name="bulkBonus"
                          defaultValue={v.bulkBonus}
                          className="input mt-1 text-sm font-mono"
                          placeholder="2+1"
                        />
                        <p className="text-[10px] text-muted mt-1">
                          Купил 2 — получил 3. Повторяется: за 4 купленных дадут 2 в подарок.
                          Подарочные штуки списываются со склада, сверх остатка не выдаются.
                        </p>
                      </div>
                    </div>
                  </form>
                );
              })}
            </div>
          )}

          {/* Stock (deliverable codes) per variant */}
          {plan.variants.length > 0 && (
            <div className="space-y-2">
              {plan.variants.map((v) => (
                <details key={v.id} className="rounded-lg border bg-surface-2/40 p-3">
                  <summary className="cursor-pointer text-sm">
                    📦 Склад · <span className="font-medium">{v.titleRu}</span> — в наличии:{" "}
                    {stockByVariant.get(v.id) ?? 0}
                  </summary>
                  <form action={addStockAction} className="mt-3 space-y-2">
                    <input type="hidden" name="variantId" value={v.id} />
                    <input type="hidden" name="productId" value={product.id} />
                    <label className="text-xs text-muted">
                      Коды для выдачи — по одному в строке. Каждый продаётся один раз.
                    </label>
                    <textarea
                      name="codes"
                      rows={3}
                      className="input text-sm font-mono"
                      placeholder="login: mail@x.io / pass&#10;KEY-XXXX-YYYY"
                    />
                    <div className="flex gap-2">
                      <button className="btn-primary text-xs">Добавить в склад</button>
                      <button formAction={clearStockAction} className="btn-ghost text-xs text-danger">
                        Очистить непроданные
                      </button>
                    </div>
                  </form>
                </details>
              ))}
            </div>
          )}

          {/* Add a variant to this plan */}
          <form action={addVariantAction} className="grid md:grid-cols-12 gap-2 items-end pt-3 border-t">
            <input type="hidden" name="planId" value={plan.id} />
            <input type="hidden" name="productId" value={product.id} />
            <div className="col-span-2 md:col-span-3">
              <label className="text-xs text-muted">Название варианта</label>
              <input name="titleRu" required className="input mt-1 text-sm" placeholder="напр. 1 месяц" />
            </div>
            <div className="md:col-span-1">
              <label className="text-xs text-muted">Дней</label>
              <input name="durationDays" type="number" min="0" className="input mt-1 text-sm" defaultValue={0} />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs text-muted">Цена (сум) 💰</label>
              <input name="priceUzs" type="number" min="0" step="1" className="input mt-1 text-sm" defaultValue={0} />
            </div>
            <div className="md:col-span-1">
              <label className="text-xs text-muted">Stars</label>
              <input name="priceStars" type="number" min="0" step="1" className="input mt-1 text-sm" defaultValue={0} />
            </div>
            <div className="md:col-span-2 flex flex-col gap-1 text-[11px] self-center">
              <label className="flex items-center gap-1">
                <input type="checkbox" name="manual" /> ручная выдача
              </label>
            </div>
            <div className="md:col-span-2">
              <label className="text-xs text-muted">Лимит (руч.)</label>
              <input name="manualStockLimit" type="number" min="-1" className="input mt-1 text-sm" defaultValue={-1} placeholder="∞" />
            </div>
            <div className="col-span-2 md:col-span-1 text-right">
              <button className="btn-primary w-full h-10 px-3">+</button>
            </div>
          </form>
        </div>
      ))}

      {/* Add another plan (tariff group) */}
      <form action={addPlanAction} className="card p-4 flex items-end gap-2">
        <input type="hidden" name="productId" value={product.id} />
        <div className="flex-1">
          <label className="text-xs text-muted">Новый тариф (группа вариантов)</label>
          <input name="titleRu" className="input mt-1" placeholder="напр. Индивидуальный" />
        </div>
        <button className="btn-ghost text-sm h-10">Добавить тариф</button>
      </form>
    </div>
  );
}
