import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SB Store — Цифровые товары и подписки",
  description: "Подписки, аккаунты и AI-сервисы с моментальной выдачей и гарантией.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
