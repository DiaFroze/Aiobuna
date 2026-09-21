"use client";

import { useState } from "react";
import { testMetaConnectionAction } from "../actions";

export function MetaConnectionTester() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    account?: any;
  } | null>(null);

  const handleTest = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await testMetaConnectionAction();
      setResult(res);
    } catch (e: any) {
      setResult({
        ok: false,
        message: e?.message || "Не удалось связаться с сервером.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={handleTest}
        disabled={loading}
        className="btn-secondary text-xs sm:text-sm inline-flex items-center gap-2"
      >
        {loading ? (
          <>
            <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full" />
            Проверка связи с Meta API...
          </>
        ) : (
          <>🔍 Проверить подключение</>
        )}
      </button>

      {result && (
        <div
          className={`p-3.5 rounded-lg border text-xs leading-relaxed ${
            result.ok
              ? "bg-success/10 border-success/30 text-success"
              : "bg-danger/10 border-danger/30 text-danger"
          }`}
        >
          <div className="font-semibold mb-0.5">
            {result.ok ? "✅ Соединение успешно установлено" : "❌ Ошибка подключения"}
          </div>
          <div>{result.message}</div>
          {result.account && (
            <div className="mt-2 pt-2 border-t border-success/20 grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px] text-foreground">
              <div>
                <span className="text-muted block text-[10px]">ID аккаунта:</span>
                {result.account.id}
              </div>
              <div>
                <span className="text-muted block text-[10px]">Название:</span>
                {result.account.name}
              </div>
              <div>
                <span className="text-muted block text-[10px]">Валюта:</span>
                {result.account.currency}
              </div>
              <div>
                <span className="text-muted block text-[10px]">Часовой пояс:</span>
                {result.account.timezone}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
