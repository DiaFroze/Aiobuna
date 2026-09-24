import React from "react";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, StatCard, EmptyState } from "@/components/admin/ui";
import {
  AddCreatorButton,
  CreatorActionButtons,
  PayoutRowActions,
  CopyButton,
} from "./ClientComponents";

export const dynamic = "force-dynamic";

function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "0 UZS";
  return `${Math.round(v).toLocaleString("ru-RU")} UZS`;
}

export default async function CreatorsPage({
  searchParams,
}: {
  searchParams: {
    tab?: string;
    payoutStatus?: string;
    q?: string;
  };
}) {
  const currentTab = searchParams.tab || "leaderboard";
  const payoutFilter = searchParams.payoutStatus || "all";
  const searchQuery = (searchParams.q || "").trim().toLowerCase();

  // 1. Fetch creators with relations
  const creators = await prisma.creator.findMany({
    orderBy: { totalEarnedUzs: "desc" },
    include: {
      productRates: true,
      _count: {
        select: {
          referredUsers: true,
          orderRewards: true,
        },
      },
      orderRewards: {
        select: {
          amountUzs: true,
          orderTotalUzs: true,
        },
      },
    },
  });

  // 2. Fetch products & variants for rate matrix modal
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
    titleRu: p.titleRu,
    variants: p.plans.flatMap((plan) =>
      plan.variants.map((v) => ({
        id: v.id,
        titleRu: plan.variants.length > 1 ? `${plan.titleRu} — ${v.titleRu}` : v.titleRu,
        priceUzs: v.priceUzs,
      }))
    ),
  }));

  // 3. Fetch payouts
  const payoutsWhere: any = {};
  if (payoutFilter !== "all") {
    payoutsWhere.status = payoutFilter;
  }

  const payouts = await prisma.creatorPayout.findMany({
    where: payoutsWhere,
    include: { creator: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  // 4. Fetch recent ledger logs
  const ledgerLogs = await prisma.creatorLedger.findMany({
    include: { creator: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Bot username setting
  const botSetting = await prisma.botSetting.findFirst({
    where: { key: "bot_username" },
  });
  const botUsername = botSetting?.valueRu || process.env.BOT_USERNAME || "Aiobuna_bot";

  // Aggregate global stats
  const totalCreators = creators.length;
  const activeCreators = creators.filter((c) => c.isActive).length;

  let totalSalesVolumeUzs = 0;
  let totalCommissionsEarnedUzs = 0;
  let totalPendingHoldUzs = 0;
  let totalPaidOutUzs = 0;

  for (const c of creators) {
    totalCommissionsEarnedUzs += c.totalEarnedUzs;
    totalPendingHoldUzs += c.holdBalanceUzs;
    totalPaidOutUzs += c.totalPaidUzs;
    for (const reward of c.orderRewards) {
      totalSalesVolumeUzs += reward.orderTotalUzs;
    }
  }

  // Filter creators for table
  const filteredCreators = creators.filter((c) => {
    if (!searchQuery) return true;
    return (
      c.name.toLowerCase().includes(searchQuery) ||
      c.code.toLowerCase().includes(searchQuery) ||
      (c.username && c.username.toLowerCase().includes(searchQuery))
    );
  });

  // Rank leaderboard
  const leaderboard = [...creators].sort((a, b) => b.totalEarnedUzs - a.totalEarnedUzs);

  return (
    <div className="space-y-6">
      <PageHeader
        title="🎬 Медиа-команда / Креаторы"
        subtitle="Партнёрская платформа для блогеров и медиа: индивидуальные ставки по товарам, лидерборд и выплаты"
        action={<AddCreatorButton products={products} />}
      />

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard
          label="Всего креаторов"
          value={`${activeCreators} / ${totalCreators}`}
          hint="Активных партнёров"
        />
        <StatCard
          label="Оборот от медиа"
          value={money(totalSalesVolumeUzs)}
          hint="Продажи по реф-ссылкам"
          tone="success"
        />
        <StatCard
          label="Заработано креаторами"
          value={money(totalCommissionsEarnedUzs)}
          hint="Сумма всех начислений"
        />
        <StatCard
          label="Ожидает вывода"
          value={money(totalPendingHoldUzs)}
          hint="Регламент: до 23:00"
          tone={totalPendingHoldUzs > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Всего выплачено"
          value={money(totalPaidOutUzs)}
          hint="Успешно переведено"
        />
      </div>

      {/* Navigation tabs */}
      <div className="flex border-b border-border gap-6 text-sm font-medium">
        <Link
          href="/admin/creators?tab=leaderboard"
          className={`pb-3 ${
            currentTab === "leaderboard"
              ? "border-b-2 border-brand text-brand font-semibold"
              : "text-muted hover:text-text"
          }`}
        >
          🏆 Лидерборд ТОП-креаторов
        </Link>
        <Link
          href="/admin/creators?tab=list"
          className={`pb-3 ${
            currentTab === "list"
              ? "border-b-2 border-brand text-brand font-semibold"
              : "text-muted hover:text-text"
          }`}
        >
          👥 Список и ставки по товарам ({creators.length})
        </Link>
        <Link
          href="/admin/creators?tab=payouts"
          className={`pb-3 relative ${
            currentTab === "payouts"
              ? "border-b-2 border-brand text-brand font-semibold"
              : "text-muted hover:text-text"
          }`}
        >
          💳 Заявки на вывод средств
          {totalPendingHoldUzs > 0 && (
            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-warning/20 text-warning">
              {payouts.filter((p) => p.status === "pending").length}
            </span>
          )}
        </Link>
        <Link
          href="/admin/creators?tab=ledger"
          className={`pb-3 ${
            currentTab === "ledger"
              ? "border-b-2 border-brand text-brand font-semibold"
              : "text-muted hover:text-text"
          }`}
        >
          📒 Журнал проводок (Ledger)
        </Link>
      </div>

      {/* TAB 1: LEADERBOARD */}
      {currentTab === "leaderboard" && (
        <div className="space-y-4">
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted text-xs">
                  <th className="px-4 py-3">Место</th>
                  <th className="px-4 py-3">Креатор / Медийка</th>
                  <th className="px-4 py-3">Код ссылки</th>
                  <th className="px-4 py-3 text-right">Покупатели</th>
                  <th className="px-4 py-3 text-right">Заказов</th>
                  <th className="px-4 py-3 text-right">Общий оборот</th>
                  <th className="px-4 py-3 text-right">Заработано</th>
                  <th className="px-4 py-3 text-right">Баланс к выводу</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {leaderboard.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-muted">
                      Пока нет зарегистрированных креаторов. Нажмите «+ Добавить креатора».
                    </td>
                  </tr>
                ) : (
                  leaderboard.map((c, idx) => {
                    const badge =
                      idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `#${idx + 1}`;
                    const salesTotal = c.orderRewards.reduce((acc, r) => acc + r.orderTotalUzs, 0);

                    return (
                      <tr key={c.id} className="hover:bg-surface-2/40 transition">
                        <td className="px-4 py-3 font-bold text-base">{badge}</td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-text">{c.name}</div>
                          <div className="text-xs text-muted">
                            {c.username ? `@${c.username}` : c.phone || "Без контакта"}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-brand">
                          c_{c.code}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          {c._count.referredUsers}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          {c._count.orderRewards}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-text">
                          {money(salesTotal)}
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-success">
                          {money(c.totalEarnedUzs)}
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-text">
                          {money(c.balanceUzs)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: CREATORS LIST & RATE MATRIX */}
      {currentTab === "list" && (
        <div className="space-y-4">
          <div className="card p-3">
            <div className="text-xs text-muted">
              💡 <b>Как работают ставки:</b> Вы можете задать общую ставку по умолчанию для креатора (например, 10 000 сум) и переопределить её для конкретных товаров (Gemini → 10k, ChatGPT → 25k, Canva → 5k) кнопкой «⚙️ Ставки».
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted text-xs">
                  <th className="px-4 py-3">Креатор</th>
                  <th className="px-4 py-3">Ссылка / Код</th>
                  <th className="px-4 py-3 text-right">Ставка по умолч.</th>
                  <th className="px-4 py-3 text-right">Спец-ставки</th>
                  <th className="px-4 py-3 text-right">Доступный баланс</th>
                  <th className="px-4 py-3 text-right">В холде</th>
                  <th className="px-4 py-3 text-center">Статус</th>
                  <th className="px-4 py-3 text-right">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filteredCreators.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-muted">
                      Креаторы не найдены.
                    </td>
                  </tr>
                ) : (
                  filteredCreators.map((c) => (
                    <tr key={c.id} className="hover:bg-surface-2/40 transition">
                      <td className="px-4 py-3">
                        <div className="font-semibold">{c.name}</div>
                        <div className="text-xs text-muted">
                          {c.username ? `@${c.username}` : ""} {c.tgId ? `(ID: ${c.tgId})` : ""}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <code className="text-xs font-mono bg-surface-2 px-1.5 py-0.5 rounded">
                          c_{c.code}
                        </code>
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {money(c.defaultRateUzs)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-surface-2 text-text">
                          {c.productRates.length} товаров
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-success">
                        {money(c.balanceUzs)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-warning">
                        {money(c.holdBalanceUzs)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`text-xs px-2 py-0.5 rounded font-semibold ${
                            c.isActive
                              ? "bg-success/10 text-success"
                              : "bg-muted/20 text-muted"
                          }`}
                        >
                          {c.isActive ? "Активен" : "Отключен"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <CreatorActionButtons
                          creator={c}
                          botUsername={botUsername}
                          products={products}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: PAYOUTS QUEUE */}
      {currentTab === "payouts" && (
        <div className="space-y-4">
          <div className="card p-4 bg-surface-2/40 border border-brand/20 flex items-center justify-between gap-4">
            <div>
              <div className="font-semibold text-sm">⚡️ Регламент выплат: ежедневно до 23:00</div>
              <div className="text-xs text-muted mt-0.5">
                Креаторы запрашивают вывод в боте (/creator). Скопируйте номер карты Humo/Uzcard и сумму, сделайте перевод через банковское приложение и подтвердите заявку.
              </div>
            </div>
            <div className="flex gap-1.5">
              {["all", "pending", "paid", "rejected"].map((s) => (
                <Link
                  key={s}
                  href={`/admin/creators?tab=payouts&payoutStatus=${s}`}
                  className={`text-xs px-3 py-1.5 rounded-lg font-medium transition ${
                    payoutFilter === s
                      ? "bg-brand text-brand-fg"
                      : "bg-surface border border-border text-muted hover:text-text"
                  }`}
                >
                  {s === "all"
                    ? "Все"
                    : s === "pending"
                    ? "Ожидают"
                    : s === "paid"
                    ? "Выплачено"
                    : "Отклонено"}
                </Link>
              ))}
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted text-xs">
                  <th className="px-4 py-3">ID / Дата</th>
                  <th className="px-4 py-3">Креатор</th>
                  <th className="px-4 py-3">Сумма к выплате</th>
                  <th className="px-4 py-3">Карта Humo / Uzcard</th>
                  <th className="px-4 py-3">Получатель</th>
                  <th className="px-4 py-3 text-center">Статус</th>
                  <th className="px-4 py-3 text-right">Действие</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {payouts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-muted">
                      Заявок на вывод не найдено.
                    </td>
                  </tr>
                ) : (
                  payouts.map((p) => {
                    const statusBadge =
                      p.status === "pending" ? (
                        <span className="text-xs px-2 py-0.5 rounded font-semibold bg-warning/20 text-warning">
                          ⏳ Ожидает
                        </span>
                      ) : p.status === "paid" ? (
                        <span className="text-xs px-2 py-0.5 rounded font-semibold bg-success/20 text-success">
                          ✅ Выплачено
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded font-semibold bg-danger/20 text-danger">
                          ❌ Отклонено
                        </span>
                      );

                    return (
                      <tr key={p.id} className="hover:bg-surface-2/40 transition">
                        <td className="px-4 py-3">
                          <div className="font-semibold">#{p.id}</div>
                          <div className="text-[11px] text-muted">
                            {new Date(p.createdAt).toLocaleDateString("ru-RU", {
                              day: "2-digit",
                              month: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-text">{p.creator.name}</div>
                          <div className="text-xs font-mono text-muted">c_{p.creator.code}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-success text-base">
                              {money(p.amountUzs)}
                            </span>
                            <CopyButton
                              text={String(p.amountUzs)}
                              label="Сумма"
                              className="btn-ghost text-[10px] py-0.5 px-1.5"
                            />
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <code className="font-mono text-sm bg-surface-2 px-2 py-1 rounded border border-border/60">
                              {p.cardNumber.replace(/(\d{4})/g, "$1 ").trim()}
                            </code>
                            <CopyButton
                              text={p.cardNumber}
                              label="Карта"
                              className="btn-secondary text-[11px] py-1 px-2"
                            />
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted">
                          {p.cardHolder || "—"}
                        </td>
                        <td className="px-4 py-3 text-center">{statusBadge}</td>
                        <td className="px-4 py-3 text-right">
                          <PayoutRowActions payout={p} />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: LEDGER AUDIT */}
      {currentTab === "ledger" && (
        <div className="space-y-4">
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted text-xs">
                  <th className="px-4 py-3">Дата</th>
                  <th className="px-4 py-3">Креатор</th>
                  <th className="px-4 py-3">Тип операции</th>
                  <th className="px-4 py-3 text-right">Сумма</th>
                  <th className="px-4 py-3 text-right">Баланс До → После</th>
                  <th className="px-4 py-3">Ссылка / Примечание</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {ledgerLogs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-muted">
                      Журнал проводок пока пуст.
                    </td>
                  </tr>
                ) : (
                  ledgerLogs.map((l) => {
                    const isPositive = l.amountUzs > 0;
                    const isNegative = l.amountUzs < 0;

                    return (
                      <tr key={l.id} className="hover:bg-surface-2/40 transition">
                        <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">
                          {new Date(l.createdAt).toLocaleDateString("ru-RU", {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-xs">{l.creator.name}</div>
                          <div className="text-[11px] text-muted font-mono">c_{l.creator.code}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs px-2 py-0.5 rounded font-mono font-medium bg-surface-2 text-text">
                            {l.type}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-bold whitespace-nowrap">
                          <span
                            className={
                              isPositive
                                ? "text-success"
                                : isNegative
                                ? "text-danger"
                                : "text-muted"
                            }
                          >
                            {isPositive ? `+${money(l.amountUzs)}` : money(l.amountUzs)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-xs text-muted font-mono whitespace-nowrap">
                          {money(l.balanceBefore)} → {money(l.balanceAfter)}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted">
                          {l.note || l.referenceId || "—"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
