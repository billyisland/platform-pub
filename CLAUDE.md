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

### External feeds (Universal Feed Phases 1–4 + Phase 5A)
- External content (RSS, external Nostr, Bluesky, Mastodon) is ingested by `feed-ingest/` (Graphile Worker service + a long-lived Jetstream WebSocket listener, no HTTP port)
- `external_sources` (shared canonical feeds), `external_subscriptions` (per-user), `external_items` (normalised content) — see migration 052
- `feed_items` (migration 053) is the denormalised unified timeline — articles, notes, and external items all land here via transactional dual-write from their source tables
- Feed query (`gateway/src/routes/feed.ts`) is a single-table scan on `feed_items` with LEFT JOINs for type-specific fields (article price/gate, note quote tags, external HTML, atproto quote/reply URIs). Compound `(published_at, id)` cursor
- External items appear in the following feed only (excluded from explore until scoring worker ships for external content)
- Daily cap per source enforced at query time via windowed `ROW_NUMBER()` over a rolling 24h window
- Universal resolver (`gateway/src/lib/resolver.ts`) provides identity resolution for subscribe, invite, and other input fields — see `POST /api/v1/resolve`. AT Protocol identity via `gateway/src/lib/atproto-resolve.ts` (DID docs, handle resolution, profile metadata — all through the public AppView `public.api.bsky.app`)
- Subscription CRUD: `gateway/src/routes/feeds.ts` — subscribe, list, remove, mute, refresh. Accepts `rss`, `nostr_external`, `atproto`, `activitypub` protocols; enqueues an immediate fetch job per protocol (RSS poll, Nostr fetch, atproto `getAuthorFeed` backfill, or AP outbox poll). Also exposes `GET /admin/activitypub/instance-health` for per-instance success/failure rates
- `ExternalCard` component renders external items with provenance badge (`VIA RSS` / `VIA NOSTR` / `VIA BLUESKY` / `VIA MASTODON`), sanitised HTML, images, link embed cards, quote-post links, video links. Atproto `at://` URIs are rewritten to `bsky.app` URLs at render time
- `/subscriptions` page manages external feed subscriptions
- SSRF-hardened HTTP client in `shared/src/lib/http-client.ts` — used by feed-ingest, gateway resolver, and atproto adapter
- External Nostr: `feed-ingest-nostr.ts` opens temporary WebSockets to source relays, REQ for kinds 1/30023/5, NIP-19 encoding. Outbound replies: `publishToExternalRelays()` in `gateway/src/lib/nostr-publisher.ts` — `POST /notes` accepts optional `signedEvent` and fires to source relays
- Bluesky (Phase 3, read-only): `feed-ingest/src/jetstream/listener.ts` maintains a long-lived WebSocket to `wss://jetstream1.us-east.bsky.network/subscribe`, filtered by active atproto DIDs. Leader-elected via a session-scoped `pg_try_advisory_lock`, so only one feed-ingest replica holds the socket at a time (other replicas poll for the lock every 30s). DID set is refreshed every 60s via a self-scheduling `setTimeout`; connection reconnects with updated filter on change. Cursor resumes from oldest `time_us` across sources on reconnect. `feed-ingest/src/adapters/atproto.ts` normalises post records (facets → HTML via `@atproto/api` RichText, embeds → media array, quote refs). `feed-ingest/src/lib/atproto-ingest.ts` is the shared dual-write helper used by both the listener and the backfill job. `feed_ingest_atproto_backfill` task pages `app.bsky.feed.getAuthorFeed` on new subscription (and as a fallback when `platform_config.jetstream_healthy = false`, driven by `feed_ingest_poll`)
- Mastodon (Phase 4, read-only): `feed-ingest/src/adapters/activitypub.ts` fetches the actor doc to find the outbox URL, then paginates the outbox newest-first. Only public `Create` → `Note` activities are ingested (visibility check via `to`/`cc` containing the AS Public URI); Announces (boosts), non-public posts, and tombstones are ignored — outbox polling has no deletion signal, so delete propagation waits for inbox delivery (future phase). `feed-ingest/src/tasks/feed-ingest-activitypub.ts` is the per-source poll task, cursor = id URI of the previous newest item. `feed-ingest/src/lib/activitypub-ingest.ts` shared dual-write + `activitypub_instance_health` counters (see migration 056). WebFinger + actor lookup: `gateway/src/lib/activitypub-resolve.ts` (`resolveWebFinger`, `fetchActorProfile`, `extractFromMastodonUrl`). The universal resolver's `fediverse_handle` chain is live, and the ambiguous `user@domain` chain runs WebFinger alongside NIP-05. Mastodon sources wear a `BETA` label in `SubscribeInput` and the subscriptions page — per ADR §XIII, outbox polling is best-effort
- Daily cron jobs: `feed_items_reconcile` (05:00) catches dual-write drift, `feed_items_author_refresh` (04:00) propagates author metadata changes
- Outbound (Phase 5A — Mastodon, Phase 5B — Bluesky + external Nostr): migration 057 adds `linked_accounts` (encrypted OAuth credentials via `LINKED_ACCOUNT_KEY_HEX` / `shared/src/lib/crypto.ts`), `outbound_posts` (audit + retry state), and `oauth_app_registrations` (per-instance dynamic client reg). Migration 058 makes `outbound_posts.linked_account_id` nullable and adds `signed_event jsonb` so external-Nostr jobs ride the same queue without an OAuth account. Migration 059 adds `atproto_oauth_sessions` (DB-backed `NodeSavedSessionStore` for `@atproto/oauth-client-node`, AES-256-GCM encrypted). Migration 060 adds `atproto_oauth_pending_states` (DB-backed `NodeSavedStateStore` for the authorize→callback PKCE/DPoP round-trip so the flow survives multi-replica gateway scale-out; pruned every 5m by `atproto_oauth_states_prune`). Gateway `/api/v1/linked-accounts/*` handles Mastodon OAuth + AT Protocol OAuth (`POST /linked-accounts/bluesky` → authorize URL, `GET /linked-accounts/bluesky/callback`); `shared/src/lib/atproto-oauth.ts` is the singleton `NodeOAuthClient` factory (confidential client, `private_key_jwt`, PKCE + DPoP + PAR; loopback `client_id` for local dev, `ATPROTO_CLIENT_BASE_URL` + `ATPROTO_PRIVATE_JWK` in prod). `POST /notes` accepts optional `crossPost: { linkedAccountId, sourceItemId, actionType }` and calls `enqueueCrossPost` (best-effort); quote/reply to external Nostr posts enqueues via `enqueueNostrOutbound` (user-signed event in the job payload). feed-ingest `outbound_cross_post` dispatches by protocol: `activitypub-outbound.ts` (`/api/v1/statuses` + `Idempotency-Key`, federated reply targets via `/api/v2/search?resolve=true`), `atproto-outbound.ts` (`com.atproto.repo.createRecord` via `OAuthSession.fetchHandler`, DPoP-bound, 300-grapheme truncation via `Intl.Segmenter`, reply strong-refs and `app.bsky.embed.record` quotes from `external_items.interaction_data`), `nostr-outbound.ts` (WS publishes to `external_sources.relay_urls`). `outbound_token_refresh` cron (every 30m) proactively touches dormant atproto sessions weekly via `client.restore(did, 'auto')`; Mastodon tokens don't expire so that branch is a no-op. `LinkedAccountsPanel` on `/settings` manages both Mastodon and Bluesky connections. Nginx routes `/.well-known/oauth-client-metadata.json` + `/.well-known/jwks.json` to the gateway for PDS discovery
- Full spec: `UNIVERSAL-FEED-ADR.md`

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

### Page shell
All top-level admin/settings/dashboard pages use `<PageShell>` from `web/src/components/ui/PageShell.tsx`. It fixes outer padding (`py-12`), title styling, and title→content gap (`mb-8`). Choose width by content type: `article` (640px) for single-column forms, `feed` (780px) for lists/cards/reading surfaces, `content` (960px) for tables and data-dense dashboards. Do not hand-roll `mx-auto max-w-* px-4 sm:px-6 py-*` wrappers on new pages. Use `<PageHeader>` standalone for sub-views that need the same title treatment.

### Dividers
Use `.slab-rule-4` for major section dividers. Do not use `h-[4px] bg-black` inline.

## Key docs

- `feature-debt.md` — consolidated feature debt, outstanding work, and attack order
- `UNIVERSAL-FEED-ADR.md` — universal social reader spec (external feeds, resolver, outbound posting)
- `DEPLOYMENT.md` — full production deployment guide
- `schema.sql` — full PostgreSQL schema (source of truth for DB structure)
- `planning-archive/` — completed specs (FEATURES.md, DESIGN-BRIEF.md, FEED-ALGORITHM.md, RESILIENCE.md, etc.)
