# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A publishing and social platform for writers and readers, built on the Nostr protocol. Writers own their identity, audience, and content via custodial Nostr keypairs. Readers pay via a shared "reading tab" (Stripe-based accrual → payout flow).

## Services & Ports

| Service | Dir | Port | Framework |
|---|---|---|---|
| Web frontend | `web/` | 3010 | Next.js 14 / React 18 |
| API gateway | `gateway/` | 3000 | Fastify 4 |
| Payment service | `payment-service/` | 3001 | Fastify 4 |
| Key service | `key-service/` | 3002 | Fastify 4 |
| Blossom media | external | 3003 | Blossom |
| Key custody | `key-custody/` | 3004 | Fastify 4 |
| Nostr relay | `relay/` | 4848 | strfry |
| PostgreSQL | — | 5432 | Postgres 16 |

All backend services share a single PostgreSQL database. `shared/` contains the DB client, migration runner, auth helpers, and shared types used by all services.

## Commands

### Local dev stack
```bash
docker compose up          # Start all services
docker compose up gateway  # Start a single service
docker compose build web   # Rebuild one service image
```

### Individual service development
Each backend service (`gateway/`, `payment-service/`, `key-service/`, `key-custody/`):
```bash
npm run dev    # tsx watch mode
npm run build  # tsc → dist/
npm run test   # Vitest (run once)
npm run test:watch  # Vitest watch
```

Web frontend (`web/`):
```bash
npm run dev    # Next.js dev server (port 3010)
npm run build  # Production build
npm run lint   # ESLint via next lint
```

Shared library (`shared/`):
```bash
npm run build  # tsc
npm run test   # Vitest
```

### Database migrations
Migrations are numbered SQL files in `migrations/`. The shared migration runner applies them in order. Each backend service also has its own `db/migrate.ts` (run via `npm run migrate` in `payment-service`).

## Architecture

### Request flow
Browser → Nginx (80/443) → routes `/api/*` to gateway, `/` to web. The Next.js app rewrites `/api/*` calls to the gateway at `GATEWAY_URL`, so the frontend never calls backend services directly.

### Auth
- Magic links + Google OAuth (no passwords)
- Auth cookies are httpOnly JWTs set by the gateway
- `gateway/src/middleware/auth.ts` exports `requireAuth` and `optionalAuth` Fastify hooks
- Custodial Nostr keypairs: key-custody holds private keys, key-service wraps/issues NIP-44 encrypted keys to readers for unlocking gated content

### Nostr integration
- Articles are Nostr kind 30023 (NIP-23) replaceable long-form events, signed via key-custody
- The platform runs its own strfry relay; events are published via `gateway/src/lib/nostr-publisher.ts`
- The web client uses NDK (`@nostr-dev-kit/ndk`) for reading events; `web/src/lib/ndk.ts` handles event parsing
- Soft-delete: articles are marked deleted in the DB and a Nostr kind 5 deletion event is published

### Payments
- Readers accumulate a tab (Stripe PaymentIntent) as they read gated articles
- `payment-service/src/services/` contains accrual, settlement, and payout logic
- Payouts go to writers via Stripe Connect
- Article access logic lives in `gateway/src/services/access.ts`

### Media
- Uploaded via gateway (`gateway/src/routes/media.ts`), stored in a Docker volume, served via Nginx at `/media/`
- Blossom is configured for Nostr-native media federation but primary storage is local
- oEmbed proxying handled in `gateway/src/routes/media.ts`

### Editor
- TipTap (ProseMirror-based) in `web/src/components/editor/`
- Supports a paywall gate node — content below the gate requires payment to unlock
- Markdown serialization via `tiptap-markdown`

### Feed & search
- Feed ranking spec in `planning-archive/FEED-ALGORITHM.md` (Phase 1 implemented)
- Full-text search uses PostgreSQL trigrams (`pg_trgm`), see `gateway/src/routes/search.ts`

## TypeScript setup

- Backend services extend `tsconfig.base.json` (ES2022, NodeNext module resolution, strict)
- `web/tsconfig.json` uses `moduleResolution: bundler` and `@/*` path alias for `web/src/*`
- All services compile to `dist/`

## Design tokens (Tailwind)

Custom semantic tokens in `web/tailwind.config.js`: `surface`, `card`, `rule`, `accent`, `ink`, `nav`, `content-*`, `avatar`. Fonts: Source Sans 3 (sans), Literata (serif), IBM Plex Mono (mono). Key max-widths: `article: 640px`, `feed: 780px`, `editor-frame: 780px`.

## Key docs

- `feature-debt.md` — consolidated feature debt, outstanding work, and attack order
- `DEPLOYMENT.md` — full production deployment guide
- `schema.sql` — full PostgreSQL schema (source of truth for DB structure)
- `planning-archive/` — completed specs (FEATURES.md, DESIGN-BRIEF.md, FEED-ALGORITHM.md, RESILIENCE.md, etc.)
