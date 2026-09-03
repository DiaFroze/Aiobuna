"use client";

import { useState, useMemo } from "react";
import {
  type StockPayloadType,
  type StructuredStockPayload,
  parseStockPayload,
  formatSingleStockPayloadForTelegram,
  serializeStockPayload,
} from "@/lib/domain/stock-payload";
import { importStockAction } from "./actions";

interface VariantOption {
  id: number;
  label: string;
}

interface StockUploaderProps {
  variants: VariantOption[];
}

export function StockUploader({ variants }: StockUploaderProps) {
  const [selectedVariant, setSelectedVariant] = useState<number>(variants[0]?.id ?? 0);
  const [format, setFormat] = useState<StockPayloadType>("account");
  const [inputMode, setInputMode] = useState<"fields" | "bulk">("fields");

  // Fields mode state
  const [accountRows, setAccountRows] = useState<{ login: string; password: string; extra: string }[]>([
    { login: "", password: "", extra: "" },
  ]);
  const [linkPromoRows, setLinkPromoRows] = useState<{ link: string; promo: string }[]>([
    { link: "", promo: "" },
  ]);
  const [linkRows, setLinkRows] = useState<{ link: string }[]>([{ link: "" }]);
  const [codeRows, setCodeRows] = useState<{ code: string }[]>([{ code: "" }]);
  const [textRows, setTextRows] = useState<{ text: string }[]>([{ text: "" }]);

  // Bulk mode state
  const [bulkText, setBulkText] = useState<string>("");
  const [delimiter, setDelimiter] = useState<string>(":");
  const [noMono, setNoMono] = useState<boolean>(false);

  // Common parameters
  const [copies, setCopies] = useState<number>(1);
  const [allowDuplicates, setAllowDuplicates] = useState<boolean>(false);
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);

  // Derive structured payloads from current state
  const currentItems: StructuredStockPayload[] = useMemo(() => {
    if (inputMode === "fields") {
      switch (format) {
        case "account":
          return accountRows
            .filter((r) => r.login.trim() || r.password.trim())
            .map((r) => ({
              type: "account",
              login: r.login.trim(),
              password: r.password.trim(),
              extra: r.extra.trim() || undefined,
            }));
        case "link_promo":
          return linkPromoRows
            .filter((r) => r.link.trim() || r.promo.trim())
            .map((r) => ({
              type: "link_promo",
              link: r.link.trim(),
              promo: r.promo.trim(),
            }));
        case "link":
          return linkRows
            .filter((r) => r.link.trim())
            .map((r) => ({
              type: "link",
              link: r.link.trim(),
            }));
        case "code":
          return codeRows
            .filter((r) => r.code.trim())
            .map((r) => ({
              type: "code",
              code: r.code.trim(),
            }));
        case "text":
          return textRows
            .filter((r) => r.text.trim())
            .map((r) => ({
              type: "text",
              text: r.text.trim(),
              noMono,
            }));
      }
    } else {
      // Bulk mode
      const lines = bulkText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (lines.length === 0) return [];

      return lines.map((line) => {
        if (format === "account") {
          const parts = line.split(delimiter);
          const login = (parts[0] ?? "").trim();
          const password = (parts[1] ?? "").trim();
          const extra = parts.slice(2).join(delimiter).trim();
          return {
            type: "account",
            login,
            password,
            extra: extra || undefined,
          };
        }
        if (format === "link_promo") {
          const parts = line.split(delimiter);
          return {
            type: "link_promo",
            link: (parts[0] ?? "").trim(),
            promo: (parts.slice(1).join(delimiter) ?? "").trim(),
          };
        }
        if (format === "link") {
          return { type: "link", link: line };
        }
        if (format === "code") {
          return { type: "code", code: line };
        }
        return { type: "text", text: line, noMono };
      });
    }
  }, [
    inputMode,
    format,
    accountRows,
    linkPromoRows,
    linkRows,
    codeRows,
    textRows,
    bulkText,
    delimiter,
    noMono,
  ]);

  // Preview item: first entered item, or default sample if empty
  const previewItem: StructuredStockPayload = useMemo(() => {
    if (currentItems.length > 0) return currentItems[0];
    switch (format) {
      case "account":
        return {
          type: "account",
          login: "customer@gmail.com",
          password: "SecurePass2026!",
        };
      case "link_promo":
        return {
          type: "link_promo",
          link: "https://serviceactivation.google.com/redeem?token=sample",
          promo: "PROMO-2026-VIP",
        };
      case "link":
        return {
          type: "link",
          link: "https://serviceactivation.google.com/redeem?token=sample",
        };
      case "code":
        return {
          type: "code",
          code: "VEX-PROMO-999-ABCD",
        };
      case "text":
        return {
          type: "text",
          text: "Инструкция: войдите в профиль и активируйте подарочную карту.",
          noMono,
        };
    }
  }, [currentItems, format, noMono]);

  const previewHtml = useMemo(() => {
    return formatSingleStockPayloadForTelegram(previewItem, "ru");
  }, [previewItem]);

  const handleCopySimulation = (text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedNotice(text);
      setTimeout(() => setCopiedNotice(null), 1800);
    }
  };

  const serializedItems = useMemo(() => {
    return currentItems.map((it) => serializeStockPayload(it));
  }, [currentItems]);

  return (
    <div className="card p-6 space-y-6">
      <div className="border-b pb-4">
        <h3 className="text-lg font-bold flex items-center gap-2">
          <span>📥</span> Умная загрузка товаров на склад
        </h3>
        <p className="text-sm text-muted mt-1">
          Раздельные поля для email и ссылок, двойной моно (тап для копирования каждого поля отдельно) и живое превью сообщения Telegram.
        </p>
      </div>

      <div className="grid lg:grid-cols-12 gap-6">
        {/* Left column: Form configuration & inputs */}
        <div className="lg:col-span-7 space-y-5">
          {/* 1. Variant selection */}
          <div>
            <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-1.5">
              1. Выберите товар
            </label>
            <select
              value={selectedVariant}
              onChange={(e) => setSelectedVariant(Number(e.target.value))}
              className="input w-full text-sm font-medium"
            >
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          {/* 2. Format selection */}
          <div>
            <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-2">
              2. Формат товара
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setFormat("account")}
                className={`p-3 rounded-lg border text-left transition flex flex-col gap-1 ${
                  format === "account"
                    ? "border-brand bg-brand/10 text-foreground ring-1 ring-brand"
                    : "border-border/60 hover:bg-surface-2 text-muted"
                }`}
              >
                <div className="font-semibold text-sm flex items-center gap-1.5">
                  <span>👤🔑</span> Email + Пароль
                </div>
                <div className="text-[11px] text-muted leading-tight">
                  Два отдельных моно: копируются по тапу
                </div>
              </button>

              <button
                type="button"
                onClick={() => setFormat("link_promo")}
                className={`p-3 rounded-lg border text-left transition flex flex-col gap-1 ${
                  format === "link_promo"
                    ? "border-brand bg-brand/10 text-foreground ring-1 ring-brand"
                    : "border-border/60 hover:bg-surface-2 text-muted"
                }`}
              >
                <div className="font-semibold text-sm flex items-center gap-1.5">
                  <span>🔗🎟</span> Ссылка + Код
                </div>
                <div className="text-[11px] text-muted leading-tight">
                  Кликабельная ссылка сверху, промокод снизу
                </div>
              </button>

              <button
                type="button"
                onClick={() => setFormat("link")}
                className={`p-3 rounded-lg border text-left transition flex flex-col gap-1 ${
                  format === "link"
                    ? "border-brand bg-brand/10 text-foreground ring-1 ring-brand"
                    : "border-border/60 hover:bg-surface-2 text-muted"
                }`}
              >
                <div className="font-semibold text-sm flex items-center gap-1.5">
                  <span>🔗</span> Только ссылка
                </div>
                <div className="text-[11px] text-muted leading-tight">
                  Чистая ссылка без лишнего моно
                </div>
              </button>

              <button
                type="button"
                onClick={() => setFormat("code")}
                className={`p-3 rounded-lg border text-left transition flex flex-col gap-1 ${
                  format === "code"
                    ? "border-brand bg-brand/10 text-foreground ring-1 ring-brand"
                    : "border-border/60 hover:bg-surface-2 text-muted"
                }`}
              >
                <div className="font-semibold text-sm flex items-center gap-1.5">
                  <span>🎟</span> Только промокод
                </div>
                <div className="text-[11px] text-muted leading-tight">
                  Один ключ/код активации
                </div>
              </button>

              <button
                type="button"
                onClick={() => setFormat("text")}
                className={`p-3 rounded-lg border text-left transition flex flex-col gap-1 ${
                  format === "text"
                    ? "border-brand bg-brand/10 text-foreground ring-1 ring-brand"
                    : "border-border/60 hover:bg-surface-2 text-muted"
                }`}
              >
                <div className="font-semibold text-sm flex items-center gap-1.5">
                  <span>📝</span> Свой текст
                </div>
                <div className="text-[11px] text-muted leading-tight">
                  Свободный текст (с моно или без)
                </div>
              </button>
            </div>
          </div>

          {/* 3. Input Mode tabs */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-muted uppercase tracking-wider">
                3. Способ ввода
              </label>
              <div className="inline-flex rounded-lg bg-surface-2 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setInputMode("fields")}
                  className={`px-3 py-1 rounded-md transition ${
                    inputMode === "fields"
                      ? "bg-brand text-brand-fg shadow-sm"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  ✍️ Построчно в поля
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode("bulk")}
                  className={`px-3 py-1 rounded-md transition ${
                    inputMode === "bulk"
                      ? "bg-brand text-brand-fg shadow-sm"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  📑 Массовая вставка списком
                </button>
              </div>
            </div>

            {/* Fields mode inputs */}
            {inputMode === "fields" && (
              <div className="space-y-3 bg-surface-1 p-4 rounded-xl border border-border/60">
                {format === "account" && (
                  <div className="space-y-3">
                    {accountRows.map((row, idx) => (
                      <div key={idx} className="p-3 bg-surface-2/60 rounded-lg space-y-2 border border-border/40">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-brand">Аккаунт #{idx + 1}</span>
                          {accountRows.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setAccountRows(accountRows.filter((_, i) => i !== idx))}
                              className="text-xs text-danger hover:underline"
                            >
                              ✕ Удалить
                            </button>
                          )}
                        </div>
                        <div className="grid sm:grid-cols-2 gap-2">
                          <div>
                            <label className="text-[11px] text-muted">Email или Логин</label>
                            <input
                              type="text"
                              value={row.login}
                              onChange={(e) => {
                                const next = [...accountRows];
                                next[idx].login = e.target.value;
                                setAccountRows(next);
                              }}
                              placeholder="user@example.com"
                              className="input text-xs font-mono mt-0.5"
                            />
                          </div>
                          <div>
                            <label className="text-[11px] text-muted">Пароль</label>
                            <input
                              type="text"
                              value={row.password}
                              onChange={(e) => {
                                const next = [...accountRows];
                                next[idx].password = e.target.value;
                                setAccountRows(next);
                              }}
                              placeholder="Pass12345!"
                              className="input text-xs font-mono mt-0.5"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="text-[11px] text-muted">Доп. инфо / 2FA (необязательно)</label>
                          <input
                            type="text"
                            value={row.extra}
                            onChange={(e) => {
                              const next = [...accountRows];
                              next[idx].extra = e.target.value;
                              setAccountRows(next);
                            }}
                            placeholder="Код 2FA или инструкция"
                            className="input text-xs font-mono mt-0.5"
                          />
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setAccountRows([...accountRows, { login: "", password: "", extra: "" }])}
                      className="btn-secondary text-xs w-full py-2"
                    >
                      ＋ Добавить ещё один аккаунт
                    </button>
                  </div>
                )}

                {format === "link_promo" && (
                  <div className="space-y-3">
                    {linkPromoRows.map((row, idx) => (
                      <div key={idx} className="p-3 bg-surface-2/60 rounded-lg space-y-2 border border-border/40">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-brand">Позиция #{idx + 1}</span>
                          {linkPromoRows.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setLinkPromoRows(linkPromoRows.filter((_, i) => i !== idx))}
                              className="text-xs text-danger hover:underline"
                            >
                              ✕ Удалить
                            </button>
                          )}
                        </div>
                        <div>
                          <label className="text-[11px] text-muted">Ссылка для активации</label>
                          <input
                            type="url"
                            value={row.link}
                            onChange={(e) => {
                              const next = [...linkPromoRows];
                              next[idx].link = e.target.value;
                              setLinkPromoRows(next);
                            }}
                            placeholder="https://serviceactivation.google.com/..."
                            className="input text-xs font-mono mt-0.5"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-muted">Промокод / Ключ</label>
                          <input
                            type="text"
                            value={row.promo}
                            onChange={(e) => {
                              const next = [...linkPromoRows];
                              next[idx].promo = e.target.value;
                              setLinkPromoRows(next);
                            }}
                            placeholder="PROMO-2026-XYZ"
                            className="input text-xs font-mono mt-0.5"
                          />
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setLinkPromoRows([...linkPromoRows, { link: "", promo: "" }])}
                      className="btn-secondary text-xs w-full py-2"
                    >
                      ＋ Добавить ещё пару ссылка + код
                    </button>
                  </div>
                )}

                {format === "link" && (
                  <div className="space-y-3">
                    {linkRows.map((row, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="url"
                          value={row.link}
                          onChange={(e) => {
                            const next = [...linkRows];
                            next[idx].link = e.target.value;
                            setLinkRows(next);
                          }}
                          placeholder="https://..."
                          className="input text-xs font-mono flex-1"
                        />
                        {linkRows.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setLinkRows(linkRows.filter((_, i) => i !== idx))}
                            className="text-danger text-sm px-2"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setLinkRows([...linkRows, { link: "" }])}
                      className="btn-secondary text-xs w-full py-2"
                    >
                      ＋ Добавить ещё ссылку
                    </button>
                  </div>
                )}

                {format === "code" && (
                  <div className="space-y-3">
                    {codeRows.map((row, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={row.code}
                          onChange={(e) => {
                            const next = [...codeRows];
                            next[idx].code = e.target.value;
                            setCodeRows(next);
                          }}
                          placeholder="KEY-XXXX-YYYY"
                          className="input text-xs font-mono flex-1"
                        />
                        {codeRows.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setCodeRows(codeRows.filter((_, i) => i !== idx))}
                            className="text-danger text-sm px-2"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setCodeRows([...codeRows, { code: "" }])}
                      className="btn-secondary text-xs w-full py-2"
                    >
                      ＋ Добавить ещё промокод
                    </button>
                  </div>
                )}

                {format === "text" && (
                  <div className="space-y-3">
                    {textRows.map((row, idx) => (
                      <div key={idx} className="space-y-1">
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-muted">Текст #{idx + 1}</span>
                          {textRows.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setTextRows(textRows.filter((_, i) => i !== idx))}
                              className="text-danger hover:underline"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        <textarea
                          rows={3}
                          value={row.text}
                          onChange={(e) => {
                            const next = [...textRows];
                            next[idx].text = e.target.value;
                            setTextRows(next);
                          }}
                          placeholder="Введите текст товара..."
                          className="input text-xs font-mono"
                        />
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setTextRows([...textRows, { text: "" }])}
                      className="btn-secondary text-xs w-full py-2"
                    >
                      ＋ Добавить ещё вариант текста
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Bulk mode inputs */}
            {inputMode === "bulk" && (
              <div className="space-y-3 bg-surface-1 p-4 rounded-xl border border-border/60">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted">
                    {format === "account" && "Вставьте список (каждая строка: логин:пароль)"}
                    {format === "link_promo" && "Вставьте список (каждая строка: ссылка : промокод)"}
                    {format === "link" && "Вставьте список ссылок (по одной на строку)"}
                    {format === "code" && "Вставьте список кодов (по одному на строку)"}
                    {format === "text" && "Вставьте текст (каждая строка — отдельный товар)"}
                  </span>
                  {(format === "account" || format === "link_promo") && (
                    <div className="flex items-center gap-1.5 text-xs text-muted">
                      <span>Разделитель:</span>
                      <select
                        value={delimiter}
                        onChange={(e) => setDelimiter(e.target.value)}
                        className="input text-xs py-0.5 px-2 font-mono w-auto"
                      >
                        <option value=":">Двоеточие (:)</option>
                        <option value="|">Вертикальная черта (|)</option>
                        <option value=";">Точка с запятой (;)</option>
                        <option value="	">Табуляция (Tab)</option>
                      </select>
                    </div>
                  )}
                </div>

                <textarea
                  rows={8}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={
                    format === "account"
                      ? "alice@gmail.com:pass123\nbob@gmail.com:pass456\ncharlie@gmail.com:pass789"
                      : format === "link_promo"
                      ? "https://site.com/redeem:PROMO1\nhttps://site.com/redeem:PROMO2"
                      : format === "link"
                      ? "https://site.com/link1\nhttps://site.com/link2"
                      : format === "code"
                      ? "CODE-001\nCODE-002\nCODE-003"
                      : "Товар 1\nТовар 2\nТовар 3"
                  }
                  className="input font-mono text-xs"
                />

                <div className="text-xs text-muted flex items-center justify-between">
                  <span>
                    Распознано строк: <b className="text-foreground">{currentItems.length}</b>
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Option: No-mono for text format */}
          {format === "text" && (
            <div className="flex items-center gap-2 p-3 bg-surface-2/40 rounded-lg border border-border/40">
              <input
                type="checkbox"
                id="noMonoCheckbox"
                checked={noMono}
                onChange={(e) => setNoMono(e.target.checked)}
                className="rounded"
              />
              <label htmlFor="noMonoCheckbox" className="text-xs text-foreground select-none cursor-pointer">
                <b>Без моно (обычный текст)</b> — отправлять как обычный абзац без рамки <code>&lt;code&gt;</code>.
              </label>
            </div>
          )}

          {/* 4. Quantity & duplicates */}
          <div className="grid sm:grid-cols-2 gap-4 pt-2">
            <div>
              <label className="text-xs text-muted font-medium">Копий каждого товара</label>
              <input
                type="number"
                min={1}
                max={5000}
                value={copies}
                onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 1))}
                className="input mt-1 text-sm font-medium"
              />
              <p className="text-[11px] text-muted mt-1">
                Если 1 ссылка/аккаунт рассчитан на несколько клиентов (например, многоместная подписка).
              </p>
            </div>

            <div className="flex items-start gap-2 sm:pt-6">
              <input
                type="checkbox"
                id="allowDupesCheck"
                checked={allowDuplicates}
                onChange={(e) => setAllowDuplicates(e.target.checked)}
                className="mt-1"
              />
              <label htmlFor="allowDupesCheck" className="text-xs cursor-pointer select-none">
                <b>Разрешить дубликаты</b>
                <span className="block text-[11px] text-muted">
                  Добавить, даже если такой товар уже есть в базе.
                </span>
              </label>
            </div>
          </div>

          {/* Hidden Form to execute Server Action */}
          <form action={importStockAction} className="pt-2">
            <input type="hidden" name="variantId" value={selectedVariant} />
            <input type="hidden" name="copies" value={copies} />
            <input type="hidden" name="allowDuplicates" value={allowDuplicates ? "on" : ""} />
            <input type="hidden" name="itemsJson" value={JSON.stringify(serializedItems)} />

            <button
              type="submit"
              disabled={currentItems.length === 0}
              className="btn-primary w-full py-3 text-sm font-semibold flex items-center justify-center gap-2 shadow-lg disabled:opacity-50"
            >
              <span>✅</span> Загрузить {currentItems.length > 0 ? `(${currentItems.length * copies} шт.)` : ""} на склад
            </button>
          </form>
        </div>

        {/* Right column: Interactive Telegram Live Preview */}
        <div className="lg:col-span-5 flex flex-col">
          <div className="sticky top-6 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted flex items-center gap-1.5">
                <span>📱</span> Как это видит покупатель в Telegram
              </span>
              <span className="badge bg-brand/10 text-brand text-[10px]">Live Preview</span>
            </div>

            {/* Telegram simulated chat bubble */}
            <div className="bg-[#18222d] text-white rounded-2xl p-4 shadow-xl border border-white/5 space-y-3 text-sm leading-relaxed">
              {/* Header */}
              <div className="flex items-center gap-2 text-xs text-sky-400 border-b border-white/10 pb-2">
                <span className="font-bold">Aiobuna Bot</span>
                <span className="text-[10px] text-white/40">bot · 15:42</span>
              </div>

              {/* Order paid info */}
              <div className="text-xs text-white/70 space-y-1">
                <div className="font-semibold text-emerald-400">✅ Заказ #1042 оплачен!</div>
                <div className="text-white/90 font-medium">
                  {variants.find((v) => v.id === selectedVariant)?.label ?? "Товар"}
                </div>
                <div className="text-[11px] text-white/50">Списано: 35 000 сум</div>
              </div>

              <div className="border-t border-white/10 pt-2 space-y-2">
                <div className="font-bold text-amber-300 text-xs">🎁 Ваш товар:</div>

                {/* Body formatted according to type */}
                {previewItem.type === "account" && (
                  <div className="space-y-2 text-xs">
                    <div>
                      <div className="text-white/60 text-[11px]">📧 Логин / Email:</div>
                      <div
                        onClick={() => handleCopySimulation(previewItem.login)}
                        className="font-mono bg-[#0e1621] text-emerald-300 px-2.5 py-1.5 rounded-lg border border-white/10 mt-0.5 cursor-pointer hover:bg-white/5 transition flex items-center justify-between"
                        title="Нажмите, чтобы скопировать"
                      >
                        <span className="truncate">{previewItem.login || "login@example.com"}</span>
                        <span className="text-[10px] text-white/30 ml-2 select-none">копировать ❐</span>
                      </div>
                    </div>

                    <div>
                      <div className="text-white/60 text-[11px]">🔑 Пароль:</div>
                      <div
                        onClick={() => handleCopySimulation(previewItem.password)}
                        className="font-mono bg-[#0e1621] text-emerald-300 px-2.5 py-1.5 rounded-lg border border-white/10 mt-0.5 cursor-pointer hover:bg-white/5 transition flex items-center justify-between"
                        title="Нажмите, чтобы скопировать"
                      >
                        <span className="truncate">{previewItem.password || "Password123"}</span>
                        <span className="text-[10px] text-white/30 ml-2 select-none">копировать ❐</span>
                      </div>
                    </div>

                    {previewItem.extra && (
                      <div>
                        <div className="text-white/60 text-[11px]">ℹ️ Дополнительно:</div>
                        <div
                          onClick={() => handleCopySimulation(previewItem.extra!)}
                          className="font-mono bg-[#0e1621] text-sky-300 px-2.5 py-1.5 rounded-lg border border-white/10 mt-0.5 cursor-pointer hover:bg-white/5 transition flex items-center justify-between"
                        >
                          <span className="truncate">{previewItem.extra}</span>
                          <span className="text-[10px] text-white/30 ml-2 select-none">копировать ❐</span>
                        </div>
                      </div>
                    )}

                    <div className="text-[11px] text-white/40 italic pt-1">
                      (нажмите на логин или пароль, чтобы скопировать)
                    </div>
                  </div>
                )}

                {previewItem.type === "link_promo" && (
                  <div className="space-y-2 text-xs">
                    <div>
                      <div className="text-white/60 text-[11px]">🔗 Ссылка для активации:</div>
                      <a
                        href={previewItem.link || "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:underline break-all block mt-0.5"
                      >
                        {previewItem.link || "https://serviceactivation.google.com/..."}
                      </a>
                    </div>

                    <div>
                      <div className="text-white/60 text-[11px]">🎟 Промокод / Ключ:</div>
                      <div
                        onClick={() => handleCopySimulation(previewItem.promo)}
                        className="font-mono bg-[#0e1621] text-emerald-300 px-2.5 py-1.5 rounded-lg border border-white/10 mt-0.5 cursor-pointer hover:bg-white/5 transition flex items-center justify-between"
                        title="Нажмите, чтобы скопировать"
                      >
                        <span className="truncate">{previewItem.promo || "PROMO-XYZ"}</span>
                        <span className="text-[10px] text-white/30 ml-2 select-none">копировать ❐</span>
                      </div>
                    </div>

                    <div className="text-[11px] text-white/40 italic pt-1">
                      (нажмите на промокод, чтобы скопировать)
                    </div>
                  </div>
                )}

                {previewItem.type === "link" && (
                  <div className="space-y-1.5 text-xs">
                    <div className="text-white/60 text-[11px]">🔗 Ссылка для активации:</div>
                    <a
                      href={previewItem.link || "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sky-400 hover:underline break-all block"
                    >
                      {previewItem.link || "https://serviceactivation.google.com/..."}
                    </a>
                  </div>
                )}

                {previewItem.type === "code" && (
                  <div className="space-y-1.5 text-xs">
                    <div className="text-white/60 text-[11px]">🎟 Промокод / Ключ:</div>
                    <div
                      onClick={() => handleCopySimulation(previewItem.code)}
                      className="font-mono bg-[#0e1621] text-emerald-300 px-2.5 py-1.5 rounded-lg border border-white/10 cursor-pointer hover:bg-white/5 transition flex items-center justify-between"
                    >
                      <span className="truncate">{previewItem.code || "VEX-KEY-ABCD"}</span>
                      <span className="text-[10px] text-white/30 ml-2 select-none">копировать ❐</span>
                    </div>
                    <div className="text-[11px] text-white/40 italic">
                      (нажмите на промокод, чтобы скопировать)
                    </div>
                  </div>
                )}

                {previewItem.type === "text" && (
                  <div className="text-xs">
                    {previewItem.noMono ? (
                      <div className="text-white/90 whitespace-pre-wrap">
                        {previewItem.text || "Инструкция к товару без моно."}
                      </div>
                    ) : (
                      <div
                        onClick={() => handleCopySimulation(previewItem.text)}
                        className="font-mono bg-[#0e1621] text-emerald-300 p-2.5 rounded-lg border border-white/10 cursor-pointer hover:bg-white/5 transition whitespace-pre-wrap"
                      >
                        {previewItem.text || "Текст в блоке code"}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Telegram action buttons */}
              <div className="space-y-1.5 pt-2">
                <button
                  type="button"
                  className="w-full py-2 bg-[#2b5278] hover:bg-[#2e5984] text-white rounded-lg text-xs font-semibold text-center transition select-none"
                >
                  ✅ Я получил товар
                </button>
                <button
                  type="button"
                  className="w-full py-2 bg-white/10 hover:bg-white/15 text-white/80 rounded-lg text-xs font-medium text-center transition select-none"
                >
                  ⬅️ В магазин
                </button>
              </div>
            </div>

            {/* Notification when copied in preview */}
            {copiedNotice && (
              <div className="p-2 bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 text-xs rounded-lg text-center font-mono">
                ✓ Скопировано в буфер: {copiedNotice}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
