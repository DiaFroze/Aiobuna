import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState, StatCard } from "@/components/admin/ui";
import {
  createGiveawayAction,
  toggleGiveawayAction,
  publishGiveawayAction,
  drawGiveawayAction,
  deleteGiveawayAction,
} from "./actions";
import { maskUserIdentifier } from "@/lib/domain/giveaways";

const ERROR_MESSAGES: Record<string, string> = {
  missing: "Заполните название, товар и текст поста.",
  invalid: "Проверьте целые числа, длину текста и ссылку на закрытый канал.",
  novariant: "Выбранный тариф не найден.",
  nochannel: "Укажите канал и текст публикации.",
  nobottoken: "Не настроен токен Telegram-бота.",
  alreadydrawn: "Итоги уже подведены. Создайте новый розыгрыш.",
  noparticipants: "Нет участников, выполнивших условия.",
  notfound: "Розыгрыш не найден.",
  publishexception: "Не удалось опубликовать пост. Проверьте права бота в канале.",
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
        <PageHeader title="Розыгрыши и конкурсы" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || "Aiobunabot";

  const [products, giveaways, totalWinnersCount] = await Promise.all([
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

  const activeCount = giveaways.filter((g) => g.status === "active").length;
  const completedCount = giveaways.filter((g) => g.status === "completed").length;
  const totalParticipants = giveaways.reduce((acc, g) => acc + g.participants.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="🎉 Розыгрыши и конкурсы"
        subtitle="Проведение розыгрышей товаров со скидкой или бесплатно, публикация постов в Telegram-канал с премиум-эмодзи. Победители выбираются случайно по кнопке «Подвести итоги»."
      />

      {searchParams.ok === "created" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          ✅ Розыгрыш успешно создан! Вы можете опубликовать его в канал.
        </div>
      )}
      {searchParams.ok === "published" && (
        <div className="card p-3 border-success/30 bg-success/5 text-success text-sm">
          📢 Пост с кнопкой «Участвовать» успешно отправлен в канал! Розыгрыш переведён в статус «Активен».
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

      {searchParams.warning === "notifyfailed" && (
        <div className="card p-3 border-warning/30 text-sm" role="alert">
          Победители сохранены, но часть уведомлений Telegram не отправлена. Проверьте права бота в канале.
          Победители могут открыть исходную ссылку розыгрыша в боте и забрать приз.
        </div>
      )}
      {searchParams.error && (
        <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">
          ⚠️ Ошибка: {ERROR_MESSAGES[searchParams.error] ?? searchParams.error}
        </div>
      )}

      {/* Top statistics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Всего конкурсов" value={String(giveaways.length)} />
        <StatCard label="Активных" value={String(activeCount)} />
        <StatCard label="Завершённых" value={String(completedCount)} />
        <StatCard label="Всего победителей" value={String(totalWinnersCount)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left: Giveaways list */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Список розыгрышей</h2>
            <span className="text-xs text-muted">Всего: {giveaways.length}</span>
          </div>

          {giveaways.length === 0 ? (
            <EmptyState>Розыгрыши пока не созданы. Заполните форму справа для запуска первого конкурса.</EmptyState>
          ) : (
            <div className="space-y-4">
              {giveaways.map((gw) => {
                const p = gw.variant.plan.product;
                const v = gw.variant;
                const eligibleCount = gw.participants.filter((pt) => pt.isEligible).length;

                return (
                  <div key={gw.id} className="card p-5 space-y-4 bg-surface border">
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

                    {/* Channel post preview snippet */}
                    <details className="text-xs text-muted border rounded p-2.5 bg-surface-1">
                      <summary className="cursor-pointer font-medium hover:text-text select-none">
                        👁 Текст поста для канала (нажмите для просмотра)
                      </summary>
                      <div className="mt-2 font-mono whitespace-pre-wrap bg-surface-2 p-2 rounded text-text text-[11px] max-h-40 overflow-y-auto">
                        {gw.postText}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[11px]">
                        <span>Кнопка: <b>{gw.buttonText}</b></span>
                        <span>Ссылка: <code>https://t.me/{botUsername}?start=gw_{gw.id}</code></span>
                      </div>
                    </details>

                    {/* Winners details if completed */}
                    {gw.winners.length > 0 && (
                      <div className="p-3 bg-brand/5 border border-brand/20 rounded-lg text-xs space-y-2">
                        <div className="font-semibold text-brand flex items-center justify-between">
                          <span>🏆 Победители розыгрыша ({gw.winners.length}):</span>
                          <span>{gw.drawnAt ? new Date(gw.drawnAt).toLocaleString("ru-RU") : ""}</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-36 overflow-y-auto">
                          {gw.winners.map((w, idx) => (
                            <div key={w.id} className="flex items-center justify-between p-1 bg-surface rounded border text-[11px]">
                              <span>{idx + 1}. {maskUserIdentifier(w.user)}</span>
                              <span className={w.isClaimed ? "text-success font-semibold" : "text-muted"}>
                                {w.isClaimed ? "Куплено ✅" : "Ожидает"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
                      <div className="flex items-center gap-2">
                        {/* Publish button */}
                        {gw.channelTarget && gw.status !== "completed" && (
                          <form action={publishGiveawayAction}>
                            <input type="hidden" name="id" value={gw.id} />
                            <button
                              type="submit"
                              className="btn-ghost flex items-center gap-1 text-xs"
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
                              title={eligibleCount === 0 ? "Нет участников, выполнивших условия" : "Провести розыгрыш и выбрать победителей"}
                            >
                              🎲 Подвести итоги ({eligibleCount} участников)
                            </button>
                          </form>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        {/* Toggle active / draft */}
                        {gw.status !== "completed" && (
                          <form action={toggleGiveawayAction}>
                            <input type="hidden" name="id" value={gw.id} />
                            <button type="submit" className="btn btn-sm btn-ghost text-xs">
                              {gw.status === "active" ? "⏸ В черновик" : "▶️ Активировать"}
                            </button>
                          </form>
                        )}

                        {/* Delete button */}
                        <form action={deleteGiveawayAction}>
                          <input type="hidden" name="id" value={gw.id} />
                          <button
                            type="submit"
                            className="btn btn-sm btn-ghost text-danger hover:bg-danger/10 text-xs"
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
        <div className="card p-5 bg-surface border space-y-4 lg:sticky lg:top-6">
          <div>
            <h2 className="text-base font-semibold">Новый розыгрыш</h2>
            <p className="text-xs text-muted">Задайте условия, выберите товар и подготовьте текст для публикации.</p>
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
              <input type="url" name="extraChannelUrl" placeholder="https://t.me/+…" className="input" />
              <span className="text-muted">Обязательна для закрытого канала, указанного числовым ID.</span>
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
