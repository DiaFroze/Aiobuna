import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState, StatCard } from "@/components/admin/ui";
import {
  toggleReferralsAction,
  saveSalesFeedAction,
  setRefBanAction,
  zeroPointsAction,
  giveePointsAction,
  unlinkReferralAction,
  repairPointsAction,
} from "./actions";

export const dynamic = "force-dynamic";

// Must stay identical to countVerifiedRefs() in the bot: an invitee only counts
// once they have passed the channel-subscription gate.
const VERIFIED = { channelVerifiedAt: { not: null } } as const;

export default async function BotReferralsPage() {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Рефералы" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const [settings, totalLinked, totalVerified, banned, withSpend, topRaw] = await Promise.all([
    botDb.setting.findMany({ where: { key: { in: ["referrals_enabled", "sales_group_id", "sales_feed_enabled"] } } }),
    botDb.botUser.count({ where: { referredBy: { not: null } } }),
    botDb.botUser.count({ where: { referredBy: { not: null }, ...VERIFIED } }),
    botDb.botUser.count({ where: { refBanned: true } }),
    botDb.botUser.count({ where: { spentReferrals: { gt: 0 } } }),
    botDb.botUser.groupBy({
      by: ["referredBy"],
      where: { referredBy: { not: null }, ...VERIFIED },
      _count: { _all: true },
      orderBy: { _count: { referredBy: "desc" } },
      take: 15,
    }),
  ]);

  const val = (k: string, dflt = "") => settings.find((s) => s.key === k)?.valueRu ?? dflt;
  const refsOn = val("referrals_enabled", "1") !== "0";
  const feedOn = val("sales_feed_enabled", "1") !== "0";
  const groupId = val("sales_group_id");

  const topIds = topRaw.map((g) => g.referredBy!).filter(Boolean);
  const topUsers = topIds.length ? await botDb.botUser.findMany({ where: { tgId: { in: topIds } } }) : [];
  const byTgId = new Map(topUsers.map((u) => [u.tgId, u]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="🤝 Рефералы"
        subtitle="Очко начисляется только после того, как приглашённый подписался на обязательный канал. Все действия здесь доступны и командами в боте."
      />

      <div className="grid sm:grid-cols-4 gap-4">
        <StatCard label="Программа" value={refsOn ? "включена" : "выключена"} tone={refsOn ? "success" : "default"} />
        <StatCard label="Перешли по ссылкам" value={String(totalLinked)} />
        <StatCard label="Из них засчитано" value={String(totalVerified)} tone="success" />
        <StatCard label="Забанено" value={String(banned)} tone={banned > 0 ? "warning" : "default"} />
      </div>

      {totalLinked > totalVerified && (
        <div className="card p-4 border-warning/30 bg-warning/5 text-sm">
          <b>{totalLinked - totalVerified}</b> приглашённых ещё не подписались на канал — их очки не начислены.
          Если кто-то из них на самом деле подписан, запустите в боте <code className="font-mono">/reffix</code>:
          он перепроверит каждого через Telegram и засчитает подтверждённых.
        </div>
      )}

      {/* ── master switch ─────────────────────────────── */}
      <form action={toggleReferralsAction} className="card p-5 space-y-3 max-w-2xl">
        <div className="font-semibold text-sm">Реферальная программа</div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={refsOn} />
          Включена
        </label>
        <p className="text-xs text-muted">
          Выключение останавливает начисление и трату очков. Сама ссылка приглашения продолжает
          сохраняться, поэтому после обратного включения приглашения не теряются.
        </p>
        <button className="btn-primary">Сохранить</button>
      </form>

      {/* ── sales feed ────────────────────────────────── */}
      <form action={saveSalesFeedAction} className="card p-5 space-y-3 max-w-2xl">
        <div className="font-semibold text-sm">📣 Лента продаж в группе</div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="feedEnabled" defaultChecked={feedOn} />
          Автоматически публиковать покупки и подарки
        </label>
        <div>
          <label className="text-xs text-muted block mb-1">Группа</label>
          <input name="groupId" defaultValue={groupId} className="input font-mono" placeholder="@subhub_group" />
          <p className="text-xs text-muted mt-1">
            Публичная группа — <code className="font-mono">@имя</code>, закрытая — числовой id вида
            <code className="font-mono"> -1001234567890</code>. Бот должен состоять в группе и иметь право писать.
          </p>
        </div>
        <div className="rounded-lg bg-surface-2/60 p-3 text-xs space-y-1">
          <div className="text-muted mb-1">В группу уходит только это — ни юзернейма, ни полного ID:</div>
          <div>🎁 <b>Забрал подарок за рефералов!</b></div>
          <div>👤 Ja•••••r · <span className="font-mono">714•••••61</span></div>
          <div>📦 Gemini AI Pro — 18 месяцев</div>
          <div>🤝 <b>10 реф.</b> — бесплатно</div>
        </div>
        <button className="btn-primary">Сохранить</button>
        <p className="text-xs text-muted">
          Проверить отправку: команда <code className="font-mono">/salesgroup test</code> в боте.
        </p>
      </form>

      {/* ── per-user tools ────────────────────────────── */}
      <div className="card p-5 space-y-4 max-w-2xl">
        <div className="font-semibold text-sm">Действия с пользователем</div>
        <p className="text-xs text-muted">
          Везде указывается <code className="font-mono">tgId</code> или <code className="font-mono">@username</code>.
          Полный отчёт по человеку — команда <code className="font-mono">/refinfo &lt;id&gt;</code> в боте.
        </p>

        <form action={giveePointsAction} className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[12rem]">
            <label className="text-xs text-muted block mb-1">Начислить / списать очки</label>
            <input name="user" className="input text-sm" placeholder="tgId или @username" required />
          </div>
          <input name="amount" type="number" className="input text-sm w-24" placeholder="+3" required />
          <button className="btn-primary text-sm">Применить</button>
        </form>
        <p className="text-xs text-muted -mt-2">
          Отрицательное число отнимает. Используйте для приглашений, потерянных пока программа была выключена.
        </p>

        <form action={zeroPointsAction} className="flex flex-wrap gap-2 items-end border-t pt-4">
          <div className="flex-1 min-w-[12rem]">
            <label className="text-xs text-muted block mb-1">Обнулить доступные очки</label>
            <input name="user" className="input text-sm" placeholder="tgId или @username" required />
          </div>
          <button className="btn-danger text-sm">Обнулить</button>
        </form>

        <form action={setRefBanAction} className="flex flex-wrap gap-2 items-end border-t pt-4">
          <div className="flex-1 min-w-[12rem]">
            <label className="text-xs text-muted block mb-1">Бан в реферальной программе</label>
            <input name="user" className="input text-sm" placeholder="tgId или @username" required />
          </div>
          <button name="banned" value="1" className="btn-danger text-sm">Забанить</button>
          <button name="banned" value="0" className="btn-ghost text-sm">Разбанить</button>
        </form>
        <p className="text-xs text-muted -mt-2">Забаненный не может ни приглашать, ни тратить очки.</p>

        <form action={unlinkReferralAction} className="flex flex-wrap gap-2 items-end border-t pt-4">
          <div className="flex-1 min-w-[12rem]">
            <label className="text-xs text-muted block mb-1">Отвязать от пригласившего</label>
            <input name="user" className="input text-sm" placeholder="tgId приглашённого" required />
          </div>
          <button className="btn-ghost text-sm">Отвязать</button>
        </form>
      </div>

      {/* ── repair ────────────────────────────────────── */}
      <div className="card p-5 space-y-3 max-w-2xl">
        <div className="font-semibold text-sm">🔧 Вернуть потерянные очки</div>
        <p className="text-xs text-muted">
          Если очки списались, а подарок не выдался, они пропадали. Сверяет счётчик списаний с реально
          полученными подарками и возвращает разницу. Пользователей со списаниями: <b>{withSpend}</b>.
        </p>
        <div className="card p-3 border-warning/30 bg-warning/5 text-xs text-warning">
          Отменяет и ручное обнуление — в данных они выглядят одинаково. Мошенников придётся обнулить заново.
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <form action={repairPointsAction} className="flex gap-2 items-end flex-1 min-w-[14rem]">
            <input type="hidden" name="scope" value="one" />
            <input name="user" className="input text-sm" placeholder="tgId или @username" required />
            <button className="btn-primary text-sm">Вернуть одному</button>
          </form>
          <form action={repairPointsAction}>
            <input type="hidden" name="scope" value="all" />
            <button className="btn-danger text-sm">Вернуть всем</button>
          </form>
        </div>
        <p className="text-xs text-muted">
          Предпросмотр без изменений: <code className="font-mono">/refrepair all</code> в боте.
        </p>
      </div>

      {/* ── leaderboard ───────────────────────────────── */}
      <div className="card p-5">
        <div className="font-semibold text-sm mb-3">Топ пригласивших (только засчитанные)</div>
        {topRaw.length === 0 ? (
          <EmptyState>Пока никто никого не пригласил.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {topRaw.map((g) => {
              const u = byTgId.get(g.referredBy!);
              return (
                <li key={g.referredBy} className="flex items-center justify-between text-sm border-b last:border-0 pb-2">
                  <span className="min-w-0 truncate">
                    {u ? (
                      <>
                        {u.firstName ?? "—"}
                        {u.username && <span className="text-muted"> @{u.username}</span>}
                        {u.refBanned && <span className="ml-2 text-danger text-xs">бан</span>}
                      </>
                    ) : (
                      <span className="font-mono text-muted">{g.referredBy}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-3 shrink-0">
                    <span className="font-mono text-xs text-muted">{g.referredBy}</span>
                    <b>{g._count._all}</b>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
