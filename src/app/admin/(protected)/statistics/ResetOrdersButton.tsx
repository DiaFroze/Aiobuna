"use client";

import React, { useState, useTransition } from "react";
import { resetSalesDataAction } from "./actions";

export function ResetOrdersButton() {
  const [isPending, startTransition] = useTransition();
  const [showConfirm, setShowConfirm] = useState(false);

  const handleReset = () => {
    startTransition(async () => {
      await resetSalesDataAction();
      setShowConfirm(false);
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setShowConfirm(true)}
        className="btn-danger text-xs py-1.5 px-3 flex items-center gap-1.5 shadow-sm"
        title="Обнулить все старые заказы и начать с чистого листа"
      >
        <span>🧹</span>
        <span>С чистого листа</span>
      </button>

      {showConfirm && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="card p-5 max-w-md w-full bg-surface-1 border border-border shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2 text-rose-500 font-semibold text-base">
              <span className="text-xl">⚠️</span>
              <span>Обнулить заказы и начать с чистого листа?</span>
            </div>
            <p className="text-xs text-muted leading-relaxed">
              Это действие удалит старые тестовые заказы и расходы, отвяжет склад и обнулит статистику продаж для старта в реальном режиме. Товары, планы, пользователи и реф-ссылки останутся нетронутыми.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                disabled={isPending}
                className="btn-secondary text-xs py-1.5 px-3"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={isPending}
                className="btn-danger text-xs py-1.5 px-3 flex items-center gap-1 font-medium"
              >
                {isPending ? "Обнуление..." : "Да, обнулить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
