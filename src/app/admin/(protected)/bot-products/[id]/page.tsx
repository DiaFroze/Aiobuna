import { notFound } from "next/navigation";
import Link from "next/link";
import { botDb } from "@/lib/botDb";
import { PageHeader } from "@/components/admin/ui";
import {
  updateBotProductAction,
  retranslateProductAction,
  testEmojiAction,
  uploadBannerAction,
  deleteBannerAction,
  addVariantAction,
  updateVariantAction,
  deleteVariantAction,
  addPlanAction,
  addStockAction,
  clearStockAction,
  addVariantSupplierAction,
  updateVariantSupplierAction,
  deleteVariantSupplierAction,
  deleteVideoAction,
} from "../actions";
import { ProductDescriptionEditor } from "@/components/admin/ProductDescriptionEditor";

export const dynamic = "force-dynamic";

export default async function BotProductEditPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  const [product, apiSources] = await Promise.all([
    botDb.product.findUnique({
      where: { id },
      include: {
        plans: {
          orderBy: { sortOrder: "asc" },
          include: {
            variants: {
              orderBy: { sortOrder: "asc" },
              include: { suppliers: { orderBy: { priority: "asc" } } },
            },
          },
        },
      },
    }),
    botDb.apiSource.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ]);
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
              <button className="btn-primary text-sm flex items-center gap-1.5">
                <span>✨</span>
                <span>Оформить через ИИ (Gemini)</span>
              </button>
            </form>
            <Link href="/admin/bot-products" className="btn-ghost text-sm">← Назад</Link>
          </div>
        }
      />

      <div className="card p-3 text-xs text-muted">
        💡 <b>AI-оформление:</b> Нажмите «✨ Оформить через ИИ (Gemini)» для автоматического создания красивого описания с анимированными Telegram Premium эмодзи на русском и узбекском языках.
      </div>

      <div className="card p-3 text-xs text-muted flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-primary/20 bg-primary/5">
        <div>
          📱 <b>Установка описания прямо из Telegram:</b> отправьте боту команду <code className="bg-surface-2 px-1.5 py-0.5 rounded font-bold text-foreground">/desc</code> со своего аккаунта администратора. Выберите этот товар и просто отправьте сообщение со своими <b>премиум-эмодзи</b> — бот сохранит их в точности!
        </div>
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

        {/* Rich Description Editor with Premium Emoji toolbar */}
        <ProductDescriptionEditor
          initialDescRu={product.descRu}
          initialDescUz={product.descUz}
          initialDescEn={product.descEn}
        />

        {/* Sort order & Video file_id */}
        <div className="grid md:grid-cols-2 gap-4 pt-2 border-t">
          <div>
            <label className="text-sm font-medium text-foreground">Позиция в очереди (№ по порядку)</label>
            <input
              type="number"
              name="sortOrder"
              defaultValue={product.sortOrder}
              className="input mt-1 font-mono text-sm"
              placeholder="0"
            />
            <p className="text-xs text-muted mt-1">
              Меньшее число — товар отображается раньше (1-й, 2-й, 3-й...).
            </p>
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">Видео товара (Telegram file_id)</label>
            <input
              name="videoFileId"
              defaultValue={product.videoFileId ?? ""}
              className="input mt-1 font-mono text-sm"
              placeholder="BAACAgIAAxkDA..."
            />
            <p className="text-xs text-muted mt-1">
              Показывается в карточке товара и при выдаче заказа. Можно задать прямо из Telegram: /pvideo
            </p>
          </div>
        </div>

        {/* Banner file_id or URL */}
        <div className="pt-2 border-t">
          <label className="text-sm font-medium text-foreground">Баннер товара (Telegram file_id или URL)</label>
          <input
            name="bannerFileId"
            defaultValue={product.bannerFileId ?? ""}
            className="input mt-1 font-mono text-sm"
            placeholder="file_id (напр. AgACAgIAAxkDA...) или https://example.com/banner.jpg"
          />
          <p className="text-xs text-muted mt-1">
            Если указан — бот отправляет карточку товара с этим графическим баннером сверху сообщения.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isActive" defaultChecked={product.isActive} />
          Товар активен (показывается в боте)
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="refDiscount" defaultChecked={product.refDiscount} />
          Скидка за рефералов (5→−10%, 10→−20%, 20→−40%)
        </label>

        <div className="flex gap-2">
          <button className="btn-primary">Сохранить</button>
        </div>
      </form>

      {/* Banner Upload / Management card */}
      <div className="card p-5 space-y-3">
        <h3 className="font-semibold">📷 Графический баннер товара</h3>
        <p className="text-sm text-muted">
          Баннер крепится сверху сообщения при открытии карточки в Telegram-боте.
        </p>
        {product.bannerFileId || product.code === "ai_darslik" ? (
          <div className="space-y-3 p-3 rounded-lg border bg-surface-2/40">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-success">✅ Баннер прикреплён</div>
                <div className="text-xs font-mono text-muted break-all mt-0.5">
                  {product.bannerFileId || "course-banner.jpg (встроенный)"}
                </div>
              </div>
              {product.bannerFileId && (
                <form action={deleteBannerAction}>
                  <input type="hidden" name="productId" value={product.id} />
                  <button className="btn-danger text-xs px-3">Удалить баннер</button>
                </form>
              )}
            </div>
            <div className="relative rounded overflow-hidden border border-border/40 max-w-sm bg-black/20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={
                  product.bannerFileId?.startsWith("http")
                    ? product.bannerFileId
                    : `/banners/${product.bannerFileId || "course-banner.jpg"}`
                }
                alt="Превью баннера"
                className="w-full h-auto object-contain max-h-48"
              />
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted">Баннер пока не загружен. Можно загрузить файл ниже или ввести file_id в форме выше.</div>
        )}

        <form action={uploadBannerAction} className="flex flex-wrap items-center gap-2 pt-2 border-t">
          <input type="hidden" name="productId" value={product.id} />
          <input type="file" name="file" accept="image/*" required className="text-xs" />
          <button className="btn-primary text-xs px-3">Загрузить файл баннера</button>
        </form>
      </div>

      {/* Video Management card */}
      <div className="card p-5 space-y-3">
        <h3 className="font-semibold">🎬 Видео товара</h3>
        <p className="text-sm text-muted">
          Видео показывается в карточке товара и отправляется в одном сообщении вместе с заказом при выдаче.
        </p>
        {product.videoFileId ? (
          <div className="space-y-3 p-3 rounded-lg border bg-surface-2/40">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-primary">✅ Видео прикреплено</div>
                <div className="text-xs font-mono text-muted break-all mt-0.5">
                  {product.videoFileId}
                </div>
              </div>
              <form action={deleteVideoAction}>
                <input type="hidden" name="productId" value={product.id} />
                <button className="btn-danger text-xs px-3">Удалить видео</button>
              </form>
            </div>
          </div>
        ) : (
          <div className="p-3 rounded-lg border bg-surface-2/20 text-xs text-muted space-y-1">
            <p>Видео пока не прикреплено.</p>
            <p>
              💡 <b>Как загрузить видео:</b> Откройте бот с аккаунта администратора и отправьте команду <code className="bg-surface-2 px-1 py-0.5 rounded font-bold text-foreground">/pvideo</code> или <code className="bg-surface-2 px-1 py-0.5 rounded font-bold text-foreground">/pmedia</code>. Выберите этот товар и отправьте видео в чат!
            </p>
          </div>
        )}
      </div>

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
            <div className="space-y-4">
              {plan.variants.map((v) => {
                const st = stockByVariant.get(v.id) ?? 0;
                const totalSuppStock = v.suppliers.length > 0
                  ? v.suppliers.filter((s) => s.isActive).reduce((acc, s) => acc + s.supplierStock, 0)
                  : v.supplierStock;
                const stockText = v.manualDelivery
                  ? (v.manualStockLimit >= 0 ? `${v.manualStockLimit} (руч)` : "∞")
                  : (v.autoSupplier ? `API: ${totalSuppStock}` : String(st));
                return (
                  <div key={v.id} className="rounded-xl border bg-surface-2/40 p-3 space-y-3">
                    <form
                      action={updateVariantAction}
                      className="grid grid-cols-2 md:grid-cols-12 gap-2 items-end"
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

                      {/* Supplier routing & auto order */}
                      <div className="col-span-2 md:col-span-12 grid md:grid-cols-2 gap-3 pt-2 mt-1 border-t bg-surface-1/50 p-2 rounded-lg">
                        <div>
                          <label className="flex items-center gap-1 font-semibold text-xs text-foreground cursor-pointer">
                            <input type="checkbox" name="autoSupplier" defaultChecked={v.autoSupplier} />
                            ⚡ Авто-заказ у поставщика (API)
                          </label>
                          <p className="text-[11px] text-muted mt-0.5">
                            При покупке бот заказывает у подключенного поставщика по выбранной стратегии.
                          </p>
                        </div>
                        <div>
                          <label className="text-[11px] font-medium text-foreground">Стратегия выбора поставщика</label>
                          <select name="routingStrategy" defaultValue={v.routingStrategy || "priority"} className="input mt-1 text-xs">
                            <option value="priority">🎯 Приоритет (Каскад: Уровень 1 → 2 если ошибка/нет стока)</option>
                            <option value="cheapest">💸 Самый дешевый (сравнение цен поставщиков USDT)</option>
                            <option value="balance">💳 По наличию баланса у поставщика</option>
                          </select>
                        </div>
                      </div>

                      {/* Stars / Premium — delivered to a Telegram account */}
                      <div className="col-span-2 md:col-span-12 grid md:grid-cols-3 gap-2 pt-2 mt-1 border-t">
                        <label className="flex items-center gap-2 text-xs" title="Спросить @username получателя ДО оплаты">
                          <input type="checkbox" name="needsUsername" defaultChecked={v.needsUsername} />
                          👤 Спрашивать @username
                        </label>
                        <div>
                          <label className="text-[11px] text-muted">Тип Fragment</label>
                          <select name="fragmentKind" defaultValue={v.fragmentKind} className="input mt-1 text-sm">
                            <option value="">— обычный товар —</option>
                            <option value="stars">⭐ Telegram Stars</option>
                            <option value="premium">💎 Telegram Premium</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[11px] text-muted">Кол-во (звёзд / месяцев)</label>
                          <input
                            name="fragmentAmount"
                            type="number"
                            min="0"
                            defaultValue={v.fragmentAmount}
                            className="input mt-1 text-sm"
                            placeholder="100"
                          />
                        </div>
                        <p className="md:col-span-3 text-[10px] text-muted">
                          Для Stars — количество звёзд (например 100). Для Premium — только 3, 6 или 12 месяцев,
                          других сроков Fragment не даёт. Включите «Спрашивать @username» и «выдача админом»:
                          бот соберёт получателя до оплаты и пришлёт вам готовое задание на выдачу.
                        </p>
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

                    {/* Multi-Supplier details */}
                    <details className="border-t pt-2 mt-1 text-xs">
                      <summary className="cursor-pointer font-medium text-foreground flex items-center gap-2 select-none">
                        <span>🔗 Подключенные поставщики (Multi-Supplier)</span>
                        {v.suppliers.length > 0 ? (
                          <span className="badge bg-brand/10 text-brand">
                            {v.suppliers.length} подключено · {v.routingStrategy === "cheapest" ? "Самый дешевый" : v.routingStrategy === "balance" ? "По балансу" : "Каскад по уровням"}
                          </span>
                        ) : v.supplierKey ? (
                          <span className="badge bg-surface-3 text-muted">
                            1 (старый формат: {v.supplierKey})
                          </span>
                        ) : (
                          <span className="badge bg-warning/10 text-warning">нет поставщиков</span>
                        )}
                      </summary>

                      <div className="mt-3 space-y-3 pl-2">
                        {v.suppliers.length > 0 ? (
                          <div className="space-y-2">
                            {v.suppliers.map((s) => (
                              <form
                                key={s.id}
                                action={updateVariantSupplierAction}
                                className="flex flex-wrap items-center gap-2 p-2 rounded-lg bg-surface-1 border"
                              >
                                <input type="hidden" name="id" value={s.id} />
                                <input type="hidden" name="productId" value={product.id} />
                                <span className="badge font-semibold bg-brand/20 text-brand">
                                  Уровень {s.priority} {s.priority === 1 ? "(Основной)" : `(Резерв #${s.priority})`}
                                </span>
                                <span className="font-mono font-medium">{s.supplierKey}</span>
                                <span className="text-muted font-mono text-[11px]">ID: {s.supplierExternalId}</span>
                                <div className="flex items-center gap-1">
                                  <span className="text-muted">Закупка:</span>
                                  <input
                                    name="supplierPriceUsdt"
                                    type="number"
                                    step="0.01"
                                    defaultValue={s.supplierPriceUsdt}
                                    className="input text-xs w-16 py-1 px-1 font-mono"
                                  />
                                  <span className="text-muted">$</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <span className="text-muted">Сток:</span>
                                  <input
                                    name="supplierStock"
                                    type="number"
                                    defaultValue={s.supplierStock}
                                    className="input text-xs w-16 py-1 px-1 font-mono"
                                  />
                                </div>
                                <div className="flex items-center gap-1">
                                  <span className="text-muted">Уровень:</span>
                                  <input
                                    name="priority"
                                    type="number"
                                    min="1"
                                    max="99"
                                    defaultValue={s.priority}
                                    className="input text-xs w-12 py-1 px-1 font-mono"
                                  />
                                </div>
                                <label className="flex items-center gap-1 text-muted">
                                  <input type="checkbox" name="isActive" defaultChecked={s.isActive} /> вкл
                                </label>
                                <button className="btn-primary text-xs px-2 py-1">💾</button>
                                <button formAction={deleteVariantSupplierAction} className="btn-danger text-xs px-2 py-1">
                                  🗑
                                </button>
                              </form>
                            ))}
                          </div>
                        ) : v.supplierKey ? (
                          <div className="p-2 rounded-lg bg-surface-1 border flex items-center justify-between">
                            <div>
                              <span className="font-medium text-foreground">Поставщик: {v.supplierKey}</span>
                              <span className="text-muted ml-2 font-mono">ID: {v.supplierExternalId}</span>
                              <span className="text-muted ml-2">Закупка: {v.supplierPriceUsdt}$</span>
                            </div>
                            <form action={addVariantSupplierAction}>
                              <input type="hidden" name="variantId" value={v.id} />
                              <input type="hidden" name="productId" value={product.id} />
                              <input type="hidden" name="supplierKey" value={v.supplierKey} />
                              <input type="hidden" name="supplierExternalId" value={v.supplierExternalId ?? ""} />
                              <input type="hidden" name="supplierPriceUsdt" value={v.supplierPriceUsdt} />
                              <input type="hidden" name="supplierStock" value={v.supplierStock} />
                              <input type="hidden" name="priority" value="1" />
                              <input type="hidden" name="isActive" value="on" />
                              <button className="btn-secondary text-xs">⚡ Перевести в мульти-поставщика (Уровень 1)</button>
                            </form>
                          </div>
                        ) : (
                          <p className="text-muted italic">К этому тарифу пока не подключено ни одного поставщика.</p>
                        )}

                        {/* Add supplier link form */}
                        <form
                          action={addVariantSupplierAction}
                          className="p-3 rounded-lg bg-surface-2/60 border space-y-2"
                        >
                          <input type="hidden" name="variantId" value={v.id} />
                          <input type="hidden" name="productId" value={product.id} />
                          <div className="font-medium text-foreground">＋ Подключить поставщика к этому тарифу:</div>
                          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
                            <div className="col-span-2">
                              <label className="text-[10px] text-muted">Поставщик (API Source)</label>
                              <select name="supplierKey" required className="input text-xs mt-1">
                                <option value="">— выберите источник —</option>
                                {apiSources.map((src) => (
                                  <option key={src.slug} value={src.slug}>
                                    {src.name} ({src.slug})
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="col-span-2">
                              <label className="text-[10px] text-muted">ID товара в API поставщика</label>
                              <input
                                name="supplierExternalId"
                                required
                                placeholder="напр. 12345 или gemini-1m"
                                className="input text-xs font-mono mt-1"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-muted" title="1 = Уровень 1 (основной), 2 = Уровень 2 (резервный)">
                                Уровень (Приоритет)
                              </label>
                              <input
                                name="priority"
                                type="number"
                                min="1"
                                max="99"
                                defaultValue={v.suppliers.length + 1}
                                className="input text-xs font-mono mt-1"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-muted">Закупка USDT</label>
                              <input
                                name="supplierPriceUsdt"
                                type="number"
                                step="0.01"
                                min="0"
                                defaultValue={0}
                                className="input text-xs font-mono mt-1"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-muted">Сток</label>
                              <input
                                name="supplierStock"
                                type="number"
                                min="0"
                                defaultValue={100}
                                className="input text-xs font-mono mt-1"
                              />
                            </div>
                            <div className="flex items-center gap-1 pt-4">
                              <label className="flex items-center gap-1 text-xs">
                                <input type="checkbox" name="isActive" defaultChecked /> вкл
                              </label>
                            </div>
                            <div className="col-span-2 md:col-span-2">
                              <button className="btn-primary text-xs w-full">＋ Подключить</button>
                            </div>
                          </div>
                        </form>
                      </div>
                    </details>
                  </div>
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
