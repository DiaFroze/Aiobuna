# SB Store — платформа цифровых товаров (Reseller)

Публичный магазин цифровых товаров + защищённая админ-панель + интеграция с
несколькими Reseller API поставщиков.

**Стек:** Next.js 14 (App Router) · TypeScript · PostgreSQL · Prisma · Redis ·
BullMQ · Tailwind CSS.

> Вся логика поставщиков по умолчанию работает через детерминированные **mock-адаптеры** —
> проект полностью демонстрируется офлайн, без реальных ключей API.

---

## Быстрый старт (Docker Compose)

```bash
cp .env.example .env      # секреты для CREDENTIALS_ENC_KEY/AUTH_SESSION_SECRET уже можно сгенерировать
docker compose up --build
```

Поднимутся 4 сервиса: `db` (Postgres), `redis`, `web` (Next.js) и `worker`
(очереди BullMQ). При старте `web` автоматически применит схему и выполнит seed.

- Магазин: http://localhost:3000
- Админ-панель: http://localhost:3000/admin
- Логин администратора: `admin@sb.eu` / `admin12345` (меняется в `.env`)

## Быстрый старт (локально, без Docker)

Нужны запущенные PostgreSQL и Redis.

```bash
npm install
cp .env.example .env       # заполните DATABASE_URL, REDIS_URL
npm run setup              # prisma db push + seed (роли, админ, mock-поставщики, первая синхронизация)
npm run dev                # http://localhost:3000
npm run worker             # (в отдельном терминале) воркер очередей
```

После seed откройте **/admin/candidates** — там уже будут кандидаты из mock-поставщиков,
готовые к публикации.

---

## Скрипты

| Скрипт | Действие |
| --- | --- |
| `npm run dev` | dev-сервер Next.js |
| `npm run build` / `npm start` | production build/запуск |
| `npm run worker` | процесс воркера очередей (BullMQ) |
| `npm run setup` | `db push` + seed |
| `npm run db:push` / `db:seed` | по отдельности |
| `npm test` | unit + integration тесты (Vitest) |
| `npm run typecheck` | проверка типов |

---

## Переменные окружения

См. `.env.example`. Ключевые:

| Переменная | Назначение |
| --- | --- |
| `DATABASE_URL` | строка подключения PostgreSQL |
| `REDIS_URL` | Redis для кеша и очередей |
| `AUTH_SESSION_SECRET` | секрет сессий админа (`openssl rand -hex 32`) |
| `CREDENTIALS_ENC_KEY` | 32 байта hex — ключ AES-256-GCM для шифрования API-ключей поставщиков |
| `SUPPLIER_MODE` | `mock` (по умолчанию) или `live` |
| `USDT_UZS_RATE` | курс USDT→UZS (можно переопределить в админке) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ADMIN_CHAT_ID` | уведомления админа (опц.) |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | учётка суперадмина при seed |

Секреты читаются **только на backend** через `src/lib/env.ts` (`import "server-only"`).
Ничего секретного не имеет префикса `NEXT_PUBLIC_`, поэтому на фронтенд не попадает.

---

## Архитектура

```
src/
  app/
    (shop)/         публичный магазин (главная, каталог, товар, оформление, ...)
    admin/          админ-панель: login + (protected) c RBAC-гвардом
    api/            route handlers (orders, admin login, payments)
  components/       UI + ProductTitleIcon (Premium Emoji)
  lib/
    domain/         ЧИСТАЯ логика: pricing, supplier-selection, rounding, content-diff
    services/       оркестрация: sync, candidate, catalog, order, dashboard, storefront
    suppliers/      adapter (интерфейс) + mock + http (шаблон) + registry
    security/       crypto (AES-GCM), password (bcrypt), rbac, sanitize-html, audit
    auth/           серверные сессии администратора
    queue/          очереди BullMQ
    notifications/  Telegram
  worker/           процесс воркера очередей
  i18n/             словарь строк (ru по умолчанию; uz/en готовы к переводу)
prisma/             schema + идемпотентный seed
tests/              Vitest: pricing, supplier-selection, fallback, content, premium-emoji, mock
docs/               API_INTEGRATION_GUIDE, ADMIN_GUIDE, DATABASE_SCHEMA
```

Подробный план — в [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

---

## Что работает через mock и требует документации поставщика

- Импорт товаров/цен/наличия/условий, баланс, покупка — `MockSupplierAdapter`.
- Реальный поставщик: `src/lib/suppliers/http-adapter.ts` — все места помечены
  `// TODO(supplier-api):`. См. [docs/API_INTEGRATION_GUIDE.md](docs/API_INTEGRATION_GUIDE.md).
- Оплата — `MockPaymentProvider` (эндпоинт `/api/orders/[code]/pay`); карты не хранятся.

---

## Безопасность (кратко)

- RBAC (роли/права), защита `/admin` через серверные сессии (httpOnly cookie).
- API-ключи поставщиков — AES-256-GCM в БД, расшифровка только на backend.
- Санитизация всего HTML/Markdown от поставщиков (без script/iframe/onerror).
- Audit log всех чувствительных действий; логи очищаются от секретов.
- Zod-валидация входных данных; данные карт не принимаются и не хранятся.
