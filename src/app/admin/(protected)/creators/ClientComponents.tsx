"use client";

import React, { useState, useTransition } from "react";
import {
  createCreatorAction,
  updateCreatorAction,
  saveCreatorProductRatesAction,
  approvePayoutAction,
  rejectPayoutAction,
} from "./actions";
import { extractCreatorSlug } from "@/lib/domain/creators";

export function CopyButton({
  text,
  label = "Копировать",
  className = "btn-secondary text-xs py-1 px-2.5",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <button type="button" onClick={handleCopy} className={className}>
      {copied ? "✅ Скопировано!" : label}
    </button>
  );
}

export function CreatorModal({
  creator,
  onClose,
}: {
  creator?: any;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [codeVal, setCodeVal] = useState(creator?.code || "");

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const clean = extractCreatorSlug(raw);
    setCodeVal(clean || raw);
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      try {
        const res = creator
          ? await updateCreatorAction(formData)
          : await createCreatorAction(formData);
        if (res && !res.success) {
          setError(res.error || "Ошибка сохранения");
        } else {
          onClose();
        }
      } catch (err: any) {
        setError(err.message || "Ошибка сохранения");
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card max-w-lg w-full p-6 relative max-h-[90vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-muted hover:text-text text-xl"
        >
          ✕
        </button>
        <h2 className="text-xl font-bold mb-4">
          {creator ? `Редактирование: ${creator.name}` : "Добавить нового креатора"}
        </h2>

        {error && (
          <div className="p-3 mb-4 rounded bg-danger/10 border border-danger/30 text-danger text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {creator && <input type="hidden" name="id" value={creator.id} />}

          <div>
            <label className="block text-xs font-semibold text-muted mb-1">
              Имя / Название медийки *
            </label>
            <input
              name="name"
              required
              defaultValue={creator?.name || ""}
              placeholder="Например: Alex Media или @alex_ai"
              className="w-full input text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted mb-1">
              Реферальный слаг / код (t.me/...start=c_КОД) *
            </label>
            <input
              name="code"
              required
              value={codeVal}
              onChange={handleCodeChange}
              placeholder="alex, media2026, meta_campaign"
              className="w-full input text-sm font-mono"
            />
            <div className="flex items-center justify-between text-xs text-muted mt-1 gap-2 flex-wrap">
              <span>Латиница, цифры, дефис, подчеркивание (можно вставить ссылку)</span>
              {codeVal && (
                <span className="text-brand font-medium">
                  Ссылка: t.me/...start=c_{codeVal}
                </span>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted mb-1">
              Базовая ставка за заказ по умолчанию (UZS) *
            </label>
            <input
              type="number"
              name="defaultRateUzs"
              required
              defaultValue={creator?.defaultRateUzs ?? 10000}
              step="1000"
              min="0"
              className="w-full input text-sm"
            />
            <span className="text-xs text-muted mt-0.5 block">
              Применяется к товарам, для которых не установлена индивидуальная ставка.
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">
                Telegram ID (для /creator)
              </label>
              <input
                name="tgId"
                defaultValue={creator?.tgId || ""}
                placeholder="123456789"
                className="w-full input text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">
                Telegram @username
              </label>
              <input
                name="username"
                defaultValue={creator?.username || ""}
                placeholder="username"
                className="w-full input text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted mb-1">
              Телефон
            </label>
            <input
              name="phone"
              defaultValue={creator?.phone || ""}
              placeholder="+998 90 123 45 67"
              className="w-full input text-sm"
            />
          </div>

          <div className="p-3 bg-surface-2 rounded-lg space-y-3">
            <div className="text-xs font-semibold text-text">Реквизиты для выплат (Humo / Uzcard)</div>
            <div>
              <label className="block text-xs text-muted mb-1">Номер карты</label>
              <input
                name="cardNumber"
                defaultValue={creator?.cardNumber || ""}
                placeholder="9860 0000 0000 0000"
                className="w-full input text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">ФИО владельца</label>
              <input
                name="cardHolder"
                defaultValue={creator?.cardHolder || ""}
                placeholder="Имя Фамилия"
                className="w-full input text-sm"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost text-sm">
              Отмена
            </button>
            <button type="submit" disabled={isPending} className="btn-primary text-sm">
              {isPending ? "Сохранение..." : creator ? "Сохранить изменения" : "Создать креатора"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function RateMatrixModal({
  creator,
  products,
  onClose,
}: {
  creator: any;
  products: any[];
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Map of variantId -> rewardUzs
  const existingRates = new Map<number, number>();
  for (const r of creator.productRates || []) {
    existingRates.set(r.variantId, r.rewardUzs);
  }

  const [rates, setRates] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    for (const p of products) {
      for (const v of p.variants) {
        init[v.id] = existingRates.has(v.id) ? String(existingRates.get(v.id)) : "";
      }
    }
    return init;
  });

  const handleRateChange = (variantId: number, val: string) => {
    setRates((prev) => ({ ...prev, [variantId]: val }));
  };

  const handleSave = () => {
    setError(null);
    const toSave: Array<{ variantId: number; rewardUzs: number }> = [];
    for (const [vId, val] of Object.entries(rates)) {
      const num = Number.parseInt(val, 10);
      if (!isNaN(num) && num > 0) {
        toSave.push({ variantId: Number(vId), rewardUzs: num });
      }
    }

    const formData = new FormData();
    formData.append("creatorId", String(creator.id));
    formData.append("ratesJson", JSON.stringify(toSave));

    startTransition(async () => {
      try {
        const res = await saveCreatorProductRatesAction(formData);
        if (res && !res.success) {
          setError(res.error || "Ошибка сохранения ставок");
        } else {
          onClose();
        }
      } catch (err: any) {
        setError(err.message || "Ошибка сохранения ставок");
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card max-w-3xl w-full p-6 relative max-h-[90vh] flex flex-col">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-muted hover:text-text text-xl"
        >
          ✕
        </button>

        <div className="mb-4">
          <h2 className="text-xl font-bold">
            Сетка ставок: {creator.name} (@{creator.code})
          </h2>
          <p className="text-xs text-muted mt-1">
            Базовая ставка по умолчанию: <b>{creator.defaultRateUzs.toLocaleString("ru-RU")} UZS</b>.
            Здесь вы можете задать индивидуальное вознаграждение для конкретного товара. Если поле пустое — действует базовая ставка.
          </p>
        </div>

        {error && (
          <div className="p-3 mb-4 rounded bg-danger/10 border border-danger/30 text-danger text-sm">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {products.map((p) => (
            <div key={p.id} className="border border-border/60 rounded-lg p-3 bg-surface-2/40">
              <div className="font-semibold text-sm mb-2 text-text flex items-center gap-2">
                <span>{p.nameRu || p.title}</span>
              </div>
              <div className="space-y-2">
                {p.variants.map((v: any) => {
                  const currentCustom = rates[v.id];
                  const hasCustom = Boolean(currentCustom && Number(currentCustom) > 0);
                  return (
                    <div
                      key={v.id}
                      className="flex items-center justify-between gap-4 p-2 rounded bg-surface border border-border/40 text-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-xs">{v.nameRu || v.name}</div>
                        <div className="text-[11px] text-muted">
                          Базовая цена: {v.priceUzs.toLocaleString("ru-RU")} UZS
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <input
                            type="number"
                            step="1000"
                            min="0"
                            placeholder={`${creator.defaultRateUzs} (по умолч.)`}
                            value={rates[v.id] ?? ""}
                            onChange={(e) => handleRateChange(v.id, e.target.value)}
                            className={`w-36 input text-xs font-mono text-right py-1 px-2 ${
                              hasCustom ? "border-brand font-semibold text-brand-fg bg-brand/10" : ""
                            }`}
                          />
                        </div>
                        <span className="text-xs text-muted">UZS</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border mt-4">
          <button type="button" onClick={onClose} className="btn-ghost text-sm">
            Отмена
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={handleSave}
            className="btn-primary text-sm"
          >
            {isPending ? "Сохранение..." : "Сохранить индивидуальные ставки"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PayoutApproveModal({
  payout,
  onClose,
}: {
  payout: any;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleApprove = () => {
    setError(null);
    const formData = new FormData();
    formData.append("payoutId", String(payout.id));
    formData.append("note", note);

    startTransition(async () => {
      try {
        const res = await approvePayoutAction(formData);
        if (res && !res.success) {
          setError(res.error || "Ошибка подтверждения");
        } else {
          onClose();
        }
      } catch (err: any) {
        setError(err.message || "Ошибка подтверждения");
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card max-w-md w-full p-6 relative">
        <h3 className="text-lg font-bold mb-2">Подтверждение выплаты #{payout.id}</h3>
        <p className="text-sm text-muted mb-4">
          Креатор: <b>{payout.creator.name}</b><br />
          Сумма к выплате: <b>{payout.amountUzs.toLocaleString("ru-RU")} UZS</b><br />
          Карта: <code className="font-mono">{payout.cardNumber}</code> ({payout.cardHolder || "ФИО не указано"})
        </p>

        {error && (
          <div className="p-3 mb-4 rounded bg-danger/10 border border-danger/30 text-danger text-sm">
            {error}
          </div>
        )}

        <div className="mb-4">
          <label className="block text-xs font-semibold text-muted mb-1">
            Номер квитанции / примечание (необязательно)
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Чек перевода Humo/Uzcard"
            className="w-full input text-sm"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost text-sm">
            Отмена
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={handleApprove}
            className="btn-primary text-sm bg-success text-white"
          >
            {isPending ? "Обработка..." : "✅ Подтвердить выплату"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PayoutRejectModal({
  payout,
  onClose,
}: {
  payout: any;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleReject = () => {
    if (!reason.trim()) {
      setError("Укажите причину отклонения");
      return;
    }
    setError(null);
    const formData = new FormData();
    formData.append("payoutId", String(payout.id));
    formData.append("reason", reason);

    startTransition(async () => {
      try {
        const res = await rejectPayoutAction(formData);
        if (res && !res.success) {
          setError(res.error || "Ошибка отклонения");
        } else {
          onClose();
        }
      } catch (err: any) {
        setError(err.message || "Ошибка отклонения");
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card max-w-md w-full p-6 relative">
        <h3 className="text-lg font-bold mb-2 text-danger">Отклонить заявку #{payout.id}</h3>
        <p className="text-sm text-muted mb-4">
          Сумма <b>{payout.amountUzs.toLocaleString("ru-RU")} UZS</b> будет моментально возвращена на баланс креатора.
        </p>

        {error && (
          <div className="p-3 mb-4 rounded bg-danger/10 border border-danger/30 text-danger text-sm">
            {error}
          </div>
        )}

        <div className="mb-4">
          <label className="block text-xs font-semibold text-muted mb-1">
            Причина отклонения *
          </label>
          <input
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Например: Недействительный номер карты или ФИО"
            className="w-full input text-sm"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost text-sm">
            Отмена
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={handleReject}
            className="btn-danger text-sm"
          >
            {isPending ? "Обработка..." : "🔴 Отклонить и вернуть баланс"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CreatorActionButtons({
  creator,
  botUsername,
  products,
}: {
  creator: any;
  botUsername: string;
  products: any[];
}) {
  const [showEdit, setShowEdit] = useState(false);
  const [showRates, setShowRates] = useState(false);
  const startUrl = `https://t.me/${botUsername}?start=c_${creator.code}`;

  return (
    <>
      <div className="flex items-center gap-1.5 flex-wrap">
        <CopyButton
          text={startUrl}
          label="🔗 Ссылка"
          className="btn-secondary text-xs py-1 px-2"
        />
        <button
          onClick={() => setShowRates(true)}
          className="btn-secondary text-xs py-1 px-2 text-brand"
        >
          ⚙️ Ставки ({creator.productRates?.length || 0})
        </button>
        <button
          onClick={() => setShowEdit(true)}
          className="btn-ghost text-xs py-1 px-2"
        >
          ✏️ Изменить
        </button>
      </div>

      {showEdit && (
        <CreatorModal creator={creator} onClose={() => setShowEdit(false)} />
      )}
      {showRates && (
        <RateMatrixModal
          creator={creator}
          products={products}
          onClose={() => setShowRates(false)}
        />
      )}
    </>
  );
}

export function PayoutRowActions({ payout }: { payout: any }) {
  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);

  if (payout.status !== "pending") {
    return (
      <span className="text-xs text-muted">
        {payout.status === "paid" ? "Выплачено" : "Отклонено"}
      </span>
    );
  }

  return (
    <>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setShowApprove(true)}
          className="btn-primary text-xs py-1 px-2 bg-success hover:bg-success/90 text-white"
        >
          ✅ Выплатить
        </button>
        <button
          onClick={() => setShowReject(true)}
          className="btn-ghost text-xs py-1 px-2 text-danger hover:bg-danger/10"
        >
          ❌ Отклонить
        </button>
      </div>

      {showApprove && (
        <PayoutApproveModal payout={payout} onClose={() => setShowApprove(false)} />
      )}
      {showReject && (
        <PayoutRejectModal payout={payout} onClose={() => setShowReject(false)} />
      )}
    </>
  );
}

export function AddCreatorButton({ products }: { products: any[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-primary text-sm">
        + Добавить креатора
      </button>
      {open && <CreatorModal onClose={() => setOpen(false)} />}
    </>
  );
}
