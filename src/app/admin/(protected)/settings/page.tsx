import { PageHeader } from "@/components/admin/ui";
import { getGlobalSettings } from "@/lib/services/settings";
import { saveSettingsAction, resetSalesStatsAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getGlobalSettings();

  return (
    <div className="max-w-lg">
      <PageHeader title="Настройки" subtitle="Округление цен. Все цены и суммы — в сумах (UZS)." />
      <form action={saveSettingsAction} className="card p-5 space-y-4">
        <div>
          <label className="text-sm text-muted">Правило округления</label>
          <select name="defaultRoundingMode" defaultValue={settings.defaultRoundingMode} className="input mt-1">
            <option value="NONE">Без округления</option>
            <option value="NEAREST_05">До 0.05 (0.63 → 0.65)</option>
            <option value="NEAREST_10">До 0.10 (0.67 → 0.70)</option>
            <option value="NEAREST_1000">До 1000 (8570 → 9000)</option>
            <option value="PSYCHOLOGICAL">Психологическое (.99)</option>
          </select>
        </div>
        <button className="btn-primary">Сохранить</button>
      </form>

      <p className="text-xs text-muted mt-4">
        Настройки Telegram-уведомлений задаются через переменные окружения
        <code className="mx-1">TELEGRAM_BOT_TOKEN</code> и <code>TELEGRAM_ADMIN_CHAT_ID</code>.
      </p>

      <div className="card p-5 mt-8 border-danger/30 bg-danger/5 space-y-3">
        <h3 className="font-semibold text-danger">⚠ Опасная зона</h3>
        <p className="text-sm text-muted">
          Полностью удаляет историю заказов, покупок методов, погашений промокодов и заявок на
          пополнение (обнуляет «Выручку», «Продаж всего» и счётчики промокодов). Действие
          необратимо.
        </p>
        <p className="text-sm text-muted">
          <b>Не затрагивает:</b> баланс пользователей, склад, товары и тарифы, каналы, самих
          пользователей и промокоды (только счётчик использований).
        </p>
        <form action={resetSalesStatsAction} className="flex flex-wrap items-end gap-3 pt-2">
          <div>
            <label className="text-xs text-muted block mb-1">
              Введите <b>ОБНУЛИТЬ</b> для подтверждения
            </label>
            <input
              name="confirm"
              required
              placeholder="ОБНУЛИТЬ"
              className="input text-sm font-mono"
            />
          </div>
          <button type="submit" className="btn btn-danger text-sm">
            🗑 Обнулить выручку и продажи
          </button>
        </form>
      </div>
    </div>
  );
}
