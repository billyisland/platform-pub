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

It builds throwaway DBs in the dev Postgres container (read-only w.r.t. your real dev DB) and exits non-zero with a diff on drift. **This is enforced in CI** (`.github/workflows/ci.yml` `schema` job) — a stale `schema.sql` fails the build before it can break a fresh deploy.

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
- Article mode is a dedicated panel (`web/src/components/compose/ArticleComposePanel.tsx`) with its own Tiptap instance, title input, `PUBLISH AS:` selector, paywall gate + price, autosave to the drafts table, `OPEN IN FULL EDITOR ↗` (navigates to `/write?draft=<id>[&pub=<slug>]`), `SCHEDULE`, and Publish. Desktop overlay widens to 760px in article mode; dek/tags/email/comments toggles are deferred to the full editor
- Overlay sits above content with 40% scrim, topbar stays visible and interactive
- Mobile: full-screen bottom sheet
- NoteComposer is deleted — all composing goes through `ComposeOverlay` or the workspace `Composer`
- Full spec: `docs/adr/ALLHAUS-REDESIGN-SPEC.md` §3

### Feed & search

- Feed ranking spec in `planning-archive/FEED-ALGORITHM.md` (Phase 1 implemented)
- Full-text search uses PostgreSQL trigrams (`pg_trgm`), see `gateway/src/routes/search.ts`

### External feeds (Universal Feed)

External content (RSS/Atom/JSON Feed, external Nostr, Bluesky, Mastodon/Lemmy/threadiverse, email newsletters) is ingested by `feed-ingest/` (Graphile Worker + a long-lived Jetstream WebSocket listener, no HTTP port). Each protocol has an adapter in `feed-ingest/src/adapters/` and a shared dual-write helper in `feed-ingest/src/lib/`. Per-phase history, migration numbers, and cron cadences live in the ADR below; this section is orientation only.

- **Data model**: `external_sources` (shared canonical feeds), `external_subscriptions` (per-user), `external_items` (normalised content). `feed_items` (migration 053) is the denormalised unified timeline — articles, notes, and external items all land here via transactional dual-write from their source tables. Every row also carries a deterministic per-THING `post_id`, an edit-detecting `version`, a persisted `biddability_tier`, and (for tier-A/B external rows) an `external_author_id` linking to the `external_authors` identity table — all minted by a `BEFORE INSERT/UPDATE` trigger (`feed_items_post_identity`, migrations 098/099 — UNIVERSAL-POST-ADR Phase 0a/0b); source tables are untouched and later phases read these columns. Bare reposts/boosts are **not** rows here — a boost has no body, so it is an edge in `repost_edges` (migration 100, Phase 0c): a booster handle + the boosted THING's deterministic `post_id` (via the same `feed_items_derive_post_id`), detected per-adapter at ingestion (nostr kind-6/16, atproto reposts, activitypub `Announce`; rss/email have none) by `feed-ingest/src/lib/repost-edge.ts::recordRepostEdge`. **Nostr identity is relay-free** (migration 101): `source_item_uri` — and therefore `post_id`, the `(protocol, source_item_uri)` upsert dedup key, and reply-threading — encode `nevent`/`naddr` *without* relay hints (shared `nostrEventUri`/`nostrAddrUri` helpers in `feed-ingest-nostr.ts`, used by both the THING path and `detectNostrRepost` so they can't drift), else the same event from two relays would mint two `post_id`s and a boost could never reconstruct the boosted THING's key. Relay hints live only in `external_items.interaction_data`. Feed assembly that consumes these edges is Phase 1; Phase 0c is ingestion-only. The native `feed_items.author_id` (→ `accounts`) is a separate id-space from `external_author_id` (→ `external_authors`, keyed `UNIQUE(protocol, stable_handle)`); tier-C/D rss/email rows have no stable handle so `external_author_id` stays NULL (plain-text byline).
- **Feed query** (`gateway/src/routes/timeline.ts`): single-table scan on `feed_items` with LEFT JOINs for type-specific fields, compound `(published_at, id)` cursor, per-source cap via windowed `ROW_NUMBER() PARTITION BY source_id`. External items appear in the following feed only. The **Post-model successors** are `gateway/src/routes/post-feed.ts` (`GET /feed/:feedId`, UNIVERSAL-POST-ADR Phase 1) — reuses this query's membership but adds live §5 hotness scoring + dedup-to-one by `post_id` — and `gateway/src/routes/post-thread.ts` (`GET /thread/:postId`) — a *projector* that resolves the focal by `post_id` then projects native `comments` (which carry no `post_id` of their own — they get a deterministic derived one) + `external_items` into the §2.2 `Post` shape; both share the mapper in `gateway/src/lib/post-mapper.ts`. For an external (atproto/activitypub) focal the projector first **hydrates the live source thread** into `external_items` + `feed_items` (`external-items.ts::hydrateExternalThreadContext`, best-effort + throttled, context-only so the main feed excludes it) so the pure-DB ancestor/reply walk resolves the full origin reply graph — without it we only ingest a source's own posts, so a Bluesky/Mastodon card advertising N replies expanded to nothing (the Phase-5 cutover dropped the legacy live walk). The hydrated context-only rows are reclaimed by the `external_context_gc` cron, which now cascades the backing `feed_items` rows. **Phase 5 cut the workspace over to these** (the `usePostCardFlag` gate is gone; `PostCardInteractive`/`PostThread` is the only workspace feed path). The legacy reads remain only for the non-workspace surfaces: `timeline.ts` `/feed` still serves the standalone `/feed` page; `replies.ts` `/conversation` is now orphaned by the web client (left live); `/external-items/:id/thread` is still used by `useNeighbourhood` on `/feed`+`/source`. Retiring those is a later `/feed`+`/source`-scoped pass.
- **Adapters**: RSS/Atom/JSON Feed + podcast enrichment (`adapters/rss.ts`); external Nostr via temporary source-relay WebSockets (`feed-ingest-nostr.ts`); Bluesky via a leader-elected Jetstream listener (`jetstream/listener.ts`) + `getAuthorFeed` backfill (`adapters/atproto.ts`); Mastodon/Lemmy/threadiverse via outbox polling (`adapters/activitypub.ts`, read-only, best-effort per ADR §XIII); email newsletters pushed via Postmark inbound webhook (`gateway/src/routes/inbound-mail.ts` → `adapters/email.ts`, push-only).
- **Resolver** (`gateway/src/lib/resolver.ts`, `POST /api/v1/resolve`): omnivorous identity resolution for subscribe/invite/other inputs — see the Omnivorous input section and UNIVERSAL-FEED-ADR §V.5. Async Phase B results persist in `resolver_async_results`; clients poll off the response's `status` field.
- **Subscription CRUD** (`gateway/src/routes/external-feeds.ts`): subscribe/list/remove/mute/refresh. Supported protocols: `rss`, `nostr_external`, `atproto`, `activitypub`; the `external_protocol` enum also carries not-yet-supported values (`farcaster`/`matrix`/`telegram`/`email`) rejected at subscribe time until their adapters ship.
- **Rendering**: `ExternalCard` / `VesselCard` render external items with a provenance badge, sanitised HTML, media, link previews, quoted posts, and video embeds; `SourceAttribution` maps raw protocol names to friendly labels (`ACTIVITYPUB` → `FEDIVERSE`, `ATPROTO` → `BLUESKY`, `NOSTR_EXTERNAL` → `NOSTR`). `at://` URIs are rewritten to `bsky.app` URLs at render time.
- **SSRF hardening**: all outbound fetches use the hardened HTTP client in `shared/src/lib/http-client.ts` (undici `Agent` with a pinned `connect.lookup` to close the DNS-rebinding TOCTOU). `validateWebSocketUrl` covers ws:/wss:.
- **Engagement, threads, rich context**: `external_items` carries denormalised like/reply/repost counts (refreshed by the `external_engagement_refresh` cron) plus parent-context, quote, and thread hydration via `GET /api/v1/external-items/:id/{engagement,parent,quote,thread}` (rate-limited, timeout-capped, server-signalled `partial` flag). Quoted/parent posts render as nested context tiles; see CARD-BEHAVIOUR-ADR.
- **Cross-platform interactions**: like/favourite, repost/boost, and inline reply (with dual-write) to external items via `POST /api/v1/external-items/:id/{like,repost,reply}`, validated against linked-account ownership + protocol match and dispatched by `feed-ingest` per protocol. Capability matrix in UNIVERSAL-FEED-ADR §5.5.
- **Outbound cross-posting** (Mastodon/Bluesky/external Nostr): encrypted OAuth credentials in `linked_accounts`, audit/retry in `outbound_posts`; `POST /notes` accepts `crossPost` and enqueues via `enqueueCrossPost`/`enqueueNostrOutbound`, dispatched by the `outbound_cross_post` task. AT Protocol OAuth (PKCE/DPoP/PAR) in `shared/src/lib/atproto-oauth.ts`; managed on `/settings` via `LinkedAccountsPanel`.
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

Quote embeds are a distinct grammar (a quote *is* one post that references another) and are not covered by this rule.

### Feed card chassis

All three feed card types (`ArticleCard`, `NoteCard`, `ExternalCard`) share a unified visual grammar:

- **Left bar**: 4px solid, full card height. Black (`#111111`) for native, crimson (`#B5242A`) for paid, grey-300 (`#BBBBBB`) for external. Applied via `borderLeft` inline style + `paddingLeft: '24px'`.
- **Byline row**: mono-caps 11px (`font-mono text-[11px] uppercase tracking-[0.06em] text-grey-600`). Order: TrustPip · Author name · middle-dot · timestamp · (optional price or protocol badge).
- **Byline routing**: every author byline — on a card, and on every expanded parent or reply in the conversational neighbourhood — links to the internal all.haus surface, never the origin platform. Native authors route to their writer profile (`/{username}`). **Tier-A/B external authors** (those carrying an `external_authors` identity record — nostr pubkey, atproto DID, activitypub actor URI) route to the constructed external-author profile `/author/:authorId` (UNIVERSAL-POST-ADR Phase 4, §4.4 — supersedes the old `/source/:id` byline target for these tiers). **Tier-C/D external authors** (rss/email — no stable identity record, `post.author.id` is null) remain **plain text**, no link. The only route out to the origin platform is the source-attribution line (§VI.4). Every linked byline (native + tier A/B) also opens a debounced, session-cached hover modal (`AuthorModal type="author"` → `GET /author/:id/profile`).
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
- **Focal node + parents-above (workspace)**: an expanded conversation reads strictly top-down — a focal node sits in the middle, its **ancestor chain renders above it** (one flat `ml-8` indent — never a deepening nested cascade) up to the conversation root, descendants below. There is **no separate pinned card or duplicated byline**: the opened item's byline lives on its own focal entry beneath its ancestors. **Clicking any ancestor or reply re-roots the view on that node in place** (repeatable); **clicking the focal node collapses the card**, and `↑ Full conversation` returns to the opened item.
  - **Rich focal, light context** (uniform across native + external): the focal node always renders its **full rich body** (content, media, action row) — including after re-rooting; ancestors and replies render as **lightweight playscript** entries. The rich body renders immediately on expand and context fills in around it once loaded. **Re-rooting onto any reply/ancestor renders that node as a full focal card** with no left bar and no visual record that it wasn't the originally-opened item: native re-roots from the in-memory conversation tree (`renderFocalNode`); external re-roots fetch the focal node's full data via the thread endpoint's `focus` field (gateway hydrates + persists it context-only so it carries a real id for like/repost/reply). **No left bar is ever drawn on a focal node** (the old re-root marker is gone).
  - **Byline routing**: native bylines link per-author to `/{username}`; **tier-A/B external bylines** (carrying an `external_authors` record) link per-author to the constructed profile `/author/:authorId` (UNIVERSAL-POST-ADR Phase 4 — this flipped the prior `/source/:id`-only rule); **tier-C/D external participants render as plain text** (no identity record; never fabricate a link or route out to the origin platform).
  - Wiring (native `ConversationView` / `useConversation`; external `ExternalAncestorRail` / `useExternalThread`) and full behaviour: see `docs/adr/CARD-BEHAVIOUR-ADR.md` addendum (2026-05-30).

## Key docs

- `feature-debt.md` — consolidated feature debt, outstanding work, and attack order
- `FEED-INGEST-ATTACK-PLAN.md` — build plan for omnivorous stream ingestion (per-adapter contract, slices 0–9; 0–3 shipped, 4–9 planned)
- `docs/adr/CARD-BEHAVIOUR-ADR.md` — unified card interaction model (click regions, conversational neighbourhood expansion, biddability tiers, author affordances, rich embeds). Phases 1–5 complete; external bylines route to the internal source surface (`/source/[id]`), not the origin platform, and the workspace `VesselCard` is the live surface (the `/feed/` cards are being retired). Only the §VI.3 constructed external author profile remains deferred
- `docs/adr/ALLHAUS-REDESIGN-SPEC.md` — redesign spec for topbar, feed, compose overlay, card family (Steps 1–4 shipped including article tiers, reading-history resumption, playscript threads; remaining: compose article mode, polish states)
- `docs/adr/REDESIGN-SCOPE.md` — product scope document arguing what the product is (companion to the redesign spec)
- `docs/adr/UNIVERSAL-FEED-ADR.md` — universal social reader spec (external feeds, resolver, outbound posting)
- `docs/adr/ALLHAUS-OMNIBUS.md` — trust graph spec (Layer 1/2/4, Phase A/B anonymity)
- `docs/adr/WORKSPACE-FULL-VIEW-SPEC.md` — workspace full view spec (Compact/Full fidelity modes, engagement counts, parent context, threads, cross-platform interactions, reader pane, content warnings, polls, inline video, pull-to-refresh, reply grouping; all phases shipped). **Note:** the reply-grouping (`reply_group`) and inline parent-context-tile features it describes were later removed by the **one post per card** rule (see Design system rules); the workspace feed now also has infinite scroll (cursor-paged) and keeps at most one conversation expanded per feed.
- `docs/adr/UNIVERSAL-POST-ADR.md` — unified **Post** model, feed assembly/ordering, single thread engine, and full-view rendering matrix. Supersedes the node-identity + thread-rendering portions of `UNIVERSAL-FEED-ADR.md` and `CARD-BEHAVIOUR-ADR.md`, the chronological-only following feed, and the HN-gravity score. Phase 0a (deterministic `post_id`/`version`/`biddability_tier` on `feed_items`, migration 098), Phase 0b (tier-A/B `external_authors` identity records + `feed_items.external_author_id`, migration 099), Phase 0c (`repost_edges` + per-adapter boost detection, migration 100) shipped; **Phase 1 shipped in full** — `/feed` slice (`gateway/src/routes/post-feed.ts` — `GET /feed/:feedId`, live §5 hotness scoring + dedup-to-one) and `/thread` slice (`gateway/src/routes/post-thread.ts` + shared `gateway/src/lib/post-mapper.ts` — `GET /thread/:postId`, a *projector* that projects native `comments` + ingested `external_items` into the §2.2 `Post` shape; native comments get a deterministic derived `post_id` since they live in `comments`, not `feed_items`); both coexist with the legacy `timeline.ts` `/feed` + `replies.ts` `/conversation` + `/external-items/:id/thread` until the Phase 5 cutover. **Phase 2 shipped** — one unified `PostCard` (`web/src/components/post/`) renders a `Post` at any of six levels via the §4 matrix-as-data (`web/src/lib/post/level-spec.ts`) + §7 tier gating, fed by a pure client-side adapter (`web/src/lib/post/map-feed-item.ts`, legacy `FeedItem` → §2.2 client `Post`), behind a runtime localStorage dev flag (`web/src/lib/post/flags.ts::usePostCardFlag`) gating a single swap in `WorkspaceView`; render-only (thread interaction, reader pane, author profile deferred to Phases 3/R/4), with a six-level parity harness at `/dev/postcard`. **Phase 3 shipped** — one thread engine (`web/src/hooks/usePostThread.ts` + `web/src/components/post/PostThread.tsx` + pure `web/src/lib/post/thread.ts::deriveThreadView`) over the `GET /thread/:postId` projector, replacing `useConversation`/`useExternalThread`/`useNeighbourhood` for the flag-on workspace: ancestors/focal/replies all render through the same `PostCard` levels (native + external indistinguishable), with client-side re-root (pool-accumulating, fetch only an unloaded subtree), scroll-centre focal, gutter overflow arrows, `↑ Full conversation`, and lazy reply pagination. The id bridge that makes it work: the workspace payload now surfaces the real `feed_items.post_id` end-to-end (`feeds.ts` `FEED_SELECT` + `rowToItem` → API JSON `postId` → `WorkspaceFeedApi*` types + `WorkspaceView.mapApiItem`/`mapExternalApiItem` → ndk `FeedItem.postId` → adapter `Post.id`), since the feed card previously carried the origin event id (64-hex but not a `post_id`, so `/thread` 404'd). **(The client legs — the `postId` field on the `WorkspaceFeedApi*` interfaces and its propagation in `mapApiItem` — were missing until the 2026-06-01 post-cutover browser verification: the gateway emitted `postId` but the client dropped it, so every thread-expand showed "COULDN'T LOAD THIS THREAD" until fixed.)** Articles open the reader pane (Phase R), so they have no inline thread. **Phase R shipped** — one addressable reader environment via the **store + URL-sync** mechanism (not Next.js intercepting routes): the `useReader` store (`web/src/stores/reader.ts`) opens `ReaderOverlay` (`web/src/components/workspace/ReaderOverlay.tsx`) over the workspace and pushes the article's real URL (native `/article/<dTag>`, external `/reader/<postId>`) so Back/Esc/scrim close + restore; native renders the existing `ArticleReader` (gate-pass client-side), external renders `ExternalArticleReader` (`/extract`, whose Readability HTML is sanitised server-side via `shared/src/lib/sanitize.ts::sanitizeArticleContent` — a long-form allowlist — before it reaches the client's `dangerouslySetInnerHTML`), both shared with the direct-URL full pages (`web/src/app/reader/[postId]/page.tsx` resolves external via the Phase-1 `GET /thread/:postId` focal — no new gateway endpoint; native keeps its SEO-rich `/article/[dTag]` page). `PostCard`'s article `reader-pane` click is now wired in `WorkspaceView`/`PostThread`. The old `ReaderPane.tsx` is deleted. **Phase 4 shipped** — byline hover modal + constructed external-author profile (`/author/:authorId`) for tier A/B (gateway `routes/author.ts` + `lib/author-resolve.ts`; web `app/author/[authorId]/`); byline routing flipped (tier-A/B external → `/author/:id`; tier-C/D plain text). **Phase 5 shipped — the cutover, the final phase.** The unified Post model is the workspace's only card path: the deferred Phase-2/3 scope cuts were closed first (external like/repost/reply, poll voting, fresh-on-expand counters, parent-context tile — wired via `usePostInteractions` + `PostCardInteractive`, reusing existing interact-back endpoints + kept components; the greenfield `POST /post/:postId/react` scoresheet, §9, stays deferred). **Phase-5 gap CLOSED (2026-06-01): external like/repost/reply on the focal thread card.** Was non-functional because the `/thread` projector (`gateway/src/lib/post-mapper.ts::feedItemToPost` + `post-thread.ts::commentToPost`) never emitted `externalItemId`, so web's `usePostInteractions` left `active = !!externalItemId && interactBack` false → inert buttons. Fixed by surfacing the external interact-back key on the gateway `Post` (mirrors the `postId` id-bridge): `feedItemToPost` now emits `externalItemId: isExternal ? row.external_item_id : null` (`FEED_SELECT` already carried `fi.external_item_id`), `commentToPost` emits null. The client `Post` type + `usePostInteractions` already read the field — the gateway was the only missing leg. (The collapsed *feed* card still shows static `inline-numerals` counters by design; interaction happens on the expanded focal card.) Native vote/reply, reader pane, threads, re-root, `/author` all verified working. Then then the `usePostCardFlag` gate was removed and the flag-off legacy deleted (`VesselCard`, `useConversation`, `useExternalThread`, `ConversationView`, `ExternalAncestorRail`, `ExternalPlayscriptThread`, `ConversationNode`/`ConversationResponse` + `replies.conversation`, `lib/post/flags.ts`, `/dev/postcard`). **Scoped to the workspace** — the standalone `/feed` page + `/source/[id]` + the `components/feed/` card family (`ExternalCard`, `FeedView`) and what they consume (`useNeighbourhood`, `ExternalThreadEntry`/`ParentItem`, `quoted*` fields) were deliberately left intact for a later `/feed`+`/source`-scoped pass. Gateway `GET /conversation/:eventId` is now orphaned by the web client (the `/thread` projector replaced it) but left live; `GET /external-items/:id/thread` is still used by `useNeighbourhood` on `/feed`+`/source`. **Post-cutover (2026-06-02): one post per card.** The Phase-5 parity work above wired an inline parent-context tile into `PostCardInteractive` and the gateway grouped reply bursts into `reply_group` cards; both were removed to make **one post per card** an absolute rule (see Design system rules) — `PostCardInteractive` no longer renders a parent tile and `feeds.ts` no longer groups replies. The workspace feed also gained infinite scroll (the `sourceFilteredItems` cursor is now consumed by `WorkspaceView`/`Vessel`) and keeps at most one conversation expanded per feed (`expandedByFeed` in `WorkspaceView`). **Content-pull bug hunt (2026-06-03):** three fixes — (1) a 5-leg `external_author_id` id-bridge (parallel to `postId`/`externalItemId`) so external bylines link to `/author/:id` and arm the hover modal on the **collapsed feed card** too, not only inside expanded threads (`fi.external_author_id` → `feeds.ts` `FEED_SELECT`/`rowToItem` → `authorId` on `WorkspaceFeedApiExternal`/ndk `ExternalFeedItem` → `mapExternalApiItem` → `mapExternal` `author.id`); (2) the `/thread` projector now emits `quotedPreview` (from `notes.quoted_*`) so native quotes render the rich quoted-mini in threads instead of a "Quoted a post →" stub; (3) `persistHydratedThreadNodes`' `ON CONFLICT` now `COALESCE`s `source_reply_uri` and backfills empty `content_*`/`media`, so external thread hydration can attach a parent link to an already-ingested row (the ancestor walk climbs `source_reply_uri`) and enrich a thin parent without clobbering a full ingest. Comment-table media/quote columns were considered and rejected as dead schema (overlay replies are notes; kind-1111 comment media is inline-extracted; comments can't quote). Full record: UNIVERSAL-POST-ADR content-pull bug-hunt note.
- `docs/adr/` — active ADRs and specs (publications, email-on-publish, traffology, currency strategy, etc.)
- `docs/audits/` — code reviews, audits, and fix programmes (`docs/audits/FIX-PROGRAMME.md`, `docs/audits/platform-pub-review.md`, `docs/audits/AUDIT-BACKLOG.md`, etc.)
- `DEPLOYMENT.md` — full production deployment guide
- `schema.sql` — full PostgreSQL schema (source of truth for DB structure)
- `planning-archive/` — completed specs (FEATURES.md, DESIGN-BRIEF.md, FEED-ALGORITHM.md, RESILIENCE.md, etc.)
