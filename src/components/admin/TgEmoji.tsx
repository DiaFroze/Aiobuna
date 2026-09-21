"use client";

import React from "react";

export type TgEmojiPresetKey =
  | "stars"
  | "click"
  | "payme"
  | "admin"
  | "receipt"
  | "statistics"
  | "stock";

export interface TgEmojiPreset {
  id: string;
  char: string;
  label: string;
  tag: string;
}

export const PRESET_TG_EMOJIS: Record<TgEmojiPresetKey, TgEmojiPreset> = {
  stars: {
    id: "5897658922600240288",
    char: "⭐️",
    label: "Stars",
    tag: '<tg-emoji emoji-id="5897658922600240288">⭐️</tg-emoji>',
  },
  click: {
    id: "5332606428068737460",
    char: "💳",
    label: "Click",
    tag: '<tg-emoji emoji-id="5332606428068737460">💳</tg-emoji>',
  },
  payme: {
    id: "5204128408463744787",
    char: "💸",
    label: "Payme",
    tag: '<tg-emoji emoji-id="5204128408463744787">💸</tg-emoji>',
  },
  admin: {
    id: "6269458311381258421",
    char: "👩‍💻",
    label: "Администратор",
    tag: '<tg-emoji emoji-id="6269458311381258421">👩‍💻</tg-emoji>',
  },
  receipt: {
    id: "5204242830687494041",
    char: "🧾",
    label: "Чек",
    tag: '<tg-emoji emoji-id="5204242830687494041">🧾</tg-emoji>',
  },
  statistics: {
    id: "5449872877929127395",
    char: "📈",
    label: "Статистика",
    tag: '<tg-emoji emoji-id="5449872877929127395">📈</tg-emoji>',
  },
  stock: {
    id: "5255860701133552970",
    char: "📦",
    label: "Склад",
    tag: '<tg-emoji emoji-id="5255860701133552970">📦</tg-emoji>',
  },
};

export interface TgEmojiProps {
  name?: TgEmojiPresetKey;
  emojiId?: string | null;
  fallback?: string;
  className?: string;
  title?: string;
  children?: React.ReactNode;
}

/**
 * Renders an official Telegram Premium custom emoji tag <tg-emoji emoji-id="...">.
 * Beautifully styled for web admin panels while strictly preserving native Telegram tags.
 */
export function TgEmoji({
  name,
  emojiId,
  fallback,
  className = "",
  title,
  children,
}: TgEmojiProps) {
  const preset = name ? PRESET_TG_EMOJIS[name] : undefined;
  const finalId = emojiId || preset?.id;
  const content = children || fallback || preset?.char || "✨";
  const hoverTitle = title || preset?.label;

  return (
    <tg-emoji
      emoji-id={finalId || undefined}
      className={`inline-flex items-center justify-center align-middle leading-none select-none transition-transform hover:scale-110 ${className}`}
      title={hoverTitle}
    >
      {content}
    </tg-emoji>
  );
}

/**
 * Returns native Telegram HTML string for message/caption templates.
 */
export function getTgEmojiTag(name: TgEmojiPresetKey): string {
  return PRESET_TG_EMOJIS[name]?.tag || "✨";
}
