import { PageHeader } from "@/components/admin/ui";
import { getGlobalSettings, getUsdtUzsRate } from "@/lib/services/settings";
import { saveSettingsAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getGlobalSettings();
  const rate = await getUsdtUzsRate();

  return (
    <div className="max-w-lg">
      <PageHeader title="Настройки" subtitle="Глобальная наценка, округление, курс валют." />
      <form action={saveSettingsAction} className="card p-5 space-y-4">
        <div>
          <label className="text-sm text-muted">Глобальная наценка по умолчанию, %</label>
          <input name="globalMarkupPercent" defaultValue={settings.globalMarkupPercent} className="input mt-1" />
        </div>
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
        <div>
          <label className="text-sm text-muted">Валюта продажи по умолчанию</label>
          <select name="sellCurrency" defaultValue={settings.sellCurrency} className="input mt-1">
            <option value="USDT">USDT</option>
            <option value="USD">USD</option>
            <option value="UZS">UZS</option>
          </select>
        </div>
        <div>
          <label className="text-sm text-muted">Курс USDT → UZS</label>
          <input name="usdtUzsRate" defaultValue={rate} className="input mt-1" />
        </div>
        <button className="btn-primary">Сохранить</button>
      </form>

      <p className="text-xs text-muted mt-4">
        Настройки Telegram-уведомлений задаются через переменные окружения
        <code className="mx-1">TELEGRAM_BOT_TOKEN</code> и <code>TELEGRAM_ADMIN_CHAT_ID</code>.
      </p>
    </div>
  );
}
