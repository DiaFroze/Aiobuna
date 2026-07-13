// Client-safe formatting helpers (no server-only imports).

export function formatMoney(amount: number, currency: string, locale = "ru-RU"): string {
  if (currency === "UZS") {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(amount)} сум`;
  }
  const symbol = currency === "USD" ? "$" : currency === "USDT" ? "USDT " : `${currency} `;
  const value = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return currency === "USD" ? `${symbol}${value}` : `${symbol}${value}`;
}

export function formatDate(d: Date | string, locale = "ru-RU"): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatPercent(p: number): string {
  return `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;
}
