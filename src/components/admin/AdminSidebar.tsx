"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

const NAV: { href: string; label: string; icon: string }[] = [
  { href: "/admin", label: "Dashboard", icon: "▤" },
  { href: "/admin/bot-products", label: "Товары бота", icon: "🤖" },
  { href: "/admin/bot-fragment", label: "Stars и Premium", icon: "⭐" },
  { href: "/admin/bot-methods", label: "Методы / Гайды", icon: "📘" },
  { href: "/admin/bot-import", label: "Импорт из API", icon: "⇩" },
  { href: "/admin/bot-apis", label: "API-источники", icon: "🔌" },
  { href: "/admin/bot-settings", label: "Тексты и меню бота", icon: "✎" },
  { href: "/admin/bot-channels", label: "Подписки бота", icon: "📢" },
  { href: "/admin/bot-topups", label: "Пополнения бота", icon: "💳" },
  { href: "/admin/bot-users", label: "Пользователи бота", icon: "👤" },
  { href: "/admin/bot-vip-prices", label: "Индивидуальные цены", icon: "💎" },
  { href: "/admin/bot-promo-codes", label: "Промокоды", icon: "🎟" },
  { href: "/admin/bot-promo", label: "Подарки", icon: "🎁" },
  { href: "/admin/bot-referrals", label: "Рефералы", icon: "🤝" },
  { href: "/admin/bot-poll", label: "Опрос", icon: "📊" },
  { href: "/admin/bot-stock", label: "Склад", icon: "📦" },
  { href: "/admin/bot-verify", label: "Проверка кодов", icon: "🔑" },
  { href: "/admin/link-formatter", label: "Форматирование ссылок", icon: "🔗" },
  { href: "/admin/settings", label: "Настройки", icon: "⚙" },
  { href: "/admin/admins", label: "Администраторы", icon: "⛨" },
  { href: "/admin/audit", label: "Audit logs", icon: "🗒" },
];

export function AdminSidebar({ admin }: { admin: { email: string; roleKey: string } }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function logout() {
    await fetch("/api/admin/login", { method: "DELETE" });
    router.push("/admin/login");
    router.refresh();
  }

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="md:hidden fixed top-3 left-3 z-40 btn-ghost h-10 w-10 p-0"
        aria-label="menu"
      >
        ☰
      </button>
      <aside
        className={`${open ? "translate-x-0" : "-translate-x-full"} md:translate-x-0 fixed md:sticky top-0 z-30 h-screen w-64 shrink-0 border-r bg-surface transition-transform overflow-y-auto`}
      >
        <div className="p-4 border-b flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-brand-fg font-bold">
            SB
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold">Админ-панель</div>
            <div className="text-xs text-muted truncate">{admin.email}</div>
          </div>
        </div>
        <nav className="p-2 space-y-0.5">
          {NAV.map((n) => {
            const active = pathname === n.href || (n.href !== "/admin" && pathname.startsWith(n.href));
            return (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                  active ? "bg-brand text-brand-fg" : "text-muted hover:text-text hover:bg-surface-2"
                }`}
              >
                <span className="w-4 text-center opacity-70">{n.icon}</span>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-2 border-t mt-2">
          <button onClick={logout} className="btn-ghost w-full text-sm">
            Выйти
          </button>
        </div>
      </aside>
      {open && <div className="md:hidden fixed inset-0 z-20 bg-black/40" onClick={() => setOpen(false)} />}
    </>
  );
}
