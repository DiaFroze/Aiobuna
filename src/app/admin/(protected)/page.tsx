import Link from "next/link";
import { botDb, botConfigured } from "@/lib/botDb";
import { prisma } from "@/lib/db";
import { PageHeader, StatCard } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

const UZS_RATE = Number(process.env.USDT_UZS_RATE ?? 12600);
const uzs = (usdt: number) =>
  `${Math.round((usdt ?? 0) * UZS_RATE).toLocaleString("ru-RU")} сум`;

export default async function DashboardPage() {
  const admins = await prisma.admin.count();

  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Dashboard" subtitle="Обзор магазина-бота" />
        <div className="card p-6 text-muted">BOT_DATABASE_URL не задан — статистика бота недоступна.</div>
      </div>
    );
  }

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [
    products,
    activeProducts,
    unsoldStock,
    users,
    balanceAgg,
    ordersAgg,
    todayAgg,
    pendingTopups,
    topProducts,
  ] = await Promise.all([
    botDb.product.count(),
    botDb.product.count({ where: { isActive: true } }),
    botDb.stockItem.count({ where: { isSold: false } }),
    botDb.botUser.count(),
    botDb.botUser.aggregate({ _sum: { balance: true } }),
    botDb.botOrder.aggregate({ _count: { _all: true }, _sum: { priceUsdt: true } }),
    botDb.botOrder.aggregate({ where: { createdAt: { gte: startToday } }, _count: { _all: true }, _sum: { priceUsdt: true } }),
    botDb.topUp.count({ where: { status: "pending" } }),
    botDb.botOrder.groupBy({
      by: ["titleRu"],
      _count: { _all: true },
      _sum: { priceUsdt: true },
      orderBy: { _count: { titleRu: "desc" } },
      take: 5,
    }),
  ]);

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Обзор магазина-бота в реальном времени" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Выручка сегодня" value={uzs(todayAgg._sum.priceUsdt ?? 0)} tone="success" />
        <StatCard label="Продаж сегодня" value={String(todayAgg._count._all)} />
        <StatCard label="Выручка всего" value={uzs(ordersAgg._sum.priceUsdt ?? 0)} />
        <StatCard label="Продаж всего" value={String(ordersAgg._count._all)} />
        <StatCard label="Товаров (активных)" value={`${activeProducts}/${products}`} />
        <StatCard
          label="Остаток на складе"
          value={String(unsoldStock)}
          tone={unsoldStock === 0 ? "danger" : "default"}
        />
        <StatCard label="Пользователей бота" value={String(users)} />
        <StatCard label="Сумма балансов" value={uzs(balanceAgg._sum.balance ?? 0)} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="card p-5">
          <h3 className="font-semibold mb-3">Топ товаров (по продажам)</h3>
          {topProducts.length === 0 ? (
            <p className="text-sm text-muted">
              Пока нет продаж.{" "}
              <Link href="/admin/bot-products" className="text-brand underline">
                Добавить товары
              </Link>
            </p>
          ) : (
            <ul className="space-y-2">
              {topProducts.map((p) => (
                <li key={p.titleRu} className="flex justify-between text-sm">
                  <span className="truncate pr-2">{p.titleRu}</span>
                  <span className="text-muted whitespace-nowrap">
                    {p._count._all} продаж • {uzs(p._sum.priceUsdt ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-5">
          <h3 className="font-semibold mb-3">Быстрые действия</h3>
          <ul className="space-y-2 text-sm">
            <li>
              <Link href="/admin/bot-products" className="text-brand underline">Товары бота</Link>
              <span className="text-muted"> — каталог, тарифы, склад</span>
            </li>
            <li>
              <Link href="/admin/bot-topups" className="text-brand underline">Пополнения бота</Link>
              {pendingTopups > 0 && <span className="badge bg-warning/10 text-warning ml-2">ожидают: {pendingTopups}</span>}
            </li>
            <li>
              <Link href="/admin/bot-settings" className="text-brand underline">Тексты и меню бота</Link>
            </li>
            <li>
              <Link href="/admin/admins" className="text-brand underline">Администраторы</Link>
              <span className="text-muted"> — всего: {admins}</span>
            </li>
          </ul>
        </div>
      </div>

      {activeProducts > 0 && unsoldStock === 0 && (
        <div className="card p-4 mt-4 text-sm text-warning">
          ⚠ Склад пуст — покупатели не смогут ничего купить.{" "}
          <Link href="/admin/bot-products" className="underline">Добавить коды в склад</Link>
        </div>
      )}
    </div>
  );
}
