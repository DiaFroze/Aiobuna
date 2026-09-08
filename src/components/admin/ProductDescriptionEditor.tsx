"use client";

import { useState, useRef } from "react";
import { aiFormatProductContentAction } from "@/app/admin/(protected)/bot-products/actions";

interface ProductDescriptionEditorProps {
  initialDescRu: string;
  initialDescUz: string;
  initialDescEn?: string;
}

const PRESET_EMOJIS = [
  { id: "5372917041193828849", char: "🚀", label: "Ракета" },
  { id: "5467512909909214089", char: "🎓", label: "Курс / Шапка" },
  { id: "5927026418616636353", char: "🧠", label: "Мозг / ИИ" },
  { id: "5235837920081887219", char: "📸", label: "Камера" },
  { id: "5256131095094652290", char: "🎯", label: "Цель" },
  { id: "5375464961822695044", char: "🖤", label: "CapCut / Сердце" },
  { id: "6283073379184415506", char: "🎁", label: "Подарок" },
  { id: "5197288647275071607", char: "🛡", label: "Щит / Безопасность" },
  { id: "5231102735817918643", char: "👇", label: "Стрелка вниз" },
  { id: "5424972470023104089", char: "💎", label: "Алмаз" },
  { id: "5359512328003941083", char: "⭐", label: "Звезда" },
  { id: "5278711610775457808", char: "✨", label: "Блеск" },
];

export function ProductDescriptionEditor({
  initialDescRu,
  initialDescUz,
  initialDescEn = "",
}: ProductDescriptionEditorProps) {
  const [descRu, setDescRu] = useState(initialDescRu);
  const [descUz, setDescUz] = useState(initialDescUz);
  const [descEn] = useState(initialDescEn);
  const [activeLang, setActiveLang] = useState<"ru" | "uz">("uz");

  const [customId, setCustomId] = useState("");
  const [customChar, setCustomChar] = useState("✨");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState<string | null>(null);

  const ruRef = useRef<HTMLTextAreaElement>(null);
  const uzRef = useRef<HTMLTextAreaElement>(null);

  const insertText = (snippet: string) => {
    const targetRef = activeLang === "ru" ? ruRef : uzRef;
    const textarea = targetRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentVal = textarea.value;
    const nextVal = currentVal.slice(0, start) + snippet + currentVal.slice(end);

    if (activeLang === "ru") setDescRu(nextVal);
    else setDescUz(nextVal);

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + snippet.length, start + snippet.length);
    }, 10);
  };

  const handleInsertPreset = (id: string, char: string) => {
    insertText(`<tg-emoji emoji-id="${id}">${char}</tg-emoji> `);
  };

  const handleInsertCustom = () => {
    const id = customId.trim();
    if (!id) return;
    const char = customChar.trim() || "✨";
    insertText(`<tg-emoji emoji-id="${id}">${char}</tg-emoji> `);
    setCustomId("");
  };

  const handleWrapTag = (tag: string) => {
    const targetRef = activeLang === "ru" ? ruRef : uzRef;
    const textarea = targetRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const sel = textarea.value.slice(start, end);
    const snippet = `<${tag}>${sel || "текст"}</${tag}>`;
    insertText(snippet);
  };

  const handleAiFormat = async () => {
    try {
      setIsAiLoading(true);
      setAiStatus(null);
      const titleInput = (document.querySelector('input[name="titleRu"]') as HTMLInputElement)?.value || "";
      const emojiInput = (document.querySelector('input[name="emoji"]') as HTMLInputElement)?.value || "";
      const currentText = descRu || descUz || titleInput;

      if (!titleInput && !currentText) {
        setAiStatus("Сначала укажите название товара");
        setIsAiLoading(false);
        return;
      }

      const res = await aiFormatProductContentAction(titleInput, currentText, emojiInput);
      if (!res) {
        setAiStatus("Не удалось сгенерировать описание через Gemini");
        setIsAiLoading(false);
        return;
      }

      if (res.descRu) setDescRu(res.descRu);
      if (res.descUz) setDescUz(res.descUz);

      const titleUzInput = document.querySelector('input[name="titleUz"]') as HTMLInputElement;
      if (titleUzInput && !titleUzInput.value.trim() && res.titleUz) {
        titleUzInput.value = res.titleUz;
      }

      const premiumInput = document.querySelector('input[name="premiumEmoji"]') as HTMLInputElement;
      if (premiumInput && !premiumInput.value.trim() && res.premiumEmoji) {
        premiumInput.value = res.premiumEmoji;
      }

      const emojiElem = document.querySelector('input[name="emoji"]') as HTMLInputElement;
      if (emojiElem && (!emojiElem.value.trim() || emojiElem.value === "✨") && res.emoji) {
        emojiElem.value = res.emoji;
      }

      setAiStatus("✅ Описание и анимированные эмодзи успешно сгенерированы через Gemini!");
      setTimeout(() => setAiStatus(null), 6000);
    } catch (e) {
      setAiStatus("Ошибка при вызове ИИ: " + (e as Error).message);
    } finally {
      setIsAiLoading(false);
    }
  };

  return (
    <div className="space-y-4 pt-2">
      {/* Gemini AI Assistant Banner */}
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-3.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="text-xl">🤖</span>
            <div>
              <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                <span>Оформление через Gemini AI</span>
                <span className="text-[10px] bg-primary/20 text-primary px-2 py-0.5 rounded-full font-medium">Auto Emoji &amp; HTML</span>
              </div>
              <div className="text-xs text-muted">
                Автоматически составит продающее описание (RU + UZ) с официальными анимированными эмодзи
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleAiFormat}
            disabled={isAiLoading}
            className="btn-primary text-xs px-3.5 py-1.5 flex items-center gap-1.5 shadow-sm"
          >
            {isAiLoading ? (
              <>
                <span className="animate-spin inline-block">⏳</span>
                <span>Генерация Gemini...</span>
              </>
            ) : (
              <>
                <span>✨</span>
                <span>Оформить через ИИ</span>
              </>
            )}
          </button>
        </div>
        {aiStatus && (
          <div className={`text-xs px-3 py-1.5 rounded-lg ${aiStatus.startsWith("✅") ? "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20" : "bg-destructive/10 text-destructive border border-destructive/20"}`}>
            {aiStatus}
          </div>
        )}
      </div>

      <div className="rounded-xl border bg-surface-2/40 p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
          <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            ✨ Вставка Premium Emoji в текст описания
          </span>
          <div className="flex items-center gap-1 text-xs">
            <span className="text-muted mr-1">Вставлять в:</span>
            <button
              type="button"
              onClick={() => setActiveLang("uz")}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                activeLang === "uz" ? "bg-primary text-primary-foreground" : "bg-surface-2 text-muted hover:text-foreground"
              }`}
            >
              UZ
            </button>
            <button
              type="button"
              onClick={() => setActiveLang("ru")}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                activeLang === "ru" ? "bg-primary text-primary-foreground" : "bg-surface-2 text-muted hover:text-foreground"
              }`}
            >
              RU
            </button>
          </div>
        </div>

        {/* Preset emoji buttons */}
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[11px] text-muted mr-1">Быстрые:</span>
          {PRESET_EMOJIS.map((em) => (
            <button
              key={em.id}
              type="button"
              title={`${em.label} (ID: ${em.id})`}
              onClick={() => handleInsertPreset(em.id, em.char)}
              className="px-2 py-1 bg-surface-1 hover:bg-surface-2 border rounded-lg text-sm transition-transform active:scale-95 flex items-center gap-1"
            >
              <span>{em.char}</span>
              <span className="text-[10px] text-muted font-mono">{em.char}</span>
            </button>
          ))}
        </div>

        {/* Formatting tags */}
        <div className="flex flex-wrap gap-1.5 items-center pt-1 border-t">
          <span className="text-[11px] text-muted mr-1">Форматирование:</span>
          <button
            type="button"
            onClick={() => handleWrapTag("b")}
            className="px-2 py-0.5 bg-surface-1 hover:bg-surface-2 border rounded text-xs font-bold font-mono"
            title="Жирный текст"
          >
            &lt;b&gt;Ж&lt;/b&gt;
          </button>
          <button
            type="button"
            onClick={() => handleWrapTag("i")}
            className="px-2 py-0.5 bg-surface-1 hover:bg-surface-2 border rounded text-xs italic font-mono"
            title="Курсив"
          >
            &lt;i&gt;К&lt;/i&gt;
          </button>
          <button
            type="button"
            onClick={() => handleWrapTag("code")}
            className="px-2 py-0.5 bg-surface-1 hover:bg-surface-2 border rounded text-xs font-mono"
            title="Моноширинный код"
          >
            &lt;code&gt;
          </button>
        </div>

        {/* Custom emoji input tool */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t text-xs">
          <span className="text-muted">Свой Emoji ID:</span>
          <input
            type="text"
            placeholder="ID (напр. 5372917041193828849)"
            value={customId}
            onChange={(e) => setCustomId(e.target.value)}
            className="input h-8 text-xs font-mono w-48"
          />
          <input
            type="text"
            placeholder="Символ"
            value={customChar}
            onChange={(e) => setCustomChar(e.target.value)}
            className="input h-8 text-xs text-center w-14"
            title="Запасной стандартный эмодзи"
          />
          <button
            type="button"
            onClick={handleInsertCustom}
            disabled={!customId.trim()}
            className="btn-primary h-8 text-xs px-3"
          >
            ➕ Вставить в {activeLang.toUpperCase()}
          </button>
        </div>

        <p className="text-[11px] text-muted leading-relaxed">
          💡 <b>Синтаксис:</b> Бот поддерживает как нативный тег Telegram:{" "}
          <code className="bg-surface-2 px-1 rounded">&lt;tg-emoji emoji-id=&quot;ID&quot;&gt;🚀&lt;/tg-emoji&gt;</code>,
          так и короткий шорткод: <code className="bg-surface-2 px-1 rounded">[emoji:ID:🚀]</code>. При отправке они превращаются в премиум-эмодзи в Telegram.
        </p>
      </div>

      {/* Description Textareas */}
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">Описание (RU)</label>
            <span className="text-[11px] text-muted">{descRu.length} симв.</span>
          </div>
          <textarea
            ref={ruRef}
            name="descRu"
            value={descRu}
            onFocus={() => setActiveLang("ru")}
            onChange={(e) => setDescRu(e.target.value)}
            rows={10}
            className="input mt-1 text-sm font-mono leading-relaxed"
            placeholder="Полное описание на русском..."
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">Описание (UZ)</label>
            <span className="text-[11px] text-muted">{descUz.length} симв.</span>
          </div>
          <textarea
            ref={uzRef}
            name="descUz"
            value={descUz}
            onFocus={() => setActiveLang("uz")}
            onChange={(e) => setDescUz(e.target.value)}
            rows={10}
            className="input mt-1 text-sm font-mono leading-relaxed"
            placeholder="O'zbekcha to'liq tavsif..."
          />
        </div>
      </div>

      {/* Hidden input to preserve descEn if already set */}
      <input type="hidden" name="descEn" value={descEn} />
    </div>
  );
}
