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

Backend services (`gateway/`, `payment-service/`, `key-service/`, `key-custody/`) and `shared/` share the same npm scripts: `npm run dev` (tsx watch), `npm run build` (tsc → `dist/`), `npm run test` / `npm run test:watch` (Vitest). The web frontend (`web/`) uses `npm run dev` (Next.js, port 3010), `npm run build`, and `npm run lint` (ESLint via next lint).

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

- **Data model**: `external_sources` (shared canonical feeds), `external_subscriptions` (per-user), `external_items` (normalised content). `feed_items` (migration 053) is the denormalised unified timeline — articles, notes, and external items all land here via transactional dual-write from their source tables. Every row also carries a deterministic per-THING `post_id`, an edit-detecting `version`, a persisted `biddability_tier`, and (for tier-A/B external rows) an `external_author_id` linking to the `external_authors` identity table — all minted by a `BEFORE INSERT/UPDATE` trigger (`feed_items_post_identity`, migrations 098/099 — UNIVERSAL-POST-ADR Phase 0a/0b); source tables are untouched and later phases read these columns. Bare reposts/boosts are **not** rows here — a boost has no body, so it is an edge in `repost_edges` (migration 100, Phase 0c): a booster handle + the boosted THING's deterministic `post_id` (via the same `feed_items_derive_post_id`), detected per-adapter at ingestion (nostr kind-6/16, atproto reposts, activitypub `Announce`; rss/email have none) by `feed-ingest/src/lib/repost-edge.ts::recordRepostEdge`. Feed assembly that consumes these edges is Phase 1; Phase 0c is ingestion-only. The native `feed_items.author_id` (→ `accounts`) is a separate id-space from `external_author_id` (→ `external_authors`, keyed `UNIQUE(protocol, stable_handle)`); tier-C/D rss/email rows have no stable handle so `external_author_id` stays NULL (plain-text byline).
- **Feed query** (`gateway/src/routes/timeline.ts`): single-table scan on `feed_items` with LEFT JOINs for type-specific fields, compound `(published_at, id)` cursor, per-source cap via windowed `ROW_NUMBER() PARTITION BY source_id`. External items appear in the following feed only. The **Post-model successors** are `gateway/src/routes/post-feed.ts` (`GET /feed/:feedId`, UNIVERSAL-POST-ADR Phase 1) — reuses this query's membership but adds live §5 hotness scoring + dedup-to-one by `post_id` — and `gateway/src/routes/post-thread.ts` (`GET /thread/:postId`) — a *projector* that resolves the focal by `post_id` then projects native `comments` (which carry no `post_id` of their own — they get a deterministic derived one) + ingested `external_items` into the §2.2 `Post` shape; both share the mapper in `gateway/src/lib/post-mapper.ts` and run side-by-side with the legacy feed/`conversation`/`external-items` thread reads until the Phase 5 cutover.
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

### Feed card chassis

All three feed card types (`ArticleCard`, `NoteCard`, `ExternalCard`) share a unified visual grammar:

- **Left bar**: 4px solid, full card height. Black (`#111111`) for native, crimson (`#B5242A`) for paid, grey-300 (`#BBBBBB`) for external. Applied via `borderLeft` inline style + `paddingLeft: '24px'`.
- **Byline row**: mono-caps 11px (`font-mono text-[11px] uppercase tracking-[0.06em] text-grey-600`). Order: TrustPip · Author name · middle-dot · timestamp · (optional price or protocol badge).
- **Byline routing**: every author byline — on a card, and on every expanded parent or reply in the conversational neighbourhood — links to the internal all.haus surface, never the origin platform. Native authors route to their writer profile (`/{username}`); external authors route to the source surface (`/source/:id`, CARD-BEHAVIOUR-ADR §VI.2) until the constructed external author profile (§VI.3) ships. The only route out to the origin platform is the source-attribution line (§VI.4).
- **Action row**: mono-caps 11px (`font-mono text-[11px] uppercase tracking-[0.02em] text-grey-600`). `Reply` opens the compose overlay; `Quote`, `VoteControls`, `BookmarkButton`, `ShareButton` as appropriate per type.
- **No avatars** in card bodies. The left bar + pip + mono-caps name carry identity.
- **Feed rhythm**: 40px gap between all items (`space-y-[40px]`), no horizontal rules between cards (see No hairlines — absolute sitewide).

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
  - **Byline routing**: native bylines link per-author to `/{username}`; for external, only the host item's byline links to its `/source/:id` and **every other external participant renders as plain text** (no internal surface for arbitrary external authors until §VI.3 ships; never fabricate a `/source` link or route out to the origin platform).
  - Wiring (native `ConversationView` / `useConversation`; external `ExternalAncestorRail` / `useExternalThread`) and full behaviour: see `docs/adr/CARD-BEHAVIOUR-ADR.md` addendum (2026-05-30).

## Key docs

- `feature-debt.md` — consolidated feature debt, outstanding work, and attack order
- `FEED-INGEST-ATTACK-PLAN.md` — build plan for omnivorous stream ingestion (per-adapter contract, slices 0–9; 0–3 shipped, 4–9 planned)
- `docs/adr/CARD-BEHAVIOUR-ADR.md` — unified card interaction model (click regions, conversational neighbourhood expansion, biddability tiers, author affordances, rich embeds). Phases 1–5 complete; external bylines route to the internal source surface (`/source/[id]`), not the origin platform, and the workspace `VesselCard` is the live surface (the `/feed/` cards are being retired). Only the §VI.3 constructed external author profile remains deferred
- `docs/adr/ALLHAUS-REDESIGN-SPEC.md` — redesign spec for topbar, feed, compose overlay, card family (Steps 1–4 shipped including article tiers, reading-history resumption, playscript threads; remaining: compose article mode, polish states)
- `docs/adr/REDESIGN-SCOPE.md` — product scope document arguing what the product is (companion to the redesign spec)
- `docs/adr/UNIVERSAL-FEED-ADR.md` — universal social reader spec (external feeds, resolver, outbound posting)
- `docs/adr/ALLHAUS-OMNIBUS.md` — trust graph spec (Layer 1/2/4, Phase A/B anonymity)
- `docs/adr/WORKSPACE-FULL-VIEW-SPEC.md` — workspace full view spec (Compact/Full fidelity modes, engagement counts, parent context, threads, cross-platform interactions, reader pane, content warnings, polls, inline video, pull-to-refresh, reply grouping; all phases shipped)
- `docs/adr/UNIVERSAL-POST-ADR.md` — unified **Post** model, feed assembly/ordering, single thread engine, and full-view rendering matrix. Supersedes the node-identity + thread-rendering portions of `UNIVERSAL-FEED-ADR.md` and `CARD-BEHAVIOUR-ADR.md`, the chronological-only following feed, and the HN-gravity score. Phase 0a (deterministic `post_id`/`version`/`biddability_tier` on `feed_items`, migration 098), Phase 0b (tier-A/B `external_authors` identity records + `feed_items.external_author_id`, migration 099), Phase 0c (`repost_edges` + per-adapter boost detection, migration 100) shipped; **Phase 1 shipped in full** — `/feed` slice (`gateway/src/routes/post-feed.ts` — `GET /feed/:feedId`, live §5 hotness scoring + dedup-to-one) and `/thread` slice (`gateway/src/routes/post-thread.ts` + shared `gateway/src/lib/post-mapper.ts` — `GET /thread/:postId`, a *projector* that projects native `comments` + ingested `external_items` into the §2.2 `Post` shape; native comments get a deterministic derived `post_id` since they live in `comments`, not `feed_items`); both coexist with the legacy `timeline.ts` `/feed` + `replies.ts` `/conversation` + `/external-items/:id/thread` until the Phase 5 cutover. **Phase 2 shipped** — one unified `PostCard` (`web/src/components/post/`) renders a `Post` at any of six levels via the §4 matrix-as-data (`web/src/lib/post/level-spec.ts`) + §7 tier gating, fed by a pure client-side adapter (`web/src/lib/post/map-feed-item.ts`, legacy `FeedItem` → §2.2 client `Post`), behind a runtime localStorage dev flag (`web/src/lib/post/flags.ts::usePostCardFlag`) gating a single swap in `WorkspaceView`; render-only (thread interaction, reader pane, author profile deferred to Phases 3/R/4), with a six-level parity harness at `/dev/postcard`. Phases 3–5 + R planned
- `docs/adr/` — active ADRs and specs (publications, email-on-publish, traffology, currency strategy, etc.)
- `docs/audits/` — code reviews, audits, and fix programmes (`docs/audits/FIX-PROGRAMME.md`, `docs/audits/platform-pub-review.md`, `docs/audits/AUDIT-BACKLOG.md`, etc.)
- `DEPLOYMENT.md` — full production deployment guide
- `schema.sql` — full PostgreSQL schema (source of truth for DB structure)
- `planning-archive/` — completed specs (FEATURES.md, DESIGN-BRIEF.md, FEED-ALGORITHM.md, RESILIENCE.md, etc.)
