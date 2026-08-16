import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { upsertBotSettingAction, deleteBotSettingAction, saveMenuConfigAction, toggleMaintenanceModeAction, toggleReferralsModeAction } from "./actions";

export const dynamic = "force-dynamic";

// Keys owned by the "Меню бота" config card below — hidden from the generic list.
const MENU_KEYS = ["store_name", "menu_emoji", "menu_premium_emoji", "menu_tagline", "support"];

// Common bot settings, shown as ready-to-fill rows even before they exist in the DB.
const SUGGESTED: { key: string; hint: string }[] = [
  { key: "support_username", hint: "Username поддержки БЕЗ @ (кнопка «Поддержка» откроет t.me/username)" },
  { key: "sales_group_id", hint: "Chat ID группы/канала для ленты покупок (напр. -1001234567890). Бот должен быть админом группы. Имя покупателя маскируется. Пусто = выключено." },
  { key: "payment_card", hint: "Номер карты для оплаты (на неё клиент переводит; последние 4 цифры сверяются с чеком)" },
  { key: "payment_card_holder", hint: "Владелец карты (имя, показывается клиенту)" },
  { key: "button_emoji", hint: "Premium emoji ID (иконка на кнопках Назад/Вперёд). Нужен рестарт бота." },
  { key: "wallet_button_emoji", hint: "Premium emoji ID (иконка на кнопке Баланс/Кошелек). Нужен рестарт бота." },
  { key: "review_url", hint: "Ссылка на ролик в Instagram для отзывов. Просьба приходит клиенту после успешной выдачи. Превью: /review в боте." },
  { key: "review_enabled", hint: "1 = просить отзыв после покупки, 0 = выключено. По умолчанию выключено." },
  { key: "review_reward", hint: "Сколько рефералов обещать за отзыв (0 = без награды). Начисляете вручную после проверки — бот присылает заявку." },
  { key: "promo_post_text", hint: "Текст промо-поста для канала (HTML: <b>, <i>). Публикуется командой /promopost send, превью — /promopost. Пусто = текст по умолчанию." },
  { key: "promo_post_button", hint: "Надпись на кнопке промо-поста. Кнопка открывает бота на вкладке «Подарки». Пусто = «🎁 Sovg'ani olish»." },
  { key: "promo_post_channel", hint: "Канал для промо-поста (@nomi или -100…). Пусто = первый обязательный канал. Бот должен быть админом с правом публикации." },
  { key: "welcome", hint: "Приветствие / стартовое сообщение" },
  { key: "disclaimer", hint: "Дисклеймер (без гарантий) — показывается при выборе количества" },
  { key: "payment_info", hint: "Реквизиты и инструкция по оплате" },
  { key: "rules", hint: "Правила / условия" },
];

export default async function BotSettingsPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Тексты и оплата бота" />
        <EmptyState>BOT_DATABASE_URL не задан в .env — не могу подключиться к базе бота.</EmptyState>
      </div>
    );
  }

  const allSettings = await botDb.setting.findMany({ orderBy: { key: "asc" } });
  const val = (key: string) => allSettings.find((s) => s.key === key)?.valueRu ?? "";
  const maintenanceOn = val("maintenance_mode") === "1";
  // referrals_enabled defaults to on when key is absent
  const referralsRow = allSettings.find((s) => s.key === "referrals_enabled");
  const referralsOn = referralsRow === undefined || referralsRow.valueRu !== "0";
  const settings = allSettings.filter(
    (s) => !MENU_KEYS.includes(s.key) && s.key !== "maintenance_mode" && s.key !== "referrals_enabled",
  );
  const existingKeys = new Set(allSettings.map((s) => s.key));
  const missingSuggested = SUGGESTED.filter((s) => !existingKeys.has(s.key));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Тексты и оплата бота"
        subtitle="Сообщения и настройки, которые показываются в Telegram-боте. Сохранение применяется сразу."
      />

      {/* Quick toggles row */}
      <div className="grid sm:grid-cols-2 gap-4">

      {/* Maintenance mode toggle */}
      <div className={`card p-5 flex flex-col items-start justify-between gap-4 border-2 ${maintenanceOn ? "border-danger/60 bg-danger/5" : "border-border"}`}>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg">{maintenanceOn ? "🔴" : "🟢"}</span>
            <h2 className="font-semibold">{maintenanceOn ? "Бот выключен (техперерыв)" : "Бот работает"}</h2>
          </div>
          <p className="text-xs text-muted mt-1">
            {maintenanceOn
              ? "Пользователи видят сообщение о техническом обслуживании. Вы (админ) работаете в обычном режиме."
              : "Все пользователи могут пользоваться ботом."}
          </p>
        </div>
        <form action={toggleMaintenanceModeAction} className="shrink-0 w-full">
          <input type="hidden" name="enable" value={maintenanceOn ? "0" : "1"} />
          <button
            type="submit"
            className={`btn text-sm px-5 w-full ${maintenanceOn ? "btn-primary" : "btn-danger"}`}
          >
            {maintenanceOn ? "▶ Включить бота" : "⏸ Выключить бота"}
          </button>
        </form>
      </div>

      {/* Referrals toggle */}
      <div className={`card p-5 flex flex-col items-start justify-between gap-4 border-2 ${!referralsOn ? "border-warning/60 bg-warning/5" : "border-border"}`}>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg">{referralsOn ? "🤝" : "⏸"}</span>
            <h2 className="font-semibold">{referralsOn ? "Рефералы включены" : "Рефералы выключены"}</h2>
          </div>
          <p className="text-xs text-muted mt-1">
            {referralsOn
              ? "Новые приглашения считаются. Подарки за рефералов доступны."
              : "Новые приглашения не считаются. Вкладка подарков заблокирована."}
          </p>
        </div>
        <form action={toggleReferralsModeAction} className="shrink-0 w-full">
          <input type="hidden" name="enable" value={referralsOn ? "0" : "1"} />
          <button
            type="submit"
            className={`btn text-sm px-5 w-full ${referralsOn ? "btn-danger" : "btn-primary"}`}
          >
            {referralsOn ? "⏸ Выключить рефералы" : "▶ Включить рефералы"}
          </button>
        </form>
      </div>

      </div>{/* end quick toggles row */}

      {searchParams.error === "missing" && (
        <div className="card p-3 border-danger/30 bg-danger/5 text-danger text-sm">
          Укажите ключ настройки.
        </div>
      )}

      {/* Main-menu config — name, header emoji, PREMIUM EMOJI code, tagline, support */}
      <form action={saveMenuConfigAction} className="card p-5 space-y-4">
        <div>
          <h2 className="font-semibold">🛍 Меню бота</h2>
          <p className="text-xs text-muted">Отображается в шапке магазина и в постоянном меню бота.</p>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-muted">Название магазина</label>
            <input name="store_name" defaultValue={val("store_name") || "SB Store"} className="input mt-1" />
          </div>
          <div>
            <label className="text-sm text-muted">Эмодзи шапки (обычный, плейсхолдер)</label>
            <input name="menu_emoji" defaultValue={val("menu_emoji") || "🛍"} maxLength={8} className="input mt-1" />
          </div>
        </div>
        <div>
          <label className="text-sm text-muted">Premium Emoji code (custom_emoji_id)</label>
          <input
            name="menu_premium_emoji"
            defaultValue={val("menu_premium_emoji")}
            className="input mt-1 font-mono"
            placeholder="напр. 5278711610775457808"
          />
          <p className="text-xs text-muted mt-1">
            Длинный числовой код. Рендерится премиум-эмодзи в тексте шапки. На самих кнопках Telegram
            премиум-эмодзи не поддерживает — только в тексте сообщений.
          </p>
        </div>
        <div>
          <label className="text-sm text-muted">Подзаголовок (tagline)</label>
          <input name="menu_tagline" defaultValue={val("menu_tagline")} className="input mt-1" placeholder="Цифровые товары — быстро и удобно" />
        </div>
        <div>
          <label className="text-sm text-muted">Текст поддержки (кнопка 🆘 Поддержка)</label>
          <textarea name="support" defaultValue={val("support")} rows={2} className="input mt-1 text-sm" placeholder="Напишите: @your_admin" />
        </div>
        <button className="btn-primary">Сохранить меню</button>
      </form>

      {settings.length === 0 && missingSuggested.length === 0 && (
        <EmptyState>Нет настроек. Добавьте первую через форму ниже.</EmptyState>
      )}

      {settings.map((s) => (
        <SettingCard
          key={s.key}
          settingKey={s.key}
          valueRu={s.valueRu}
          valueUz={s.valueUz}
          fileId={s.fileId ?? ""}
          type={s.type}
          updatedAt={s.updatedAt.toLocaleString("ru-RU")}
          deletable
        />
      ))}

      {missingSuggested.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-muted pt-2">Частые настройки (ещё не заданы)</h2>
          {missingSuggested.map((s) => (
            <SettingCard key={s.key} settingKey={s.key} hint={s.hint} valueRu="" valueUz="" fileId="" type="text" />
          ))}
        </>
      )}

      {/* Add an arbitrary custom setting key */}
      <details className="card p-5">
        <summary className="cursor-pointer font-semibold">+ Добавить свою настройку</summary>
        <form action={upsertBotSettingAction} className="mt-4 space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-muted">Ключ</label>
              <input name="key" required className="input mt-1 font-mono" placeholder="напр. faq" />
            </div>
            <div>
              <label className="text-sm text-muted">Тип</label>
              <input name="type" className="input mt-1" defaultValue="text" />
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-muted">Значение (RU)</label>
              <textarea name="valueRu" rows={3} className="input mt-1 text-sm" />
            </div>
            <div>
              <label className="text-sm text-muted">Значение (UZ)</label>
              <textarea name="valueUz" rows={3} className="input mt-1 text-sm" />
            </div>
          </div>
          <button className="btn-primary">Сохранить</button>
        </form>
      </details>
    </div>
  );
}

function SettingCard({
  settingKey,
  valueRu,
  valueUz,
  fileId,
  type,
  hint,
  updatedAt,
  deletable,
}: {
  settingKey: string;
  valueRu: string;
  valueUz: string;
  fileId: string;
  type: string;
  hint?: string;
  updatedAt?: string;
  deletable?: boolean;
}) {
  return (
    <form action={upsertBotSettingAction} className="card p-5 space-y-3">
      <input type="hidden" name="key" value={settingKey} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="font-mono text-sm font-semibold">{settingKey}</span>
          {hint && <span className="text-xs text-muted ml-2">{hint}</span>}
          {updatedAt && <span className="text-xs text-muted ml-2">· обновлено {updatedAt}</span>}
        </div>
        <input name="type" defaultValue={type} className="input w-32 text-xs" />
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted">Значение (RU)</label>
          <textarea name="valueRu" defaultValue={valueRu} rows={3} className="input mt-1 text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted">Значение (UZ)</label>
          <textarea name="valueUz" defaultValue={valueUz} rows={3} className="input mt-1 text-sm" />
        </div>
      </div>
      <div>
        <label className="text-xs text-muted">file_id (баннер/картинка, необязательно)</label>
        <input name="fileId" defaultValue={fileId} className="input mt-1 font-mono text-xs" />
      </div>
      <div className="flex gap-2">
        <button className="btn-primary text-sm">Сохранить</button>
        {deletable && (
          <button formAction={deleteBotSettingAction} className="btn-danger text-sm">
            Удалить
          </button>
        )}
      </div>
    </form>
  );
}
