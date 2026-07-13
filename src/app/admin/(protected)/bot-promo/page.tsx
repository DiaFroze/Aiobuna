import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState, StatCard } from "@/components/admin/ui";
import { saveRefPromoAction } from "../bot-products/actions";

export const dynamic = "force-dynamic";

export default async function BotPromoPage() {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Акция за приглашения" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const [settings, products, claimed] = await Promise.all([
    botDb.setting.findMany({ where: { key: { in: ["ref_reward_enabled", "ref_reward_threshold", "ref_reward_variant"] } } }),
    botDb.product.findMany({ orderBy: { sortOrder: "asc" }, include: { plans: { include: { variants: true } } } }),
    botDb.botUser.count({ where: { refRewardClaimed: true } }),
  ]);
  const val = (k: string) => settings.find((s) => s.key === k)?.valueRu ?? "";
  const enabled = val("ref_reward_enabled") === "1";
  const threshold = val("ref_reward_threshold") || "15";
  const currentVariant = val("ref_reward_variant");

  const options = products.flatMap((p) =>
    p.plans.flatMap((pl) => pl.variants.map((v) => ({ id: v.id, label: `${p.titleRu} — ${v.titleRu} (${v.priceUzs.toLocaleString("ru-RU")} сум)` }))),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="🎁 Акция за приглашения"
        subtitle="Пригласи N человек → получи товар бесплатно. Награда выдаётся один раз при достижении порога."
      />

      <div className="grid sm:grid-cols-3 gap-4">
        <StatCard label="Статус" value={enabled ? "включена" : "выключена"} tone={enabled ? "success" : "default"} />
        <StatCard label="Порог приглашений" value={threshold} />
        <StatCard label="Уже получили награду" value={String(claimed)} />
      </div>

      <form action={saveRefPromoAction} className="card p-5 space-y-4 max-w-2xl">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={enabled} />
          Акция включена
        </label>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-muted">Сколько приглашений нужно</label>
            <input name="threshold" type="number" min="1" defaultValue={threshold} className="input mt-1" />
            <p className="text-xs text-muted mt-1">Считаются пользователи, зашедшие по реф-ссылке и нажавшие /start.</p>
          </div>
          <div>
            <label className="text-sm text-muted">Награда (товар/вариант)</label>
            <select name="variantId" defaultValue={currentVariant} className="input mt-1">
              <option value="0">— не выбрано —</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">Выдаётся бесплатно (со склада или через API, как обычная покупка).</p>
          </div>
        </div>

        {options.length === 0 && (
          <div className="card p-3 border-warning/30 bg-warning/5 text-warning text-sm">
            Сначала добавьте товары с вариантами — тогда их можно выбрать наградой.
          </div>
        )}

        <button className="btn-primary">Сохранить акцию</button>
      </form>
    </div>
  );
}
