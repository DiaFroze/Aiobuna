"use client";

import { useState } from "react";

export function CopyLinkButton({
  url,
  label = "Копировать",
  className = "btn-secondary text-xs py-1 px-2.5",
}: {
  url: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`${className} transition-all duration-150 inline-flex items-center gap-1.5`}
      title={url}
    >
      {copied ? (
        <>
          <span className="text-success font-bold">✓</span>
          <span>Скопировано!</span>
        </>
      ) : (
        <>
          <span>📋</span>
          <span>{label}</span>
        </>
      )}
    </button>
  );
}
