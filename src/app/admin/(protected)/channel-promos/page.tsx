import React from "react";
import { prisma } from "@/lib/db";
import { PageHeader, StatCard } from "@/components/admin/ui";
import {
  LaunchPromoForm,
  ForceLaunchButton,
  CancelCampaignButton,
} from "./ClientComponents";
import { formatUzs } from "@/lib/domain/channel-promos";

export const dynamic = "force-dynamic";

export default async function ChannelPromosPage() {
  // 1. Fetch active products with variants
  const rawProducts = await prisma.product.findMany({
    where: { isActive: true },
    include: {
      plans: {
        where: { isActive: true },
        include: {
          variants: {
            where: { isActive: true },
            orderBy: { priceUzs: "asc" },
          },
        },
        orderBy: { sortOrder: "asc" },
      },
    },
    orderBy: { sortOrder: "asc" },
  });

  const products = rawProducts.map((p) => ({
    id: p.id,
    nameRu: p.titleRu,
    title: p.titleRu,
    variants: p.plans.flatMap((plan) =>
      plan.variants.map((v) => ({
        id: v.id,
        nameRu: plan.variants.length > 1 ? `${plan.titleRu} — ${v.titleRu}` : v.titleRu,
        name: plan.variants.length > 1 ? `${plan.titleRu} — ${v.titleRu}` : v.titleRu,
        priceUzs: v.priceUzs,
      }))
    ),
  }));

  // 2. Fetch current active or waiting campaign
  const activeCampaign = await prisma.channelPromoCampaign.findFirst({
    where: {
      state: { in: ["active", "waiting_reactions"] },
    },
    include: {
      variant: {
        include: {
          plan: {
            include: { product: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Fetch next variant info if configured
  let nextVariantInfo = null;
  if (activeCampaign?.nextVariantId) {
    nextVariantInfo = await prisma.variant.findUnique({
      where: { id: activeCampaign.nextVariantId },
      include: {
        plan: {
          include: { product: true },
        },
      },
    });
  }

  // 3. Fetch past campaigns
  const pastCampaigns = await prisma.channelPromoCampaign.findMany({
    include: {
      variant: {
        include: {
          plan: {
            include: { product: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  // Check channel configuration
  const customChan = await prisma.botSetting.findUnique({ where: { key: "promo_post_channel" } });
  const reqChan = await prisma.requiredChannel.findFirst({ where: { isActive: true } });
  const promoChannelId = (customChan?.valueRu || reqChan?.chatId || "").trim();

  return (
    <div className="space-y-6">
      <PageHeader
        title="⚡️ Акции в канале и реакции"
        subtitle="Интерактивные промо-посты: по окончании скидки пост не удаляется, а собирает реакции и автоматически открывает следующую скидку!"
      />

      {/* ACTIVE CAMPAIGN MONITOR */}
      {activeCampaign ? (
        <div className="card p-6 border-2 border-brand/40 bg-brand/5 relative overflow-hidden">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xl">
                  {activeCampaign.state === "active" ? "🔥" : "🎯"}
                </span>
                <span
                  className={`text-xs px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                    activeCampaign.state === "active"
                      ? "bg-danger text-white"
                      : "bg-warning text-black"
                  }`}
                >
                  {activeCampaign.state === "active"
                    ? "Акция идёт сейчас"
                    : "Ожидает реакций в канале"}
                </span>
              </div>
              <h2 className="text-xl font-bold text-text">
                {activeCampaign.variant.plan?.product?.titleRu || "Товар"} —{" "}
                {activeCampaign.variant.titleRu}
              </h2>
              <div className="text-sm text-muted mt-1">
                Цена по акции:{" "}
                <b className="text-success text-base">
                  {formatUzs(activeCampaign.promoPriceUzs)} сум
                </b>{" "}
                (было <s>{formatUzs(activeCampaign.originalPriceUzs)} сум</s>) • Истекает:{" "}
                {new Date(activeCampaign.expiresAt).toLocaleTimeString("ru-RU", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <ForceLaunchButton campaignId={activeCampaign.id} />
              <CancelCampaignButton campaignId={activeCampaign.id} />
            </div>
          </div>

          {/* Reaction Progress Bar */}
          <div className="mt-5 p-4 rounded-xl bg-surface border border-border/80">
            <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
              <span>
                Прогресс реакций в канале ({activeCampaign.targetEmoji}):
              </span>
              <span className="text-base font-bold text-brand">
                {activeCampaign.currentReactions} / {activeCampaign.targetReactions}{" "}
                {activeCampaign.targetEmoji}
              </span>
            </div>

            <div className="w-full bg-surface-2 h-3 rounded-full overflow-hidden border border-border/60">
              <div
                className="bg-brand h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round(
                      (activeCampaign.currentReactions / activeCampaign.targetReactions) * 100
                    )
                  )}%`,
                }}
              />
            </div>

            {nextVariantInfo && (
              <div className="text-xs text-muted mt-2 flex items-center justify-between">
                <span>
                  Следующая скидка на очереди:{" "}
                  <b>
                    {nextVariantInfo.plan?.product?.titleRu || "Товар"} —{" "}
                    {nextVariantInfo.titleRu}
                  </b>
                </span>
                {activeCampaign.nextPriceUzs && (
                  <span className="font-semibold text-text">
                    {formatUzs(activeCampaign.nextPriceUzs)} сум
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* LAUNCH NEW PROMO SECTION */}
      <div className="card p-6 space-y-4">
        <h2 className="text-lg font-bold">
          {activeCampaign ? "➕ Запланировать следующую акцию" : "🚀 Запуск новой акции"}
        </h2>
        <LaunchPromoForm
          products={products}
          channelConfigured={Boolean(promoChannelId)}
        />
      </div>

      {/* PAST CAMPAIGNS HISTORY */}
      <div className="space-y-4">
        <h3 className="text-base font-bold">История акций в канале</h3>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted text-xs">
                <th className="px-4 py-3">ID / Дата</th>
                <th className="px-4 py-3">Товар</th>
                <th className="px-4 py-3 text-right">Скидочная цена</th>
                <th className="px-4 py-3 text-center">Реакции</th>
                <th className="px-4 py-3 text-center">Статус</th>
                <th className="px-4 py-3">Следующий товар</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {pastCampaigns.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-muted">
                    История акций пока пуста.
                  </td>
                </tr>
              ) : (
                pastCampaigns.map((c) => (
                  <tr key={c.id} className="hover:bg-surface-2/40 transition">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-xs">#{c.id}</div>
                      <div className="text-[11px] text-muted">
                        {new Date(c.createdAt).toLocaleDateString("ru-RU", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-text">
                        {c.variant?.plan?.product?.titleRu || "Товар"}
                      </div>
                      <div className="text-xs text-muted">
                        {c.variant?.titleRu}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-success">
                      {formatUzs(c.promoPriceUzs)} сум
                    </td>
                    <td className="px-4 py-3 text-center font-bold">
                      {c.currentReactions} / {c.targetReactions} {c.targetEmoji}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`text-xs px-2 py-0.5 rounded font-semibold ${
                          c.state === "active"
                            ? "bg-danger/20 text-danger"
                            : c.state === "waiting_reactions"
                            ? "bg-warning/20 text-warning"
                            : c.state === "completed"
                            ? "bg-success/20 text-success"
                            : "bg-muted/20 text-muted"
                        }`}
                      >
                        {c.state === "active"
                          ? "Активна"
                          : c.state === "waiting_reactions"
                          ? "Ждет реакций"
                          : c.state === "completed"
                          ? "Завершена"
                          : "Отменена"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {c.nextVariantId ? `Вариант #${c.nextVariantId}` : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
