// Interface strings. Russian is the source of truth; uz/en fall back to ru
// until translated. No hardcoded UI text elsewhere — always use t().

export type Locale = "ru" | "uz" | "en";
export const LOCALES: Locale[] = ["ru", "uz", "en"];
export const DEFAULT_LOCALE: Locale = "ru";

type Dict = Record<string, string>;

const ru: Dict = {
  "brand.name": "SB Store",
  "nav.catalog": "Каталог",
  "nav.categories": "Категории",
  "nav.orders": "Мои заказы",
  "nav.profile": "Профиль",
  "nav.support": "Поддержка",
  "nav.faq": "FAQ",
  "nav.guarantees": "Гарантии",
  "nav.terms": "Условия использования",
  "home.hero.title": "Цифровые товары и подписки",
  "home.hero.subtitle": "Подписки, аккаунты и AI-сервисы с моментальной выдачей и гарантией.",
  "home.cta": "Перейти в каталог",
  "product.buy": "Купить",
  "product.inStock": "В наличии",
  "product.outOfStock": "Нет в наличии",
  "product.duration": "Срок",
  "product.description": "Описание",
  "product.conditions": "Условия",
  "product.guarantee": "Гарантия",
  "product.instructions": "Инструкция",
  "product.delivery": "Время выдачи",
  "product.similar": "Похожие товары",
  "product.price": "Цена",
  "cart.title": "Корзина",
  "checkout.title": "Оформление заказа",
  "checkout.pay": "Перейти к оплате",
  "common.loading": "Загрузка…",
  "common.back": "Назад",
  "admin.title": "Админ-панель",
  "admin.login": "Вход в админ-панель",
  "admin.username": "Логин",
  "admin.email": "Email",
  "admin.password": "Пароль",
  "admin.signIn": "Войти",
};

// Uzbek / English start as copies of ru (fallback) — translate incrementally.
const uz: Dict = { ...ru };
const en: Dict = { ...ru };

const DICTS: Record<Locale, Dict> = { ru, uz, en };

export function translate(locale: Locale, key: string): string {
  return DICTS[locale]?.[key] ?? DICTS[DEFAULT_LOCALE][key] ?? key;
}

/** Server helper: build a bound t() for a locale. */
export function getT(locale: Locale = DEFAULT_LOCALE) {
  return (key: string) => translate(locale, key);
}
