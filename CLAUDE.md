# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project overview

**AI OBUNA** — a Telegram shop selling digital subscriptions (Gemini, CapCut,
Canva, ElevenLabs …) to customers in Uzbekistan. Prices are in **UZS (сум)**.

There is no public storefront: customers buy **only through the Telegram bot**,
and the Next.js app exists to serve the **admin panel** and the **payment
webhooks**. (An earlier storefront, queue worker and Redis/BullMQ stack were
removed; if you find docs describing them, those docs are stale.)

## Commands

```bash
npm install
npm run dev          # admin panel, http://localhost:3000
npm run bot          # Telegram bot (long-polling), separate terminal
npm run db:push      # apply prisma/schema.prisma to the database
npm run db:seed      # roles + admin
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build        # prisma generate && next build
```

`npm run lint` is **not usable**: ESLint has never been configured here and
`next lint` drops into an interactive setup. Treat typecheck + tests as the gate.

## Runtime

Two processes share one PostgreSQL database:

```
Railway (NIXPACKS, 1 replica) → npm run start:all → scripts/start-all.mjs
   ├─ prisma db push            (blocking; a failure aborts the deploy)
   ├─ next start -p $PORT       admin panel + /api/payme + /api/click
   └─ tsx src/bot/index.ts      the bot; runs ensureSchema() before serving
```

`start-all.mjs` supervises both children: if either dies, the container exits
non-zero so Railway restarts it. One long-poller per bot token — never run a
second bot process against production.

## Layout

| Path | What |
| --- | --- |
| `src/bot/index.ts` | the whole bot (~5k lines): catalog, purchase, payments, referrals, admin commands |
| `src/lib/domain/*` | pure, unit-tested logic — no DB, no network, no grammY |
| `src/lib/supplier.ts` | supplier adapters (`vex`, `somadeth`); add new formats here |
| `src/app/admin/(protected)/*` | admin panel (server components + server actions) |
| `src/app/api/payme`, `api/click` | payment webhooks |
| `prisma/schema.prisma` | schema; `ensureSchema()` in the bot adds what `db push` cannot express |

Domain modules: `payme`, `click`, `bulk-pricing`, `premium-delivery`,
`topup-approval`, `telegram-username`. Anything worth testing belongs here —
that is why these exist.

## Database

`prisma db push` is the workflow; there are **no migrations** (`prisma/migrations`
does not exist, and `prisma migrate dev` would offer to reset the database — do
not add it back casually). Schema changes go in `schema.prisma` **and**, when the
bot needs them immediately or Prisma cannot express them, in `ensureSchema()` as
idempotent raw DDL.

Orders store a snapshot of price and title at purchase time — do not join back to
live product rows for historical display.

## i18n

Three languages (`ru` default, `uz`, `en`) in `src/bot/i18n.ts`. A new key must
be added to **all three**, or `t()` returns the key itself to the customer.

## Invariants (do not break)

These are load-bearing rules, learned from real bugs. Each one has tests.

- **Money moves exactly once.** Every credit, charge and delivery is guarded by a
  compare-and-set (`UPDATE … WHERE <state>` / `updateMany` + row count), never by
  read-then-write. Reading a row, checking its status and then updating it lets
  two concurrent callers both pass the check. See `domain/topup-approval.ts`.
- **No payment approval without CAS.** The status transition *is* the lock; only
  the caller whose update changed a row may credit and fulfil.
- **No duplicate fulfilment.** An order is delivered from two places (`/give` and
  the admin panel) — both must use `closeDeliveryPatch()` and refuse an order
  that `isAlreadyDelivered()`. `COMPLETED` is terminal.
- **Recipient before payment.** Anything delivered to a Telegram account
  (`deliversToAccount()`) must capture its recipient before money moves, and the
  recipient travels in the purchase note (`buildBuyNote`/`parseBuyNote`) — never
  hand-rolled `split(":")`. Delivery is addressed by numeric id; a username alone
  is never sufficient.
- **Payme / Click are not edited without regression tests.** `tests/payme.test.ts`
  and `tests/click.test.ts` must stay green; they encode provider protocol rules.
- **Production schema never uses `--accept-data-loss`.** Startup must fail closed
  on a destructive change. Verified: without the flag Prisma refuses when a column
  holding data would be dropped; additive changes still apply normally. Partial
  indexes live in `ensureSchema()` raw DDL (Prisma cannot express them) and are
  left untouched by `db push`.
- **Secrets only via env.** Never a hardcoded token, key or seed — not even as a
  fallback, and not even a revoked one.
- **Fragment is not implemented.** No Fragment API, cookies, session, wallet, seed
  or private key, and `giftPremiumSubscription` is not called. Telegram Premium
  delivery stays `PREMIUM_DELIVERY_MODE=manual` until a separate, explicit task.

## Deployment reality

Production is Railway (NIXPACKS) running `npm run start:all`, which runs
`prisma db push` and then supervises the Next.js and bot processes — if either
dies, the container exits non-zero so the platform restarts it. `Dockerfile` and
`docker-compose.yml` are **not** used by production and are stale (compose still
references a removed `worker` service).
