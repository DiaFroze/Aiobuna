# IMPLEMENTATION_PLAN.md — Digital Goods Reseller Platform

> Проект: публичный магазин цифровых товаров + защищённая админ-панель +
> интеграция с несколькими Reseller API поставщиков.
> Стек: **Next.js 14 (App Router) + TypeScript + PostgreSQL + Prisma + Redis +
> BullMQ + Tailwind CSS**.

---

## 0. Принципы

1. **Секреты только на backend.** API-ключи поставщиков шифруются (AES-256-GCM)
   и никогда не сериализуются в client-компоненты, логи или ответы API.
2. **Никаких выдуманных эндпоинтов поставщиков.** Каждый поставщик реализует
   интерфейс `SupplierAdapter`. По умолчанию активен `MockSupplierAdapter`.
   Для реального поставщика есть `HttpSupplierAdapter` с ПОМЕЧЕННЫМИ TODO-местами,
   куда вставляются реальные endpoint/params из документации поставщика.
3. **Слой сервисов отделён от транспорта.** Вся бизнес-логика в `src/lib/services`
   и `src/lib/domain`; API-роуты и server actions — тонкие обёртки.
4. **Всё логируется:** цены, условия, гарантии, поставщики, наценки → `AuditLog`,
   `PriceHistory`, `ProductContentVersion`, `SupplierSyncLog`, `SupplierApiError`.
5. **i18n-ready.** Все строки интерфейса — ключи словаря (`src/i18n`), по умолчанию
   `ru`, архитектура готова к `uz` и `en`.

---

## 1. Архитектура (высокоуровнево)

```
Браузер (клиент/админ)
      │  HTTPS
      ▼
Next.js App Router  ── Server Components / Server Actions / Route Handlers
      │                    │
      │                    ├── src/lib/services   (бизнес-логика)
      │                    ├── src/lib/domain      (чистые функции: цена, выбор)
      │                    ├── src/lib/suppliers    (адаптеры + реестр)
      │                    └── src/lib/security     (auth, rbac, crypto, sanitize)
      ▼
Prisma ── PostgreSQL         Redis ── BullMQ (очереди)
                                 │
                                 ├── queue: supplier-sync   (импорт товаров/цен/условий)
                                 ├── queue: price-recalc     (пересчёт цен)
                                 ├── queue: order-fulfil     (покупка у поставщика + fallback)
                                 └── queue: notifications    (Telegram)
```

Воркер очередей — отдельный процесс (`src/worker/index.ts`, сервис `worker` в
docker-compose), использует те же сервисы, что и web.

---

## 2. Таблицы БД (Prisma модели)

Полный список (см. `prisma/schema.prisma` и `docs/DATABASE_SCHEMA.md`):

| Модель | Назначение |
| --- | --- |
| `Admin`, `Role`, `Permission`, `RolePermission` | RBAC для админов |
| `AdminSession` | серверные сессии админа |
| `AuditLog` | все чувствительные действия |
| `User` | клиент магазина |
| `Supplier` | поставщик: URL, статус, баланс, метрики надёжности |
| `SupplierApiCredential` | **зашифрованный** API-ключ (AES-256-GCM) |
| `SupplierProduct` | сырой товар от поставщика (цена, наличие, тексты) |
| `CanonicalProduct` | наш товар в каталоге |
| `ProductSupplierLink` | связка canonical ↔ supplierProduct (приоритет, fallback) |
| `ProductCategory` | категории (наценка по категории) |
| `ProductPriceRule` | правила цены/наценки (глобал/категория/товар) |
| `ProductContent` | публичные + оригинальные тексты, режимы sync/override |
| `ProductContentVersion` | история версий контента (diff) |
| `PremiumEmojiConfig` | premium_emoji_code (VARCHAR!), fallback, режим отображения |
| `Candidate` | кандидат на добавление (найденный, ещё не опубликованный товар) |
| `Order`, `OrderItem` | заказы + позиции со **снапшотом** условий/гарантии/цены |
| `Payment` | платёж (без данных карт) |
| `ProfitRecord` | запись прибыли по заказу |
| `PriceHistory` | история изменения цен |
| `SupplierSyncLog` | история синхронизаций |
| `SupplierApiError` | ошибки API поставщиков |
| `Notification` | уведомления (в т.ч. Telegram) |
| `CurrencyRate` | курсы USDT/USD/UZS |
| `Setting` | глобальные настройки (наценка по умолчанию, округление и т.д.) |

`premium_emoji_code` хранится как **VARCHAR** — длинные цифровые коды без потери
точности (никогда не BigInt/Number).

---

## 3. Модули логики (`src/lib`)

| Модуль | Ответственность | Тесты |
| --- | --- | --- |
| `domain/pricing.ts` | расчёт финальной цены: fixed/markup, min_price, min_profit, округление, валюты | `tests/pricing.test.ts` |
| `domain/supplier-selection.ts` | выбор лучшего поставщика + fallback + флаг ручной проверки | `tests/supplier-selection.test.ts`, `tests/fallback.test.ts` |
| `domain/rounding.ts` | «красивое» округление по правилам (0.63→0.65, 8570→9000) | покрыто в pricing |
| `domain/content-diff.ts` | сравнение версий контента | `tests/content.test.ts` |
| `security/sanitize-html.ts` | безопасная очистка HTML/Markdown от поставщика | `tests/content.test.ts` |
| `suppliers/adapter.ts` | интерфейс `SupplierAdapter` + типы | — |
| `suppliers/mock-adapter.ts` | детерминированный mock поставщика | integration |
| `suppliers/http-adapter.ts` | шаблон реального HTTP-адаптера (TODO-места) | — |
| `suppliers/registry.ts` | реестр адаптеров по `Supplier.adapterKey` | — |
| `emoji/renderer.ts` | `PremiumEmojiRenderer` (расширяемый провайдер) | `tests/premium-emoji.test.ts` |
| `security/crypto.ts` | AES-256-GCM шифрование credentials | — |
| `security/rbac.ts` | проверка ролей/прав | — |
| `services/*` | оркестрация: sync, candidates, orders, pricing-apply, notifications | integration |

---

## 4. Страницы

**Клиент** (`src/app/(shop)`): Главная, Каталог, Категории, Товар, Корзина,
Оформление, Оплата, Мои заказы, Профиль, Поддержка, Условия, Гарантии, FAQ.

**Админ** (`src/app/admin`): Dashboard, Товары, Категории, Кандидаты, Поставщики,
Связки товаров, Цены и наценки, Условия и гарантии, Заказы, Клиенты, Платежи,
Прибыль и аналитика, История цен, Логи синхронизации, Ошибки API, Настройки,
Администраторы, Audit logs.

---

## 5. План по этапам

- **Этап 1 — Каркас (этот коммит).** Next.js+TS+Tailwind, Prisma schema, Docker,
  .env.example, i18n, дизайн-система.
- **Этап 2 — Ядро логики + тесты.** pricing, supplier-selection, fallback,
  content-sync, sanitize, premium-emoji. Юнит-тесты.
- **Этап 3 — Поставщики.** adapter/mock/http/registry, сервис синхронизации,
  логи, ошибки.
- **Этап 4 — Кандидаты и публикация.** обнаружение, экран кандидатов, approve→publish.
- **Этап 5 — Заказы.** оформление, снапшоты, выбор поставщика, fallback, статусы.
- **Этап 6 — Админ-панель.** dashboard + разделы (RBAC, audit).
- **Этап 7 — Витрина.** каталог, страница товара, ProductTitleIcon.
- **Этап 8 — Очереди и уведомления.** BullMQ воркеры, Telegram.
- **Этап 9 — Тесты интеграции, документация, финализация.**

---

## 6. Что работает на mock и требует документации поставщика

- Импорт товаров/цен/наличия/условий — `MockSupplierAdapter` (детерминированный).
- Покупка у поставщика (`placeOrder`) — mock.
- Реальный поставщик подключается через `HttpSupplierAdapter`: точные места для
  endpoint/params/парсинга помечены `// TODO(supplier-api):`.
- Telegram-уведомления работают при заданном `TELEGRAM_BOT_TOKEN`, иначе no-op лог.
- Платёжный провайдер — заглушка `MockPaymentProvider` (карты не хранятся).

Подробности в `docs/API_INTEGRATION_GUIDE.md`.
