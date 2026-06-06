# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

When conversation produces a rule or piece of design philosophy that is intended to apply universally across the site, check it for consistency with the existing rules in this file. If it's consistent and non-redundant, add it here. This file is the canonical source of sitewide standards — if a rule isn't here, it will be forgotten between sessions.

## What This Is

A publishing and social platform for writers and readers, built on the Nostr protocol. Writers own their identity, audience, and content via custodial Nostr keypairs. Readers pay via a shared "reading tab" (Stripe-based accrual → payout flow).

## Services & Ports

| Service         | Dir                | Port | Framework             |
| --------------- | ------------------ | ---- | --------------------- |
| Web frontend    | `web/`             | 3010 | Next.js 14 / React 18 |
| API gateway     | `gateway/`         | 3000 | Fastify 4             |
| Payment service | `payment-service/` | 3001 | Fastify 4             |
| Key service     | `key-service/`     | 3002 | Fastify 4             |
| Blossom media   | external           | 3003 | Blossom               |
| Key custody     | `key-custody/`     | 3004 | Fastify 4             |
| Feed ingest     | `feed-ingest/`     | —    | Graphile Worker       |
| Nostr relay     | `relay/`           | 4848 | strfry                |
| PostgreSQL      | —                  | 5432 | Postgres 16           |

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

### Per-service scripts

Backend services (`gateway/`, `payment-service/`, `key-service/`, `key-custody/`) and `shared/` share the same npm scripts: `npm run dev` (tsx watch), `npm run build` (tsc → `dist/`), `npm run test` / `npm run test:watch` (Vitest). The web frontend (`web/`) uses `npm run dev` (Next.js, port 3010), `npm run build`, and `npm run lint` (next lint — React/hooks/a11y/next-image; currently dormant).

**Linting.** The root `eslint.config.mjs` (flat config, `npm run lint` at the repo root) is the type-aware pass covering **all workspaces including `web/src`** — its reason to exist is promise safety (`no-floating-promises`/`no-misused-promises`/`await-thenable`), applied identically to backend and frontend via a shared rule set. The web block sets `checksVoidReturn.attributes: false` (React ignores a handler's returned promise) and carries no-op stubs for the React/hooks/a11y/next-image rule names so the source's inline `eslint-disable` directives stay valid — those rules are enforced by `web`'s own `next lint`, not here. `npm run lint` must stay at **0 errors** (warnings — `no-explicit-any`, `no-unused-vars` — are accepted hygiene debt).

### Database migrations

Migrations are numbered SQL files in `migrations/`. The shared migration runner applies them in order. Each backend service also has its own `db/migrate.ts` (run via `npm run migrate` in `payment-service`).

**`schema.sql` is the genesis base, not a derivative.** A fresh DB (dev `initdb.d` and prod) boots from `schema.sql`, *then* `migrate.ts` applies anything newer on top. So the two halves must always agree: `schema.sql` must already contain every migration's effect **and** seed `_migrations` with every migration filename (so `migrate.ts` is a clean no-op on a fresh boot). There is no genesis migration — migration `001` already ALTERs tables that only `schema.sql` ever created — so the chain cannot be replayed from empty; `schema.sql` is load-bearing.

After **adding a migration** or otherwise changing the schema, regenerate `schema.sql` with `pg_dump` from a fully-migrated DB (never hand-edit it — hand-edits break canonical round-trip) and re-append the `_migrations` seed, then run the drift guard:

```bash
scripts/check-schema-drift.sh   # 0: seed lists all migrations · 1: migrate is a no-op on a schema.sql DB · 2: schema.sql round-trips clean
```

It builds throwaway DBs in the dev Postgres container (read-only w.r.t. your real dev DB) and exits non-zero with a diff on drift. **This is enforced in CI** (`.github/workflows/ci.yml` `schema` job) — a stale `schema.sql` fails the build before it can break a fresh deploy. **Scope (what it does and does not catch):** the guard catches the common drift — a migration added but `schema.sql` not regenerated, so the seed omits the new filename (Check 0) — and non-canonical hand-edits (Check 2). It does **not** rebuild the schema from migrations (there is no genesis migration — see above), so it cannot catch a migration whose filename *is* seeded but whose object body was left out of `schema.sql` by a partial or hand regen: `migrate.ts` then trusts the seed and never creates the object, and all three checks pass green. The discipline that closes this is mechanical — regenerate with `pg_dump` and re-append the seed in one step; never hand-edit the seed line.

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
- **Relay outbox (complete)**: every write path that publishes a signed Nostr event to the platform relay enqueues into `relay_outbox` (migration 076) inside the caller's transaction via `shared/src/lib/relay-outbox.ts::enqueueRelayPublish`. The `feed-ingest` worker `relay_publish` publishes via `publishNostrToRelays` and owns retry (`attempts` / `next_attempt_at` / `max_attempts`) under a transaction-scoped advisory lock on `(entity_type, entity_id)`; `relay_outbox_redrive` (minute cadence) is a second heartbeat and `relay_outbox_reconcile` emits daily metrics. Consequently `POST /sign-and-publish` and the publication publish routes mean "signed and durably queued", not "on relay" — relay blips become invisible worker retries, not 5xx. Specs: `planning-archive/RELAY-OUTBOX-ADR.md` + `planning-archive/RELAY-OUTBOX-PHASE-4-ADR.md`

### Payments

- Readers accumulate a tab (Stripe PaymentIntent) as they read gated articles
- `payment-service/src/services/` contains accrual, settlement, and payout logic
- Payouts go to writers via Stripe Connect
- Article access logic lives in `gateway/src/services/article-access/` (`access-check.ts`, `unlock-records.ts`, `gate-pass.ts` orchestrator + `index.ts` barrel). The `/articles/:id/gate-pass` route in `gateway/src/routes/articles/gate-pass.ts` is a thin HTTP wrapper that translates `performGatePass()`'s typed result into status codes

### Media

- Uploaded via gateway (`gateway/src/routes/media.ts`), stored in a Docker volume, served via Nginx at `/media/`
- Blossom is configured for Nostr-native media federation but primary storage is local
- oEmbed proxying handled in `gateway/src/routes/media.ts`

### Editor

- TipTap (ProseMirror-based) in `web/src/components/editor/`
- Supports a paywall gate node — content below the gate requires payment to unlock
- Markdown serialization via `tiptap-markdown`

### Compose overlay

- `ComposeOverlay` (`web/src/components/compose/ComposeOverlay.tsx`) is the single compose surface for all composing, mounted globally in `app/layout.tsx`
- Three modes: _note_ (default, from topbar COMPOSE button or `⌘K`), _reply_ (from Reply on any card, or QuoteSelector), and _article_ (from the `Write an article →` link in note mode, or `useCompose().openArticle({ draftId?, publicationSlug? })`)
- State managed by Zustand store `web/src/stores/compose.ts` — `useCompose().open(mode, replyTarget)` for note/reply, `openArticle(opts)` for article, `setMode(mode)` to escalate mid-compose
- Article mode is a dedicated panel (`web/src/components/compose/ArticleComposePanel.tsx`) with its own Tiptap instance, title input, `PUBLISH AS:` selector, paywall gate + price, autosave to the drafts table, `OPEN IN FULL EDITOR ↗` (navigates to `/write?draft=<id>[&pub=<slug>]`), `SCHEDULE`, and Publish. The pane widens to 760px in article mode (640px for note/reply); dek/tags/email/comments toggles are deferred to the full editor
- Renders through the canonical `<Glasshouse>` primitive (frosted full-viewport scrim, centred white pane, 6px slab top, floating ✕). No internal keylines — zones are separated by whitespace, not rules. Glasshouse's scrim / ✕ / Escape route to a single `dismiss` (article flushes the draft first; note/reply uses a two-step confirm when dirty). One pane for desktop and mobile — the old 40%-scrim topbar-anchored overlay and mobile bottom-sheet are gone
- NoteComposer is deleted — all composing goes through `ComposeOverlay` or the workspace `Composer`
- Full spec: `docs/adr/ALLHAUS-REDESIGN-SPEC.md` §3

### Feed & search

- Feed ranking spec in `planning-archive/FEED-ALGORITHM.md` (Phase 1 implemented)
- Full-text search uses PostgreSQL trigrams (`pg_trgm`), see `gateway/src/routes/search.ts`

### External feeds (Universal Feed)

External content (RSS/Atom/JSON Feed, external Nostr, Bluesky, Mastodon/Lemmy/threadiverse, email newsletters) is ingested by `feed-ingest/` (Graphile Worker + a long-lived Jetstream WebSocket listener, no HTTP port). Each protocol has an adapter in `feed-ingest/src/adapters/` and a shared dual-write helper in `feed-ingest/src/lib/`. Per-phase history, migration numbers, and cron cadences live in the ADR below; this section is orientation only.

- **Data model**: `external_sources` (shared canonical feeds), `external_subscriptions` (per-user), `external_items` (normalised content). `feed_items` (migration 053) is the denormalised unified timeline — articles, notes, and external items all land here via transactional dual-write from their source tables. Each row carries a deterministic per-THING `post_id`, an edit-detecting `version`, a persisted `biddability_tier`, and (for tier-A/B external rows) an `external_author_id` → `external_authors` identity table, all minted by the `feed_items_post_identity` trigger (migrations 098/099, UNIVERSAL-POST-ADR Phase 0a/0b); source tables are untouched. Bare reposts/boosts are edges in `repost_edges` (migration 100, Phase 0c), not rows — detected per-adapter at ingestion (nostr kind-6/16, atproto reposts, activitypub `Announce`) by `feed-ingest/src/lib/repost-edge.ts`. **Nostr identity is relay-free** (migration 101): `source_item_uri` — and therefore `post_id` and the `(protocol, source_item_uri)` dedup key — encode `nevent`/`naddr` *without* relay hints (else two relays mint two `post_id`s); relay hints live only in `external_items.interaction_data`. The native `feed_items.author_id` (→ `accounts`) is a separate id-space from `external_author_id` (→ `external_authors`, `UNIQUE(protocol, stable_handle)`); tier-C/D rss/email rows have no stable handle so `external_author_id` stays NULL (plain-text byline). Per-phase detail in UNIVERSAL-POST-ADR.
- **Feed query** (`gateway/src/routes/timeline.ts`): single-table scan on `feed_items` with LEFT JOINs, compound `(published_at, id)` cursor, per-source cap via windowed `ROW_NUMBER() PARTITION BY source_id`. The **Post-model successors** are `gateway/src/routes/post-feed.ts` (`GET /feed/:feedId` — live §5 hotness scoring + dedup-to-one by `post_id`) and `gateway/src/routes/post-thread.ts` (`GET /thread/:postId` — a *projector* resolving the focal by `post_id`, then projecting native `comments` + `external_items` into the §2.2 `Post` shape; shared mapper `gateway/src/lib/post-mapper.ts`). For an external focal the projector first hydrates the live source thread context-only (`external-items.ts::hydrateExternalThreadContext`, best-effort, reclaimed by the `external_context_gc` cron) so the pure-DB ancestor/reply walk resolves the full origin reply graph. **Phase 5 cut the workspace over to these** (`PostCardInteractive`/`PostThread` is the only workspace feed path). Legacy reads remain for non-workspace surfaces only (`timeline.ts` `/feed`, orphaned `replies.ts` `/conversation`, `/external-items/:id/thread` for `useNeighbourhood`); retiring those is a later `/feed`+`/source`-scoped pass.
- **Adapters**: RSS/Atom/JSON Feed + podcast enrichment (`adapters/rss.ts`); external Nostr via temporary source-relay WebSockets (`feed-ingest-nostr.ts`); Bluesky via a leader-elected Jetstream listener (`jetstream/listener.ts`) + `getAuthorFeed` backfill (`adapters/atproto.ts`); Mastodon/Lemmy/threadiverse via outbox polling (`adapters/activitypub.ts`, read-only, best-effort per ADR §XIII); email newsletters pushed via Postmark inbound webhook (`gateway/src/routes/inbound-mail.ts` → `adapters/email.ts`, push-only).
- **Resolver** (`gateway/src/lib/resolver.ts`, `POST /api/v1/resolve`): omnivorous identity resolution for subscribe/invite/other inputs — see the Omnivorous input section and UNIVERSAL-FEED-ADR §V.5. Async Phase B results persist in `resolver_async_results`; clients poll off the response's `status` field.
- **Subscription CRUD** (`gateway/src/routes/external-feeds.ts`): subscribe/list/remove/mute/refresh. Supported protocols: `rss`, `nostr_external`, `atproto`, `activitypub`; the `external_protocol` enum also carries not-yet-supported values (`farcaster`/`matrix`/`telegram`/`email`) rejected at subscribe time until their adapters ship.
- **Rendering**: `ExternalCard` / `VesselCard` render external items with a provenance badge, sanitised HTML, media, link previews, quoted posts, and video embeds; `SourceAttribution` maps raw protocol names to friendly labels (`ACTIVITYPUB` → `FEDIVERSE`, `ATPROTO` → `BLUESKY`, `NOSTR_EXTERNAL` → `NOSTR`). `at://` URIs are rewritten to `bsky.app` URLs at render time.
- **SSRF hardening**: all outbound fetches use the hardened HTTP client in `shared/src/lib/http-client.ts` (undici `Agent` with a pinned `connect.lookup` to close the DNS-rebinding TOCTOU). `validateWebSocketUrl` covers ws:/wss:.
- **Engagement, threads, rich context**: `external_items` carries denormalised like/reply/repost counts (refreshed by the `external_engagement_refresh` cron) plus parent-context, quote, and thread hydration via `GET /api/v1/external-items/:id/{engagement,parent,quote,thread}` (rate-limited, timeout-capped, server-signalled `partial` flag). Quoted/parent posts render as nested context tiles; see CARD-BEHAVIOUR-ADR.
- **Cross-platform interactions**: like/favourite, repost/boost, and inline reply (with dual-write) to external items via `POST /api/v1/external-items/:id/{like,repost,reply}`, validated against linked-account ownership + protocol match and dispatched by `feed-ingest` per protocol. Capability matrix in UNIVERSAL-FEED-ADR §5.5.
- **Outbound cross-posting** (Mastodon/Bluesky/external Nostr): encrypted OAuth credentials in `linked_accounts`, audit/retry in `outbound_posts`; `POST /notes` accepts `crossPost` and enqueues via `enqueueCrossPost`/`enqueueNostrOutbound`, dispatched by the `outbound_cross_post` task. AT Protocol OAuth (PKCE/DPoP/PAR) in `shared/src/lib/atproto-oauth.ts`; managed via `LinkedAccountsPanel`.
- **Workspace Full View** (content warnings, polls, reader pane, inline video, pull-to-refresh, empty states, context-only GC): all phases shipped — see WORKSPACE-FULL-VIEW-SPEC.
- **Crons**: `feed_items_reconcile` / `feed_items_author_refresh` catch dual-write drift; `feed_scores_refresh` computes HN-style gravity scores into `feed_items.score` (lives in feed-ingest so scoring failures can't affect the public API).
- Full spec: `docs/adr/UNIVERSAL-FEED-ADR.md`

### Trust graph

- **Layer 1** (`trust_layer1`): precomputed per-user signals (account age, paying readers, article count, Stripe KYC, NIP-05), refreshed by a daily feed-ingest cron. The `TrustPip` four-state glyph (`known`/`partial`/`unknown`/`contested`) is composed from L1 + `trust_polls` by `feed-ingest/src/lib/trust-pip.ts` and renders on all feed cards.
- **Layer 2 — vouches** (`vouches`, `trust_profiles`, `trust_epochs`): per-attestor/subject/dimension endorsements (dimensions `humanity`/`encounter`/`identity`/`integrity`; values `affirm`/`contest`; visibility `public`/`aggregate`, contests aggregate-only; one per attestor/subject/dimension via upsert; soft-delete withdrawal; freshness decay). Epoch aggregation (`feed-ingest/src/tasks/trust-epoch-aggregate.ts`) runs quarterly full epochs + Mon/Thu mop-ups with attestor weighting `age × payment × readership × activity`; pure scoring libs in `trust-weighting.ts` + `trust-aggregation.ts`. `TRUST_DRY_RUN=1` for dry runs.
- **Layer 4 — relational**: viewer's valued set (follows + active subscriptions) ∩ subject's public endorsements → "N writers you follow endorse this person".
- **API + frontend**: gateway `trust.ts` (`GET /trust/:userId`, `POST /vouches`, `DELETE /vouches/:id`, `GET /my/vouches`; prefers epoch scores, live counts as pre-first-epoch fallback); `TrustProfile`, `VouchModal`, `VouchList` on `/network?tab=vouches`.
- Full spec: `docs/adr/ALLHAUS-OMNIBUS.md`

## Omnivorous input (identity resolution)

Wherever all.haus asks a user to identify a person, feed, or resource, the receiving field should be omnivorous: accept a URL, a handle, an email, an npub, a DID, a username — whatever the user has — and resolve it. Do not build narrow single-format inputs (email-only, username-only) for identity fields. Use the universal resolver (`POST /api/resolve`, specced in `docs/adr/UNIVERSAL-FEED-ADR.md` §V.5) as the shared resolution backend. The resolver classifies input by pattern matching and dispatches to protocol-specific resolution chains. Context parameter (`subscribe`, `invite`, `dm`, `general`) controls priority and filtering.

## TypeScript setup

- Backend services extend `tsconfig.base.json` (ES2022, NodeNext module resolution, strict)
- `web/tsconfig.json` uses `moduleResolution: bundler` and `@/*` path alias for `web/src/*`
- All services compile to `dist/`

## Design tokens (Tailwind)

Custom semantic tokens in `web/tailwind.config.js`. Fonts: Jost (sans), Literata (serif), IBM Plex Mono (mono). Key max-widths: `article: 640px`, `feed: 780px`, `editor-frame: 780px`, `content: 960px`.

## Design system rules

These rules apply to all frontend code. Follow them when writing or modifying components.

### Three-voice typeface system

| Voice                     | Typeface      | Use for                                                                    |
| ------------------------- | ------------- | -------------------------------------------------------------------------- |
| **Literary** (serif)      | Literata      | Article prose, publication names, content previews, the reading experience |
| **Platform** (sans)       | Jost          | UI copy, page titles, body text, descriptions, buttons, display names      |
| **Infrastructure** (mono) | IBM Plex Mono | Labels, metadata, system status, data values, tab pills                    |

Never use serif for platform UI elements (page titles, settings, admin headings, user display names in lists). Never use sans for infrastructure labels. When in doubt, prefer sans over serif for non-literary content.

### Use design tokens, not inline sizes

| Token          | Size                                  | Use for                                          |
| -------------- | ------------------------------------- | ------------------------------------------------ |
| `text-ui-xs`   | 13px sans                             | Small UI text, descriptions, secondary copy      |
| `text-ui-sm`   | 14px sans                             | Standard UI text, form values, list items        |
| `text-mono-xs` | 11px mono                             | Small mono data (dates, amounts, tabular values) |
| `.label-ui`    | 11px mono, uppercase, 0.06em tracking | All infrastructure labels and metadata tags      |

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

### Workspace brightness — derive colours from the palette, never hard-code

The workspace has two brightness modes (`web/src/components/workspace/tokens.ts`): `primary` (light — dark text on light surfaces) and `dark` (a real dark mode — light text on dark surfaces). `PALETTES[brightness]` is a `VesselPalette` whose fields (`cardBg`, `cardTitle`, `cardStandfirst`, `cardMeta`, `interior`, `barText`, …) flip between the two modes.

**Any component that renders inside the themed vessel interior or a card must take the palette (a `palette: VesselPalette` prop, or `brightness` + `paletteFor(brightness)`) and colour every text and background element from it.** Never hard-code a text/background colour (`text-black`/`text-white`/`text-grey-800`/`text-grey-900`, inline `color:'#111'`/`'#fff'`, `bg-white`) on an interior surface — it does not invert, so it becomes invisible (black-on-black / white-on-white) in one of the two modes. This includes **hover and selected/active states**: `hover:text-black` over the dark interior is invisible on hover. Drive emphasis from a palette field (e.g. hover → `palette.cardTitle`) or a mode-agnostic affordance (`hover:opacity-70`, `hover:underline`) instead. For a translucent wash that must read on either card (poll result bars, inset input panels), pick it with `isDarkPalette(palette)` — a dark wash on the light card, a light wash on the dark card; a fixed `rgba(0,0,0,…)` wash vanishes in dark mode.

Note: `text-grey-500`/`700`/`800`/`900` are **not defined** in `web/tailwind.config.js` (only `100/200/300/400/600`) — those class names emit no rule and silently inherit the ambient colour, which reads as dark-on-dark in dark mode. Use a palette field, not an undefined grey.

Exempt: surfaces that are intentionally **always-light** regardless of brightness — the Glasshouse frosted pane and overlay panels that define their own fixed `panelBg:'#FFFFFF'` with dark text (Reader, Messages, Notifications, Search, PipPanel, Composer, ForallMenu). Those never consume `PALETTES`, so they never invert; keep their text dark.

### Glasshouse (frosted workspace overlay)

Any surface that opens **over the workspace** — the reader pane, direct messages, the feed composer, the global compose overlay (note/reply/article), and future panels — uses the canonical `<Glasshouse>` primitive (`web/src/components/workspace/Glasshouse.tsx`). It is the single source of the pattern: a full-viewport frosted scrim (`z-[55]`, blur-only `backdrop-blur-[3px]` with no tint — preserving the ground colour so the ForallMenu disc keeps its contrast, click-to-close), a centred white pane (`z-[56]`) with the 6px black slab top + elevation shadow, Escape-to-close, and body scroll-lock. Mount it conditionally and pass `onClose` + `maxWidth` (+ optional `ariaLabel`); it owns only the chrome — URL-sync/history (e.g. the reader's shareable `/article`·`/reader` entries) is layered on top by the caller's store, not by Glasshouse. A child that opens a portalled popover above the pane (e.g. the feed composer's source-name hover `AuthorModal`) must raise its own `z-index` above `z-[56]` — `AuthorModal` takes a `zIndex` prop for exactly this.

The defining invariant: the **ForallMenu stays crisp above the frost** as the sole nav affordance. It lives at `z-60` in `WorkspaceView`, so it floats sharp over any Glasshouse simply because Glasshouse never reaches `z-60`. Never raise a Glasshouse above `z-[56]`, and never blur or dim the ForallMenu. Do not hand-roll a frosted scrim + centred pane anywhere — reuse `<Glasshouse>`. Per-surface stores follow the `useReader` / `useMessagesOverlay` shape (an `isOpen` + `open`/`close` zustand store); the surface's body should be a shared panel component (e.g. `MessagesPanel`) reused by both its Glasshouse and any standalone page.

### Overlay close affordance

Every modal/overlay/panel dismisses via a **floating ✕**, never a text "Close"/"Done" button. The canonical placement is `<Glasshouse>`'s built-in ✕ (top-right, `text-grey-400 hover:text-black`); a bespoke modal that can't use Glasshouse puts the same ✕ on a `relative` pane at `absolute right-4 top-4` and reserves clearance for it (e.g. `pr-12` on the title row). This does **not** apply to paired action dialogs (`Cancel | Confirm`/`Submit`): there `Cancel` is a deliberate semantic choice, not a generic close, and stays a labelled button. Likewise a single-button acknowledgement (`OK`) is a CTA, not a close. The rule targets the dedicated dismiss affordance only.

### No hairlines, no outlines, no single-pixel anything

This is an absolute, sitewide invariant — not a feed-and-thread guideline. **The site never renders a 1px line, anywhere, ever.** No hairline dividers, no 1px borders, no 1px outlines or rings, no 1px line elements, no `<hr>`, no `box-shadow` used as a line. Separation is whitespace and rhythm; emphasis is the 4px slab; structural enclosure, when genuinely needed, is `>= 2px`. There are no exceptions for "dense UI chrome" (dropdowns, menus, popovers, settings rows) — those were the prior loophole and it is now closed.

Concretely, all of these are banned and must never be introduced:

- `1px` in any inline style or CSS (`border: 1px …`, `borderBottom: '1px …'`, `box-shadow: 0 1px 0 …`, `outline: 1px …`).
- Tailwind 1px-resolving utilities: bare `border` / `border-t|b|l|r|x|y` (these are 1px by default), `border-[1px]`, `divide-x` / `divide-y`, `ring-1` / `ring-px`, `outline-1` / `outline-px`, `h-px` / `w-px` / `h-[1px]` / `w-[1px]`.
- The raw `<hr>` element.
- Any `hairline` color token used to draw a line.

What to use instead:

- **Separation between items**: whitespace (`space-y-*`, `gap-*`) and the established feed/thread rhythm. Never a line.
- **Major section divider**: `.slab-rule-4` (the 4px slab). Do not hand-roll `h-[4px] bg-black` inline, and never substitute a thin rule for it.
- **Enclosure / emphasis** where a real border is unavoidable: `>= 2px` (e.g. the 2px a11y focus outlines in `globals.css` are correct and intentional — they are not hairlines).

#### Failsafe — pre-ship hairline check (required)

Before shipping any frontend change, run the tripwire and treat a non-zero exit for the lines you touched as a blocking failure:

```bash
scripts/check-hairlines.sh            # scans all of web/src
scripts/check-hairlines.sh <paths…>   # scope to the files you touched
```

It greps for every 1px form listed above. The script is a heuristic — read each match; a genuinely reviewed false positive may carry a trailing `hairline-ok` marker with a written reason on the same line, but a real hairline must be removed, not suppressed. The repo has pre-existing hairline debt (tracked separately); the rule for new work is strict — **do not add to the count, and prefer to remove any hairline you touch.**

### One post per card

A card renders exactly **one** post — never two or more fused together. This is an absolute, sitewide rule, so the conversational grammar of threading reads the same in every context: relationships between posts (parent → reply, a burst of replies) are expressed by **expanding a card into the thread** (ancestors above, focal, replies below), never by inlining another post's body into a card.

Concretely, the following fusions are banned and must not be reintroduced:

- **Parent-context tile** — a collapsed reply must not inline its parent above the byline. (Removed from `PostCardInteractive`; reply context comes from thread expansion.)
- **Reply groups** — a burst of replies sharing one parent must not be collapsed into a single multi-reply card. The gateway feed query (`gateway/src/routes/feeds.ts`) emits each reply as its own item; there is no `reply_group` envelope.

Quote embeds are a distinct grammar (a quote *is* one post that references another) and are not covered by this rule. The Quote action is available on **all** card tiers, native and external: quoting an external (Bluesky/Mastodon/RSS) post publishes a native note that embeds the origin as a `QuotedEmbed` mini (author · source · excerpt, linked to the permalink) — there is no NIP-18 `q` tag, the reference is carried by `notes.quoted_post_id`/`quoted_url`/`quoted_source` (migration 102). See UNIVERSAL-POST-ADR's external-quote note.

### Feed card chassis

All three feed card types (`ArticleCard`, `NoteCard`, `ExternalCard`) share a unified visual grammar:

- **Left bar**: 4px solid, full card height. Black (`#111111`) for native, crimson (`#B5242A`) for paid, grey-300 (`#BBBBBB`) for external. Applied via `borderLeft` inline style + `paddingLeft: '24px'`.
- **Byline row**: mono-caps 11px (`font-mono text-[11px] uppercase tracking-[0.06em] text-grey-600`). Order: TrustPip · Author name · middle-dot · timestamp · (optional price or protocol badge).
- **Byline routing**: every author byline — on a card, and on every expanded parent or reply in the conversational neighbourhood — links to the internal all.haus surface, never the origin platform. Native authors route to their writer profile (`/{username}`). **Tier-A/B external authors** (those carrying an `external_authors` identity record — nostr pubkey, atproto DID, activitypub actor URI) route to the constructed external-author profile `/author/:authorId` (UNIVERSAL-POST-ADR Phase 4, §4.4 — supersedes the old `/source/:id` byline target for these tiers). **Tier-C/D external authors** (rss/email — no stable identity record, `post.author.id` is null) remain **plain text**, no link. On a card, the only route out to the origin platform is the source-attribution line (§VI.4). Every linked byline (native + tier A/B) also opens a debounced, session-cached hover modal (`AuthorModal type="author"` → `GET /author/:id/profile`). **Inside that modal** the display name links to the internal all.haus profile (`profilePath`: native `/{username}`, external A/B `/author/:id`) and — for external A/B only — the `@handle` links out to the author's profile on the origin platform (`externalUrl`: bsky.app for atproto, the actor URI for activitypub, njump.me for nostr; built by `gateway/src/lib/author-resolve.ts::buildExternalProfileUrl`, carried on the `AuthorCardResponse`/`AuthorProfile` DTO). The modal is the one byline affordance that routes out to origin; native handles (= username) and tier-C/D stay plain text.
- **Action row**: mono-caps 11px (`font-mono text-[11px] uppercase tracking-[0.02em] text-grey-600`). `Reply` opens the compose overlay; `Quote`, `VoteControls`, `BookmarkButton`, `ShareButton` as appropriate per type.
- **No avatars** in card bodies. The left bar + pip + mono-caps name carry identity.
- **Feed rhythm**: in the live workspace each unified `PostCard` carries its own `marginBottom` (no wrapping `space-y`), governed by `GAP_PX` in `web/src/lib/post/level-spec.ts` — **8px** between independent feed items, **5px** between items in an expanded conversational chain (ancestors · focal · replies, a uniform beat). No horizontal rules between cards (see No hairlines — absolute sitewide). (The retiring legacy `/feed`+`/source` cards in `components/feed/` use `space-y-[10px]`; the legacy `PlayscriptThread` still uses `space-y-[32px]` — see Reply threads below.)

### Reply threads (playscripts)

Threads never use nested indentation, left borders between nested replies, quote-of-parent blockquotes, or avatars. They render flat and chronological as a transcript.

- **Thread step-in**: the thread container is indented 32px once (`ml-8`) from the parent card's content column. This is the only indentation in the thread system.
- **Inter-entry rhythm**: 32px (`space-y-[32px]`). No hairline rules between entries (see No hairlines — absolute sitewide).
- **Speaker line**: mono-caps 11px (`font-mono text-[11px] uppercase tracking-[0.06em] text-grey-600`). Structure: `TrustPip` · bold Jost name · colon. Own replies read `YOU:` with no pip (the asymmetric 16px left-jog is deliberate — `YOU:` is the reader, not a named speaker).
- **Non-adjacent parent**: when the reply's parent isn't the immediately-previous entry, prefix the speaker line with `→ PARENT:` in `grey-400` + 16px gap, then the speaker's own `NAME:`.
- **Dialogue line**: Jost 14.5px (`text-[14.5px]`), 1.55 line height (`leading-[1.55]`), black. Directly under the speaker line at `mt-1`.
- **Vote count**: `VoteControls` pinned top-right of the entry, aligned to the first line of dialogue.
- **Action row**: `time · REPLY · DELETE · REPORT` at mono-caps 11px `text-grey-400`, revealed on hover/focus with an optional `#fafaf7` background tint on the entry.
- **Pagination**: first 10 entries + `SHOW N MORE REPLIES` (mono-caps, grey-400, underlined on hover).
- **Component surface**: `PlayscriptReply` + `PlayscriptThread` in `web/src/components/replies/`. `ReplySection.tsx` flattens the nested tree into `PlayscriptEntry[]`; the API still returns a nested tree with `parentCommentId` on each node.
- **Focal node + parents-above (workspace)**: an expanded conversation reads strictly top-down — a focal node sits in the middle, its **ancestor chain renders above it** (one flat `ml-8` indent — never a deepening nested cascade) up to the conversation root, descendants below. There is **no separate pinned card or duplicated byline**: the opened item's byline lives on its own focal entry beneath its ancestors. **Clicking any ancestor or reply re-roots the view on that node in place** (repeatable); **clicking an external quote tile re-roots onto the quoted post** (the gateway mints a context-only `feed_items` twin for the quoted post on demand so `/thread/:postId` can resolve it); **clicking the focal node collapses the card**, and `↑ Full conversation` returns to the opened item.
  - **Rich focal, light context** (uniform across native + external): the focal node always renders its **full rich body** (content, media, action row) — including after re-rooting; ancestors and replies render as **lightweight playscript** entries. The rich body renders immediately on expand and context fills in around it once loaded. **Re-rooting onto any reply/ancestor renders that node as a full focal card** with no left bar and no visual record that it wasn't the originally-opened item: native re-roots from the in-memory conversation tree (`renderFocalNode`); external re-roots fetch the focal node's full data via the thread endpoint's `focus` field (gateway hydrates + persists it context-only so it carries a real id for like/repost/reply). **No left bar is ever drawn on a focal node** (the old re-root marker is gone).
  - **Byline routing**: native bylines link per-author to `/{username}`; **tier-A/B external bylines** (carrying an `external_authors` record) link per-author to the constructed profile `/author/:authorId` (UNIVERSAL-POST-ADR Phase 4 — this flipped the prior `/source/:id`-only rule); **tier-C/D external participants render as plain text** (no identity record; never fabricate a link or route out to the origin platform).
  - Wiring (native `ConversationView` / `useConversation`; external `ExternalAncestorRail` / `useExternalThread`) and full behaviour: see `docs/adr/CARD-BEHAVIOUR-ADR.md` addendum (2026-05-30).

## Key docs

- `feature-debt.md` — consolidated feature debt, outstanding work, and attack order
- `FEED-INGEST-ATTACK-PLAN.md` — build plan for omnivorous stream ingestion (per-adapter contract, slices 0–9; 0–3 shipped, 4–9 planned)
- `docs/adr/CARD-BEHAVIOUR-ADR.md` — unified card interaction model (click regions, neighbourhood expansion, biddability tiers, author affordances, rich embeds). Phases 1–5 complete. Largely superseded by UNIVERSAL-POST-ADR for node identity + thread rendering.
- `docs/adr/ALLHAUS-REDESIGN-SPEC.md` — redesign spec for topbar, feed, compose overlay, card family (Steps 1–4 shipped; remaining: compose article mode, polish states)
- `docs/adr/REDESIGN-SCOPE.md` — product scope (companion to the redesign spec)
- `docs/adr/UNIVERSAL-FEED-ADR.md` — universal social reader spec (external feeds, resolver, outbound posting)
- `docs/adr/ALLHAUS-OMNIBUS.md` — trust graph spec (Layer 1/2/4, Phase A/B anonymity)
- `docs/adr/WORKSPACE-FULL-VIEW-SPEC.md` — workspace full view spec (Compact/Full fidelity modes, engagement counts, threads, cross-platform interactions, reader pane, content warnings, polls, inline video, pull-to-refresh; all phases shipped). **Note:** the reply-grouping (`reply_group`) and inline parent-context-tile features it describes were later removed by the **one post per card** rule; the workspace feed now also has cursor-paged infinite scroll and keeps at most one conversation expanded per feed.
- `docs/adr/UNIVERSAL-POST-ADR.md` — unified **Post** model, feed assembly/ordering, single thread engine, and full-view rendering matrix. Supersedes the node-identity + thread-rendering portions of `UNIVERSAL-FEED-ADR.md` and `CARD-BEHAVIOUR-ADR.md`, the chronological-only following feed, and the HN-gravity score. **All phases shipped (0a–0c, 1, 2, 3, R, 4, 5 — the cutover).** The unified `PostCard` (`web/src/components/post/`) — fed by `GET /feed/:feedId` and the `GET /thread/:postId` projector (shared mapper `gateway/src/lib/post-mapper.ts`) — is the workspace's only card path; the flag-off legacy (`VesselCard`, `useConversation`/`useExternalThread`/`useNeighbourhood`, `ConversationView`) is deleted. Reader pane (Phase R) = `useReader` + `ReaderOverlay`, URL-synced (native `/article/<dTag>`, external `/reader/<postId>`); external HTML sanitised server-side via `shared/src/lib/sanitize.ts`. Byline routing: tier-A/B external → `/author/:id`; tier-C/D plain text. The id-bridges (`postId`/`externalItemId`/`external_author_id`, threaded from `feeds.ts` `FEED_SELECT` to the client adapter) and bug-hunt history live in the ADR. **Scoped to the workspace** — the standalone `/feed` + `/source/[id]` + `components/feed/` (and `GET /external-items/:id/thread`, orphaned `GET /conversation/:eventId`) left intact for a later pass.
- `docs/adr/` — active ADRs and specs (publications, email-on-publish, traffology, currency strategy, etc.)
- `docs/audits/` — code reviews, audits, and fix programmes (`FIX-PROGRAMME.md`, `platform-pub-review.md`, `AUDIT-BACKLOG.md`, etc.)
- `DEPLOYMENT.md` — full production deployment guide
- `schema.sql` — full PostgreSQL schema (source of truth for DB structure)
- `planning-archive/` — completed specs (FEATURES.md, DESIGN-BRIEF.md, FEED-ALGORITHM.md, RESILIENCE.md, etc.)
