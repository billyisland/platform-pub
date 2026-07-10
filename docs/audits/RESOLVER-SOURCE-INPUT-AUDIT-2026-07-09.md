# Resolver & source-input audit — 2026-07-09

Three-agent audit of the source ingesting/resolving machinery: the universal resolver
(`POST /api/v1/resolve`, UNIVERSAL-FEED-ADR §V.5), the discovery-fallback suggestion
feature (§V.5.8), the frontend identity-input surfaces, and the `addSource` →
feed-ingest entry path. All file:line refs verified in source at the time of audit.

**Companion queue entry:** CONSOLIDATED-TODO §0b. When items ship, log in
FIX-PROGRAMME and amend both.

> **Resolution status (2026-07-10).** The discovery-expansion programme this audit
> triggered (`docs/adr/RESOLVER-DISCOVERY-ADR.md`, Phases 0–4 all shipped
> 2026-07-10) discharged **F8** (orchestration harness, Phase 0), **F3**
> (Matches/Suggestions tier rendering, Phase 3), **F5.4** (per-context priority
> ordering, Phase 3 `mergeMatches`), and **F7** (discovery reach: catalog grown to
> 500 generated probed-live entries, Phase 4; branch 4 stays deferred behind
> `DISCOVERY_WEBSEARCH_ENABLED` per its §7.2). Phase 2's addSource acct→webfinger
> handling is a down-payment on **F1**, not its discharge. **F2** discharged
> 2026-07-10 (nostr-model error accounting + re-throw in the atproto backfill's
> outer catch; `externalFetchMaxAttempts` gives it 5 subscribe-time attempts —
> FIX-PROGRAMME 2026-07-10). **F4** discharged 2026-07-10 (all three surfaces
> onto `useResolverInput`: picked-match actions replace the blind `results[0]`,
> the MembersTab stale race is closed — FIX-PROGRAMME 2026-07-10). Still open,
> tracked in CONSOLIDATED-TODO §0b: **F1** (addSource liveness),
> **F5** remainder (native-URL short-circuit, njump re-entry, AP actor probe, JSON
> Feed autodiscovery), **F6** (deactivated-source signal). Findings below are the
> frozen audit-time snapshot — file:line refs and the branch table predate the
> expansion.

---

## I. Where the suggestion feature stands

The "suggest sources from incomplete/fragmentary input" work is the **discovery
fallback** (ADR §V.5.8, design addendum 2026-06-08). Status: **branches 1–3 shipped
and wired end-to-end; branch 4 never started.**

| # | Branch | Status |
|---|--------|--------|
| 1 | Bluesky actor search (`app.bsky.actor.searchActors`) | Shipped. `gateway/src/lib/atproto-resolve.ts::searchActors`, `resolver.ts::discoverBluesky` (~596–623). Tested (`gateway/tests/atproto-discovery.test.ts`). |
| 2 | Nostr NIP-50 name search | Shipped. `resolver.ts::searchNostrProfiles` (~1118–1215) over SSRF-pinned WebSocket to `NOSTR_SEARCH_RELAY` (default `wss://relay.nostr.band`), 4s timeout, newest kind-0 per pubkey. |
| 3 | Curated publication catalog | Shipped but **11 entries only** (`gateway/src/lib/discovery-catalog.ts`: Guardian/BBC/NYT/NPR/Al Jazeera/Atlantic/Verge/Ars/Wired/TechCrunch/HN). A demo-scale head cover, not the head of the distribution. |
| 4 | Web-search → URL bridge (long-tail open web) | **Unbuilt.** No code, and the planned feature flag doesn't exist either. "Obscure blog findable only by name" returns nothing. |

The design invariants all held in implementation:

- **Submit-only**: `discover: boolean` (default false) threaded route → `resolve` →
  `resolveAsync`; the frontend sets it only in `useResolverInput.submit()` (Enter),
  never on the 300ms debounced keystroke path.
- **Context-gated**: `invite`/`dm` never discover (`skipExternal` gate).
- **Trigger**: only `free_text` or `platform_username`-with-no-exact-hit
  (`resolver.ts` ~241–247, ~365–371).
- **Nomination, not resolution**: candidates are `confidence:'speculative'`; picking
  one re-enters the exact chain / `addSource`, so a wrong guess is harmless. The
  single-authoritative-path-to-source-creation invariant is intact.
- Catalog resolves synchronously and persists first; Bluesky+Nostr run concurrently
  with incremental `storeAsyncResult` partial persistence.

---

## II. Verified sound (don't re-audit)

- **SSRF discipline**: every external HTTP fetch in resolver + adapters uses
  `safeFetch`; both WebSocket paths use `pinnedWebSocketOptions`. No raw fetch found.
  Timeouts everywhere (10s HTTP default; 5s NIP-05/rss-parser; 4s Nostr WS), 5MB cap,
  3-redirect max with per-hop re-validation.
- **Fail-soft isolation**: every protocol probe try/caught to null/[]; a dead branch
  never fails the resolve; Phase B is fire-and-forget with a seeded partial row so an
  early poll still returns Phase-A matches.
- **Classification** (`resolver.ts::classifyInput` ~163–200): deterministic ordered
  regex over 11 input types; custom-domain Bluesky handles deliberately fall to
  `dotted_host` which races atproto + URL/RSS probes concurrently. Well tested
  (`resolver-classify.test.ts`).
- **RSS autodiscovery cascade** (`resolveUrl` ~692–759): platform extractors →
  YouTube channel→Atom → Substack→/feed → direct parse (header **and** body sniff +
  real rss-parser confirm) → HTML `<link>` discovery → 7 well-known paths probed in
  parallel with per-origin 5-min memo cache (1000-entry cap).
- **Async plumbing**: `resolver_async_results` (migration 061) initiator-scoped, 60s
  TTL, 100-rows/initiator cap, pruned by `resolver-results-prune` task. Route rate
  limit 30/min, query ≤500 chars.
- **Frontend hook** (`web/src/hooks/useResolverInput.ts`): debounce, capped polling,
  and stale-request cancellation via `genRef` generation counter. Used identically by
  `FeedComposer` (L127), `VesselBar` (L28), `IdentityLinkControl` (L54).
- **addSource dedup/projection**: `(protocol, source_uri)` upsert revives orphaned
  sources; `external_subscriptions` projection + owner-scoped advisory lock
  (`feed_sub:<owner>`) per the feed-derived invariant; nostr backfill uses the
  distinct `feed_ingest_backfill_<id>` job key; `markFollowListDirty` wired.

---

## III. Findings (ranked)

### F1 — `addSource` has no liveness validation; the resolver is advisory (HIGH)

`gateway/src/routes/feeds/sources.ts:344-364`: the `(protocol, sourceUri)` branch
validates syntax only (URL parses + scheme; atproto `^did:(plc|web):…$`; nostr
64-hex). A well-formed dead RSS URL, nonexistent DID, or random hex pubkey gets
**201 Created** and a live subscription. All real verification (feed fetch/parse,
handle resolution, kind-0) lives in `/resolve`, which is on the write path only by
frontend convention — any direct API caller bypasses it. The failure then only
manifests as an asynchronously climbing `error_count`; the user is never told.

*Fix shape:* either (a) require a recent resolver result (pass the `requestId` /
re-resolve server-side before insert), or (b) a cheap synchronous liveness probe per
protocol at add time (HEAD/GET-parse for rss, `getProfile` for atproto, kind-0 for
nostr, actor fetch for AP) with a distinguishable 4xx on failure. Also split the
error space: malformed URI vs unresolvable target currently both collapse to
404 `"Source target not found"` (sources.ts:582-584).

### F2 — atproto backfill failure is a silent no-op; subscribe-time jobs never retry (HIGH)

- `feed-ingest/src/tasks/feed-ingest-atproto-backfill.ts:279-284`: the outer catch
  only logs — no `error_count` increment, no deactivation (unlike the RSS/AP/nostr
  tasks, which all do full error/backoff/deactivate accounting). A bad atproto source
  sits `is_active=TRUE, error_count=0`, producing nothing, looking healthy.
- All subscribe-time ingest jobs are enqueued `max_attempts := 1`
  (sources.ts:311,415). RSS/AP/nostr recover via the 60s poll scheduler, but atproto
  has **no poll fallback while Jetstream is healthy** — a failed first backfill means
  no history and no retry until the author happens to post.

*Fix shape:* give the atproto backfill catch the same error-accounting block as the
nostr backfill (`feed-ingest-nostr-backfill.ts:402-434` is the model); raise
`max_attempts` (or add a retry) at least for atproto.

### F3 — confidence is computed, carried, and never used (MEDIUM)

Backend ranks matches `exact | probable | speculative`; `web/src/lib/workspace/resolve.ts`
carries `confidence` onto `MatchOption`; **no consumer renders it** (grep across
`web/src/components` — zero UI hits). A speculative Bluesky guess is visually
identical to an exact NIP-05 hit in the FeedComposer/VesselBar dropdowns. It's also
never persisted (`external_sources` has no confidence column; `resolver_async_results`
TTL is 60s), so there's no "unverified source" notion downstream.

*Fix shape (cheap first slice):* render a tier marker / section split
("Matches" vs "Suggestions") in the match well — data already flows. Persisting
confidence on sources is a separate, optional decision.

### F4 — three surfaces still violate the omnivorous-input rule (MEDIUM)

Per CLAUDE.md and ADR §V.5.5 (the adoption table), stalled since Phase 1:

| Surface | File | State |
|---|---|---|
| DM new-conversation | `web/src/components/messages/MessagesInbox.tsx:168-186` | Username-only against `GET /api/v1/search?type=writers`, takes `results[0]` blind, `alert()` errors. Never calls the resolver (which already supports `context:'dm'` — no consumer exists). |
| DM fee override | `web/src/components/social/DmFeeSettings.tsx:99-113` | Same pattern, same gaps. |
| Publication invite | `web/src/components/dashboard/MembersTab.tsx:42-85` | Calls `resolver.resolve(value,'invite')` but via hand-rolled debounce with **no stale-request guard** (fast typing can land a stale match over a newer one — the race `useResolverInput`'s `genRef` exists to prevent); keeps only the first `native_account`; never polls Phase B. |

*Fix shape:* move all three onto `useResolverInput` (drop-in; contexts `dm`/`invite`
already gate externals server-side). Fixes the MembersTab race for free.

### F5 — resolver drift from its own spec (MEDIUM, batchable)

Missing vs ADR §V.5.2/§V.5.3 (in `resolveUrl` / `resolveAsync`):

1. No native `all.haus/...` URL short-circuit (step 1) — a native profile/pub URL
   isn't recognised.
2. No `njump.me` / `nostr.com` re-entry (step 2).
3. No generic ActivityPub actor probe (`Accept: application/activity+json`) on
   arbitrary URLs (step 4) — only known Mastodon/threadiverse path patterns resolve;
   a bare actor URL on an unknown instance falls through to RSS discovery and misses.
4. Context priority *ordering* (§V.5.3: native-first for invite/dm, external-first
   for subscribe) never implemented — only the binary `skipExternal` filter; matches
   return in insertion order.
5. `extractFeedLink` (`resolver.ts` ~830–847) is regex-over-HTML — brittle to
   attribute order, and misses JSON Feed autodiscovery
   (`application/feed+json`) even though the ingest adapter fully supports JSON Feed
   (`feed-ingest/src/adapters/rss.ts:355-438`).

### F6 — silent source lifecycle (MEDIUM, product call)

A source that hits the error threshold (default 10 failures with exponential
backoff) flips `is_active = FALSE` with **no user-facing signal** — it just stops
producing into the feed. There is no re-verification path other than manual re-add
(the upsert forces `is_active = TRUE`). There's also no pending/verified state at
all: a source that has never successfully fetched is indistinguishable from a
healthy one until errors accrue.

*Fix shape:* surface `is_active=FALSE` + `last_error` in the FeedComposer source
list (data is already on the row), and decide whether deactivation should notify.

### F7 — discovery reach (PRODUCT DECISION)

Branch 4 (web-search → URL bridge) vs growing the catalog. The catalog's 11 entries
cover a sliver of the head; branch 4 needs an external search API key + ranking
noise handling (the ADR deliberately flagged it feature-first, feature-flagged).
Cheap middle path: grow the catalog 10–20× (it's a zero-I/O seed table) and defer
branch 4 until the flag exists.

**Resolved 2026-07-10:** design accepted in `docs/adr/RESOLVER-DISCOVERY-ADR.md`
(known-world index, `activitypub_discovery` behind a FASP-ready provider interface,
bridge-aware merge + F3/F5.4 discharge, generated catalog, branch 4 deferred behind
a flag; Feedly ruled out on API-ToS grounds). F7 is now a build queue, not an open
decision.

### F8 — test coverage is leaf-only (LOW)

Well tested: `classifyInput`, catalog, `searchActors`, kind-0 parsing, AP URL
extraction, frontend `matchToOptions`. **Zero tests** for: `resolve()`/`resolveAsync()`
orchestration (Phase A→B assembly, `skipExternal`/`discover` gating, partial
persistence), `resolveUrl` and every network pathway (`tryRssFetch`,
`discoverRssFromHtml`, `tryWellKnownPaths`, `resolveNip05`, `resolveAtproto`,
`resolveActivityPubHandle`, `fetchNostrProfile`, `searchNostrProfiles`),
`storeAsyncResult`/`getAsyncResult` (initiator scoping, TTL, row cap), the route
handlers, and no end-to-end `POST /resolve` test. `http-client.ts` SSRF logic also
untested.

### Minor notes (batch with §7 cleanup if convenient)

- `graphile_worker.add_job` runs inside the addSource transaction while holding the
  per-owner advisory lock — a slow job insert serialises that owner's adds/removes.
- `GET /resolve/:requestId` has no dedicated rate limit (global only).
- No caching of atproto/AP/NIP-05 profile fetches (only well-known RSS paths cached)
  — each resolve re-fetches.
- `addSource` atproto branch accepts DIDs only (handles must pre-resolve) — correct
  by design, but the 404 message ("Source target not found") is misleading for a
  handle; fold into F1's error-space split.
- CONSOLIDATED-TODO §9.9 (email sources have no Follow affordance) is adjacent —
  `addSource` has no `email` protocol branch at all.

---

## IV. Suggested attack order

1. **F2** (atproto silent catch + retry) — small, closes a real data-loss hole.
2. **F3 first slice** (render confidence tiers) — cheapest visible win, data already
   flows to the client.
3. **F4** (DM ×2 + MembersTab onto `useResolverInput`) — closes the omnivory-rule
   violations and the stale-match race in one pass.
4. **F1** (addSource liveness/enforcement + error-space split) — the substantive
   server-side hardening; decide approach (a) vs (b) first.
5. **F5** as a batch (spec-drift items are independent and small; the AP actor probe
   is the most valuable).
6. **F7** decision (catalog growth now, branch 4 flag later) + **F6** product call.
7. **F8** opportunistically — at minimum an orchestration test for
   `resolve()`/`resolveAsync()` gating before touching the engine again (also a
   prerequisite for the `resolver.ts` decomposition already queued in
   CONSOLIDATED-TODO §8.5).
