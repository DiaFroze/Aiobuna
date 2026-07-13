"use client";

import { useState } from "react";

export default function FormatterToolClient() {
  const [linksText, setLinksText] = useState("");
  const [startIndex, setStartIndex] = useState(1);
  const [formattedResult, setFormattedResult] = useState("");
  const [copied, setCopied] = useState(false);

  const handleFormat = (e: React.FormEvent) => {
    e.preventDefault();
    const links = linksText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (links.length === 0) {
      setFormattedResult("Вставьте хотя бы одну ссылку.");
      return;
    }

    let currentNum = startIndex;
    const lines = links.map((link) => {
      const formatted = `${currentNum}. ${link}`;
      currentNum++;
      return formatted;
    });

    setFormattedResult(lines.join("\n"));
    setCopied(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(formattedResult);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="grid md:grid-cols-2 gap-6">
      {/* Input Card */}
      <div className="card p-5 space-y-4">
        <h3 className="font-semibold text-lg">Входные данные</h3>
        <form onSubmit={handleFormat} className="space-y-4">
          <div>
            <label className="text-sm text-muted block mb-1">
              Начать нумерацию с числа
            </label>
            <input
              type="number"
              min="1"
              value={startIndex}
              onChange={(e) => setStartIndex(Math.max(1, Number(e.target.value)))}
              className="input"
              required
            />
          </div>
          <div>
            <label className="text-sm text-muted block mb-1">
              Список ссылок (по одной на строке)
            </label>
            <textarea
              rows={10}
              value={linksText}
              onChange={(e) => setLinksText(e.target.value)}
              className="input font-mono text-xs"
              placeholder={"https://link1.com\nhttps://link2.com\nhttps://link3.com"}
              required
            />
          </div>
          <button type="submit" className="btn btn-primary w-full">
            ⚡ Форматировать ссылки
          </button>
        </form>
      </div>

      {/* Output Card */}
      <div className="card p-5 flex flex-col justify-between space-y-4">
        <div>
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-semibold text-lg">Результат</h3>
            {formattedResult && (
              <button
                type="button"
                onClick={handleCopy}
                className={`btn btn-sm ${copied ? "btn-success" : "btn-outline-primary"}`}
              >
                {copied ? "✅ Скопировано" : "📋 Скопировать"}
              </button>
            )}
          </div>
          <pre className="p-3 bg-surface-2 rounded font-mono text-xs border overflow-x-auto whitespace-pre-wrap min-h-[250px] max-h-[350px]">
            {formattedResult || "Здесь появится результат форматирования..."}
          </pre>
        </div>
        <p className="text-xs text-muted">
          Каждая ссылка нумеруется по порядку для удобства отправки списком.
        </p>
      </div>
    </div>
  );
}
