"use client";

import { useState } from "react";
import { simulateSupplierRouting, type SupplierCandidate, type RoutingStrategy } from "@/lib/domain/supplier-routing";

export interface SimulatorVariant {
  id: number;
  title: string;
  productTitle: string;
  routingStrategy: string;
  autoSupplier: boolean;
  candidates: SupplierCandidate[];
}

export function RoutingSimulator({
  variants,
  balances,
}: {
  variants: SimulatorVariant[];
  balances: Record<string, number>;
}) {
  const [selectedVariantId, setSelectedVariantId] = useState<number>(variants[0]?.id ?? 0);
  const [strategy, setStrategy] = useState<RoutingStrategy>(
    (variants[0]?.routingStrategy as RoutingStrategy) || "cheapest",
  );
  const [quantity, setQuantity] = useState<number>(1);
  const [simulated, setSimulated] = useState<boolean>(false);

  const currentVariant = variants.find((v) => v.id === selectedVariantId) ?? variants[0];

  const handleVariantChange = (id: number) => {
    setSelectedVariantId(id);
    const v = variants.find((x) => x.id === id);
    if (v) {
      setStrategy((v.routingStrategy as RoutingStrategy) || "cheapest");
    }
    setSimulated(false);
  };

  const decision = currentVariant
    ? simulateSupplierRouting(currentVariant.candidates, strategy, balances, quantity)
    : null;

  return (
    <div className="card p-5 space-y-4 border border-brand/30 bg-surface-1">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-base flex items-center gap-2">
            <span>🔬 Интерактивный симулятор закупки</span>
            <span className="badge bg-brand/10 text-brand text-xs font-normal">Тест в реальном времени</span>
          </h3>
          <p className="text-xs text-muted mt-0.5">
            Проверьте, какой поставщик будет выбран прямо сейчас с учётом реальных балансов ваших API и цен закупки.
          </p>
        </div>
        <button
          onClick={() => setSimulated(true)}
          className="btn-primary text-xs px-4 py-2 flex items-center gap-1.5 shrink-0"
        >
          <span>⚡</span>
          <span>Запустить проверку</span>
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
        <div>
          <label className="text-xs font-medium text-muted">Товар и тариф</label>
          <select
            value={selectedVariantId}
            onChange={(e) => handleVariantChange(Number(e.target.value))}
            className="input text-xs mt-1 w-full"
          >
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.productTitle} — {v.title} ({v.candidates.length} API)
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-muted">Стратегия маршрутизации</label>
          <select
            value={strategy}
            onChange={(e) => {
              setStrategy(e.target.value as RoutingStrategy);
              setSimulated(true);
            }}
            className="input text-xs mt-1 w-full"
          >
            <option value="cheapest">💸 Самый дешевый (проверяет баланс и берёт мин. цену)</option>
            <option value="priority">🎯 Каскадный приоритет (Ур.1 → Ур.2 если нет денег/сток)</option>
            <option value="balance">💳 По наличию баланса (максимальный баланс)</option>
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-muted">Количество для закупки (шт.)</label>
          <input
            type="number"
            min="1"
            max="100"
            value={quantity}
            onChange={(e) => {
              setQuantity(Math.max(1, Number(e.target.value) || 1));
              setSimulated(true);
            }}
            className="input text-xs mt-1 w-full font-mono"
          />
        </div>
      </div>

      {decision && (
        <div className="mt-3 p-3.5 rounded-xl border bg-surface-2/60 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground uppercase tracking-wide">
              Результат симуляции для {quantity} шт.:
            </span>
            {decision.selectedCandidate ? (
              <span className="badge badge-success text-xs font-medium">
                ✅ Будет куплено у: <b>{decision.selectedCandidate.supplierKey.toUpperCase()}</b> (закупка: ${(decision.selectedCandidate.supplierPriceUsdt * quantity).toFixed(2)})
              </span>
            ) : (
              <span className="badge badge-danger text-xs font-medium">
                ❌ Нет доступного поставщика (заказ уйдёт на ручную выдачу)
              </span>
            )}
          </div>

          <div className="space-y-1.5 font-mono text-xs bg-black/25 p-3 rounded-lg border border-border/40 text-foreground">
            {decision.logs.map((log, idx) => (
              <div
                key={idx}
                className={
                  log.startsWith("🎯")
                    ? "text-success font-semibold pt-1 border-t border-border/30"
                    : log.startsWith("❌")
                    ? "text-danger"
                    : "text-muted"
                }
              >
                {log}
              </div>
            ))}
          </div>

          <div className="text-[11px] text-muted flex items-center gap-1.5">
            <span>ℹ️</span>
            <span>
              Если у выбранного поставщика в момент реального заказа возникнет ошибка API или сбой, бот автоматически переключится на следующего кандидата в списке без остановки продажи!
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
