import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState, StatCard } from "@/components/admin/ui";
import {
  createGiveawayAction,
  toggleGiveawayAction,
  publishGiveawayAction,
  drawGiveawayAction,
  deleteGiveawayAction,
  sendTestGiveawayPostAction,
  sendTestGiveawayResultsAction,
  updateBoostSettingsAction,
  toggleGlobalBoostDiscountAction,
  updateVariantBoostPricingAction,
  publishBoosterAdAction,
  sendTestBoosterAdAction,
} from "./actions";
import { maskUserIdentifier, formatGiveawayCountdown } from "@/lib/domain/giveaways";
import {
  generateBoosterAdTemplates,
  buildTelegramBoostUrl,
  calculateVariantBoosterPrice,
} from "@/lib/domain/channel-boosts";

const ERROR_MESSAGES: Record<string, string> = {
  missing: "Заполните все обязательные поля.",
  invalid: "Проверьте введённые данные.",
  novariant: "Выбранный тариф не найден.",
  nochannel: "Укажите канал для публикации.",
  nobottoken: "Не настроен токен Telegram-бота.",
  notargetchat: "Не указан Telegram Chat ID для отправки теста (задайте TELEGRAM_ADMIN_CHAT_ID в .env).",
  alreadydrawn: "Итоги уже подведены. Создайте новый розыгрыш.",
  noparticipants: "Нет участников, выполнивших условия.",
  notfound: "Запись не найдена.",
  publishexception: "Не удалось опубликовать пост. Проверьте права бота в канале.",
  testpostexception: "Ошибка при отправке тестового сообщения.",
  testresultsexception: "Ошибка при отправке тестовых итогов.",
};

export const dynamic = "force-dynamic";

function money(n: number) {
  return `${n.toLocaleString("ru-RU")} сум`;
}

export default async function BotGiveawaysPage({
  searchParams,
}: {
  searchParams: { error?: string; ok?: string; view?: string; warning?: string };
}) {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Розыгрыши и бусты" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || "Aiobunabot";
  const defaultAdminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || "";

  const [
    products,
    giveaways,
    totalWinnersCount,
    boostPercentSetting,
    boostEnabledSetting,
    boostLinkSetting,
    channelSetting,
    activeBoosters,
  ] = await Promise.all([
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
    botDb.giveaway.findMany({
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
        participants: {
          include: {
            user: true,
          },
          orderBy: { joinedAt: "desc" },
        },
        winners: {
          include: {
            user: true,
            promoLink: true,
          },
        },
      },
    }),
    botDb.giveawayWinner.count(),
    botDb.botSetting.findUnique({ where: { key: "boost_discount_percent" } }),
    botDb.botSetting.findUnique({ where: { key: "boost_discount_enabled" } }),
    botDb.botSetting.findUnique({ where: { key: "channel_boost_link" } }),
    botDb.botSetting.findUnique({ where: { key: "channel_username" } }),
    (botDb as any).channelBoost.findMany({
      where: { expiresAt: { gt: new Date() } },
      include: { user: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }).catch(() => []),
  ]);

  const boostDiscountPercent = Number(boostPercentSetting?.valueRu ?? "10") || 10;
  const isBoostGlobalEnabled = boostEnabledSetting ? boostEnabledSetting.valueRu !== "0" && boostEnabledSetting.valueRu !== "false" : true;
  const channelTarget = channelSetting?.valueRu || "@Aiobuna";
  const customBoostLink = boostLinkSetting?.valueRu || "";
  const effectiveBoostLink = customBoostLink || buildTelegramBoostUrl(channelTarget);

  const adTemplates = generateBoosterAdTemplates({
    channelTitle: channelTarget,
    boostLink: effectiveBoostLink,
    defaultPercent: boostDiscountPercent,
    botUsername,
  });

  const allVariants = products.flatMap((p) =>
    p.plans.flatMap((pl) =>
      pl.variants.map((v) => ({
        ...v,
        productTitle: p.titleRu,
        planTitle: pl.titleRu,
        label: `${p.titleRu} — ${v.titleRu}`,
      })),
    ),
  );

  const variantOptions = allVariants.map((v) => ({
    id: v.id,
    label: `${v.label} (Обычная цена: ${money(v.priceUzs)})`,
    priceUzs: v.priceUzs,
  }));

  const activeCount = giveaways.filter((g) => g.status === "active").length;
  const completedCount = giveaways.filter((g) => g.status === "completed").length;
  const totalParticipants = giveaways.reduce((acc, g) => acc + g.participants.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="🎉 Розыгрыши, бусты и акции"
        subtitle="Проведение розыгрышей, авто-итоги по таймеру, автоматические скидки за буст канала, готовые рекламные материалы и настройка спеццен по товарам."
      />

      {/* Status Banners */}
      {searchParams.ok === "created" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          ✅ Розыгрыш успешно создан!
        </div>
      )}
      {searchParams.ok === "published" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          📢 Пост с кнопкой успешно отправлен в канал!
        </div>
      )}
      {searchParams.ok === "drawn" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          🏆 Победители успешно определены! Им выдано право на покупку со спецценой.
        </div>
      )}
      {searchParams.ok === "updated" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          ✅ Статус розыгрыша обновлен.
        </div>
      )}
      {searchParams.ok === "deleted" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          🗑 Розыгрыш удален.
        </div>
      )}
      {searchParams.ok === "test_sent" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          🧪 <b>Тестовый пост анонса отправлен в Telegram!</b>
        </div>
      )}
      {searchParams.ok === "test_results_sent" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          🧪 <b>Тестовый пост итогов отправлен в Telegram!</b>
        </div>
      )}
      {searchParams.ok === "boost_updated" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          🚀 <b>Настройки скидки за буст канала успешно сохранены!</b>
        </div>
      )}
      {searchParams.ok === "boost_variant_updated" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          🏷 <b>Индивидуальные настройки цены бустера для тарифа сохранены!</b>
        </div>
      )}
      {searchParams.ok === "ad_published" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          📢 <b>Рекламный пост для бустеров опубликован в канал с кнопкой перехода!</b>
        </div>
      )}
      {searchParams.ok === "ad_test_sent" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          🧪 <b>Тестовая реклама отправлена администратору в Telegram!</b> Проверьте кнопки и оформление.
        </div>
      )}

      {searchParams.warning === "notifyfailed" && (
        <div className="card p-3 border-warning/30 text-sm" role="alert">
          Победители сохранены, но часть уведомлений Telegram не отправлена.
        </div>
      )}
      {searchParams.error && (
        <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">
          ⚠️ Ошибка: {ERROR_MESSAGES[searchParams.error] ?? searchParams.error}
        </div>
      )}

      {/* Top statistics */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Всего конкурсов" value={String(giveaways.length)} />
        <StatCard label="Активных" value={String(activeCount)} />
        <StatCard label="Завершённых" value={String(completedCount)} />
        <StatCard label="Участников конкурсов" value={String(totalParticipants)} />
        <StatCard label="Бустеров канала" value={String(activeBoosters.length)} />
      </div>

      {/* Section 1: Channel Boost General Settings & Boosters */}
      <div className="card p-5 bg-surface border space-y-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">🚀</span>
              <h2 className="text-base font-semibold">Скидки за буст Telegram-канала</h2>
              <span
                className={`badge text-xs px-2 py-0.5 rounded-full font-medium ${
                  isBoostGlobalEnabled
                    ? "bg-success/15 text-success border border-success/30"
                    : "bg-muted/15 text-muted border border-muted/30"
                }`}
              >
                {isBoostGlobalEnabled ? "🟢 Система активна" : "⚪ Отключена"}
              </span>
            </div>
            <p className="text-xs text-muted mt-1">
              Когда пользователь отдаёт голос каналу, бот мгновенно начисляет ему скидку на все разрешённые товары.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <form action={toggleGlobalBoostDiscountAction}>
              <button
                type="submit"
                className={`btn btn-sm text-xs border ${
                  isBoostGlobalEnabled
                    ? "border-warning/30 text-warning hover:bg-warning/10"
                    : "border-success/30 text-success hover:bg-success/10"
                }`}
              >
                {isBoostGlobalEnabled ? "⏸ Отключить буст-скидки" : "▶️ Включить буст-скидки"}
              </button>
            </form>
          </div>
        </div>

        {/* Settings form: Percent + Boost Link */}
        <form action={updateBoostSettingsAction} className="p-3.5 bg-surface-2 rounded-lg border space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="font-semibold block mb-1">Скидка по умолчанию (%)</label>
              <div className="relative">
                <input
                  type="number"
                  name="boostDiscountPercent"
                  defaultValue={boostDiscountPercent}
                  min="0"
                  max="100"
                  className="input w-full pr-8 font-semibold"
                />
                <span className="absolute right-3 top-2 text-muted">%</span>
              </div>
              <span className="text-[10px] text-muted">Применяется к товарам, где не задана индивидуальная цена.</span>
            </div>

            <div>
              <label className="font-semibold block mb-1">Прямая ссылка на буст канала</label>
              <input
                type="text"
                name="channelBoostLink"
                defaultValue={customBoostLink}
                placeholder={effectiveBoostLink}
                className="input w-full font-mono text-[11px]"
              />
              <span className="text-[10px] text-muted">Оставьте пустым для автогенерации (https://t.me/boost/ваш_канал).</span>
            </div>
          </div>

          <div className="flex justify-end">
            <button type="submit" className="btn btn-sm btn-primary text-xs">
              💾 Сохранить общие настройки буста
            </button>
          </div>
        </form>

        {/* Active Boosters List */}
        {activeBoosters.length > 0 ? (
          <div className="border rounded-lg p-3 bg-surface-2 space-y-2">
            <div className="flex items-center justify-between text-xs text-muted font-medium">
              <span>Активные бустеры канала ({activeBoosters.length}):</span>
              <span className="text-success font-semibold">Скидка активна</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              {activeBoosters.map((b: any) => {
                const u = b.user;
                const displayName = u ? maskUserIdentifier(u) : `ID: ${b.tgId}`;
                const expDate = new Date(b.expiresAt).toLocaleDateString("ru-RU");
                return (
                  <div key={b.id} className="p-2 bg-surface rounded border flex items-center justify-between shadow-xs">
                    <div className="truncate">
                      <span className="font-medium text-text">{displayName}</span>
                      <span className="text-[10px] text-muted block">ID буста: {b.boostId.slice(0, 8)}...</span>
                    </div>
                    <span className="text-[10px] text-success font-semibold shrink-0 ml-2">
                      до {expDate}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted p-2.5 bg-surface-2 rounded border">
            ℹ️ Активных бустов пока нет. Опубликуйте рекламу в канал ниже, чтобы привлечь первых бустеров!
          </div>
        )}
      </div>

      {/* Section 2: Ready-made Advertising Posts & Buttons */}
      <div className="card p-5 bg-surface border space-y-4 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">📢</span>
            <h2 className="text-base font-semibold">Готовые рекламные посты для привлечения бустов</h2>
            <span className="badge text-xs px-2 py-0.5 rounded-full bg-brand/15 text-brand border border-brand/30">
              В 1 клик
            </span>
          </div>
          <p className="text-xs text-muted mt-1">
            Выберите готовый рекламный пост, протестируйте его в личке Telegram или сразу опубликуйте в канал.
            К каждому посту автоматически прикрепляются кнопки «🚀 Забустить канал» и «🛍 Открыть магазин со скидкой».
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {adTemplates.map((tpl) => (
            <div key={tpl.id} className="border rounded-xl p-4 bg-surface-2 flex flex-col justify-between space-y-3">
              <div>
                <div className="flex items-center justify-between border-b pb-2 mb-2">
                  <span className="font-semibold text-xs text-text">{tpl.title}</span>
                  <span className="badge text-[10px] bg-surface border px-1.5 py-0.5 rounded text-muted">Шаблон</span>
                </div>

                {/* Post mockup preview */}
                <div className="rounded-lg p-3 bg-[#182533] text-[#e4e4e4] text-[11px] leading-relaxed whitespace-pre-wrap font-sans border border-[#2b3c4f] max-h-48 overflow-y-auto">
                  <div dangerouslySetInnerHTML={{ __html: tpl.text.replace(/\n/g, "<br/>") }} />
                </div>

                {/* Mockup buttons */}
                <div className="mt-2 space-y-1">
                  <div className="bg-[#3390ec] text-white text-[11px] py-1.5 px-2 rounded text-center font-medium shadow-xs">
                    {tpl.buttonText} ↗
                  </div>
                  <div className="bg-[#242f3d] text-[#8ecaff] text-[10px] py-1 px-2 rounded text-center border border-[#374b61]">
                    {tpl.storeButtonText} ↗
                  </div>
                </div>
              </div>

              {/* Action buttons for template */}
              <div className="pt-2 border-t space-y-2">
                <form action={publishBoosterAdAction}>
                  <input type="hidden" name="adText" value={tpl.text} />
                  <input type="hidden" name="channelTarget" value={channelTarget} />
                  <button
                    type="submit"
                    className="btn btn-sm btn-primary w-full text-xs font-semibold flex items-center justify-center gap-1"
                    title="Опубликовать этот рекламный пост в канал с кнопками"
                  >
                    📢 Опубликовать в канал
                  </button>
                </form>

                <form action={sendTestBoosterAdAction}>
                  <input type="hidden" name="adText" value={tpl.text} />
                  <input type="hidden" name="channelTarget" value={channelTarget} />
                  <button
                    type="submit"
                    className="btn btn-sm btn-ghost w-full text-xs border flex items-center justify-center gap-1 hover:bg-surface-1"
                    title="Отправить точную копию рекламы с кнопками админу в Telegram"
                  >
                    🧪 Тест мне в Telegram
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Section 3: Per-Product/Variant Booster Pricing Configuration */}
      <div className="card p-5 bg-surface border space-y-4 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">🏷</span>
            <h2 className="text-base font-semibold">Настройка цен бустеров по товарам (Процент или точная цена)</h2>
          </div>
          <p className="text-xs text-muted mt-1">
            Вы можете включить или отключить скидку бустера для каждого товара индивидуально, а также выбрать: процент скидки или конкретную фиксированную цену.
          </p>
        </div>

        <div className="overflow-x-auto border rounded-xl">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-surface-2 text-muted text-left">
                <th className="py-2.5 px-3">Товар и тариф</th>
                <th className="py-2.5 px-3">Обычная цена</th>
                <th className="py-2.5 px-3">Скидка бустера</th>
                <th className="py-2.5 px-3">Режим цены</th>
                <th className="py-2.5 px-3">Значение</th>
                <th className="py-2.5 px-3">Итого для бустера</th>
                <th className="py-2.5 px-3 text-right">Действие</th>
              </tr>
            </thead>
            <tbody>
              {allVariants.map((v) => {
                const isEnabled = (v as any).boostDiscountEnabled ?? true;
                const customPercent = (v as any).boostDiscountPercent;
                const fixedPrice = (v as any).boostPriceUzs;

                const boosterRes = calculateVariantBoosterPrice({
                  basePriceUzs: v.priceUzs,
                  boostDiscountEnabled: isEnabled,
                  boostDiscountPercent: customPercent,
                  boostPriceUzs: fixedPrice,
                  globalPercent: boostDiscountPercent,
                });

                const currentMode = fixedPrice && fixedPrice > 0 ? "price" : "percent";
                const currentValue = fixedPrice && fixedPrice > 0 ? fixedPrice : customPercent || boostDiscountPercent;

                return (
                  <tr key={v.id} className="border-b/50 hover:bg-surface-2/40 transition">
                    <td className="py-2.5 px-3 font-medium">
                      <div>{v.productTitle}</div>
                      <div className="text-[11px] text-muted">{v.titleRu}</div>
                    </td>
                    <td className="py-2.5 px-3 font-semibold text-muted">
                      {money(v.priceUzs)}
                    </td>

                    <td colSpan={5} className="py-1 px-3">
                      <form action={updateVariantBoostPricingAction} className="flex items-center gap-2 justify-between">
                        <input type="hidden" name="variantId" value={v.id} />

                        {/* On / Off switch */}
                        <label className="flex items-center gap-1.5 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            name="boostDiscountEnabled"
                            defaultChecked={isEnabled}
                            className="checkbox checkbox-xs"
                          />
                          <span className={isEnabled ? "text-success font-medium text-[11px]" : "text-muted text-[11px]"}>
                            {isEnabled ? "Включено" : "Отключено"}
                          </span>
                        </label>

                        {/* Pricing Mode: Percent vs Fixed Price */}
                        <select
                          name="pricingMode"
                          defaultValue={currentMode}
                          className="input py-1 px-2 text-[11px] w-36"
                        >
                          <option value="percent">Процент (%)</option>
                          <option value="price">Фикс. цена (сум)</option>
                        </select>

                        {/* Value Input */}
                        <div className="relative w-28">
                          <input
                            type="number"
                            name="pricingValue"
                            defaultValue={currentValue}
                            min="0"
                            className="input py-1 px-2 text-[11px] w-full font-semibold"
                          />
                        </div>

                        {/* Calculated Result Badge */}
                        <div className="w-40 truncate">
                          {isEnabled ? (
                            <span className="badge bg-brand/15 text-brand border border-brand/30 px-2 py-0.5 rounded text-[11px] font-semibold">
                              {money(boosterRes.price)} ({boosterRes.label || `-${boosterRes.discountPercent}%`})
                            </span>
                          ) : (
                            <span className="text-muted text-[11px]">— обычная цена</span>
                          )}
                        </div>

                        {/* Save Button */}
                        <button type="submit" className="btn btn-sm btn-ghost border text-[11px] hover:bg-surface-1">
                          💾 Сохранить
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

      {/* Section 4: Giveaways list and creation */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left: Giveaways list */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Список розыгрышей и конкурсов</h2>
            <span className="text-xs text-muted">Всего: {giveaways.length}</span>
          </div>

          {giveaways.length === 0 ? (
            <EmptyState>Розыгрыши пока не созданы. Заполните форму справа для запуска первого конкурса.</EmptyState>
          ) : (
            <div className="space-y-6">
              {giveaways.map((gw) => {
                const p = gw.variant.plan.product;
                const v = gw.variant;
                const eligibleCount = gw.participants.filter((pt) => pt.isEligible).length;
                const countdown = formatGiveawayCountdown(gw.endsAt);

                return (
                  <div key={gw.id} className="card p-5 space-y-4 bg-surface border shadow-sm">
                    {/* Header */}
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-base">{gw.title}</span>
                          <span
                            className={`badge text-xs px-2 py-0.5 rounded-full font-medium ${
                              gw.status === "active"
                                ? "bg-success/15 text-success border border-success/30"
                                : gw.status === "completed"
                                ? "bg-brand/15 text-brand border border-brand/30"
                                : "bg-muted/15 text-muted border border-muted/30"
                            }`}
                          >
                            {gw.status === "active"
                              ? "🟢 Активен"
                              : gw.status === "completed"
                              ? "🏁 Завершён"
                              : gw.status === "cancelled"
                              ? "❌ Отменён"
                              : "📝 Черновик"}
                          </span>
                        </div>
                        <div className="text-xs text-muted mt-1">
                          Товар: <span className="text-text font-medium">{p.titleRu} — {v.titleRu}</span>
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="text-sm font-semibold">
                          {gw.prizeType === "free" || gw.discountPriceUzs === 0 ? (
                            <span className="text-success font-bold">Бесплатно (0 сум)</span>
                          ) : (
                            <span>{money(gw.discountPriceUzs)} <s className="text-xs text-muted">{money(v.priceUzs)}</s></span>
                          )}
                        </div>
                        <div className="text-xs text-muted">Победителей: {gw.winnersCount} чел.</div>
                      </div>
                    </div>

                    {/* Countdown / End time banner */}
                    <div className="flex items-center gap-2 p-2.5 bg-brand/5 border border-brand/20 rounded-lg text-xs">
                      <span className="text-base">⏳</span>
                      <div className="flex-1">
                        <span dangerouslySetInnerHTML={{ __html: countdown }} />
                        {gw.endsAt && (
                          <span className="text-[10px] text-muted block">
                            При наступлении даты бот автоматически проведёт розыгрыш среди выполнивших условия участников.
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Metadata strip */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs p-3 bg-surface-2 rounded-lg">
                      <div>
                        <span className="text-muted block">Участников:</span>
                        <span className="font-semibold text-text">{gw.participants.length}</span> (готовы: {eligibleCount})
                      </div>
                      <div>
                        <span className="text-muted block">Срок покупки:</span>
                        <span className="font-semibold text-text">{gw.claimHours} ч.</span>
                      </div>
                      <div>
                        <span className="text-muted block">Канал:</span>
                        <span className="font-semibold text-text truncate block">{gw.channelTarget || "Не указан"}</span>
                      </div>
                      <div>
                        <span className="text-muted block">Друзья / Подписки:</span>
                        <span className="font-semibold text-text">
                          {gw.reqFriends > 0 ? `+${gw.reqFriends} друзей` : "Без друзей"}
                          {gw.reqChannels ? ", каналы" : ""}
                        </span>
                      </div>
                    </div>

                    {/* Visual Telegram Post Mockup */}
                    <div className="space-y-1.5">
                      <div className="text-xs font-semibold text-muted flex items-center justify-between">
                        <span>📱 Как это выглядит в Telegram-канале:</span>
                        <span className="text-[10px] text-muted">Живой предпросмотр поста</span>
                      </div>
                      <div className="rounded-xl p-4 bg-[#182533] text-[#f5f5f5] shadow-inner space-y-3 max-w-lg border border-[#2b3c4f]">
                        {/* Channel title & author header */}
                        <div className="flex items-center gap-2 border-b border-[#2b3c4f] pb-2">
                          <div className="w-8 h-8 rounded-full bg-[#3390ec] flex items-center justify-center font-bold text-xs text-white">
                            📢
                          </div>
                          <div>
                            <div className="font-semibold text-xs text-[#ffffff]">
                              {gw.channelTarget ? gw.channelTarget : "Ваш Telegram-канал"}
                            </div>
                            <div className="text-[10px] text-[#829bb3]">Официальный анонс конкурса</div>
                          </div>
                        </div>

                        {/* Post body */}
                        <div
                          className="text-xs leading-relaxed whitespace-pre-wrap font-sans text-[#e4e4e4]"
                          dangerouslySetInnerHTML={{
                            __html: gw.postText.replace(/\n/g, "<br/>"),
                          }}
                        />

                        {/* Countdown inside post */}
                        {gw.endsAt && (
                          <div className="text-[11px] p-2 bg-[#202f42] rounded text-[#8ecaff] border border-[#2d4159]">
                            <span dangerouslySetInnerHTML={{ __html: countdown }} />
                          </div>
                        )}

                        {/* Inline button mockup */}
                        <div className="pt-1">
                          <div className="bg-[#3390ec] hover:bg-[#2b7ac9] text-white text-xs font-medium py-2 px-4 rounded-lg text-center flex items-center justify-center gap-2 cursor-pointer transition shadow">
                            <span>{gw.buttonText || "🎉 Участвовать"}</span>
                            <span className="text-[10px] opacity-75">↗</span>
                          </div>
                          <div className="text-center text-[10px] text-[#718da6] mt-1">
                            Ссылка в бот: <code>https://t.me/{botUsername}?start=gw_{gw.id}</code>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Participants Inspector Accordion */}
                    <details className="text-xs border rounded-lg p-3 bg-surface-1">
                      <summary className="cursor-pointer font-medium hover:text-text select-none flex items-center justify-between">
                        <span>👥 Список участников ({gw.participants.length} чел., допущены: {eligibleCount})</span>
                        <span className="text-muted text-[11px]">Развернуть список ▾</span>
                      </summary>
                      <div className="mt-3 space-y-2">
                        {gw.participants.length === 0 ? (
                          <div className="text-muted text-center py-2">Участников пока нет.</div>
                        ) : (
                          <div className="overflow-x-auto max-h-60 overflow-y-auto">
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="border-b text-muted text-left">
                                  <th className="py-1 px-1.5">#</th>
                                  <th className="py-1 px-1.5">Пользователь</th>
                                  <th className="py-1 px-1.5">TG ID</th>
                                  <th className="py-1 px-1.5">Дата входа</th>
                                  <th className="py-1 px-1.5">Друзья</th>
                                  <th className="py-1 px-1.5">Статус допуска</th>
                                </tr>
                              </thead>
                              <tbody>
                                {gw.participants.map((pt, idx) => (
                                  <tr key={pt.id} className="border-b/40 hover:bg-surface-2/50">
                                    <td className="py-1 px-1.5 text-muted">{idx + 1}</td>
                                    <td className="py-1 px-1.5 font-medium">{maskUserIdentifier(pt.user)}</td>
                                    <td className="py-1 px-1.5 font-mono text-muted">{pt.user.tgId}</td>
                                    <td className="py-1 px-1.5 text-muted">
                                      {new Date(pt.joinedAt).toLocaleDateString("ru-RU", {
                                        day: "2-digit",
                                        month: "2-digit",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </td>
                                    <td className="py-1 px-1.5">
                                      {pt.friendsCount} / {gw.reqFriends}
                                    </td>
                                    <td className="py-1 px-1.5">
                                      {pt.isEligible ? (
                                        <span className="badge bg-success/15 text-success border border-success/30 px-1.5 py-0.2 rounded text-[10px]">
                                          ✅ Допущен
                                        </span>
                                      ) : (
                                        <span className="badge bg-warning/15 text-warning border border-warning/30 px-1.5 py-0.2 rounded text-[10px]">
                                          ⏳ Нужно ещё {Math.max(0, gw.reqFriends - pt.friendsCount)}
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </details>

                    {/* Winners details if completed */}
                    {gw.winners.length > 0 && (
                      <div className="p-3 bg-brand/5 border border-brand/20 rounded-lg text-xs space-y-2">
                        <div className="font-semibold text-brand flex items-center justify-between">
                          <span>🏆 Победители розыгрыша ({gw.winners.length}):</span>
                          <span>{gw.drawnAt ? new Date(gw.drawnAt).toLocaleString("ru-RU") : ""}</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
                          {gw.winners.map((w, idx) => (
                            <div key={w.id} className="flex items-center justify-between p-1.5 bg-surface rounded border text-[11px]">
                              <span>{idx + 1}. {maskUserIdentifier(w.user)}</span>
                              <span className={w.isClaimed ? "text-success font-semibold" : "text-muted"}>
                                {w.isClaimed ? "Куплено ✅" : "Ожидает покупки"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Test buttons section */}
                    <div className="p-3 bg-surface-2 rounded-lg space-y-2 border">
                      <div className="text-xs font-semibold text-text flex items-center gap-1.5">
                        <span>🧪 Тестирование и предпросмотр в Telegram</span>
                        <span className="text-[10px] text-muted font-normal">(отправка в личные сообщения админу)</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <form action={sendTestGiveawayPostAction} className="flex items-center gap-2">
                          <input type="hidden" name="id" value={gw.id} />
                          <button
                            type="submit"
                            className="btn btn-sm btn-ghost text-xs border flex items-center gap-1.5 hover:bg-surface-1"
                            title="Отправить точную копию поста анонса с кнопкой в Telegram"
                          >
                            🧪 Отправить тест поста мне
                          </button>
                        </form>

                        <form action={sendTestGiveawayResultsAction} className="flex items-center gap-2">
                          <input type="hidden" name="id" value={gw.id} />
                          <button
                            type="submit"
                            className="btn btn-sm btn-ghost text-xs border flex items-center gap-1.5 hover:bg-surface-1"
                            title="Отправить тестовый пост с примером итогов и победителей в Telegram"
                          >
                            🧪 Тест итогов в Telegram
                          </button>
                        </form>
                      </div>
                    </div>

                    {/* Main action buttons */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
                      <div className="flex items-center gap-2">
                        {/* Publish button */}
                        {gw.channelTarget && gw.status !== "completed" && (
                          <form action={publishGiveawayAction}>
                            <input type="hidden" name="id" value={gw.id} />
                            <button
                              type="submit"
                              className="btn btn-sm btn-ghost flex items-center gap-1 text-xs border"
                              title="Опубликовать анонс розыгрыша в канал"
                            >
                              📢 {gw.postedMessageId ? "Переопубликовать в канал" : "Опубликовать в канал"}
                            </button>
                          </form>
                        )}

                        {/* Draw button */}
                        {gw.status !== "completed" && (
                          <form action={drawGiveawayAction}>
                            <input type="hidden" name="id" value={gw.id} />
                            <button
                              type="submit"
                              className="btn btn-sm btn-primary flex items-center gap-1 text-xs disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
                              disabled={eligibleCount === 0}
                              title={eligibleCount === 0 ? "Нет участников, выполнивших условия" : "Провести розыгрыш и выбрать победителей прямо сейчас"}
                            >
                              🎲 Подвести итоги сейчас ({eligibleCount} участников)
                            </button>
                          </form>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        {/* Toggle active / draft */}
                        {gw.status !== "completed" && (
                          <form action={toggleGiveawayAction}>
                            <input type="hidden" name="id" value={gw.id} />
                            <button type="submit" className="btn btn-sm btn-ghost text-xs border">
                              {gw.status === "active" ? "⏸ В черновик" : "▶️ Активировать"}
                            </button>
                          </form>
                        )}

                        {/* Delete button */}
                        <form action={deleteGiveawayAction}>
                          <input type="hidden" name="id" value={gw.id} />
                          <button
                            type="submit"
                            className="btn btn-sm btn-ghost text-danger hover:bg-danger/10 text-xs border border-danger/20"
                            title="Удалить розыгрыш"
                          >
                            🗑
                          </button>
                        </form>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Create giveaway form */}
        <div className="card p-5 bg-surface border space-y-4 lg:sticky lg:top-6 shadow-sm">
          <div>
            <h2 className="text-base font-semibold">Новый розыгрыш</h2>
            <p className="text-xs text-muted">Задайте условия, дату итогов, выберите товар и подготовьте текст для публикации.</p>
          </div>

          <form action={createGiveawayAction} className="space-y-3.5 text-xs">
            {/* Title */}
            <div>
              <label className="font-semibold block mb-1">Название конкурса (для админки)</label>
              <input
                type="text"
                name="title"
                required
                placeholder="например: Розыгрыш Gemini Pro 100 мест"
                className="input w-full"
              />
            </div>

            {/* Variant selector */}
            <div>
              <label className="font-semibold block mb-1">Товар / Тариф для розыгрыша</label>
              <select name="variantId" required className="input w-full">
                <option value="">-- Выберите тариф --</option>
                {variantOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Prize Type & Special Price */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="font-semibold block mb-1">Тип приза</label>
                <select name="prizeType" className="input w-full">
                  <option value="discount">Скидочная цена</option>
                  <option value="free">Бесплатно (0 сум)</option>
                </select>
              </div>
              <div>
                <label className="font-semibold block mb-1">Цена для победителя (сум)</label>
                <input
                  type="number"
                  name="discountPriceUzs"
                  defaultValue="10000"
                  min="0"
                  step="1000"
                  placeholder="0 для бесплатного"
                  className="input w-full"
                />
              </div>
            </div>

            {/* Winners count & claim duration */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="font-semibold block mb-1">Кол-во победителей</label>
                <input
                  type="number"
                  name="winnersCount"
                  defaultValue="100"
                  min="1"
                  required
                  className="input w-full"
                />
              </div>
              <div>
                <label className="font-semibold block mb-1">Срок на покупку (в часах)</label>
                <input
                  type="number"
                  name="claimHours"
                  defaultValue="24"
                  min="1"
                  required
                  className="input w-full"
                />
                <span className="text-[10px] text-muted">24 ч = 1 сутки, 48 ч = 2 суток</span>
              </div>
            </div>

            {/* End Date and Time (Countdown & Auto-draw) */}
            <div>
              <label className="font-semibold block mb-1">
                ⏳ Дата и время подведения итогов (автоматически)
              </label>
              <input
                type="datetime-local"
                name="endsAt"
                className="input w-full"
              />
              <span className="text-[10px] text-muted block mt-0.5">
                В указанное время бот автоматически выберет победителей и опубликует итоги.
              </span>
            </div>

            {/* Channel target */}
            <div>
              <label className="font-semibold block mb-1">Канал для публикации поста</label>
              <input
                type="text"
                name="channelTarget"
                placeholder="@mychannel или -100123456789"
                className="input w-full"
              />
              <span className="text-[10px] text-muted">Бот должен быть администратором этого канала с правом публикации.</span>
            </div>

            <div>
              <label className="font-semibold block mb-1">Ссылка для вступления в канал спонсора</label>
              <input type="url" name="extraChannelUrl" placeholder="https://t.me/+…" className="input w-full" />
              <span className="text-muted text-[10px]">Обязательна для закрытого канала, указанного числовым ID.</span>
            </div>

            {/* Post text */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-semibold">Текст поста для канала</label>
                <span className="text-[10px] text-muted">HTML + Premium Emoji</span>
              </div>
              <textarea
                name="postText"
                rows={5}
                required
                defaultValue={
                  "🔥 <b>МЕГА-РОЗЫГРЫШ ПОДПИСОК!</b>\n\nРазыгрываем 100 мест на <b>Gemini 1.5 Pro</b> со скидкой всего за <b>10 000 сум</b>!\n\n📌 <b>Условия участия:</b>\n1. Нажмите кнопку «🎉 Участвовать» ниже\n2. Подпишитесь на наш канал\n\nИтоги объявим в канале! 🚀"
                }
                className="input w-full font-mono text-xs leading-relaxed"
              />
              <div className="mt-1 p-2 bg-surface-2 rounded text-[10px] text-muted space-y-1">
                <div><b>Подсказка по Premium Emoji:</b> вставляйте тег:</div>
                <code>&lt;tg-emoji emoji-id=&quot;5368324170671202286&quot;&gt;🔥&lt;/tg-emoji&gt;</code>
                <div>Также поддерживаются теги <code>&lt;b&gt;</code>, <code>&lt;i&gt;</code>, <code>&lt;code&gt;</code>.</div>
              </div>
            </div>

            {/* Button text */}
            <div>
              <label className="font-semibold block mb-1">Текст инлайн-кнопки в канале</label>
              <input
                type="text"
                name="buttonText"
                defaultValue="🎉 Участвовать"
                className="input w-full"
              />
            </div>

            {/* Conditions */}
            <div className="pt-2 border-t space-y-2">
              <span className="font-semibold block">Условия участия</span>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" name="reqChannels" defaultChecked className="checkbox checkbox-xs" />
                <span>Обязательная подписка на каналы бота</span>
              </label>

              <div>
                <label className="text-muted block text-[11px] mb-0.5">Дополнительный канал спонсора (@channel или ID)</label>
                <input
                  type="text"
                  name="extraChannelId"
                  placeholder="@sponsor_channel"
                  className="input w-full"
                />
              </div>

              <div>
                <label className="text-muted block text-[11px] mb-0.5">Пригласить друзей для участия (реферальное задание)</label>
                <input
                  type="number"
                  name="reqFriends"
                  defaultValue="0"
                  min="0"
                  className="input w-full"
                />
                <span className="text-[10px] text-muted">0 = без приглашений, участие сразу после подписки.</span>
              </div>
            </div>

            <button type="submit" className="btn btn-primary w-full text-xs font-semibold py-2 mt-4">
              ✨ Создать розыгрыш
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
