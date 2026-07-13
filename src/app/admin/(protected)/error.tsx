"use client";

// Admin error boundary. Catches render errors (e.g. database unreachable) and
// shows a clear, actionable message with a MANUAL retry — instead of letting a
// crashing server component bubble up (which in dev looks like the page
// "auto-reloading" over and over).

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isDbError = /database|localhost:5432|P1001|reach database/i.test(error.message);

  return (
    <div className="max-w-lg mx-auto mt-16 card p-8 text-center space-y-4">
      <div className="text-3xl">⚠️</div>
      <h1 className="text-xl font-bold">Раздел временно недоступен</h1>
      {isDbError ? (
        <div className="text-sm text-muted space-y-2">
          <p>Не удаётся подключиться к базе данных.</p>
          <p>Запустите инфраструктуру и примените схему:</p>
          <pre className="text-left rounded-xl bg-surface-2 p-3 text-xs overflow-auto">
{`docker compose up db redis -d
npm run setup   # схема + seed`}
          </pre>
        </div>
      ) : (
        <p className="text-sm text-muted">Произошла ошибка при загрузке данных.</p>
      )}
      <button onClick={reset} className="btn-primary">
        Повторить
      </button>
    </div>
  );
}
