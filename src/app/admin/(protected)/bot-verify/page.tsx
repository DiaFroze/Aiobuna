import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { parseVerificationCode } from "@/lib/orderCode";
import { deliverManualOrderAction } from "./actions";

export const dynamic = "force-dynamic";

function money(amount: number) {
  return `${amount.toLocaleString()} сум`;
}

export default async function BotVerifyPage({
  searchParams,
}: {
  searchParams: { code?: string };
}) {
  const code = (searchParams.code ?? "").trim();
  let errorMsg: string | null = null;
  let order: any = null;

  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Проверка кодов" />
        <EmptyState>BOT_DATABASE_URL не задан в .env — не могу подключиться к базе бота.</EmptyState>
      </div>
    );
  }

  if (code) {
    const { orderId, isValid } = parseVerificationCode(code);
    if (!isValid) {
      errorMsg = "Неверный формат или подпись проверочного кода.";
    } else {
      order = await botDb.botOrder.findUnique({
        where: { id: orderId },
        include: {
          user: true,
        },
      });

      if (!order) {
        errorMsg = `Заказ #${orderId} не найден в базе данных бота.`;
      }
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="🔑 Проверка кодов заказов"
        subtitle="Вставьте код, переданный клиентом, чтобы просмотреть детали заказа и выдать товар."
      />

      {/* Code Input Form */}
      <div className="card p-5">
        <form method="GET" className="space-y-4">
          <div>
            <label className="text-sm font-medium text-muted block mb-1">
              Код проверки заказа (например, SB-12-F3A79E)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                name="code"
                defaultValue={code}
                placeholder="SB-XXXX-XXXXXX"
                required
                className="input font-mono flex-1"
              />
              <button type="submit" className="btn btn-primary">
                🔎 Проверить код
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Error Message */}
      {errorMsg && (
        <div className="card p-4 border-danger/30 bg-danger/5 text-danger text-sm">
          ⚠️ {errorMsg}
        </div>
      )}

      {/* Order Details */}
      {order && (
        <div className="card p-6 space-y-6">
          <div className="border-b pb-4 flex justify-between items-start">
            <div>
              <h3 className="text-lg font-bold">
                Детали заказа #{order.id}
              </h3>
              <p className="text-sm text-muted">
                Создан: {new Date(order.createdAt).toLocaleString("ru-RU")}
              </p>
            </div>
            <div>
              <span
                className={`badge px-3 py-1 text-sm font-semibold ${
                  order.status === "delivered"
                    ? "bg-success/10 text-success"
                    : order.status === "awaiting_delivery"
                    ? "bg-warning/10 text-warning"
                    : "bg-danger/10 text-danger"
                }`}
              >
                {order.status === "delivered"
                  ? "Выдан ✅"
                  : order.status === "awaiting_delivery"
                  ? "Ожидает выдачи ⏳"
                  : order.status}
              </span>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {/* Left side: details */}
            <div className="space-y-4">
              <div>
                <span className="text-xs text-muted block uppercase tracking-wider font-semibold">
                  Товар / Тариф
                </span>
                <span className="text-md font-semibold">{order.titleRu}</span>
              </div>

              <div>
                <span className="text-xs text-muted block uppercase tracking-wider font-semibold">
                  Цена покупки
                </span>
                <span className="text-md font-bold text-success">
                  {money(order.priceUsdt)}
                </span>
              </div>

              <div>
                <span className="text-xs text-muted block uppercase tracking-wider font-semibold">
                  Способ покупки / Источник
                </span>
                <span className="text-sm font-mono bg-surface-2 px-2 py-0.5 rounded text-muted">
                  {order.source}
                </span>
              </div>
            </div>

            {/* Right side: buyer details */}
            <div className="space-y-4">
              <div>
                <span className="text-xs text-muted block uppercase tracking-wider font-semibold">
                  Покупатель
                </span>
                <span className="text-md font-semibold block">
                  {order.user.firstName || "—"}
                </span>
                {order.user.username && (
                  <a
                    href={`https://t.me/${order.user.username}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-brand underline"
                  >
                    @{order.user.username}
                  </a>
                )}
              </div>

              <div>
                <span className="text-xs text-muted block uppercase tracking-wider font-semibold">
                  Telegram ID
                </span>
                <span className="text-sm font-mono text-muted">
                  {order.user.tgId}
                </span>
              </div>
            </div>
          </div>

          {/* Action form / Delivered content details */}
          {order.status === "awaiting_delivery" ? (
            <div className="border-t pt-6">
              <h4 className="font-semibold mb-3">📥 Выдать товар</h4>
              <form action={deliverManualOrderAction} className="space-y-4">
                <input type="hidden" name="orderId" value={order.id} />
                <div>
                  <label className="text-sm text-muted block mb-1">
                    Данные для выдачи (ссылка, логин:пароль или промокод)
                  </label>
                  <textarea
                    name="payload"
                    required
                    rows={4}
                    className="input w-full font-mono text-sm"
                    placeholder="Например, login:password или https://serviceactivation.google.com/..."
                  />
                </div>
                <button type="submit" className="btn btn-success">
                  🚀 Отправить клиенту в бот
                </button>
              </form>
            </div>
          ) : (
            <div className="border-t pt-6 space-y-2">
              <span className="text-xs text-muted block uppercase tracking-wider font-semibold">
                Выданные данные
              </span>
              <pre className="p-3 bg-surface-2 rounded font-mono text-sm border overflow-x-auto whitespace-pre-wrap">
                {order.payload}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
