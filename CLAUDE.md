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

Browser → Nginx (80/443) → `/api/*` to gateway, `/` to web. The Next.js app rewrites `/api/*` to `GATEWAY_URL`; the frontend never calls backend services directly.

Orientation only (the cited ADRs / code are the source of truth):

- **Auth**: magic links + Google OAuth (no passwords); httpOnly JWT cookies set by the gateway. `gateway/src/middleware/auth.ts` exports `requireAuth` / `optionalAuth`. Custodial Nostr keypairs: key-custody holds private keys; key-service wraps/issues NIP-44 keys to readers for gated content.
- **Nostr**: articles are kind 30023 (NIP-23) replaceable events signed via key-custody; the platform runs its own strfry relay. Web reads via NDK (`web/src/lib/ndk.ts`). Soft-delete publishes a kind 5 tombstone.
- **Payments**: readers accrue a Stripe tab as they read gated articles; payouts via Stripe Connect (`payment-service/src/services/`). Article access logic in `gateway/src/services/article-access/`; `/articles/:id/gate-pass` is a thin wrapper over `performGatePass()`.
- **Media**: uploaded via `gateway/src/routes/media.ts`, stored in a Docker volume, served at `/media/`; Blossom configured but local is primary. oEmbed proxied in the same route.
- **Editor**: TipTap (`web/src/components/editor/`) with a paywall gate node; markdown via `tiptap-markdown`.
- **Feed & search**: full-text search via `pg_trgm` (`gateway/src/routes/search.ts`); feed ranking `planning-archive/FEED-ALGORITHM.md` (Phase 1).
- **External feeds (Universal Feed)**: RSS/Atom/JSON, external Nostr, Bluesky, Mastodon/Lemmy/threadiverse, and email are ingested by `feed-ingest/` (Graphile Worker + Jetstream listener; adapters in `feed-ingest/src/adapters/`). Data model `external_sources`/`external_subscriptions`/`external_items`, denormalised into the unified `feed_items` timeline by transactional dual-write (each row carries `post_id`, `version`, `biddability_tier`). **External subscriptions are feed-derived** (see Invariants): an `external_subscriptions` row exists iff the source sits in ≥1 of the owner's feeds, maintained by `addSource`/`removeSource` in `gateway/src/routes/feeds.ts`; it doubles as the external follow-graph (kind-3 follow list, author Following state). The standalone subscription CRUD + Subscriptions page were retired (migration 116 dropped per-sub `is_muted`/`daily_cap`); `gateway/src/routes/external-feeds.ts` now holds only admin diagnostics, and per-feed mute is `feed_sources.muted_at`. Source authoring via the workspace feed endpoints (`POST /workspace/feeds/:id/sources`, protocols `rss`/`nostr_external`/`atproto`/`activitypub`). Live workspace reads via `GET /workspace/feeds/:id/items` (+ `GET /thread/:postId` projector). Spec: `docs/adr/UNIVERSAL-FEED-ADR.md`; workspace full view: `docs/adr/WORKSPACE-FULL-VIEW-SPEC.md`.
- **Trust graph**: Layer 1 (`trust_layer1`, daily cron) + `trust_polls` compose the `TrustPip` four-state glyph on all feed cards (`feed-ingest/src/lib/trust-pip.ts`). Layer 2 vouches (`vouches`/`trust_profiles`/`trust_epochs`); Layer 4 relational ("N writers you follow endorse this"). Gateway `trust.ts`; UI `/network?tab=vouches`; `TRUST_DRY_RUN=1` for dry runs. Spec: `docs/adr/ALLHAUS-OMNIBUS.md`.

### Invariants (these are rules, not orientation)

- **Relay outbox**: every write path that publishes a signed Nostr event enqueues into `relay_outbox` inside the caller's transaction (`shared/src/lib/relay-outbox.ts::enqueueRelayPublish`); the `feed-ingest` `relay_publish` worker owns publish + retry. So `POST /sign-and-publish` and the publication publish routes mean "signed and durably queued", not "on relay" — relay blips become invisible worker retries, not 5xx. Spec: `docs/adr/RELAY-OUTBOX-ADR.md` (+ `RELAY-OUTBOX-PHASE-4-ADR.md`).
- **Outbound discovery (NIP-05 + kind 0/3/10002)**: NIP-05 served at gateway `/.well-known/nostr.json` (read-only, always on). The three replaceable discovery events are produced from DB state by `gateway/src/lib/discovery-publish.ts` (signed via key-custody, enqueued through `relay_outbox`) and drained by the gateway scheduler sweep (`runDiscoverySweep`, advisory lock `DISCOVERY`; kind 3 coalesced via `accounts.follow_list_dirty`). All publishing ships dark behind the operator master switch `DISCOVERY_PUBLISH_ENABLED` **and** the per-user opt-in `accounts.discovery_enabled` (both must be true; `republish*`/`runDiscoverySweep`/`markFollowListDirty` all gate on it — only `retractFollowList` is exempt, as the opt-out cleanup). `PUBLIC_FANOUT_RELAY_URLS` controls public-mesh fan-out (empty ⇒ in-house relay only); kind 3 is a finer per-user opt-out via `accounts.publish_follow_graph` *within* an opted-in account. Spec: `docs/adr/NOSTR-OUTBOUND-INTEROP-ADR.md`, `docs/adr/NETWORK-CONCIERGE-ADR.md` §7.
- **Network presences (Nostr root + satellites)**: the canonical identity is the custodial **Nostr root** minted at signup (`accounts.nostr_pubkey`/`nostr_privkey_enc`) — never replaced or preceded by another network. Every *other* network identity is a `network_presences` row (keyed `(account_id, protocol)`, one per network in v1), tagged `provenance` one of three tiers: **linked** (user already had it; OAuth grant in `atproto_oauth_sessions` / `credentials_enc`), **assisted** (all.haus guided the user through the *network's own* native signup and auto-linked it — for atproto a one-redirect reuse of the LINKED OAuth path; the network holds the keys, same custody as linked), or **concierge** (all.haus minted & custodies it on our own PDS; secrets in key-custody). **ASSISTED is the default "set one up for me"; CONCIERGE is demoted to an optional Phase 4 justified only by the branded `username.all.haus` handle.** All satellites are **lazy** (materialised only on explicit per-network opt-in, never at signup). Outbound dispatch targets only `lifecycle_state='active' AND is_valid`, then branches **on custody, not provenance**: OAuth-session (`linked`∪`assisted`) → post to the network's PDS; key-custody (`concierge`) → sign locally → our PDS. **Native-not-external is scoped to `concierge` only** — a linked/assisted presence lives on the network's own PDS/instance and *is* a genuine external account (its posts ride the firehose; do not treat as native). Custodial identities are **export-mandatory**: `/account/export` ships the Nostr nsec via key-custody's gated `POST /keypairs/export`. Spec: `docs/adr/NETWORK-CONCIERGE-ADR.md` (three-tier model accepted 2026-06-10; Phase 0 + 1 shipped; assisted-atproto = Phase 2, **live on prod** behind `ATPROTO_ASSISTED_ENABLED` (needs `ATPROTO_PRIVATE_JWK` — `scripts/gen-atproto-jwk.ts`); assisted-activitypub = Phase 3, **live on prod** behind `MASTODON_ASSISTED_ENABLED` (+ curated `MASTODON_ASSISTED_INSTANCES`; signup round-trip verified 2026-06-11, §9); custodial concierge = Phase 4, gated by §8.1).
- **Relay-free Nostr identity**: external-nostr `source_item_uri`/`post_id`/the `(protocol, source_item_uri)` dedup key encode `nevent`/`naddr` *without* relay hints (else two relays mint two `post_id`s); relay hints live only in `external_items.interaction_data`.
- **Separate id-spaces**: native `feed_items.author_id` (→ `accounts`) and `external_author_id` (→ `external_authors`) never mix; tier-C/D rss/email rows have no stable handle, so `external_author_id` stays NULL (plain-text byline).
- **Feed-derived external subscriptions**: an `external_subscriptions` row is a *projection* of feed membership — it exists iff the source sits in ≥1 of the owner's feeds — never a standalone, user-managed record. Only `addSource`/`removeSource` (`gateway/src/routes/feeds.ts`) write it: `addSource` upserts it (any external add path must, else the GC orphans an in-use source); `removeSource` deletes it when the source leaves the owner's *last* feed (owner-scoped `pg_advisory_xact_lock` serialises the read-then-write against a concurrent add). The same row is the external follow-graph: a `nostr_external` add/teardown calls `markFollowListDirty` so the published kind-3 list tracks it, and the author-card "Following" state reads it. Do **not** reintroduce a standalone subscribe/unsubscribe endpoint or a Subscriptions page; "follow an external author" = add the source to a feed (the FeedComposer "Add a source" field, or the hover-card Follow which adds to the *current* feed). Per-source display controls are per-feed (`feed_sources.muted_at`), not per-subscription. Spec: `docs/adr/UNIVERSAL-FEED-ADR.md`.
- **SSRF hardening**: all outbound fetches must use the hardened HTTP client in `shared/src/lib/http-client.ts` (undici `Agent` with a pinned `connect.lookup` closing the DNS-rebinding TOCTOU); `pinnedWebSocketOptions` covers ws:/wss: (validates scheme + host, returns a pinned `lookup` to thread through `new WebSocket(url, protocols?, options)`).
- **Compose surfaces**: exactly two for short-form — the global `ComposeOverlay` (`web/src/components/compose/ComposeOverlay.tsx`, mounted in `app/layout.tsx`) and the workspace `Composer`. Do not add a third. Two modes (note/reply) via `web/src/stores/compose.ts`; renders through `<Glasshouse>`. Spec: `planning-archive/ALLHAUS-REDESIGN-SPEC.md` §3.
- **Article writing — one surface**: the full TipTap `ArticleEditor` (`web/src/components/editor/ArticleEditor.tsx`) is the single article editor. It renders two ways from the same component (`chrome` prop): the standalone `/write` page (`chrome='page'`, addressable for direct visits/bookmarks/deep-links) and the global **EditorOverlay** (`web/src/components/workspace/EditorOverlay.tsx`, `chrome='overlay'`, mounted unconditionally in `LayoutShell` like `ProfileOverlay`, chromeless). Both consume the shared `useArticleEditorInit` hook (data-load + publish/schedule) so they can't drift. Opened via `useEditorOverlay` (`web/src/stores/editorOverlay.ts`) from the ForallMenu, the dashboard "New article"/"Edit"/draft rows (`inOverlay`-gated), the compose "Write an article →" affordance (seeds the note body via `seedFromNote`), or the `/workspace?overlay=editor[&draft|&edit|&pub]` deep-link. **Do not reintroduce a lightweight article editor inside the compose surfaces** — the prior `ArticleComposePanel` + the `Composer`/`ComposeOverlay` `article` modes were consolidated away (they silently dropped dek/tags/cover/comments/schedule).

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

Always use `.label-ui text-grey-400` for form labels. Not `text-ui-xs uppercase tracking-wider` or `text-sm text-grey-600`. **Exception — on the Glasshouse interior (`bg-glasshouse`, now white) and its `bg-glasshouse-well` (`#F5F4F0`) inset fields, labels are `.label-ui text-grey-600`**: `grey-400` is too weak on the wells, so labels there stay `grey-600` for one consistent treatment across pane and wells (see the Glasshouse exempt-surface rule).

### Buttons

Use the defined button classes: `.btn` (primary), `.btn-accent` (crimson), `.btn-ghost` (background), `.btn-soft` (secondary/soft). Do not hand-roll button styles inline.

**Focus state — `:focus-visible`, never bare `:focus`.** A focusable control must show its ring only for keyboard focus, via a `:focus-visible { outline: 2px solid var(--ah-crimson); outline-offset: 2px }` rule (the `.btn*`/`.focus-ring` classes already carry this; the 2px outlines are the a11y exemption to the no-hairline rule). A control that can't take a `.btn` class (e.g. the ∀ disc, `.forall-trigger`) needs its own class with that `:focus-visible` rule **plus** `:focus { outline: none }` to suppress the UA default — otherwise it re-trips the browser ring for mouse users on every programmatic refocus (`.focus()` after a menu closes). Never inline `outline: "none"` (it has higher specificity than the `:focus-visible` rule and kills the keyboard ring too); add `-webkit-tap-highlight-color: transparent` to kill the mobile tap-flash.

### Text-link actions

`.btn-text` for inline text-link actions (13px sans, black, medium). `.btn-text-muted` for secondary (grey, hover:black). `.btn-text-danger` for destructive (crimson). Do not hand-roll with `text-ui-xs text-black font-medium` or similar.

### Toggle chips

Use `.toggle-chip` + `.toggle-chip-active` / `.toggle-chip-inactive` (with `.label-ui`) for On/Off selectors. Do not hand-roll with inline conditional classes.

### Page shell

All top-level admin/settings/dashboard pages use `<PageShell>` (`web/src/components/ui/PageShell.tsx`) — it fixes outer padding (`py-12`), title styling, and title→content gap (`mb-8`). Choose width by content: `article` (640px) single-column forms, `feed` (780px) lists/cards/reading, `content` (960px) tables/dense dashboards. Do not hand-roll `mx-auto max-w-* px-4 sm:px-6 py-*` wrappers. Use `<PageHeader>` standalone for sub-views needing the same title treatment.

### Colour values — canonical registry, never a raw hex

Every colour the frontend renders lives as a CSS-variable pair on `:root` — `--ah-<slug>` (colour) + `--ah-<slug>-rgb` (RGB triple) — defined in `web/src/app/globals.css` from the ordered canonical registry `web/src/lib/palette/registry.ts` (keep both in sync, same order; the registry header documents the contract). Never introduce a raw hex/`rgb()` literal in web code: inline styles reference `var(--ah-<slug>)`, Tailwind colour tokens already resolve to the triples (alpha modifiers like `bg-white/40` keep working), and translucent washes are `rgb(var(--ah-<slug>-rgb) / 0.x)`. A genuinely new colour gets a registry entry + `:root` pair first. Contexts that cannot resolve `var()`: SVG presentation attributes (set `style={{ fill/stroke }}` instead) and canvas (read the triple off `getComputedStyle(document.documentElement)` at draw time — see `ProvenanceBar`). Exempt, deliberately hard-coded: Stripe iframe appearance (`CardSetup.tsx`), brand-locked SVGs (Google logo), print CSS. The Palette devtool — `web/src/components/devtools/PalettePanel.tsx` + `web/src/stores/paletteDevtool.ts` — live-tunes the registry vars (overrides persist in `localStorage` `ah:palette-overrides`). **Operator-only, not user-facing** (GLASSHOUSE-AND-PALETTE-ADR §III.5): the ForallMenu "Palette" row and the Settings preset-theme picker (`ThemeSection`, now parked) were retired to reclaim a single canonical identity, and existing user overrides are purged once on upgrade (headless, sentinel `ah:palette-purged-v1`). The panel is reached via `?palette` or the `Ctrl+Alt+P` chord. **Do not delete** — it remains the operator tuning surface behind the per-feed colour schemes (feature-debt.md §3), and boot-time hydration of any persisted overrides now lives in the headless `PaletteHydrator` (`web/src/components/devtools/PaletteHydrator.tsx`, mounted at the app root) — *that* component is the load-bearing mechanism; never remove it. Per-feed colour **schemes** are a separate axis (`feeds.appearance` / the layout store, `components/workspace/tokens.ts` `PALETTES`), not the override store, and are untouched by the purge. The Glasshouse pane, ∀ chrome (`ink-925`) and trust-pip slugs stay locked out of any theming (`THEME_LOCKED_SLUGS`). The registry + var indirection itself is permanent.

### Workspace colour schemes — colour from the palette, never hard-code

Per-feed colour **schemes** in `web/src/components/workspace/tokens.ts`: the two hand-tuned reference palettes `primary` (light) and `dark`, plus three curated surface schemes (`anil`/`vela`/`caju` — a Brazilian-modernist family, FEED-SCHEME-REFRESH-ADR + Addendum A retired `mata`/`cobalto`; one dark, two light). `PALETTES[scheme]` is a `VesselPalette` (`cardBg`/`cardTitle`/`cardMeta`/`interior`/`barText`/… + `isDark`) — every field a `var(--ah-…)` reference into the canonical registry. **Quoted-post embeds ride the `walls` surface, not `interior`** — `quoteBg`/`quoteText`/`quoteMeta` are derived against walls luminance (Addendum B), so a quote reads as a recessed frame, not a second content well. A curated scheme defines **surfaces only** (walls/interior/card registry slugs); every text colour is **derived by luminance** (`deriveVesselPalette`) between the two reference text ramps, with the semantic flip riding the same switch (crimson → crimson-soft on dark cards) — never hand-set a text colour in a scheme, and curate card surfaces clearly light or clearly dark (mid-luminance defeats both ramps). The scheme is **feed character**: persisted server-side (`feeds.appearance.scheme`, migration 112; cycled through the FeedComposer `Colour` AppearanceControl — GLASSHOUSE-AND-PALETTE-ADR §III.4), mirrored into the layout store's legacy `brightness` field as the per-device cache/fallback. The scheme id list must mirror `FEED_SCHEME_IDS` in `gateway/src/routes/feeds.ts`; retired ids are migrated on read by `normalizeBrightness`'s alias map (`SCHEME_ALIASES`), so renaming schemes needs no DB backfill. **Density rides the same model** (`feeds.appearance.density`, no DDL; `FEED_DENSITIES` in the gateway must mirror the `Density` type in `tokens.ts`), as do `feeds.hidden` + `feeds.sort_rank` (migration 113): hide and rank are feed character, never per-device layout state, and the numeral is derived 1..N over **visible** feeds in `sort_rank` order — one rule on every surface (MOBILE-LAYOUT-ADR §V/§VII).

### Mobile workspace (one feed per screen)

At ≤767px (`useIsMobile`) the workspace swaps the canvas for `web/src/components/workspace/MobileWorkspace.tsx`: thin bar (wordmark · numeral indicator strip · ∀ docked via `ForallMenu anchor="bar"`) over one full-bleed feed, paged horizontally in rank order. The canvas affordances (position/resize/orientation/merge) do not exist there; Glasshouse overlays render as full-screen sheets (presentation only). The pager claims a touch only when decisively horizontal, never from inside a horizontally-scrollable element or the pip (`[data-pip-trigger]` wins); resume keys off feed `id`, never the numeral. Both surfaces render cards through the single `WorkspaceView.renderFeedContents` path — don't fork it. Spec: `docs/adr/MOBILE-LAYOUT-ADR.md`.

- **Any component inside a themed vessel interior or card takes the palette** (`palette: VesselPalette` prop, or `paletteFor(brightness)`) and colours every text/background — **including hover and active states** — from it. Never hard-code `text-black`/`text-white`/`bg-white`/inline `color` on an interior surface; it won't invert. Drive emphasis from a palette field (hover → `palette.cardTitle`) or a mode-agnostic affordance (`hover:opacity-70`); pick translucent washes via `isDarkPalette(palette)`.
- **Greys `500`/`700`/`800`/`900` are not defined** in `web/tailwind.config.js` (only `100/200/300/400/600`) — they emit no rule and silently inherit (dark-on-dark). Use a palette field, never an undefined grey.
- **Exempt:** always-light surfaces (the Glasshouse pane, fixed `bg-glasshouse` — now **white** `#FFFFFF`, the lightest/outermost layer, separated from the ground by the scrim and an elevation shadow, not by being a darker slab; + overlay panels with fixed light `panelBg`) never consume `PALETTES`; keep their text dark. Two fixed conventions on this interior:
  - **Text fields are the inset well `bg-glasshouse-well` (`#F5F4F0`).** The lightest layer is the pane (white), so a field reads as a well sitting a touch *darker* inside it — the inverse of the old model (field = bright white well on a parchment pane), flipped 2026-06-14 so the lightest colour is outermost. One treatment everywhere a text-entry field is defined against a modal interior (article editor title/standfirst/tags, composers, messages, …). Don't introduce a second field colour (`bg-grey-100`/`bg-white`/transparent) for an input on the pane. Container panels that merely *group* controls (cover/settings cards) stay a softer `bg-glasshouse-well/40` wash; the entry fields themselves are the solid well. (The standalone `/write` editor carries its own `bg-glasshouse` surface so the same wells read there too.) Floating material that is itself the outermost layer — dropdowns, popovers, the byline `AuthorModal`, the reader canvas — stays white (`bg-white`/`bg-glasshouse`), never a well.
  - **Secondary text is `text-grey-600` or darker.** Use black for primary, `grey-600` for secondary/labels across both the white pane and the `#F5F4F0` wells (one treatment); keep `grey-300` only for placeholders *inside* the well fields. `grey-400` is too weak on the `#F5F4F0` wells — don't use it for content there.
  - **A component that renders on *both* the fixed-light pane and the palette vessel must be palette-aware, not flat `grey-600`.** The fixed pane (now white `#FFFFFF`, light-only) and the themed vessel interior (`PALETTES`, light *or* dark) are two different contrast regimes: `grey-600` is correct on the pane but fails on a dark card. So don't "fix the pane" by hard-coding `grey-600` into a shared card/action component — drive its muted text from `palette.cardMeta`. Flat-darkening such a component is a dark-mode regression. Reference implementations: `VoteControls` takes an optional `palette?` and derives muted/active colour from `palette.cardMeta`/`palette.crimson`, defaulting to `grey-600`/crimson when omitted (so `PostActions` passes the vessel palette while the legacy fixed-light cards pass nothing); `PostThread`'s thread-nav greys read `ctx.palette.cardMeta`. Hover is the mode-agnostic `hover:opacity-*` fade, never a `hover:text-black`/`hover:bg-grey-100` that assumes a light ground.

### Glasshouse (frosted workspace overlay)

Every surface that opens **over the workspace** (reader, messages, notifications, dashboard, composer, feed-settings, compose overlay, …) uses the canonical `<Glasshouse>` primitive (`web/src/components/workspace/Glasshouse.tsx`) — never a hand-rolled frosted scrim + centred pane. It owns the chrome: frosted scrim (`z-[55]`, `.gh-scrim` — backdrop blur **plus** a desaturate + neutral wash that converges any per-feed scheme behind toward the mode's ground, so the pane always meets a consistent field; **separation is the scrim's job, identity is the pane's** — GLASSHOUSE-AND-PALETTE-ADR §III.1; click-to-close), white pane (`z-[56]`, `bg-glasshouse` — now `#FFFFFF`, *lighter* than both the bone floor and the washed scrim ground, so it reads as lifted paper, §III.2; its inset fields/wells are `bg-glasshouse-well` `#F5F4F0`, a touch darker, so the lightest layer is outermost; lifted by an elevation shadow alone, no top edge), Escape-close, body scroll-lock. Mount conditionally; pass `onClose` + `maxWidth` (+ optional `ariaLabel`, `persistKey`, `resizable`); the caller's store layers on URL-sync. A child popover above the pane raises its own `z-index` above `z-[56]` (e.g. `AuthorModal`'s `zIndex` prop). **The pane is draggable, not fixed-centred.** It opens snapped-centred on the 20px lattice (which also kills the sub-pixel blur a flex-centred odd-width pane would have) and is dragged by a top-centre grip — drag is free, snaps to the lattice on release, clamps to the viewport, and (when the caller passes a stable `persistKey`) remembers its spot per overlay in `localStorage` (`ah:overlay-pos:<key>`). It stays **modal** throughout (scrim, one-at-a-time, scroll-lock unchanged); only placement is user-chosen. The pane clips (`overflow-hidden`) and exposes the on-screen height as the `--gh-h` CSS var, which **every body sizes its own scroll region against** (`max-h-[var(--gh-h)]` / `h-[var(--gh-h)]`, replacing the old fixed `calc(100vh-64px)`) so content scrolls inside while the pinned chrome stays put — a body must own its scroll, never rely on the wrapper. **Resizable panes** (`resizable`, opted in by the two writers — the note `Composer` and the article `EditorOverlay`) add a bottom-right stretch handle mirroring the vessel resize: width/height snap to the lattice on release, persist per overlay (`ah:overlay-size:<key>`), and clamp to the viewport; `maxWidth` then seeds the default width but no longer caps it (stretch can exceed it). Floors `MIN_W`/`MIN_H`; height switches the body from content-driven to a fixed box.

**Invariant — the ForallMenu stays crisp above the frost** as the sole nav affordance: it sits at `z-60`, Glasshouse never reaches `z-60`. Never raise a Glasshouse above `z-[56]`, never blur or dim the ForallMenu. Per-surface stores follow the `useReader`/`useMessagesOverlay` shape (`isOpen` + `open`/`close`); the body is a shared panel component (`MessagesPanel`, `DashboardPanel`) reused by both the overlay and any standalone page. The dock's own dropdown and its `SearchPanel` ride the same glasshouse material — `bg-glasshouse` (white) + `shadow-lg`, **no border/outline** (lifted by shadow alone, per the no-thin-line rule); rows group find → make → go (Search · create actions · destinations) with a tight 6px gap, muted text at `grey-600`, and the search input sits in a `bg-glasshouse-well` inset well.

**Invariant — one Glasshouse at a time.** Frosted panes never stack: opening any Glasshouse supersedes whichever was open before. Enforced in the primitive itself (`Glasshouse.tsx`, module-level `activeGlasshouse` registry), so every surface participates automatically — including the workspace-local `Composer`/`FeedComposer` driven by local state, not a store. Do not add ad-hoc "close the other overlay first" logic in callers, and do not bypass `<Glasshouse>` for an over-workspace surface (that's the only way to escape the rule). The supersede call is **state-only** (never `history.back`): URL-synced overlays (`reader`/`profile`/`surface`) pass `onSupersede={dismiss}` (a state-only clear) because the newcomer already owns the top history entry — a `history.back` there would pop *its* URL, not the old pane's. Ephemeral overlays omit `onSupersede` (their `onClose` is already state-only). Any new URL-synced overlay must expose a `dismiss` and wire `onSupersede`.

**Retiring a route into an overlay** (the direction of travel — everything that isn't the workspace or an overlay is being retired): keep the old path as a thin redirect shim to `/workspace?overlay=<name>[&seed]` so deep links/bookmarks resolve (a client component if it must forward a `#hash`, e.g. `/messages` → `?conversation=`). Routing is centralised in `web/src/lib/workspace/overlays.ts`: `WorkspaceView` reads `window.location.search` once on mount (not `useSearchParams` — it would force a Suspense boundary on prerendered `/workspace`), `openOverlayFromParams` opens the seeded store, then strips `OVERLAY_PARAM_KEYS` via `replaceState`. In-app targets point straight at `/workspace?overlay=<name>`; for navigations **already inside** the workspace, call `routeToOverlay(href)` first (opens in place, returns true so the caller skips a no-op `router.push`). Refs: `useDashboardOverlay`, `useMessagesOverlay`, `useNotificationsOverlay`.

**Invariant — no surface reachable from the workspace may escape to the black topbar.** `LayoutShell` mounts `<Nav>` (the black topbar) whenever it is not chromeless (`chromeless = mode==='workspace' || readerOpen || profileOpen || editorOpen || surfaceOpen`, `web/src/hooks/useLayoutMode.ts`). So a `Link`/`router.push`/`window.location` from any workspace-reachable surface (incl. overlay bodies like `DashboardPanel`) to a platform-prefix or canvas route mounts the topbar and breaks out of the overlay world — banned. Open the corresponding overlay instead: profiles via `ProfileLink`/`useProfile`, articles via `useReader`, **source/tag/publication surfaces via `useSurfaceOverlay`/`openSurfaceHref`** (the unified non-profile surface overlay for `/source/:id`, `/tag/:name`, and the publication surface `/pub/:slug` *and its sub-routes* `/about`·`/masthead`·`/archive` — `web/src/components/workspace/SurfaceOverlay.tsx`, mounted globally in `LayoutShell` like `ProfileOverlay`; the publication target carries a `view: home|about|masthead|archive` switched in-overlay by `PublicationPanel`'s own nav, each view backed by its real `/pub/:slug[/view]` URL so deep links + Back work and pub article rows open the reader, never `/pub/:slug/:article`), compose via the workspace `Composer` (note: the global `ComposeOverlay` is **not** mounted in the chromeless workspace — `WorkspaceView` bridges `useCompose.open('note'|'article')` into its local `Composer`, so an overlay body requests a compose by calling `useCompose.open(...)`, not by linking to `/write`). Dual-use bodies (`DashboardPanel` renders both as a page and as the dashboard overlay) **gate on `inOverlay`**: open the overlay when inside the workspace, fall back to the `Link` only on the standalone page. **Settings is an overlay too** — opened via `useSettingsOverlay` (`web/src/stores/settingsOverlay.ts`; `SettingsOverlay` mounted in `WorkspaceView`, body `SettingsPanel` with the standard `inOverlay` gate); the retired `/settings` route is a redirect shim to `/workspace?overlay=settings` that forwards the gateway's OAuth `?linked` flag so the social-connect banner still shows in the overlay. The publication sub-routes (`/pub/:slug/{about,masthead,archive}`) now render in-overlay (see above). Source-attribution bylines (now on the Post-model card path inside `SourceSurface`) keep a real `/source/:id` `<Link>` but intercept a plain left-click with `openSurfaceHref` (`isModifiedClick` lets new-tab through) so they re-root the source surface in place. **No known workspace escapes remain.** (`PubFollowButton`'s logged-out `→ /auth` redirect is *not* an escape: the workspace is login-gated — `WorkspaceView` bounces logged-out users to `/auth` — so that branch only ever runs on standalone full-page surfaces, where a full-page `/auth` redirect is correct. There is no in-app auth overlay; every logged-out CTA (`VoteControls`/`ReplySection`/`WriterActivity`/`Nav`) goes to `/auth` full-page by design.)

### Profile navigation (ProfileLink + profile overlay)

Profiles open as a **URL-synced Glasshouse overlay** (the reader model, not the in-memory model) so they're shareable and Back closes them. The `useProfile` store (`web/src/stores/profileOverlay.ts`) pushes the real URL — `/<username>` (native → `NativeProfilePanel` = writer header + `WriterActivity`) or `/author/<id>` (tier-A/B → `AuthorProfileView inOverlay`) — and `<ProfileOverlay>` is mounted **globally in `LayoutShell`** (not `WorkspaceView`), so a byline anywhere opens it without leaving the surface. Direct visits to those URLs still render the full pages. `LayoutShell` treats `profileOpen` as chromeless (same reasoning as `readerOpen`); the overlay dismisses itself when an in-overlay link navigates the route away from its target.

**Every internal profile link sitewide goes through `<ProfileLink>`** (`web/src/components/ui/ProfileLink.tsx`), never a raw `<Link href="/{username}">` / `router.push`. It renders a real `<Link>` to the canonical URL (SSR, cmd/middle-click new-tab, copy-link all work) but intercepts a plain left-click to open the overlay; it derives native-vs-external from the href alone, so it's a drop-in. Where a `<Link>` can't be swapped (it needs a `ref`, e.g. the card `Byline`, or it's a non-anchor like `AuthorModal`'s name), call the `openProfileHref(href)` + `isModifiedClick(e)` helpers from the same module. **Never alias `Link`→`ProfileLink` wholesale** — `ProfileLink` can't tell `/settings` from `/alice`, so it must only wrap links known to be profiles.

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
- **Feed rhythm**: each `PostCard` carries its own `marginBottom` (no wrapping `space-y`), per `GAP_PX` in `web/src/lib/post/level-spec.ts` — **8px** between independent items, **5px** within an expanded conversational chain. (The legacy `components/feed/` card stack is retired — FEED-RETIREMENT Slice 7; only the shared `AuthorModal` survives there. Legacy `PlayscriptThread` still uses `space-y-[32px]`.)

### Reply threads (playscripts)

Threads render flat and chronological as a transcript — never nested indentation, left borders between replies, quote-of-parent blockquotes, or avatars. Component surface: `PlayscriptReply` + `PlayscriptThread` in `web/src/components/replies/`; `ReplySection.tsx` flattens the nested API tree into `PlayscriptEntry[]`.

- **Step-in**: thread container indented 32px once (`ml-8`) from the parent's content column — the only indentation in the system.
- **Rhythm**: 32px (`space-y-[32px]`).
- **Speaker line**: mono-caps 11px. `TrustPip` · bold Jost name · colon. Own replies read `YOU:` with no pip (the asymmetric 16px left-jog is deliberate). Non-adjacent parent: prefix `→ PARENT:` in `grey-400` + 16px gap, then `NAME:`.
- **Dialogue line**: Jost 14.5px (`text-[14.5px]`), `leading-[1.55]`, black, at `mt-1`.
- **Vote count**: `VoteControls` pinned top-right, aligned to the first dialogue line.
- **Action row**: `time · REPLY · DELETE · REPORT`, mono-caps 11px `text-grey-400`, revealed on hover/focus (optional `#fafaf7` tint).
- **Pagination**: first 10 entries + `SHOW N MORE REPLIES` (mono-caps, grey-400, underline on hover).
- **Workspace focal node + parents-above**: an expanded conversation reads strictly top-down — focal in the middle, **ancestor chain above** (one flat `ml-8` indent, never a deepening cascade), descendants below. No separate pinned card or duplicated byline. **Clicking any ancestor/reply re-roots in place** (repeatable); **clicking an external quote tile re-roots onto the quoted post** (gateway mints a context-only `feed_items` twin on demand) — the same click on a **collapsed feed card** expands the quoted post directly as the focal of a fresh conversation, distinct from a body click that expands the host (UNIVERSAL-POST-ADR, 2026-06-14); **clicking the focal collapses the card**; `↑ Full conversation` returns to the opened item. **Rich focal, light context** (native + external): the focal always renders its full rich body (content, media, action row) — including after re-rooting; ancestors/replies render as lightweight playscript. **No left bar is ever drawn on a focal node.** Native re-roots from the in-memory tree (`renderFocalNode`); external re-roots fetch full data via the thread endpoint's `focus` field. Byline routing as in the feed chassis. Wiring (`ConversationView`/`useConversation`; `ExternalAncestorRail`/`useExternalThread`) and full behaviour: `docs/adr/CARD-BEHAVIOUR-ADR.md` addendum (2026-05-30).

## Key docs

**Charter & principles**
- `PRINCIPLES.md` — strategic charter; every feature is answerable to it.
- `docs/adr/REDESIGN-SCOPE.md` — product thesis (note: its anti-workspace stance is reversed; the principles stand).

**Live specs (source of truth for behaviour)**
- `docs/adr/UNIVERSAL-POST-ADR.md` — unified **Post** model, feed assembly/ordering, single thread engine, full-view matrix. The workspace's only card path (`web/src/components/post/`, `GET /workspace/feeds/:id/items` + `GET /thread/:postId` projector; reader pane = `useReader` + `ReaderOverlay`). The legacy reach-dial `GET /feed/:feedId` (post-feed.ts) was retired with the feed-derived-subscriptions change. Supersedes node-identity + thread-rendering portions of UNIVERSAL-FEED-ADR and CARD-BEHAVIOUR-ADR. Scoped to the workspace; standalone `/feed` + `/source/[id]` left for later.
- `docs/adr/UNIVERSAL-FEED-ADR.md` — universal social reader (external feeds, resolver, outbound posting, adapters, schema).
- `docs/adr/CARD-BEHAVIOUR-ADR.md` — card interaction model. Largely superseded by UNIVERSAL-POST-ADR; the 2026-05-30 addendum is still current.
- `docs/adr/WORKSPACE-FULL-VIEW-SPEC.md` — workspace full view (fidelity, threads, reader pane, warnings, polls, video, pull-to-refresh). `reply_group` + inline parent-context-tile removed by **one post per card**; feed is cursor-paged infinite scroll, ≤1 conversation expanded.
- `docs/adr/ALLHAUS-OMNIBUS.md` — trust graph (Layer 1/2/4, Phase A/B anonymity).
- `WORKSPACE-DESIGN-SPEC.md`, `WIREFRAME-DECISIONS-CONSOLIDATED.md`, `CARDS-AND-PIP-PANEL-HANDOFF.md` — workspace UX semantics, committed wireframe decisions, card/pip grammar.
- `docs/adr/` — other active ADRs: publications, email-on-publish, traffology, gateway-decomposition, code-quality, nostr-outbound-interop, relay-outbox (+ phase 4), UI-DESIGN-SPEC, glasshouse-and-palette (overlay separation, disc integrity, palette-control retirement), feed-scheme-refresh (the `anil`/`vela`/`caju` scheme family + quoted-embed-on-walls).

**Trackers (live, outstanding work)**
- `feature-debt.md` — consolidated feature debt, outstanding work, attack order.
- `FEED-INGEST-ATTACK-PLAN.md` — omnivorous ingestion roadmap (slices 0–9; 0–3 + 9 shipped, 4–8 gated/deferred).
- `docs/audits/` — `FIX-PROGRAMME.md` (master work log), `AUDIT-BACKLOG.md`, `ADR-CONFORMANCE-2026-05.md`, `SCHEMA-REFERENCE-2026-05.md`, `SUBSCRIPTIONS-GAP-ANALYSIS.md`, `FEED-INGEST-HYDRATION-PLAN.md`, `all-haus-frontend-audit.md`.

**Operations & reference**
- `DEPLOYMENT.md` — production deployment guide.
- `schema.sql` — full PostgreSQL schema (source of truth for DB structure).
- `planning-archive/ARCHIVE-INDEX.md` — **single ledger of every retired/shipped/superseded doc** (what it was, status, what replaced it). Start here before opening anything in `planning-archive/`.
