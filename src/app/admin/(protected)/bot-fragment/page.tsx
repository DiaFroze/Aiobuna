import Link from "next/link";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { botDb, botConfigured } from "@/lib/botDb";
import { toggleBotProductActiveAction } from "../bot-products/actions";
import { applyStarsRateAction, updateFragmentPricesAction } from "./actions";
import {
  STARS_ROUNDING_STEPS,
  decodeStarsRate,
  priceForStars,
} from "@/lib/domain/stars-pricing";

export const dynamic = "force-dynamic";

/**
 * One screen for the two supplier-backed products, Telegram Stars and Premium.
 *
 * They are edited far more often than the rest of the catalogue — the supplier
 * price moves with the TON rate, so the sale price gets revisited regularly —
 * and they behave differently from everything else: no stock, no codes, bought
 * on demand. Editing them through the generic product form meant opening each
 * variant one at a time. Here every price is one form, and the on/off switch is
 * one click.
 */
export default async function BotFragmentPage() {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Telegram Stars и Premium" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  const products = await botDb.product.findMany({
    orderBy: { sortOrder: "asc" },
    include: { plans: { include: { variants: { orderBy: { sortOrder: "asc" } } } } },
  });

  // Anything the bot treats as supplier-backed, whichever product it sits under.
  const groups = products
    .map((p) => ({
      product: p,
      variants: p.plans
        .flatMap((pl) => pl.variants)
        .filter((v) => v.fragmentKind === "stars" || v.fragmentKind === "premium"),
    }))
    .filter((g) => g.variants.length > 0);

  // The saved Stars rate per product, so the form comes back filled in with
  // what was last applied rather than a guess.
  const rateRows = await botDb.botSetting.findMany({
    where: { key: { in: groups.map((g) => `stars_rate_${g.product.id}`) } },
  });
  const rates = new Map(
    rateRows.map((r) => [r.key, decodeStarsRate(r.valueRu)] as const),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Telegram Stars и Premium"
        subtitle="Цены и включение/выключение. Эти товары покупаются у поставщика под заказ — склад и коды для них не используются."
        action={<Link href="/admin/bot-products" className="btn-ghost text-sm">Все товары</Link>}
      />

      {groups.length === 0 ? (
        <EmptyState>
          Пока нет товаров с типом Stars или Premium. Заведите товар в разделе{" "}
          <Link href="/admin/bot-products" className="text-brand underline">Товары</Link>{" "}
          и укажите у варианта «Тип Fragment».
        </EmptyState>
      ) : (
        groups.map(({ product, variants }) => {
          const stars = variants.filter((v) => v.fragmentKind === "stars");
          const perStar = stars.find((v) => v.fragmentAmount === 1);
          const saved = rates.get(`stars_rate_${product.id}`) ?? null;
          // Default the form to the smallest pack at its current price — that is
          // almost always the rate the admin is thinking in.
          const anchor = [...stars].filter((v) => v.fragmentAmount > 1)
            .sort((a, b) => a.fragmentAmount - b.fragmentAmount)[0];
          const formRate = saved?.rate ?? (anchor ? { stars: anchor.fragmentAmount, priceUzs: anchor.priceUzs } : { stars: 50, priceUzs: 13000 });
          const formStep = saved?.step ?? 100;
          return (
            <div key={product.id} className="card p-5 space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{product.emoji}</span>
                  <span className="font-medium">{product.titleRu}</span>
                  <span className="badge bg-surface-2 text-muted text-xs">{variants.length} вар.</span>
                </div>
                <div className="flex items-center gap-2">
                  <form action={toggleBotProductActiveAction}>
                    <input type="hidden" name="id" value={product.id} />
                    <button
                      className={`badge cursor-pointer ${product.isActive ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}
                      title={product.isActive ? "Скрыть товар в боте" : "Показать товар в боте"}
                    >
                      {product.isActive ? "✅ Включён" : "🚫 Выключен"}
                    </button>
                  </form>
                  <Link href={`/admin/bot-products/${product.id}`} className="btn-ghost text-xs">
                    Полная карточка
                  </Link>
                </div>
              </div>


              {stars.length > 0 && (
                /* One rate, every pack. The preview shows exactly what the
                   button will write, so nothing is applied blind. */
                <form action={applyStarsRateAction} className="rounded-lg bg-surface-2 p-3 space-y-3">
                  <input type="hidden" name="productId" value={product.id} />
                  <div className="text-sm font-medium">⭐ Курс звёзд</div>
                  <div className="flex items-end gap-2 flex-wrap">
                    <label className="text-xs text-muted">
                      За сколько звёзд
                      <input name="rateStars" type="number" min="1" step="1" defaultValue={formRate.stars}
                             className="input text-sm font-mono w-28 block mt-1" />
                    </label>
                    <label className="text-xs text-muted">
                      Цена, сум
                      <input name="ratePrice" type="number" min="1" step="1" defaultValue={formRate.priceUzs}
                             className="input text-sm font-mono w-36 block mt-1" />
                    </label>
                    <label className="text-xs text-muted">
                      Округление
                      <select name="rateStep" defaultValue={String(formStep)} className="input text-sm w-32 block mt-1">
                        {STARS_ROUNDING_STEPS.map((st) => (
                          <option key={st} value={st}>{st === 1 ? "точно" : `до ${st} сум`}</option>
                        ))}
                      </select>
                    </label>
                    <button className="btn-primary text-sm">🔄 Пересчитать все цены</button>
                  </div>
                  <div className="text-xs text-muted">
                    По этому курсу получится:{" "}
                    {stars
                      .filter((v) => v.fragmentAmount > 1)
                      .sort((a, b) => a.fragmentAmount - b.fragmentAmount)
                      .map((v) => {
                        const next = priceForStars(v.fragmentAmount, formRate, formStep);
                        return (
                          <span key={v.id} className="font-mono mr-3 whitespace-nowrap">
                            {v.fragmentAmount}⭐ = {next.toLocaleString("ru-RU")}
                            {next !== v.priceUzs && <span className="text-warning"> (было {v.priceUzs.toLocaleString("ru-RU")})</span>}
                          </span>
                        );
                      })}
                  </div>
                </form>
              )}

              {/* Every price on this product in a single save. */}
              <form action={updateFragmentPricesAction} className="space-y-2">
                <input type="hidden" name="productId" value={product.id} />
                {variants.map((v) => (
                  <div key={v.id} className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-5 md:col-span-4 text-sm">
                      {v.titleRu}
                      {!v.isActive && <span className="ml-2 badge bg-danger/10 text-danger text-[10px]">выкл</span>}
                    </div>
                    <div className="col-span-3 md:col-span-2 text-xs text-muted font-mono">
                      {v.fragmentKind === "stars"
                        ? `${v.fragmentAmount} ⭐`
                        : `${v.fragmentAmount} мес.`}
                    </div>
                    <div className="col-span-4 md:col-span-3">
                      <input
                        name={`price_${v.id}`}
                        type="number"
                        min="0"
                        step="1"
                        defaultValue={v.priceUzs}
                        className="input text-sm font-mono w-full"
                      />
                    </div>
                    <div className="hidden md:block md:col-span-3 text-xs text-muted">сум</div>
                  </div>
                ))}
                <div className="pt-2">
                  <button className="btn-primary text-sm">💾 Сохранить цены</button>
                </div>
              </form>

              {stars.length > 0 && (
                <p className="text-xs text-muted border-t pt-3">
                  {perStar ? (
                    <>
                      ✅ Произвольное количество включено: в боте есть кнопка «Своё количество»,
                      можно заказать любое число звёзд от 50 (например 501). Цена считается по
                      курсу — {perStar.priceUzs.toLocaleString("ru-RU")} сум за 1 звезду. Сам вариант
                      «{perStar.titleRu}» покупателям в списке не показывается.
                    </>
                  ) : (
                    <>
                      ⓘ Кнопки «Своё количество» пока нет. Нажмите «Пересчитать все цены» — вариант
                      с ценой одной звезды будет создан автоматически, и покупатель сможет выбрать
                      любое число звёзд от 50.
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
