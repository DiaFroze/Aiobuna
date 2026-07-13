# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

SB Store — a digital goods reseller platform: a public storefront + protected admin panel + integration with multiple reseller supplier APIs. Stack: Next.js 14 (App Router) + TypeScript + PostgreSQL + Prisma + Redis + BullMQ + Tailwind CSS. All supplier logic runs through deterministic **mock adapters** by default, so the project runs and demos fully offline without real API keys.

## Commands

```bash
# Local dev (requires running Postgres + Redis, or use Docker Compose below)
npm install
cp .env.example .env          # fill in DATABASE_URL, REDIS_URL, secrets
npm run setup                 # prisma db push + seed (roles, admin, mock suppliers, initial sync)
npm run dev                   # http://localhost:3000
npm run worker                # queue worker, run in a separate terminal

# Docker Compose (db + redis + web + worker)
cp .env.example .env
docker compose up --build

# Tests
npm test                      # vitest run — all tests (tests/**/*.test.ts)
npx vitest run tests/pricing.test.ts   # single test file
npm run test:watch            # vitest watch mode

# Types / lint / build
npm run typecheck             # tsc --noEmit
npm run lint                  # next lint
npm run build                 # prisma generate && next build

# Prisma
npm run db:push               # push schema without migration
npm run db:migrate            # prisma migrate dev
npm run db:seed               # tsx --conditions=react-server prisma/seed.ts
npm run admin:create          # node --env-file=.env scripts/create-admin.mjs
```

Default seeded admin login: `admin@sb.eu` / `admin12345` (via `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`).

## Architecture

```
Browser (shop / admin)
      │  HTTPS
      ▼
Next.js App Router — Server Components / Server Actions / Route Handlers
      │
      ├── src/lib/services    orchestration (sync, candidates, catalog, orders, dashboard)
      ├── src/lib/domain      pure functions (pricing, supplier-selection, rounding, content-diff)
      ├── src/lib/suppliers   SupplierAdapter interface + mock/http adapters + registry
      └── src/lib/security    auth sessions, RBAC, AES-GCM crypto, HTML sanitize, audit
      ▼
Prisma → PostgreSQL         Redis → BullMQ queues
                                 ├── supplier-sync    (import products/prices/availability)
                                 ├── price-recalc
                                 ├── order-fulfil     (purchase from supplier + fallback)
                                 └── notifications    (Telegram)
```

The queue worker is a separate process (`src/worker/index.ts`, the `worker` service in `docker-compose.yml`) and reuses the same `src/lib/services` as the web process — business logic never lives in the route handlers or worker entrypoint directly.

### Core principles (from IMPLEMENTATION_PLAN.md)

- **Secrets stay server-only.** Supplier API keys are AES-256-GCM encrypted in the DB and decrypted only in `src/lib/env.ts` (`import "server-only"`). Nothing secret is prefixed `NEXT_PUBLIC_`.
- **No invented supplier endpoints.** Every supplier implements the `SupplierAdapter` interface (`src/lib/suppliers/adapter.ts`). `MockSupplierAdapter` is active by default; `HttpSupplierAdapter` (`src/lib/suppliers/http-adapter.ts`) is a template with every real-endpoint integration point marked `// TODO(supplier-api):` — see `docs/API_INTEGRATION_GUIDE.md` before wiring a real supplier.
- **Transport is a thin wrapper.** All business logic lives in `src/lib/services` and `src/lib/domain`; API routes and server actions just call into it.
- **Everything sensitive is logged**: prices, terms, suppliers, markups → `AuditLog`, `PriceHistory`, `ProductContentVersion`, `SupplierSyncLog`, `SupplierApiError`.
- **`premium_emoji_code` is always VARCHAR** — long numeric codes that must never round-trip through BigInt/Number.
- **i18n-ready**: UI strings are dictionary keys in `src/i18n` (default `ru`; `uz`/`en` scaffolded).

### Key modules (`src/lib`)

| Module | Responsibility | Tests |
| --- | --- | --- |
| `domain/pricing.ts` | final price calc: fixed/markup, min_price, min_profit, rounding, currencies | `tests/pricing.test.ts` |
| `domain/supplier-selection.ts` | best-supplier selection + fallback + manual-review flag | `tests/supplier-selection.test.ts`, `tests/fallback.test.ts` |
| `domain/rounding.ts` | "nice" rounding rules (e.g. 0.63→0.65, 8570→9000) | covered in pricing tests |
| `domain/content-diff.ts` | content version comparison | `tests/content.test.ts` |
| `security/sanitize-html.ts` | strips supplier HTML/Markdown (no script/iframe/onerror) | `tests/content.test.ts` |
| `suppliers/registry.ts` | looks up adapter by `Supplier.adapterKey` | — |
| `emoji/renderer.ts` | `PremiumEmojiRenderer`, extensible provider | `tests/premium-emoji.test.ts` |
| `security/crypto.ts` | AES-256-GCM encryption of supplier credentials | — |
| `security/rbac.ts` | role/permission checks for admin routes | — |

### Data model

Full schema in `prisma/schema.prisma` / `docs/DATABASE_SCHEMA.md`. Orders (`Order`/`OrderItem`) store a **snapshot** of price/terms/warranty at purchase time rather than referencing live product data — don't join back to `CanonicalProduct` for historical order display.

### Routes

- `src/app/(shop)`: storefront — home, catalog, categories, product, cart, checkout, payment, orders, profile, support, terms, warranties, FAQ.
- `src/app/admin`: dashboard, products, categories, candidates, suppliers, product links, pricing/markup rules, terms/warranties, orders, customers, payments, profit analytics, price history, sync logs, API errors, settings, admins, audit logs. Protected by server-side sessions + RBAC guard.

### Env vars

See `.env.example`. `SUPPLIER_MODE=mock|live` toggles real vs. mock supplier adapters. `CREDENTIALS_ENC_KEY` must be exactly 32 bytes hex (`openssl rand -hex 32`).
