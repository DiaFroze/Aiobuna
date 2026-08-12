import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState, StatCard } from "@/components/admin/ui";
import { saveRefPromoAction } from "../bot-products/actions";

export const dynamic = "force-dynamic";

const TIER_ROWS = 6;

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
    botDb.setting.findMany({ where: { key: { in: ["ref_reward_enabled", "ref_reward_tiers"] } } }),
    botDb.product.findMany({ orderBy: { sortOrder: "asc" }, include: { plans: { include: { variants: true } } } }),
    botDb.botUser.count({ where: { refRewardClaimed: true } }),
  ]);
  const val = (k: string) => settings.find((s) => s.key === k)?.valueRu ?? "";
  const enabled = val("ref_reward_enabled") === "1";

  // "5:12,7:34,10:56" → [{threshold:5, variantId:12}, ...], sorted low→high.
  const tiers = val("ref_reward_tiers")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [th, vid] = s.split(":").map((x) => Number(x.trim()));
      return { threshold: th, variantId: vid };
    })
    .filter((t) => Number.isFinite(t.threshold) && t.threshold > 0 && Number.isFinite(t.variantId) && t.variantId > 0)
    .sort((a, b) => a.threshold - b.threshold);

  const options = products.flatMap((p) =>
    p.plans.flatMap((pl) => pl.variants.map((v) => ({ id: v.id, label: `${p.titleRu} — ${v.titleRu} (${v.priceUzs.toLocaleString("ru-RU")} сум)` }))),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="🎁 Акция за приглашения"
        subtitle="Каждый порог приглашений открывает свой подарок — например, 5 друзей → Canva Pro, 7 → CapCut Pro, 10 → Gemini AI Pro. Пользователь получает все подарки по мере накопления приглашений."
      />

      <div className="grid sm:grid-cols-3 gap-4">
        <StatCard label="Статус" value={enabled ? "включена" : "выключена"} tone={enabled ? "success" : "default"} />
        <StatCard label="Настроено уровней" value={String(tiers.length)} />
        <StatCard label="Получили все подарки" value={String(claimed)} />
      </div>

      <form action={saveRefPromoAction} className="card p-5 space-y-4 max-w-2xl">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={enabled} />
          Акция включена
        </label>

        <div>
          <label className="text-sm text-muted block mb-2">Уровни наград</label>
          <p className="text-xs text-muted mb-3">
            Заполните столько строк, сколько нужно уровней. Пустые строки (без порога или без товара) игнорируются.
          </p>
          <div className="space-y-2">
            {Array.from({ length: TIER_ROWS }, (_, i) => tiers[i] ?? { threshold: "", variantId: "" }).map((tier, i) => (
              <div key={i} className="grid grid-cols-[7rem_1fr] gap-2 items-center">
                <input
                  name={`tier${i}_threshold`}
                  type="number"
                  min="1"
                  placeholder="Друзей"
                  defaultValue={tier.threshold || ""}
                  className="input"
                />
                <select name={`tier${i}_variant`} defaultValue={tier.variantId || "0"} className="input">
                  <option value="0">— не выбрано —</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
            ))}
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
