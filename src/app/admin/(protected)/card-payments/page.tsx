import { prisma } from "@/lib/db";
import { PageHeader, Table, EmptyState, StatCard } from "@/components/admin/ui";
import { getCardPaymentConfig, maskCardNumber, maskChatId } from "@/lib/domain/card-payment";
import { getHumoMonitorStatus } from "@/lib/services/humo-monitor";
import { manualConfirmAction, manualRejectAction, linkNotificationAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-warning/10 text-warning border-warning/20",
  confirmed: "bg-success/10 text-success border-success/20",
  manual_confirmed: "bg-success/10 text-success border-success/20",
  expired: "bg-surface-2 text-muted border-surface-3",
  cancelled: "bg-danger/10 text-danger border-danger/20",
  manual_rejected: "bg-danger/10 text-danger border-danger/20",
};

const NOTIF_STATUS_BADGE: Record<string, string> = {
  unmatched: "bg-warning/10 text-warning border-warning/20",
  late: "bg-danger/10 text-danger border-danger/20",
  matched: "bg-success/10 text-success border-success/20",
  ignored: "bg-surface-2 text-muted border-surface-3",
};

export default async function CardPaymentsAdminPage() {
  const config = getCardPaymentConfig();
  const monitorStatus = await getHumoMonitorStatus(prisma);

  const [pendingRequests, unmatchedNotifications, recentConfirmed, stats] = await Promise.all([
    // Active pending requests
    prisma.cardPaymentRequest.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "desc" },
      include: { user: true },
      take: 50,
    }),
    // Unmatched or late bank notifications
    prisma.bankNotification.findMany({
      where: { status: { in: ["unmatched", "late"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    // History of confirmed payments
    prisma.cardPaymentRequest.findMany({
      where: { status: { in: ["confirmed", "manual_confirmed"] } },
      orderBy: { updatedAt: "desc" },
      include: { user: true },
      take: 50,
    }),
    // General stats
    Promise.all([
      prisma.cardPaymentRequest.count({ where: { status: "pending" } }),
      prisma.cardPaymentRequest.count({ where: { status: { in: ["confirmed", "manual_confirmed"] } } }),
      prisma.bankNotification.count({ where: { status: { in: ["unmatched", "late"] } } }),
      prisma.cardPaymentRequest.aggregate({
        where: { status: { in: ["confirmed", "manual_confirmed"] } },
        _sum: { totalAmount: true },
      }),
    ]),
  ]);

  const [pendingCount, confirmedCount, queueCount, revenueAgg] = stats;
  const totalRevenue = revenueAgg._sum.totalAmount || 0;

  const modeBadgeColor =
    config.mode === "all"
      ? "text-success bg-success/10 border-success/30"
      : config.mode === "admin_only"
      ? "text-warning bg-warning/10 border-warning/30"
      : "text-danger bg-danger/10 border-danger/30";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Оплата на карту HUMO"
        subtitle="Мониторинг Telegram MTProto, автоматические подтверждения, сверка выписки и ручной разбор."
      />

      {/* Invalid Session / Error Banner */}
      {monitorStatus.lastError === "invalid session" && (
        <div className="card p-4 border-l-4 border-l-danger bg-danger/5 text-sm space-y-1">
          <div className="font-bold text-danger flex items-center gap-2">
            <span>⚠️ Внимание: Telegram-сессия недействительна (invalid session)</span>
          </div>
          <p className="text-muted">
            Монитор не может авторизоваться в Telegram. Сгенерируйте новую строку сессии командой{" "}
            <code className="bg-surface-2 px-1.5 py-0.5 rounded font-mono">npm run humo:session</code> и обновите{" "}
            <code className="font-mono">TELEGRAM_SESSION</code> в переменных Railway.
          </p>
        </div>
      )}

      {/* Safe Diagnostics Bar */}
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between border-b pb-3">
          <h2 className="text-base font-semibold">Диагностика MTProto монитора</h2>
          <span className="text-xs text-muted">Секреты не логируются и не выводятся</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-xs text-muted block">Конфигурация (configured):</span>
            <span className={`font-semibold ${monitorStatus.isConfigured ? "text-success" : "text-danger"}`}>
              {monitorStatus.isConfigured ? "✅ Да (заполнена)" : "❌ Нет (неполная)"}
            </span>
          </div>

          <div>
            <span className="text-xs text-muted block">Слушатель (running):</span>
            <span className={`font-semibold ${monitorStatus.isRunning ? "text-success" : "text-warning"}`}>
              {monitorStatus.isRunning ? "🟢 Онлайн" : "🟠 Офлайн"}
            </span>
          </div>

          <div>
            <span className="text-xs text-muted block">Статус ошибки (lastError):</span>
            <span className={`font-mono text-xs ${monitorStatus.lastError ? "text-danger font-semibold" : "text-muted"}`}>
              {monitorStatus.lastError || "Ошибок нет"}
            </span>
          </div>

          <div>
            <span className="text-xs text-muted block">Режим доступа:</span>
            <span className={`px-2 py-0.5 rounded border text-xs font-mono font-medium ${modeBadgeColor}`}>
              {config.mode}
            </span>
          </div>

          <div>
            <span className="text-xs text-muted block">Карта (маскированная):</span>
            <span className="font-mono font-medium text-text">
              {maskCardNumber(config.cardNumber, config.cardLast4)}
            </span>
          </div>

          <div>
            <span className="text-xs text-muted block">Chat ID банка:</span>
            <span className="font-mono font-medium text-text">
              {maskChatId(config.humoChatId)}
            </span>
          </div>

          <div>
            <span className="text-xs text-muted block">Ключи Telegram:</span>
            <span className="text-xs">
              API ID: {config.hasApiId ? "✅" : "❌"} | Hash: {config.hasApiHash ? "✅" : "❌"} | Session: {config.hasSession ? "✅" : "❌"}
            </span>
          </div>

          <div>
            <span className="text-xs text-muted block">TTL заявки:</span>
            <span className="text-xs">
              {config.ttlSeconds} сек ({Math.round(config.ttlSeconds / 60)} мин)
            </span>
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid sm:grid-cols-4 gap-4">
        <StatCard
          label="Ожидают оплаты"
          value={String(pendingCount)}
          tone={pendingCount > 0 ? "warning" : "default"}
          hint="Активные 5-минутные заявки"
        />
        <StatCard
          label="Очередь на сверку"
          value={String(queueCount)}
          tone={queueCount > 0 ? "danger" : "default"}
          hint="Несовпавшие / поздние платежи"
        />
        <StatCard
          label="Подтверждено платежей"
          value={String(confirmedCount)}
          tone="success"
          hint="Авто + ручные"
        />
        <StatCard
          label="Выручка по карте"
          value={`${totalRevenue.toLocaleString("ru-RU")} сум`}
          tone="success"
        />
      </div>

      {/* Section 1: Active Pending Requests */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Активные заявки (ожидают пополнения)</h2>
          <span className="text-xs text-muted">Обновляется в реальном времени</span>
        </div>

        {pendingRequests.length === 0 ? (
          <EmptyState>Нет активных заявок на оплату картой в данный момент.</EmptyState>
        ) : (
          <Table head={["ID", "Покупатель", "Товар (ID / Кол-во)", "Сумма к оплате", "Код заявки", "Истекает", "Действия"]}>
            {pendingRequests.map((req) => {
              const isExpired = new Date(req.expiresAt).getTime() < Date.now();
              return (
                <tr key={req.id} className="border-b hover:bg-surface-2/50 transition">
                  <td className="px-4 py-3 font-mono text-muted">#{req.id}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{req.user?.firstName || "—"}</div>
                    <div className="text-xs text-muted font-mono">
                      {req.user?.username ? `@${req.user.username}` : req.chatId || "—"}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>Вариант #{req.variantId}</div>
                    <div className="text-xs text-muted">Кол-во: {req.qty} шт.</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-bold font-mono text-base">{req.totalAmount.toLocaleString("ru-RU")} сум</div>
                    <div className="text-xs text-muted">Базовая: {req.baseAmount.toLocaleString("ru-RU")}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-brand">+{req.extraAmount} сум</td>
                  <td className="px-4 py-3">
                    <span className={isExpired ? "text-danger font-semibold text-xs" : "text-xs"}>
                      {new Date(req.expiresAt).toLocaleTimeString("ru-RU")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <form action={manualConfirmAction}>
                        <input type="hidden" name="requestId" value={req.id} />
                        <button className="btn-success text-xs px-2.5 py-1">
                          Подтвердить
                        </button>
                      </form>
                      <form action={manualRejectAction}>
                        <input type="hidden" name="requestId" value={req.id} />
                        <button className="btn-danger text-xs px-2.5 py-1">
                          Отклонить
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </div>

      {/* Section 2: Unmatched / Late Notifications Queue */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Очередь банковских уведомлений на сверку</h2>
            <p className="text-xs text-muted">Поступления, которые не совпали с активной заявкой или пришли после истечения 5 минут</p>
          </div>
        </div>

        {unmatchedNotifications.length === 0 ? (
          <EmptyState>Несопоставленных банковских уведомлений нет. Всё чисто!</EmptyState>
        ) : (
          <Table head={["ID", "Время", "Сумма", "Карта", "Статус", "Выжимка сообщения", "Ручная привязка к заявке"]}>
            {unmatchedNotifications.map((notif) => (
              <tr key={notif.id} className="border-b hover:bg-surface-2/50 transition">
                <td className="px-4 py-3 font-mono text-muted">#{notif.id}</td>
                <td className="px-4 py-3 text-xs whitespace-nowrap">
                  {new Date(notif.operationTime).toLocaleString("ru-RU")}
                </td>
                <td className="px-4 py-3 font-mono font-bold text-success whitespace-nowrap">
                  +{notif.amount.toLocaleString("ru-RU")} сум
                </td>
                <td className="px-4 py-3 font-mono">*{notif.cardLast4}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs border font-medium ${NOTIF_STATUS_BADGE[notif.status] || ""}`}>
                    {notif.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-muted max-w-xs truncate" title={notif.rawSummary}>
                  {notif.rawSummary}
                </td>
                <td className="px-4 py-3">
                  <form action={linkNotificationAction} className="flex items-center gap-1.5">
                    <input type="hidden" name="notificationId" value={notif.id} />
                    <input
                      name="requestId"
                      required
                      placeholder="№ заявки"
                      className="input text-xs w-20 py-1 px-2 font-mono"
                    />
                    <button className="btn-primary text-xs px-2.5 py-1">
                      Связать
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      {/* Section 3: Confirmed History */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">История подтверждённых оплат</h2>

        {recentConfirmed.length === 0 ? (
          <EmptyState>История подтверждённых платежей пуста.</EmptyState>
        ) : (
          <Table head={["ID", "Покупатель", "Сумма", "Код", "Статус", "Создана", "Подтверждена", "Заказ #"]}>
            {recentConfirmed.map((req) => (
              <tr key={req.id} className="border-b hover:bg-surface-2/50 transition">
                <td className="px-4 py-3 font-mono text-muted">#{req.id}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{req.user?.firstName || "—"}</div>
                  <div className="text-xs text-muted font-mono">
                    {req.user?.username ? `@${req.user.username}` : req.chatId || "—"}
                  </div>
                </td>
                <td className="px-4 py-3 font-mono font-semibold">
                  {req.totalAmount.toLocaleString("ru-RU")} сум
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted">+{req.extraAmount}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs border font-medium ${STATUS_BADGE[req.status] || ""}`}>
                    {req.status === "manual_confirmed" ? "Вручную" : "Авто (MTProto)"}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">
                  {new Date(req.createdAt).toLocaleString("ru-RU")}
                </td>
                <td className="px-4 py-3 text-xs whitespace-nowrap">
                  {new Date(req.updatedAt).toLocaleString("ru-RU")}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-brand">
                  {req.orderId ? `#${req.orderId}` : "—"}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </div>
  );
}
