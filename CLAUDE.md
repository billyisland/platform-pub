# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

When conversation produces a rule or design-philosophy point intended to apply universally across the site, check it against the existing rules here; if consistent and non-redundant, add it. This file is the canonical source of sitewide standards — a rule that isn't here is forgotten between sessions. Keep entries rule-plus-pointer: state the constraint and link the ADR; don't restate rationale the ADR already holds.

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

**Linting.** Root `eslint.config.mjs` (`npm run lint` at the repo root) is the type-aware pass over **all workspaces including `web/src`**; its job is promise safety (`no-floating-promises`/`no-misused-promises`/`await-thenable`). The web block sets `checksVoidReturn.attributes: false` and carries no-op stubs for the React/hooks/a11y/next-image rule names so inline `eslint-disable` directives stay valid (those rules are enforced by `web`'s own `next lint`, not here). Must stay at **0 errors** (`no-explicit-any` / `no-unused-vars` warnings are accepted hygiene debt).

### Database migrations

Migrations are numbered SQL files in `migrations/`, applied in order by the shared runner; each backend service also has its own `db/migrate.ts` (`npm run migrate` in `payment-service`).

**`schema.sql` is the genesis base, not a derivative.** A fresh DB (dev `initdb.d` and prod) boots from `schema.sql`, *then* `migrate.ts` applies anything newer. So `schema.sql` must already contain every migration's effect **and** seed `_migrations` with every migration filename (so `migrate.ts` is a clean no-op on fresh boot). There is no genesis migration — migration `001` ALTERs tables only `schema.sql` creates — so the chain can't be replayed from empty; `schema.sql` is load-bearing.

After adding a migration or changing the schema, regenerate `schema.sql` with `pg_dump` from a fully-migrated DB (never hand-edit — that breaks canonical round-trip), re-append the `_migrations` seed in the same step, then run the drift guard:

```bash
scripts/check-schema-drift.sh   # 0: seed lists all migrations · 1: migrate is a no-op on a schema.sql DB · 2: schema.sql round-trips clean
```

It builds throwaway DBs in the dev Postgres container (read-only w.r.t. your real dev DB). **CI-enforced** (`.github/workflows/ci.yml` `schema` job). It catches a missing seed entry (Check 0) and non-canonical hand-edits (Check 2), but **not** a seeded filename whose object body was omitted from `schema.sql` (all three checks pass green) — the mechanical pg_dump-and-re-append-in-one-step discipline is what closes that gap. Never hand-edit the seed line.

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
- **Relay outbox**: every write path that publishes a signed Nostr event to the platform relay enqueues into `relay_outbox` inside the caller's transaction via `shared/src/lib/relay-outbox.ts::enqueueRelayPublish`; the `feed-ingest` `relay_publish` worker owns publish + retry. So `POST /sign-and-publish` and the publication publish routes mean "signed and durably queued", not "on relay" — relay blips become invisible worker retries, not 5xx. Spec: `planning-archive/RELAY-OUTBOX-ADR.md`
- **Outbound discovery (NIP-05 + kind 0/3/10002)**: makes users + their public content discoverable on the wider Nostr mesh. NIP-05 served at gateway `/.well-known/nostr.json` (read-only, always on). The three replaceable discovery events are produced from DB state by `gateway/src/lib/discovery-publish.ts` (signed via key-custody, enqueued through `relay_outbox`): kind 0/10002 republish on profile/username edit; kind 3 (follow list = internal follows ∪ external nostr subs) is coalesced via `accounts.follow_list_dirty` and drained — together with backfill + self-heal over `accounts.discovery_synced_at` — by the gateway scheduler sweep (`runDiscoverySweep`, advisory lock `DISCOVERY`). All publishing is gated by `DISCOVERY_PUBLISH_ENABLED` (ships dark); `PUBLIC_FANOUT_RELAY_URLS` controls public-mesh fan-out (empty ⇒ in-house relay only). kind 3 is per-user opt-out via `accounts.publish_follow_graph` (default on; settings → Privacy). Spec: `docs/adr/NOSTR-OUTBOUND-INTEROP-ADR.md`

### Payments

- Readers accumulate a tab (Stripe PaymentIntent) as they read gated articles
- `payment-service/src/services/` contains accrual, settlement, and payout logic
- Payouts go to writers via Stripe Connect
- Article access logic lives in `gateway/src/services/article-access/` (`access-check.ts`, `unlock-records.ts`, `gate-pass.ts` orchestrator + `index.ts` barrel). The `/articles/:id/gate-pass` route in `gateway/src/routes/articles/gate-pass.ts` is a thin HTTP wrapper translating `performGatePass()`'s typed result into status codes

### Media

- Uploaded via gateway (`gateway/src/routes/media.ts`), stored in a Docker volume, served via Nginx at `/media/`
- Blossom is configured for Nostr-native media federation but primary storage is local
- oEmbed proxying handled in `gateway/src/routes/media.ts`

### Editor

- TipTap (ProseMirror-based) in `web/src/components/editor/`
- Supports a paywall gate node — content below the gate requires payment to unlock
- Markdown serialization via `tiptap-markdown`

### Compose overlay

- `ComposeOverlay` (`web/src/components/compose/ComposeOverlay.tsx`) is the single global compose surface, mounted in `app/layout.tsx`. The only other compose surface is the workspace `Composer` — do not add a third.
- Three modes via Zustand store `web/src/stores/compose.ts`: _note_ (default; topbar COMPOSE or `⌘K`), _reply_ (Reply on a card, or QuoteSelector), _article_ (`Write an article →` in note mode, or `openArticle({ draftId?, publicationSlug? })`). `open(mode, replyTarget)` / `openArticle(opts)` / `setMode(mode)` to escalate mid-compose.
- Article mode is a dedicated panel (`ArticleComposePanel.tsx`) with its own Tiptap instance, title, `PUBLISH AS:` selector, paywall gate + price, autosave to drafts, `OPEN IN FULL EDITOR ↗` (`/write?draft=<id>[&pub=<slug>]`), `SCHEDULE`, Publish. Pane is 760px in article mode, 640px for note/reply; dek/tags/email/comments toggles deferred to the full editor.
- Renders through `<Glasshouse>`. Scrim / ✕ / Escape route to a single `dismiss` (article flushes the draft first; note/reply uses a two-step confirm when dirty).
- Full spec: `docs/adr/ALLHAUS-REDESIGN-SPEC.md` §3

### Feed & search

- Feed ranking spec in `planning-archive/FEED-ALGORITHM.md` (Phase 1 implemented)
- Full-text search uses PostgreSQL trigrams (`pg_trgm`), see `gateway/src/routes/search.ts`

### External feeds (Universal Feed)

External content (RSS/Atom/JSON Feed, external Nostr, Bluesky, Mastodon/Lemmy/threadiverse, email newsletters) is ingested by `feed-ingest/` (Graphile Worker + a long-lived Jetstream WebSocket listener, no HTTP port). Each protocol has an adapter in `feed-ingest/src/adapters/` and a shared dual-write helper in `feed-ingest/src/lib/`. This section is orientation only — per-phase history, migration numbers, and cron cadences live in `docs/adr/UNIVERSAL-FEED-ADR.md`.

- **Data model**: `external_sources` (shared canonical feeds), `external_subscriptions` (per-user), `external_items` (normalised content). `feed_items` is the denormalised unified timeline — articles, notes, external items all land here via transactional dual-write; each row carries a deterministic per-THING `post_id`, an edit-detecting `version`, a `biddability_tier`, and (tier-A/B external only) `external_author_id` → `external_authors`. Bare reposts/boosts are edges in `repost_edges`, not rows. Two **invariants**: (1) Nostr identity is relay-free — `source_item_uri`/`post_id`/the `(protocol, source_item_uri)` dedup key encode `nevent`/`naddr` *without* relay hints (else two relays mint two `post_id`s); relay hints live only in `external_items.interaction_data`. (2) native `feed_items.author_id` (→ `accounts`) and `external_author_id` (→ `external_authors`) are separate id-spaces; tier-C/D rss/email rows have no stable handle, so `external_author_id` stays NULL (plain-text byline).
- **Feed query**: the live workspace uses the Post-model endpoints — `post-feed.ts` (`GET /feed/:feedId`, hotness scoring + dedup-to-one by `post_id`) and `post-thread.ts` (`GET /thread/:postId`, a *projector* resolving the focal by `post_id` then projecting native `comments` + `external_items` into the `Post` shape via `gateway/src/lib/post-mapper.ts`). For an external focal the projector first hydrates the live source thread context-only (best-effort, GC'd by `external_context_gc`) so the pure-DB walk resolves the full origin reply graph. Legacy chronological reads (`timeline.ts` `/feed`, `replies.ts` `/conversation`, `/external-items/:id/thread`) remain for non-workspace surfaces only.
- **Adapters**: RSS/Atom/JSON + podcast (`adapters/rss.ts`); external Nostr via temporary source-relay WebSockets (`feed-ingest-nostr.ts`); Bluesky via leader-elected Jetstream listener (`jetstream/listener.ts`) + `getAuthorFeed` backfill (`adapters/atproto.ts`); Mastodon/Lemmy/threadiverse via outbox polling (`adapters/activitypub.ts`, read-only); email via Postmark inbound webhook (`gateway/src/routes/inbound-mail.ts` → `adapters/email.ts`, push-only).
- **Resolver** (`gateway/src/lib/resolver.ts`, `POST /api/v1/resolve`): omnivorous identity resolution — see Omnivorous input below and UNIVERSAL-FEED-ADR §V.5.
- **Subscription CRUD** (`gateway/src/routes/external-feeds.ts`): subscribe/list/remove/mute/refresh. Supported protocols: `rss`, `nostr_external`, `atproto`, `activitypub` — the `external_protocol` enum also carries values rejected at subscribe time (`farcaster`/`matrix`/`telegram`/`email`) until their adapters ship.
- **Rendering**: `ExternalCard` / `VesselCard` render external items. `SourceAttribution` maps protocols to labels (`ACTIVITYPUB`→`FEDIVERSE`, `ATPROTO`→`BLUESKY`, `NOSTR_EXTERNAL`→`NOSTR`); `at://` URIs rewritten to `bsky.app` at render time.
- **SSRF hardening** (invariant): all outbound fetches must use the hardened HTTP client in `shared/src/lib/http-client.ts` (undici `Agent` with a pinned `connect.lookup` closing the DNS-rebinding TOCTOU); `validateWebSocketUrl` covers ws:/wss:.
- **Engagement / interactions**: `external_items` carries denormalised like/reply/repost counts plus parent/quote/thread hydration via `GET /api/v1/external-items/:id/{engagement,parent,quote,thread}`; like/repost/reply back to origin via `POST /api/v1/external-items/:id/{like,repost,reply}` (validated against linked-account ownership + protocol, dispatched by `feed-ingest`). Capability matrix in UNIVERSAL-FEED-ADR §5.5.
- **Outbound cross-posting** (Mastodon/Bluesky/external Nostr): encrypted OAuth creds in `linked_accounts`, audit/retry in `outbound_posts`; `POST /notes` accepts `crossPost`. AT Protocol OAuth (PKCE/DPoP/PAR) in `shared/src/lib/atproto-oauth.ts`.
- **Crons**: `feed_items_reconcile` / `feed_items_author_refresh` catch dual-write drift; `feed_scores_refresh` computes the score in feed-ingest so scoring failures can't affect the public API.
- Workspace Full View (content warnings, polls, reader pane, inline video, pull-to-refresh): `docs/adr/WORKSPACE-FULL-VIEW-SPEC.md`. Full spec: `docs/adr/UNIVERSAL-FEED-ADR.md`.

### Trust graph

- **Layer 1** (`trust_layer1`): precomputed per-user signals (account age, paying readers, article count, Stripe KYC, NIP-05), daily cron. The `TrustPip` four-state glyph (`known`/`partial`/`unknown`/`contested`) composes L1 + `trust_polls` (`feed-ingest/src/lib/trust-pip.ts`) and renders on all feed cards.
- **Layer 2 — vouches** (`vouches`, `trust_profiles`, `trust_epochs`): per-attestor/subject/dimension endorsements (dimensions humanity/encounter/identity/integrity; affirm/contest; contests aggregate-only; one per attestor/subject/dimension; soft-delete withdrawal; freshness decay), aggregated into epochs by `trust-epoch-aggregate.ts`. `TRUST_DRY_RUN=1` for dry runs.
- **Layer 4 — relational**: viewer's valued set (follows + active subscriptions) ∩ subject's public endorsements → "N writers you follow endorse this person".
- **API + frontend**: gateway `trust.ts`; `TrustProfile`, `VouchModal`, `VouchList` on `/network?tab=vouches`.
- Full spec: `docs/adr/ALLHAUS-OMNIBUS.md`

## Omnivorous input (identity resolution)

Wherever all.haus asks a user to identify a person, feed, or resource, the receiving field must be omnivorous: accept a URL, handle, email, npub, DID, or username — whatever the user has — and resolve it. Do not build narrow single-format inputs (email-only, username-only) for identity fields. Use the universal resolver (`POST /api/resolve`, UNIVERSAL-FEED-ADR §V.5) as the shared backend; it classifies input by pattern and dispatches protocol-specific chains, with a context parameter (`subscribe`/`invite`/`dm`/`general`) controlling priority and filtering.

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

Never use serif for platform UI (page titles, settings, admin headings, display names in lists). Never use sans for infrastructure labels. When in doubt, prefer sans over serif for non-literary content.

### Use design tokens, not inline sizes

| Token          | Size                                  | Use for                                          |
| -------------- | ------------------------------------- | ------------------------------------------------ |
| `text-ui-xs`   | 13px sans                             | Small UI text, descriptions, secondary copy      |
| `text-ui-sm`   | 14px sans                             | Standard UI text, form values, list items        |
| `text-mono-xs` | 11px mono                             | Small mono data (dates, amounts, tabular values) |
| `.label-ui`    | 11px mono, uppercase, 0.06em tracking | All infrastructure labels and metadata tags      |

Never hand-roll `font-mono text-[12px] uppercase tracking-[0.06em]` — that is `.label-ui`. Never use `text-[13px] font-sans` — that is `text-ui-xs`. Never use `text-[14px] font-sans` — that is `text-ui-sm`.

### Form labels

Always use `.label-ui text-grey-400` for form labels. Not `text-ui-xs uppercase tracking-wider` or `text-sm text-grey-600`.

### Buttons

Use the defined button classes: `.btn` (primary), `.btn-accent` (crimson), `.btn-ghost` (background), `.btn-soft` (secondary/soft). Do not hand-roll button styles inline.

### Text-link actions

`.btn-text` for inline text-link actions (13px sans, black, medium). `.btn-text-muted` for secondary (grey, hover:black). `.btn-text-danger` for destructive (crimson). Do not hand-roll with `text-ui-xs text-black font-medium` or similar.

### Toggle chips

Use `.toggle-chip` + `.toggle-chip-active` / `.toggle-chip-inactive` (with `.label-ui`) for On/Off selectors. Do not hand-roll with inline conditional classes.

### Page shell

All top-level admin/settings/dashboard pages use `<PageShell>` (`web/src/components/ui/PageShell.tsx`) — it fixes outer padding (`py-12`), title styling, and title→content gap (`mb-8`). Choose width by content: `article` (640px) single-column forms, `feed` (780px) lists/cards/reading, `content` (960px) tables/dense dashboards. Do not hand-roll `mx-auto max-w-* px-4 sm:px-6 py-*` wrappers. Use `<PageHeader>` standalone for sub-views needing the same title treatment.

### Workspace brightness — derive colours from the palette, never hard-code

The workspace has two brightness modes (`web/src/components/workspace/tokens.ts`): `primary` (light) and `dark` (a real dark mode). `PALETTES[brightness]` is a `VesselPalette` whose fields (`cardBg`, `cardTitle`, `cardStandfirst`, `cardMeta`, `interior`, `barText`, …) flip between modes.

**Any component rendering inside the themed vessel interior or a card must take the palette (`palette: VesselPalette` prop, or `brightness` + `paletteFor(brightness)`) and colour every text/background element from it.** Never hard-code a text/background colour (`text-black`/`text-white`/`text-grey-800`/`text-grey-900`, inline `color:'#111'`/`'#fff'`, `bg-white`) on an interior surface — it doesn't invert, so it goes invisible in one mode. This includes **hover and selected/active states** (`hover:text-black` over the dark interior is invisible on hover): drive emphasis from a palette field (e.g. hover → `palette.cardTitle`) or a mode-agnostic affordance (`hover:opacity-70`, `hover:underline`). For a translucent wash that must read on either card, pick it with `isDarkPalette(palette)` — a fixed `rgba(0,0,0,…)` wash vanishes in dark mode.

Note: `text-grey-500`/`700`/`800`/`900` are **not defined** in `web/tailwind.config.js` (only `100/200/300/400/600`) — those class names emit no rule and silently inherit the ambient colour (dark-on-dark in dark mode). Use a palette field, not an undefined grey.

Exempt: intentionally **always-light** surfaces — the Glasshouse frosted pane and overlay panels that define their own fixed `panelBg:'#FFFFFF'` with dark text (Reader, Messages, Dashboard, Notifications, Search, PipPanel, Composer, ForallMenu). They never consume `PALETTES`, so they never invert; keep their text dark.

### Glasshouse (frosted workspace overlay)

Any surface that opens **over the workspace** — reader pane, direct messages (`MessagesOverlay.tsx` → shared `MessagesPanel.tsx`), notifications (`NotificationsOverlay.tsx` → shared `NotificationsPanel.tsx`), the writer/publication dashboard (`DashboardOverlay.tsx` → shared `DashboardPanel.tsx`), the workspace note/article composer (`Composer.tsx`), the feed-settings modal (`FeedComposer.tsx`), the global compose overlay, future panels — uses the canonical `<Glasshouse>` primitive (`web/src/components/workspace/Glasshouse.tsx`). It owns the chrome: full-viewport frosted scrim (`z-[55]`, blur-only `backdrop-blur-[3px]` with no tint, click-to-close), a centred white pane (`z-[56]`) with the 6px black slab top + elevation shadow, Escape-to-close, body scroll-lock. Mount it conditionally; pass `onClose` + `maxWidth` (+ optional `ariaLabel`). URL-sync/history is layered on by the caller's store, not Glasshouse. A child popover above the pane (e.g. the feed composer's `AuthorModal`) must raise its own `z-index` above `z-[56]` (`AuthorModal` takes a `zIndex` prop).

The defining invariant: the **ForallMenu stays crisp above the frost** as the sole nav affordance. It lives at `z-60` in `WorkspaceView`; Glasshouse never reaches `z-60`. Never raise a Glasshouse above `z-[56]`, never blur or dim the ForallMenu, and never hand-roll a frosted scrim + centred pane — reuse `<Glasshouse>`. Per-surface stores follow the `useReader` / `useMessagesOverlay` shape (`isOpen` + `open`/`close` zustand); the surface body should be a shared panel component (e.g. `MessagesPanel`, `DashboardPanel`) reused by both its Glasshouse and any standalone page.

**Retiring a route into an overlay** (the direction of travel — everything that isn't the workspace or an overlay thereof is being retired): keep the old path as a thin **redirect shim** to `/workspace?overlay=<name>[&…seed params]` (deep links, notification/email hrefs, and bookmarks must keep resolving) — a server component for simple cases, a client component when it must forward a `#hash` the server never sees (e.g. `/messages` forwards `#conversationId` → `?conversation=`). Overlay routing is centralised in `web/src/lib/workspace/overlays.ts`: `WorkspaceView` reads `window.location.search` once on mount (not `useSearchParams` — that would force a Suspense boundary on the prerendered `/workspace`) and calls `openOverlayFromParams` to `open()` the matching overlay store seeded from the query, then strips `OVERLAY_PARAM_KEYS` via `replaceState`. In-app links / `router.push` targets point straight at `/workspace?overlay=<name>` to skip the redirect bounce; for navigations that happen **while already in the workspace** (e.g. a notification row → messages/dashboard overlay), call `routeToOverlay(href)` first — it opens the overlay in place and returns true so the caller skips a no-op `router.push` to the same pathname. Reference implementations: dashboard (`useDashboardOverlay`), messages (`useMessagesOverlay`, with conversation seed), notifications (`useNotificationsOverlay`).

### Overlay close affordance

Every modal/overlay/panel dismisses via a **floating ✕**, never a text "Close"/"Done" button. Canonical placement is `<Glasshouse>`'s built-in ✕ (top-right, `text-grey-400 hover:text-black`); a bespoke modal puts the same ✕ on a `relative` pane at `absolute right-4 top-4` and reserves clearance (e.g. `pr-12` on the title row). Exceptions: paired action dialogs (`Cancel | Confirm`/`Submit`) keep a labelled `Cancel`; a single-button acknowledgement (`OK`) is a CTA. The rule targets the dedicated dismiss affordance only.

### No hairlines, no outlines, no single-pixel anything

Absolute, sitewide invariant. **The site never renders a 1px line, anywhere, ever** — no hairline dividers, 1px borders/outlines/rings, 1px line elements, `<hr>`, or `box-shadow` used as a line. Separation is whitespace and rhythm; emphasis is the 4px slab; structural enclosure, when genuinely needed, is `>= 2px`. No exception for "dense UI chrome" (dropdowns, menus, popovers, settings rows) — that loophole is closed.

Banned, never to be introduced:

- `1px` in any inline style or CSS (`border: 1px …`, `borderBottom: '1px …'`, `box-shadow: 0 1px 0 …`, `outline: 1px …`).
- Tailwind 1px-resolving utilities: bare `border` / `border-t|b|l|r|x|y`, `border-[1px]`, `divide-x` / `divide-y`, `ring-1` / `ring-px`, `outline-1` / `outline-px`, `h-px` / `w-px` / `h-[1px]` / `w-[1px]`.
- The raw `<hr>` element. Any `hairline` color token used to draw a line.

Instead: **separation** → whitespace (`space-y-*`, `gap-*`) and feed/thread rhythm; **major divider** → `.slab-rule-4` (never hand-rolled `h-[4px] bg-black`); **enclosure/emphasis** where a real border is unavoidable → `>= 2px` (the 2px a11y focus outlines in `globals.css` are correct, not hairlines).

**Failsafe (required before shipping any frontend change):** run the tripwire and treat a non-zero exit for the lines you touched as blocking.

```bash
scripts/check-hairlines.sh            # scans all of web/src
scripts/check-hairlines.sh <paths…>   # scope to the files you touched
```

It greps for every 1px form above (heuristic — read each match). A genuinely reviewed false positive may carry a trailing `hairline-ok` marker with a written reason on the same line; a real hairline must be removed, not suppressed. The repo has pre-existing hairline debt (tracked separately) — for new work: do not add to the count, and prefer to remove any hairline you touch.

### One post per card

A card renders exactly **one** post — never two or more fused. Absolute, sitewide. Relationships between posts (parent → reply, a burst of replies) are expressed by **expanding a card into the thread** (ancestors above, focal, replies below), never by inlining another post's body into a card. Banned fusions, not to be reintroduced:

- **Parent-context tile** — a collapsed reply must not inline its parent above the byline. (Reply context comes from thread expansion.)
- **Reply groups** — a burst of replies sharing a parent must not collapse into one multi-reply card. The gateway feed query emits each reply as its own item; there is no `reply_group` envelope.

Quote embeds are a distinct grammar (a quote *is* one post referencing another) and are exempt. The Quote action is on **all** card tiers, native and external: quoting an external post publishes a native note embedding the origin as a `QuotedEmbed` mini (author · source · excerpt, linked to permalink) — no NIP-18 `q` tag; the reference rides `notes.quoted_post_id`/`quoted_url`/`quoted_source` (migration 102). See UNIVERSAL-POST-ADR.

### Feed card chassis

All three feed card types (`ArticleCard`, `NoteCard`, `ExternalCard`) share a unified grammar:

- **Left bar**: 4px solid, full height. Black (`#111111`) native, crimson (`#B5242A`) paid, grey-300 (`#BBBBBB`) external. `borderLeft` inline + `paddingLeft: '24px'`.
- **Byline row**: mono-caps 11px (`font-mono text-[11px] uppercase tracking-[0.06em] text-grey-600`). Order: TrustPip · Author · middle-dot · timestamp · (optional price or protocol badge).
- **Byline routing** (same rule on cards and on every expanded parent/reply): a byline links to the internal all.haus surface, never the origin platform. Native → writer profile (`/{username}`). **Tier-A/B external** (carrying an `external_authors` record — nostr pubkey, atproto DID, activitypub actor) → `/author/:authorId` (UNIVERSAL-POST-ADR §4.4). **Tier-C/D external** (rss/email, `post.author.id` null) → **plain text**, no link. The only route out to origin on a card is the source-attribution line. Every linked byline (native + A/B) opens a debounced, session-cached `AuthorModal` (`type="author"` → `GET /author/:id/profile`); inside it the display name links internally (`profilePath`) and — A/B only — the `@handle` links out to origin (`externalUrl`: bsky.app / actor URI / njump.me, built by `gateway/src/lib/author-resolve.ts::buildExternalProfileUrl`). The modal is the one byline affordance routing to origin.
- **Action row**: mono-caps 11px (`tracking-[0.02em]`). `Reply` opens the compose overlay; `Quote`, `VoteControls`, `BookmarkButton`, `ShareButton` per type.
- **No avatars** in card bodies — left bar + pip + mono-caps name carry identity.
- **Feed rhythm**: each `PostCard` carries its own `marginBottom` (no wrapping `space-y`), per `GAP_PX` in `web/src/lib/post/level-spec.ts` — **8px** between independent items, **5px** within an expanded conversational chain. (Legacy `/feed`+`/source` cards in `components/feed/` use `space-y-[10px]`; legacy `PlayscriptThread` uses `space-y-[32px]`.)

### Reply threads (playscripts)

Threads render flat and chronological as a transcript — never nested indentation, left borders between replies, quote-of-parent blockquotes, or avatars. Component surface: `PlayscriptReply` + `PlayscriptThread` in `web/src/components/replies/`; `ReplySection.tsx` flattens the nested API tree into `PlayscriptEntry[]`.

- **Step-in**: thread container indented 32px once (`ml-8`) from the parent's content column — the only indentation in the system.
- **Rhythm**: 32px (`space-y-[32px]`).
- **Speaker line**: mono-caps 11px. `TrustPip` · bold Jost name · colon. Own replies read `YOU:` with no pip (the asymmetric 16px left-jog is deliberate). Non-adjacent parent: prefix `→ PARENT:` in `grey-400` + 16px gap, then `NAME:`.
- **Dialogue line**: Jost 14.5px (`text-[14.5px]`), `leading-[1.55]`, black, at `mt-1`.
- **Vote count**: `VoteControls` pinned top-right, aligned to the first dialogue line.
- **Action row**: `time · REPLY · DELETE · REPORT`, mono-caps 11px `text-grey-400`, revealed on hover/focus (optional `#fafaf7` tint).
- **Pagination**: first 10 entries + `SHOW N MORE REPLIES` (mono-caps, grey-400, underline on hover).
- **Workspace focal node + parents-above**: an expanded conversation reads strictly top-down — focal in the middle, **ancestor chain above** (one flat `ml-8` indent, never a deepening cascade), descendants below. No separate pinned card or duplicated byline. **Clicking any ancestor/reply re-roots in place** (repeatable); **clicking an external quote tile re-roots onto the quoted post** (gateway mints a context-only `feed_items` twin on demand); **clicking the focal collapses the card**; `↑ Full conversation` returns to the opened item. **Rich focal, light context** (native + external): the focal always renders its full rich body (content, media, action row) — including after re-rooting; ancestors/replies render as lightweight playscript. **No left bar is ever drawn on a focal node.** Native re-roots from the in-memory tree (`renderFocalNode`); external re-roots fetch full data via the thread endpoint's `focus` field. Byline routing as in the feed chassis. Wiring (`ConversationView`/`useConversation`; `ExternalAncestorRail`/`useExternalThread`) and full behaviour: `docs/adr/CARD-BEHAVIOUR-ADR.md` addendum (2026-05-30).

## Key docs

- `feature-debt.md` — consolidated feature debt, outstanding work, attack order
- `FEED-INGEST-ATTACK-PLAN.md` — build plan for omnivorous stream ingestion (slices 0–9; 0–3 shipped)
- `docs/adr/UNIVERSAL-POST-ADR.md` — unified **Post** model, feed assembly/ordering, single thread engine, full-view rendering matrix. The workspace's only card path (unified `PostCard` in `web/src/components/post/`, fed by `GET /feed/:feedId` + the `GET /thread/:postId` projector; reader pane = `useReader` + `ReaderOverlay`, URL-synced). Supersedes node-identity + thread-rendering portions of UNIVERSAL-FEED-ADR and CARD-BEHAVIOUR-ADR. **Scoped to the workspace** — standalone `/feed` + `/source/[id]` + `components/feed/` left for a later pass.
- `docs/adr/CARD-BEHAVIOUR-ADR.md` — card interaction model (click regions, neighbourhood expansion, biddability tiers, author affordances, rich embeds). Largely superseded by UNIVERSAL-POST-ADR.
- `docs/adr/UNIVERSAL-FEED-ADR.md` — universal social reader spec (external feeds, resolver, outbound posting)
- `docs/adr/ALLHAUS-REDESIGN-SPEC.md` — redesign spec (topbar, feed, compose overlay, card family); `docs/adr/REDESIGN-SCOPE.md` — product scope companion
- `docs/adr/ALLHAUS-OMNIBUS.md` — trust graph spec (Layer 1/2/4, Phase A/B anonymity)
- `docs/adr/WORKSPACE-FULL-VIEW-SPEC.md` — workspace full view (Compact/Full fidelity, engagement counts, threads, reader pane, content warnings, polls, inline video, pull-to-refresh). **Note:** its `reply_group` + inline parent-context-tile features were removed by **one post per card**; the workspace feed now has cursor-paged infinite scroll, ≤1 conversation expanded per feed.
- `docs/adr/` — active ADRs and specs (publications, email-on-publish, traffology, currency strategy, etc.)
- `docs/audits/` — code reviews, audits, fix programmes (`FIX-PROGRAMME.md`, `platform-pub-review.md`, `AUDIT-BACKLOG.md`)
- `DEPLOYMENT.md` — full production deployment guide
- `schema.sql` — full PostgreSQL schema (source of truth for DB structure)
- `planning-archive/` — completed specs (FEATURES.md, DESIGN-BRIEF.md, FEED-ALGORITHM.md, RESILIENCE.md, RELAY-OUTBOX-ADR.md, etc.)
