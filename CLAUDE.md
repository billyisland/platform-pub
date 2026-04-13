# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

When conversation produces a rule or piece of design philosophy that is intended to apply universally across the site, check it for consistency with the existing rules in this file. If it's consistent and non-redundant, add it here. This file is the canonical source of sitewide standards — if a rule isn't here, it will be forgotten between sessions.

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
| Feed ingest | `feed-ingest/` | — | Graphile Worker |
| Nostr relay | `relay/` | 4848 | strfry |
| PostgreSQL | — | 5432 | Postgres 16 |

All backend services share a single PostgreSQL database. `shared/` contains the DB client, migration runner, auth helpers, and shared types used by all services.

## Development & deployment

This is a local dev directory on the developer's laptop. Test features at `localhost:3010` (web) and `localhost:3000` (API). To deploy to production: push to git, then the developer SSHs to a remote server and rebuilds there. Claude Code has no direct access to the production server.

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

### External feeds (Universal Feed Phase 1)
- External content (RSS) is ingested by `feed-ingest/` (Graphile Worker service, no HTTP port)
- `external_sources` (shared canonical feeds), `external_subscriptions` (per-user), `external_items` (normalised content) — see migration 052
- Feed query uses a three-stream merge: articles + notes + external items in `gateway/src/routes/feed.ts`
- External items appear in the following feed only (excluded from explore until scoring worker ships)
- Daily cap per source enforced at query time via windowed `ROW_NUMBER()` over a rolling 24h window
- Universal resolver (`gateway/src/lib/resolver.ts`) provides identity resolution for subscribe, invite, and other input fields — see `POST /api/v1/resolve`
- Subscription CRUD: `gateway/src/routes/feeds.ts` — subscribe, list, remove, mute, refresh
- `ExternalCard` component renders external items with provenance badge (`VIA RSS`), sanitised HTML, media
- `/subscriptions` page manages external feed subscriptions
- SSRF-hardened HTTP client in `shared/src/lib/http-client.ts` — used by both feed-ingest and gateway
- Full spec: `UNIVERSAL-FEED-ADR.md` (Phases 2–5 cover feed_items table, Nostr, Bluesky, Mastodon, outbound)

## Omnivorous input (identity resolution)

Wherever all.haus asks a user to identify a person, feed, or resource, the receiving field should be omnivorous: accept a URL, a handle, an email, an npub, a DID, a username — whatever the user has — and resolve it. Do not build narrow single-format inputs (email-only, username-only) for identity fields. Use the universal resolver (`POST /api/resolve`, specced in `UNIVERSAL-FEED-ADR.md` §V.5) as the shared resolution backend. The resolver classifies input by pattern matching and dispatches to protocol-specific resolution chains. Context parameter (`subscribe`, `invite`, `dm`, `general`) controls priority and filtering.

## TypeScript setup

- Backend services extend `tsconfig.base.json` (ES2022, NodeNext module resolution, strict)
- `web/tsconfig.json` uses `moduleResolution: bundler` and `@/*` path alias for `web/src/*`
- All services compile to `dist/`

## Design tokens (Tailwind)

Custom semantic tokens in `web/tailwind.config.js`. Fonts: Jost (sans), Literata (serif), IBM Plex Mono (mono). Key max-widths: `article: 640px`, `feed: 780px`, `editor-frame: 780px`, `content: 960px`.

## Design system rules

These rules apply to all frontend code. Follow them when writing or modifying components.

### Three-voice typeface system
| Voice | Typeface | Use for |
|---|---|---|
| **Literary** (serif) | Literata | Article prose, publication names, content previews, the reading experience |
| **Platform** (sans) | Jost | UI copy, page titles, body text, descriptions, buttons, display names |
| **Infrastructure** (mono) | IBM Plex Mono | Labels, metadata, system status, data values, tab pills |

Never use serif for platform UI elements (page titles, settings, admin headings, user display names in lists). Never use sans for infrastructure labels. When in doubt, prefer sans over serif for non-literary content.

### Use design tokens, not inline sizes
| Token | Size | Use for |
|---|---|---|
| `text-ui-xs` | 13px sans | Small UI text, descriptions, secondary copy |
| `text-ui-sm` | 14px sans | Standard UI text, form values, list items |
| `text-mono-xs` | 11px mono | Small mono data (dates, amounts, tabular values) |
| `.label-ui` | 11px mono, uppercase, 0.06em tracking | All infrastructure labels and metadata tags |

Never hand-roll `font-mono text-[12px] uppercase tracking-[0.06em]` — that is `.label-ui`. Never use `text-[13px] font-sans` — that is `text-ui-xs`. Never use `text-[14px] font-sans` — that is `text-ui-sm`.

### Form labels
Always use `.label-ui text-grey-400` for form labels. Do not use `text-ui-xs uppercase tracking-wider` or `text-sm text-grey-600` for labels.

### Buttons
Use the defined button classes: `.btn` (primary), `.btn-accent` (crimson), `.btn-ghost` (background), `.btn-soft` (secondary/soft action). Do not hand-roll button styles with inline classes.

### Text-link actions
Use `.btn-text` for inline text-link actions (13px sans, black, medium weight). Use `.btn-text-muted` for secondary actions (grey, hover:black). Use `.btn-text-danger` for destructive actions (crimson). Do not hand-roll text button styles with `text-ui-xs text-black font-medium` or similar.

### Toggle chips
Use `.toggle-chip` + `.toggle-chip-active` / `.toggle-chip-inactive` (combined with `.label-ui`) for On/Off style selectors. Do not hand-roll toggle styling with inline conditional classes.

### Dividers
Use `.slab-rule-4` for major section dividers. Do not use `h-[4px] bg-black` inline.

## Key docs

- `feature-debt.md` — consolidated feature debt, outstanding work, and attack order
- `UNIVERSAL-FEED-ADR.md` — universal social reader spec (external feeds, resolver, outbound posting)
- `DEPLOYMENT.md` — full production deployment guide
- `schema.sql` — full PostgreSQL schema (source of truth for DB structure)
- `planning-archive/` — completed specs (FEATURES.md, DESIGN-BRIEF.md, FEED-ALGORITHM.md, RESILIENCE.md, etc.)
