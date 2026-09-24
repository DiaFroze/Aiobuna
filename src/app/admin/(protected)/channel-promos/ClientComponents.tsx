"use client";

import React, { useState, useTransition } from "react";
import {
  launchChannelPromoAction,
  forceLaunchNextAction,
  cancelPromoCampaignAction,
} from "./actions";
import { ALLOWED_REACTION_EMOJIS, buildPromoTeaserText, formatUzs } from "@/lib/domain/channel-promos";

export function LaunchPromoForm({
  products,
  channelConfigured,
}: {
  products: any[];
  channelConfigured: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Flatten variants
  const allVariants: Array<{ id: number; label: string; priceUzs: number; productName: string }> = [];
  for (const p of products) {
    for (const v of p.variants) {
      allVariants.push({
        id: v.id,
        label: `${p.nameRu || p.title} — ${v.nameRu || v.name}`,
        priceUzs: v.priceUzs,
        productName: p.nameRu || p.title,
      });
    }
  }

  const [selectedVariantId, setSelectedVariantId] = useState<number>(allVariants[0]?.id || 0);
  const [promoPrice, setPromoPrice] = useState<string>("");
  const [hours, setHours] = useState<number>(2);

  // Reaction automation settings
  const [targetEmoji, setTargetEmoji] = useState<string>("🔥");
  const [targetReactions, setTargetReactions] = useState<number>(10);
  const [autoLaunchNext, setAutoLaunchNext] = useState<boolean>(true);

  // Next promo
  const [nextVariantId, setNextVariantId] = useState<number>(allVariants[1]?.id || allVariants[0]?.id || 0);
  const [nextPrice, setNextPrice] = useState<string>("");
  const [nextHours, setNextHours] = useState<number>(2);

  const currentVariant = allVariants.find((v) => v.id === selectedVariantId);
  const nextVariant = allVariants.find((v) => v.id === nextVariantId);

  const basePrice = currentVariant?.priceUzs || 0;
  const promoPriceNum = Number.parseInt(promoPrice, 10) || 0;
  const discountPct = basePrice > promoPriceNum && promoPriceNum > 0
    ? Math.round(((basePrice - promoPriceNum) / basePrice) * 100)
    : 0;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const formData = new FormData();
    formData.append("variantId", String(selectedVariantId));
    formData.append("promoPriceUzs", String(promoPriceNum));
    formData.append("hours", String(hours));
    formData.append("targetEmoji", targetEmoji);
    formData.append("targetReactions", String(targetReactions));
    formData.append("autoLaunchNext", String(autoLaunchNext));

    if (nextVariantId) formData.append("nextVariantId", String(nextVariantId));
    if (nextPrice) formData.append("nextPriceUzs", String(nextPrice));
    formData.append("nextHours", String(nextHours));

    startTransition(async () => {
      try {
        await launchChannelPromoAction(formData);
        alert("✅ Акция успешно запущена и опубликована в канал!");
      } catch (err: any) {
        setError(err.message || "Ошибка запуска акции");
      }
    });
  };

  // Preview of the teaser text
  const teaserPreview = buildPromoTeaserText({
    nextProductName: nextVariant?.label || "Следующий товар",
    nextPriceUzs: Number.parseInt(nextPrice, 10) || undefined,
    targetEmoji,
    targetCount: targetReactions,
  });

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="p-3 rounded bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      {!channelConfigured && (
        <div className="p-3 rounded bg-warning/10 border border-warning/30 text-warning text-xs">
          ⚠️ <b>Внимание:</b> Канал для акций не настроен (настройка <code>promo_post_channel</code> или Подписки бота). Акция запустится только внутри каталога бота.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Current Promo Setup */}
        <div className="card p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-border/60 pb-3">
            <span className="text-xl">1️⃣</span>
            <div>
              <div className="font-bold text-sm">Текущая акция со скидкой</div>
              <div className="text-xs text-muted">Какой товар со скидкой запускаем прямо сейчас</div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted mb-1">
              Выберите товар *
            </label>
            <select
              value={selectedVariantId}
              onChange={(e) => {
                const id = Number(e.target.value);
                setSelectedVariantId(id);
                const found = allVariants.find((v) => v.id === id);
                if (found) {
                  // Default suggested discount 30%
                  setPromoPrice(String(Math.round(found.priceUzs * 0.7)));
                }
              }}
              className="w-full input text-sm"
            >
              {allVariants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} — {formatUzs(v.priceUzs)} сум
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">
                Обычная цена
              </label>
              <input
                disabled
                value={`${formatUzs(basePrice)} сум`}
                className="w-full input text-sm bg-surface-2 text-muted"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">
                Акционная цена (сум) *
              </label>
              <input
                type="number"
                required
                step="1000"
                min="1000"
                value={promoPrice}
                onChange={(e) => setPromoPrice(e.target.value)}
                placeholder="Скидочная цена"
                className="w-full input text-sm font-semibold text-success"
              />
            </div>
          </div>

          {discountPct > 0 && (
            <div className="p-2.5 rounded-lg bg-success/10 border border-success/30 flex items-center justify-between text-xs text-success font-semibold">
              <span>Скидка для покупателей:</span>
              <span className="text-sm font-bold">−{discountPct}%</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-muted mb-1">
              Длительность акции
            </label>
            <div className="grid grid-cols-4 gap-2">
              {[2, 4, 12, 24].map((h) => (
                <button
                  type="button"
                  key={h}
                  onClick={() => setHours(h)}
                  className={`py-1.5 px-2 rounded-lg text-xs font-medium border transition ${
                    hours === h
                      ? "bg-brand text-brand-fg border-brand font-semibold"
                      : "bg-surface border-border text-muted hover:text-text"
                  }`}
                >
                  {h} часа
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Reaction Automation & Next Promo */}
        <div className="card p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-border/60 pb-3">
            <span className="text-xl">2️⃣</span>
            <div>
              <div className="font-bold text-sm">Интерактивные реакции в канале</div>
              <div className="text-xs text-muted">
                Вместо удаления пост превратится в тизер, собирающий реакции подписчиков
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted mb-1">
              Эмодзи для реакции:
            </label>
            <div className="flex items-center gap-1.5 flex-wrap">
              {ALLOWED_REACTION_EMOJIS.map((emoji) => (
                <button
                  type="button"
                  key={emoji}
                  onClick={() => setTargetEmoji(emoji)}
                  className={`h-9 w-9 rounded-lg text-lg flex items-center justify-center border transition ${
                    targetEmoji === emoji
                      ? "bg-brand/20 border-brand scale-110 shadow-sm"
                      : "bg-surface border-border/60 hover:bg-surface-2"
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted mb-1">
              Целевое количество реакций для запуска следующей акции:
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                max="1000"
                value={targetReactions}
                onChange={(e) => setTargetReactions(Math.max(1, Number(e.target.value)))}
                className="w-28 input text-sm font-bold text-center"
              />
              <span className="text-xs text-muted">
                реакций {targetEmoji} требуется набрать в канале
              </span>
            </div>
          </div>

          <div className="p-3 bg-surface-2/60 rounded-lg space-y-3 border border-border/60">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-text">
                🚀 Автоматически запустить следующую акцию при наборе реакций
              </div>
              <input
                type="checkbox"
                checked={autoLaunchNext}
                onChange={(e) => setAutoLaunchNext(e.target.checked)}
                className="h-4 w-4 rounded text-brand focus:ring-brand"
              />
            </div>

            {autoLaunchNext && (
              <div className="space-y-3 pt-2 border-t border-border/60">
                <div>
                  <label className="block text-[11px] font-semibold text-muted mb-1">
                    Следующий товар для акции:
                  </label>
                  <select
                    value={nextVariantId}
                    onChange={(e) => {
                      const id = Number(e.target.value);
                      setNextVariantId(id);
                      const f = allVariants.find((v) => v.id === id);
                      if (f) setNextPrice(String(Math.round(f.priceUzs * 0.75)));
                    }}
                    className="w-full input text-xs"
                  >
                    {allVariants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label} ({formatUzs(v.priceUzs)} сум)
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-semibold text-muted mb-1">
                      Цена следующей акции (сум):
                    </label>
                    <input
                      type="number"
                      step="1000"
                      value={nextPrice}
                      onChange={(e) => setNextPrice(e.target.value)}
                      placeholder="Цена"
                      className="w-full input text-xs font-semibold"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-muted mb-1">
                      Длительность (часов):
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={nextHours}
                      onChange={(e) => setNextHours(Math.max(1, Number(e.target.value)))}
                      className="w-full input text-xs"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Live Preview Card */}
      <div className="card p-4 bg-surface-2/40 border border-border/60">
        <div className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
          👀 Превью тизера, в который отредактируется пост по окончании акции:
        </div>
        <div
          className="text-xs p-3 rounded bg-surface border border-border/60 whitespace-pre-line text-text"
          dangerouslySetInnerHTML={{ __html: teaserPreview }}
        />
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isPending || !promoPriceNum}
          className="btn-primary py-2.5 px-6 text-sm font-semibold flex items-center gap-2"
        >
          {isPending ? "Публикация..." : "🚀 Опубликовать и запустить акцию"}
        </button>
      </div>
    </form>
  );
}

export function ForceLaunchButton({ campaignId }: { campaignId: number }) {
  const [isPending, startTransition] = useTransition();

  const handleForce = () => {
    if (!confirm("Запустить следующую акцию досрочно прямо сейчас?")) return;
    const formData = new FormData();
    formData.append("campaignId", String(campaignId));
    startTransition(async () => {
      try {
        await forceLaunchNextAction(formData);
        alert("✅ Следующая акция успешно запущена!");
      } catch (e: any) {
        alert("Ошибка: " + e.message);
      }
    });
  };

  return (
    <button
      onClick={handleForce}
      disabled={isPending}
      className="btn-primary text-xs py-1.5 px-3 bg-brand text-brand-fg font-semibold"
    >
      {isPending ? "Запуск..." : "🚀 Запустить сейчас"}
    </button>
  );
}

export function CancelCampaignButton({ campaignId }: { campaignId: number }) {
  const [isPending, startTransition] = useTransition();

  const handleCancel = () => {
    if (!confirm("Вы уверены, что хотите отменить эту акцию и вернуть цены?")) return;
    const formData = new FormData();
    formData.append("campaignId", String(campaignId));
    startTransition(async () => {
      try {
        await cancelPromoCampaignAction(formData);
      } catch (e: any) {
        alert("Ошибка: " + e.message);
      }
    });
  };

  return (
    <button
      onClick={handleCancel}
      disabled={isPending}
      className="btn-ghost text-xs py-1 px-2 text-danger hover:bg-danger/10"
    >
      {isPending ? "Отмена..." : "🛑 Остановить"}
    </button>
  );
}
