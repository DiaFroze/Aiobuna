# AGENTS.md

**Read `CLAUDE.md` — it is the single source of truth for this repository.**

This file previously held its own copy of the project description. That copy went
stale: it described a public storefront, Redis/BullMQ queues, a separate queue
worker and mock supplier adapters, none of which still exist, and it told agents
to run `npm run worker`, a script that was removed. Two documents that disagree
are worse than one, so this one no longer duplicates anything.

Everything an agent needs — stack, commands, runtime layout, database workflow,
and the invariants that must not be broken (atomic money operations, no duplicate
fulfilment, no `--accept-data-loss`, secrets only via env, Fragment not
implemented) — lives in `CLAUDE.md`.
