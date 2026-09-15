import Link from "next/link";
import { botDb, botConfigured } from "@/lib/botDb";
import { PageHeader, EmptyState } from "@/components/admin/ui";
import {
  sourceBalance,
  envVexSource,
  envBuyerSource,
  envQamifySource,
  type Source,
} from "@/lib/supplier";
import {
  addVariantSupplierAction,
  updateVariantSupplierAction,
  deleteVariantSupplierAction,
  setVariantRoutingStrategyAction,
  toggleVariantAutoSupplierAction,
  migrateLegacySupplierAction,
} from "./actions";
import { RoutingSimulator, type SimulatorVariant } from "./RoutingSimulator";

export const dynamic = "force-dynamic";

export default async function BotSuppliersPage() {
  if (!botConfigured()) {
    return (
      <div>
        <PageHeader title="Связки API и закупка" />
        <EmptyState>BOT_DATABASE_URL не задан в .env.</EmptyState>
      </div>
    );
  }

  // 1. Fetch API sources from DB and fallback envs
  const dbSources = await botDb.apiSource.findMany({ orderBy: { id: "asc" } });
  const envSources = [envBuyerSource(), envVexSource(), envQamifySource()]
    .filter((s): s is Source => Boolean(s))
    .filter((es) => !dbSources.some((d) => d.slug === es.slug));

  const allSources: Source[] = [
    ...dbSources.map((d) => ({
      slug: d.slug,
      baseUrl: d.baseUrl,
      apiKey: d.apiKey,
      format: d.format,
    })),
    ...envSources,
  ];

  // 2. Fetch live balances for each supplier API in parallel
  const balances: Record<string, number> = {};
  const balanceErrors: Record<string, string> = {};

  await Promise.allSettled(
    allSources.map(async (src) => {
      try {
        const bal = await sourceBalance(src);
        balances[src.slug] = bal;
      } catch (err) {
        balanceErrors[src.slug] = (err as Error).message;
        balances[src.slug] = 0;
      }
    }),
  );

  // 3. Fetch all products, plans, variants, and their linked multi-suppliers
  const products = await botDb.product.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      plans: {
        orderBy: { sortOrder: "asc" },
        include: {
          variants: {
            orderBy: { sortOrder: "asc" },
            include: {
              suppliers: {
                orderBy: { priority: "asc" },
              },
            },
          },
        },
      },
    },
  });

  // Prepare data for the interactive simulator
  const simulatorVariants: SimulatorVariant[] = [];
  for (const p of products) {
    for (const pl of p.plans) {
      for (const v of pl.variants) {
        const candidates =
          v.suppliers.length > 0
            ? v.suppliers.map((vs) => ({
                id: vs.id,
                supplierKey: vs.supplierKey,
                supplierExternalId: vs.supplierExternalId,
                supplierPriceUsdt: vs.supplierPriceUsdt,
                supplierStock: vs.supplierStock,
                priority: vs.priority,
                isActive: vs.isActive,
                name: vs.name ?? undefined,
              }))
            : v.supplierKey && v.supplierExternalId
            ? [
                {
                  supplierKey: v.supplierKey,
                  supplierExternalId: v.supplierExternalId,
                  supplierPriceUsdt: v.supplierPriceUsdt,
                  supplierStock: v.supplierStock,
                  priority: 1,
                  isActive: true,
                  name: `${v.titleRu} (${v.supplierKey})`,
                },
              ]
            : [];

        simulatorVariants.push({
          id: v.id,
          title: v.titleRu,
          productTitle: p.titleRu,
          routingStrategy: v.routingStrategy || "priority",
          autoSupplier: v.autoSupplier,
          candidates,
        });
      }
    }
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title="Связки API и автоматическая закупка"
        subtitle="Объединяйте разные API на один товар (например Gemini Pro), выбирайте самого выгодного поставщика и настраивайте резерв при нехватке баланса."
        action={
          <div className="flex gap-2">
            <Link href="/admin/bot-apis" className="btn-ghost text-sm">
              🔌 Настройки API-ключей
            </Link>
            <Link href="/admin/bot-import" className="btn-primary text-sm">
              ⇩ Импорт товаров
            </Link>
          </div>
        }
      />

      {/* 1. Live Balances of Connected Suppliers */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider flex items-center gap-2">
            <span>💳 Балансы подключенных API поставщиков</span>
            <span className="badge bg-brand/10 text-brand text-xs font-normal">Live</span>
          </h2>
          <span className="text-xs text-muted">
            Баланс проверяется перед каждым заказом
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {allSources.length === 0 ? (
            <div className="col-span-full card p-4 text-xs text-muted text-center">
              Нет подключенных API источников. Добавьте их в разделе{" "}
              <Link href="/admin/bot-apis" className="text-brand underline">
                API-источники
              </Link>
              .
            </div>
          ) : (
            allSources.map((src) => {
              const bal = balances[src.slug];
              const err = balanceErrors[src.slug];
              const isOk = bal !== undefined && bal > 0;
              return (
                <div
                  key={src.slug}
                  className={`card p-4 space-y-2 border transition-all ${
                    isOk
                      ? "border-success/30 bg-success/5"
                      : bal === 0
                      ? "border-warning/30 bg-warning/5"
                      : "border-danger/30 bg-danger/5"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm text-foreground uppercase">
                      {src.slug}
                    </span>
                    <span className="badge font-mono text-[10px] bg-surface-2">
                      {src.format}
                    </span>
                  </div>
                  <div>
                    <div className="text-xs text-muted">Баланс API:</div>
                    <div
                      className={`text-xl font-bold font-mono ${
                        isOk ? "text-success" : "text-warning"
                      }`}
                    >
                      ${(bal ?? 0).toFixed(2)}{" "}
                      <span className="text-xs font-normal text-muted">USDT</span>
                    </div>
                  </div>
                  {err ? (
                    <div className="text-[10px] text-danger truncate" title={err}>
                      ⚠️ {err}
                    </div>
                  ) : (
                    <div className="text-[10px] text-muted flex items-center gap-1">
                      <span className={isOk ? "text-success" : "text-warning"}>●</span>
                      <span>{isOk ? "Готов к закупке" : "Пополните баланс!"}</span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 2. Interactive Routing Simulator */}
      {simulatorVariants.length > 0 && (
        <RoutingSimulator
          variants={simulatorVariants}
          balances={balances}
        />
      )}

      {/* 3. Product Bindings Table & Cascade Settings */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              📦 Связки товаров и каскады поставщиков
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Для каждого тарифа можно привязать несколько API (Vex, Qamify, SoMaDeth). Если у одного кончились деньги или произошёл сбой — бот мгновенно купит у следующего!
            </p>
          </div>
        </div>

        <div className="space-y-6">
          {products.map((product) => {
            const allProductVariants = product.plans.flatMap((pl) => pl.variants);
            if (allProductVariants.length === 0) return null;

            return (
              <div
                key={product.id}
                className="card p-5 space-y-4 border border-border/80 bg-surface"
              >
                {/* Product Title Bar */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xl">{product.emoji || "✨"}</span>
                    <div>
                      <h3 className="font-bold text-foreground text-base">
                        {product.titleRu}
                      </h3>
                      <div className="text-xs text-muted flex items-center gap-2">
                        <span>Код: <code>{product.code}</code></span>
                        <span>•</span>
                        <span>Тарифов: {allProductVariants.length}</span>
                      </div>
                    </div>
                  </div>
                  <Link
                    href={`/admin/bot-products/${product.id}`}
                    className="btn-ghost text-xs self-start sm:self-auto"
                  >
                    Редактировать товар →
                  </Link>
                </div>

                {/* Variants loop */}
                <div className="space-y-4">
                  {allProductVariants.map((v) => {
                    const hasMulti = v.suppliers.length > 0;
                    const hasLegacy = Boolean(v.supplierKey && v.supplierExternalId);
                    const isConfigured = hasMulti || hasLegacy;

                    return (
                      <div
                        key={v.id}
                        className={`rounded-xl border p-4 space-y-3 transition-all ${
                          v.autoSupplier
                            ? "border-brand/25 bg-surface-1/60"
                            : "border-border/40 bg-surface-1/20 opacity-80"
                        }`}
                      >
                        {/* Variant Header Row */}
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-2 border-b border-border/40">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm text-foreground">
                                {v.titleRu}
                              </span>
                              <span className="badge bg-surface-3 text-muted text-xs font-mono">
                                {v.priceUzs.toLocaleString("ru-RU")} сум
                              </span>
                              {v.autoSupplier ? (
                                <span className="badge badge-success text-[10px]">
                                  ⚡ Автозаказ ВКЛ
                                </span>
                              ) : (
                                <span className="badge badge-warning text-[10px]">
                                  ⏸ Автозаказ ВЫКЛ
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-muted mt-0.5">
                              Связок API: <b>{v.suppliers.length}</b> {hasLegacy && !hasMulti && "(одиночный режим)"}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            {/* Strategy form */}
                            <form
                              action={setVariantRoutingStrategyAction}
                              className="flex items-center gap-1.5"
                            >
                              <input type="hidden" name="variantId" value={v.id} />
                              <label className="text-[11px] text-muted">Стратегия:</label>
                              <select
                                name="routingStrategy"
                                defaultValue={v.routingStrategy || "priority"}
                                onChange={(e) => e.target.form?.requestSubmit()}
                                className="input text-xs py-1 px-2 font-medium bg-surface-2 border"
                              >
                                <option value="cheapest">💸 Самый дешевый (с балансом)</option>
                                <option value="priority">🎯 Каскад по приоритету (Ур.1 → Ур.2)</option>
                                <option value="balance">💳 По наличию баланса</option>
                              </select>
                            </form>

                            {/* Toggle auto-supplier */}
                            <form action={toggleVariantAutoSupplierAction}>
                              <input type="hidden" name="variantId" value={v.id} />
                              <input
                                type="hidden"
                                name="autoSupplier"
                                value={v.autoSupplier ? "0" : "1"}
                              />
                              <button
                                type="submit"
                                className={`text-xs px-2.5 py-1 rounded-lg font-medium border ${
                                  v.autoSupplier
                                    ? "bg-warning/10 text-warning hover:bg-warning/20 border-warning/30"
                                    : "bg-success/10 text-success hover:bg-success/20 border-success/30"
                                }`}
                              >
                                {v.autoSupplier ? "Выключить автозаказ" : "Включить автозаказ"}
                              </button>
                            </form>
                          </div>
                        </div>

                        {/* If only single legacy supplier configured, offer 1-click migration */}
                        {hasLegacy && !hasMulti && (
                          <div className="p-3 rounded-lg bg-brand/5 border border-brand/20 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <div className="text-xs">
                              <span className="font-semibold text-brand">💡 Одиночный поставщик:</span>{" "}
                              <code className="font-bold">{v.supplierKey}</code> (ID: {v.supplierExternalId}, закупка: ${v.supplierPriceUsdt}).
                              Переведите в мульти-связку, чтобы добавить второй резервный API (Qamify, SoMaDeth и др.)!
                            </div>
                            <form action={migrateLegacySupplierAction} className="shrink-0">
                              <input type="hidden" name="variantId" value={v.id} />
                              <button className="btn-primary text-xs px-3 py-1.5">
                                ⚡ Перевести в мульти-связку (Уровень 1)
                              </button>
                            </form>
                          </div>
                        )}

                        {/* List of Connected API Suppliers */}
                        {v.suppliers.length > 0 ? (
                          <div className="space-y-2">
                            <div className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                              Подключенные поставщики (в порядке каскада):
                            </div>
                            {v.suppliers.map((s) => {
                              const srcBal = balances[s.supplierKey];
                              const isEnough = srcBal !== undefined && srcBal >= s.supplierPriceUsdt && srcBal > 0;

                              return (
                                <form
                                  key={s.id}
                                  action={updateVariantSupplierAction}
                                  className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg bg-surface border text-xs"
                                >
                                  <input type="hidden" name="id" value={s.id} />
                                  <input
                                    type="hidden"
                                    name="supplierExternalId"
                                    value={s.supplierExternalId}
                                  />

                                  {/* Priority level badge */}
                                  <span
                                    className={`badge font-bold px-2 py-0.5 ${
                                      s.priority === 1
                                        ? "bg-brand/20 text-brand border border-brand/30"
                                        : "bg-surface-3 text-muted"
                                    }`}
                                  >
                                    {s.priority === 1 ? "👑 Уровень 1 (Основной)" : `🛡 Уровень ${s.priority} (Резерв)`}
                                  </span>

                                  {/* Supplier Key */}
                                  <span className="font-mono font-bold text-foreground">
                                    {s.supplierKey.toUpperCase()}
                                  </span>

                                  {/* External Product ID */}
                                  <span className="text-muted font-mono text-[11px]">
                                    ID: <code className="bg-surface-2 px-1 py-0.5 rounded">{s.supplierExternalId}</code>
                                  </span>

                                  {/* Live API Balance badge */}
                                  <span
                                    className={`badge font-mono text-[11px] ${
                                      isEnough
                                        ? "bg-success/10 text-success border border-success/30"
                                        : srcBal === 0
                                        ? "bg-danger/10 text-danger border border-danger/30"
                                        : "bg-warning/10 text-warning border border-warning/30"
                                    }`}
                                  >
                                    Баланс API: ${(srcBal ?? 0).toFixed(2)}{" "}
                                    {isEnough ? "✅" : "⚠️"}
                                  </span>

                                  {/* Price USDT */}
                                  <div className="flex items-center gap-1">
                                    <span className="text-muted text-[11px]">Закупка:</span>
                                    <input
                                      name="supplierPriceUsdt"
                                      type="number"
                                      step="0.01"
                                      defaultValue={s.supplierPriceUsdt}
                                      className="input text-xs w-20 py-0.5 px-1.5 font-mono"
                                      title="Цена закупки в USDT"
                                    />
                                    <span className="text-muted font-mono">$</span>
                                  </div>

                                  {/* Priority input */}
                                  <div className="flex items-center gap-1">
                                    <span className="text-muted text-[11px]">Уровень:</span>
                                    <input
                                      name="priority"
                                      type="number"
                                      min="1"
                                      max="99"
                                      defaultValue={s.priority}
                                      className="input text-xs w-14 py-0.5 px-1.5 font-mono"
                                      title="1 = основной, 2 = резерв"
                                    />
                                  </div>

                                  {/* Stock input */}
                                  <div className="flex items-center gap-1">
                                    <span className="text-muted text-[11px]">Сток:</span>
                                    <input
                                      name="supplierStock"
                                      type="number"
                                      defaultValue={s.supplierStock}
                                      className="input text-xs w-16 py-0.5 px-1.5 font-mono"
                                      title="Остаток у поставщика"
                                    />
                                  </div>

                                  {/* Active checkbox */}
                                  <label className="flex items-center gap-1 text-muted text-[11px] cursor-pointer">
                                    <input
                                      type="checkbox"
                                      name="isActive"
                                      defaultChecked={s.isActive}
                                    />
                                    вкл
                                  </label>

                                  <div className="flex items-center gap-1 ml-auto">
                                    <button
                                      type="submit"
                                      className="btn-primary text-xs px-2.5 py-1"
                                      title="Сохранить изменения"
                                    >
                                      💾 Сохранить
                                    </button>
                                    <button
                                      formAction={deleteVariantSupplierAction}
                                      className="btn-danger text-xs px-2 py-1"
                                      title="Удалить связку"
                                    >
                                      🗑
                                    </button>
                                  </div>
                                </form>
                              );
                            })}
                          </div>
                        ) : (
                          !hasLegacy && (
                            <div className="text-xs text-muted italic p-2 bg-surface-2/40 rounded-lg">
                              Поставщики не привязаны. Добавьте первого поставщика ниже.
                            </div>
                          )
                        )}

                        {/* Form: Add a new API supplier to this variant */}
                        <form
                          action={addVariantSupplierAction}
                          className="pt-2 border-t border-border/40 space-y-2 bg-surface-2/30 p-3 rounded-lg"
                        >
                          <input type="hidden" name="variantId" value={v.id} />
                          <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                            <span>＋ Привязать API поставщика к тарифу «{v.titleRu}»:</span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-2 items-end">
                            <div>
                              <label className="text-[10px] text-muted">Поставщик (API Source)</label>
                              <select
                                name="supplierKey"
                                required
                                className="input text-xs mt-1 w-full bg-surface"
                              >
                                <option value="">— выберите API —</option>
                                {allSources.map((src) => (
                                  <option key={src.slug} value={src.slug}>
                                    {src.slug.toUpperCase()} (${(balances[src.slug] ?? 0).toFixed(2)})
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div>
                              <label className="text-[10px] text-muted">ID товара в API поставщика</label>
                              <input
                                name="supplierExternalId"
                                required
                                placeholder="напр. d4e55f34-... или 1024"
                                className="input text-xs font-mono mt-1 w-full bg-surface"
                              />
                            </div>

                            <div>
                              <label className="text-[10px] text-muted">Цена закупки ($ USDT)</label>
                              <input
                                name="supplierPriceUsdt"
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="3.50"
                                className="input text-xs font-mono mt-1 w-full bg-surface"
                              />
                            </div>

                            <div>
                              <label className="text-[10px] text-muted">Уровень приоритета</label>
                              <input
                                name="priority"
                                type="number"
                                min="1"
                                max="99"
                                defaultValue={v.suppliers.length + 1}
                                className="input text-xs font-mono mt-1 w-full bg-surface"
                                title="1 = Основной, 2 = Резервный"
                              />
                            </div>

                            <div>
                              <input type="hidden" name="isActive" value="on" />
                              <button
                                type="submit"
                                className="btn-primary text-xs w-full py-2"
                              >
                                ＋ Добавить связку
                              </button>
                            </div>
                          </div>
                        </form>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
