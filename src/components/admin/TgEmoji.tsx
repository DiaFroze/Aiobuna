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

/**
 * 3D Telegram Premium Custom Emoji SVG Artwork.
 * Rendered inline for crisp, vibrant, professional appearance on any screen.
 */
function TgPremiumSvg({ name }: { name: TgEmojiPresetKey }) {
  switch (name) {
    case "stars":
      return (
        <svg viewBox="0 0 36 36" fill="none" className="w-[1.25em] h-[1.25em] inline-block shrink-0 drop-shadow-[0_2px_6px_rgba(245,158,11,0.5)]">
          <defs>
            <linearGradient id="tg-star-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FFF275" />
              <stop offset="30%" stopColor="#FFD000" />
              <stop offset="70%" stopColor="#FF9500" />
              <stop offset="100%" stopColor="#E65100" />
            </linearGradient>
            <linearGradient id="tg-star-facet1" x1="0%" y1="0%" x2="50%" y2="100%">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#FFD000" stopOpacity="0.2" />
            </linearGradient>
            <linearGradient id="tg-star-facet2" x1="100%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#B34700" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#FF8000" stopOpacity="0.1" />
            </linearGradient>
          </defs>
          <path
            d="M18 2.5l4.8 9.8 10.7 1.6-7.8 7.6 1.8 10.7L18 27.1l-9.5 5.1 1.8-10.7-7.8-7.6 10.7-1.6L18 2.5z"
            fill="url(#tg-star-grad)"
          />
          <path d="M18 2.5v24.6l-9.5 5.1 1.8-10.7-7.8-7.6 10.7-1.6L18 2.5z" fill="url(#tg-star-facet1)" />
          <path d="M18 14.5l4.8-2.2 10.7 1.6-7.8 7.6 1.8 10.7L18 27.1v-12.6z" fill="url(#tg-star-facet2)" />
          <polygon points="18,10 19.5,15 24,16 19.5,17 18,22 16.5,17 12,16 16.5,15" fill="#FFFFFF" opacity="0.9" />
        </svg>
      );

    case "click":
      return (
        <svg viewBox="0 0 36 36" fill="none" className="w-[1.25em] h-[1.25em] inline-block shrink-0 drop-shadow-[0_2px_6px_rgba(16,185,129,0.5)]">
          <defs>
            <linearGradient id="tg-click-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#10B981" />
              <stop offset="50%" stopColor="#059669" />
              <stop offset="100%" stopColor="#064E3B" />
            </linearGradient>
            <linearGradient id="tg-chip-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FFE082" />
              <stop offset="100%" stopColor="#FFB300" />
            </linearGradient>
          </defs>
          <rect x="2" y="6" width="32" height="24" rx="4" fill="url(#tg-click-grad)" />
          <path d="M2 10 C12 6, 24 14, 34 8 L34 6 L2 6 Z" fill="#FFFFFF" opacity="0.25" />
          <rect x="6" y="14" width="7" height="6" rx="1.5" fill="url(#tg-chip-grad)" />
          <path d="M6 17h7 M9.5 14v6" stroke="#8D6E63" strokeWidth="0.6" />
          <path d="M25 15a4 4 0 0 1 0 5 M27.5 13a7 7 0 0 1 0 9" stroke="#A7F3D0" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          <rect x="6" y="24" width="16" height="2" rx="1" fill="#E6FFFA" opacity="0.85" />
          <circle cx="28" cy="24" r="2.5" fill="#34D399" opacity="0.9" />
        </svg>
      );

    case "payme":
      return (
        <svg viewBox="0 0 36 36" fill="none" className="w-[1.25em] h-[1.25em] inline-block shrink-0 drop-shadow-[0_2px_6px_rgba(14,165,233,0.5)]">
          <defs>
            <linearGradient id="tg-payme-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#38BDF8" />
              <stop offset="50%" stopColor="#0284C7" />
              <stop offset="100%" stopColor="#0369A1" />
            </linearGradient>
            <linearGradient id="tg-wing-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="100%" stopColor="#BAE6FD" />
            </linearGradient>
          </defs>
          <path d="M7 14 C2 8, 4 3, 10 7 C11 4, 15 5, 14 11 Z" fill="url(#tg-wing-grad)" opacity="0.9" />
          <path d="M29 14 C34 8, 32 3, 26 7 C25 4, 21 5, 22 11 Z" fill="url(#tg-wing-grad)" opacity="0.9" />
          <g transform="rotate(-6 18 19)">
            <rect x="7" y="11" width="22" height="15" rx="2.5" fill="url(#tg-payme-grad)" />
            <rect x="9" y="13" width="18" height="11" rx="1.5" stroke="#BAE6FD" strokeWidth="0.75" fill="none" strokeDasharray="2 1" />
            <circle cx="18" cy="18.5" r="3.5" fill="#E0F2FE" opacity="0.95" />
            <text x="18" y="21" fontSize="5" fontWeight="bold" textAnchor="middle" fill="#0369A1" fontFamily="sans-serif">P</text>
          </g>
        </svg>
      );

    case "admin":
      return (
        <svg viewBox="0 0 36 36" fill="none" className="w-[1.25em] h-[1.25em] inline-block shrink-0 drop-shadow-[0_2px_6px_rgba(245,158,11,0.5)]">
          <defs>
            <linearGradient id="tg-admin-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#F59E0B" />
              <stop offset="100%" stopColor="#D97706" />
            </linearGradient>
          </defs>
          <circle cx="18" cy="18" r="16" fill="url(#tg-admin-grad)" />
          <circle cx="18" cy="12" r="5" fill="#FFFFFF" />
          <path d="M12 12 a6 6 0 0 1 12 0" stroke="#78350F" strokeWidth="1.5" fill="none" />
          <rect x="11" y="11" width="2" height="3" rx="1" fill="#78350F" />
          <rect x="23" y="11" width="2" height="3" rx="1" fill="#78350F" />
          <path d="M10 27 c0-5 3.5-7 8-7 s8 2 8 7 Z" fill="#FEF3C7" />
          <rect x="11" y="24" width="14" height="8" rx="1" fill="#1F2937" />
          <rect x="13" y="25" width="10" height="5" rx="0.5" fill="#38BDF8" />
          <path d="M15 27.5 l1.5 1 -1.5 1 M17.5 29.5 h2" stroke="#FFFFFF" strokeWidth="0.8" strokeLinecap="round" />
          <path d="M9 32 h18" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );

    case "receipt":
      return (
        <svg viewBox="0 0 36 36" fill="none" className="w-[1.25em] h-[1.25em] inline-block shrink-0 drop-shadow-[0_2px_6px_rgba(168,85,247,0.5)]">
          <defs>
            <linearGradient id="tg-receipt-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="100%" stopColor="#F3E8FF" />
            </linearGradient>
          </defs>
          <path
            d="M7 4 h22 v26 l-2.75 -2 -2.75 2 -2.75 -2 -2.75 2 -2.75 -2 -2.75 2 -2.75 -2 -2.75 2 -0.75 -0.5 Z"
            fill="url(#tg-receipt-grad)"
            stroke="#D8B4FE"
            strokeWidth="1"
          />
          <circle cx="18" cy="10" r="3.5" fill="#10B981" />
          <path d="M16.5 10 l1 1 2.5 -2.5" stroke="#FFFFFF" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="10" y="16" width="16" height="1.5" rx="0.75" fill="#A855F7" opacity="0.7" />
          <rect x="10" y="19.5" width="12" height="1.5" rx="0.75" fill="#CBD5E1" />
          <rect x="10" y="22.5" width="16" height="1.5" rx="0.75" fill="#CBD5E1" />
        </svg>
      );

    case "statistics":
      return (
        <svg viewBox="0 0 36 36" fill="none" className="w-[1.25em] h-[1.25em] inline-block shrink-0 drop-shadow-[0_2px_6px_rgba(34,197,94,0.5)]">
          <defs>
            <linearGradient id="tg-stat-bar1" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#38BDF8" /><stop offset="100%" stopColor="#0284C7" />
            </linearGradient>
            <linearGradient id="tg-stat-bar2" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#A855F7" /><stop offset="100%" stopColor="#7E22CE" />
            </linearGradient>
            <linearGradient id="tg-stat-bar3" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#22C55E" /><stop offset="100%" stopColor="#15803D" />
            </linearGradient>
            <linearGradient id="tg-stat-arrow" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#EF4444" /><stop offset="50%" stopColor="#F59E0B" /><stop offset="100%" stopColor="#10B981" />
            </linearGradient>
          </defs>
          <rect x="3" y="3" width="30" height="30" rx="6" fill="#0F172A" />
          <line x1="6" y1="28" x2="30" y2="28" stroke="#334155" strokeWidth="1.5" strokeLinecap="round" />
          <rect x="7" y="20" width="5" height="8" rx="1.5" fill="url(#tg-stat-bar1)" />
          <rect x="15.5" y="14" width="5" height="14" rx="1.5" fill="url(#tg-stat-bar2)" />
          <rect x="24" y="8" width="5" height="20" rx="1.5" fill="url(#tg-stat-bar3)" />
          <path d="M6 22 L14 16 L21 18 L29 7" stroke="url(#tg-stat-arrow)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <polygon points="29,5 31,10 26,8" fill="#10B981" />
        </svg>
      );

    case "stock":
      return (
        <svg viewBox="0 0 36 36" fill="none" className="w-[1.25em] h-[1.25em] inline-block shrink-0 drop-shadow-[0_2px_6px_rgba(217,119,6,0.5)]">
          <defs>
            <linearGradient id="tg-box-top" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FBBF24" /><stop offset="100%" stopColor="#D97706" />
            </linearGradient>
            <linearGradient id="tg-box-left" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#D97706" /><stop offset="100%" stopColor="#B45309" />
            </linearGradient>
            <linearGradient id="tg-box-right" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#B45309" /><stop offset="100%" stopColor="#78350F" />
            </linearGradient>
          </defs>
          <polygon points="18,4 32,11 18,18 4,11" fill="url(#tg-box-top)" />
          <polygon points="4,11 18,18 18,31 4,24" fill="url(#tg-box-left)" />
          <polygon points="18,18 32,11 32,24 18,31" fill="url(#tg-box-right)" />
          <polygon points="15.5,5.2 20.5,7.7 20.5,16.7 15.5,14.2" fill="#78350F" opacity="0.6" />
          <polygon points="18,18 20.5,16.7 20.5,29.7 18,31" fill="#451A03" opacity="0.5" />
          <polygon points="7,17 13,20 13,24 7,21" fill="#FEF3C7" />
          <line x1="8.5" y1="19" x2="11.5" y2="20.5" stroke="#78350F" strokeWidth="0.8" />
        </svg>
      );
  }
}

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
 * Beautifully styled with high-fidelity 3D artwork for web admin panels
 * while strictly preserving native Telegram tags and precision custom emoji IDs.
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
  const hoverTitle = title || preset?.label;

  return (
    <tg-emoji
      emoji-id={finalId || undefined}
      className={`inline-flex items-center justify-center align-middle leading-none select-none transition-transform hover:scale-110 ${className}`}
      title={hoverTitle}
    >
      {name && PRESET_TG_EMOJIS[name] ? (
        <>
          <span className="sr-only">{preset?.char}</span>
          <TgPremiumSvg name={name} />
        </>
      ) : (
        children || fallback || preset?.char || "✨"
      )}
    </tg-emoji>
  );
}

/**
 * Returns native Telegram HTML string for message/caption templates.
 */
export function getTgEmojiTag(name: TgEmojiPresetKey): string {
  return PRESET_TG_EMOJIS[name]?.tag || "✨";
}
