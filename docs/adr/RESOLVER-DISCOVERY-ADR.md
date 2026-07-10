# ADR — Resolver discovery expansion: known-world index, fediverse account search, bridge-aware merge

**Date:** 2026-07-10 (design conversation 2026-07-09; build-time verification amendments 2026-07-10)
**Status:** Accepted — phased; Phase 0 shipped 2026-07-10 (`gateway/tests/resolver-orchestration.test.ts` + the `nostr-search.ts` extraction + structural per-chain isolation `safeChain`); Phase 1 shipped 2026-07-10 (migration 150 + `searchKnownWorld` in Phase A, both trigger sites, twin-dedupe/cap/min-length per §4.2, 8 harness tests); Phase 2 shipped 2026-07-10 (`ap-account-search.ts` provider interface + Mastodon v1 provider + `activitypub_discovery` chain + the §5.2 addSource acct handling via `resolveApSourceUri`, 21 new tests + harness extensions); Phase 3 shipped 2026-07-10 (bridge helpers → `shared/lib/bridge-identity.ts`, `resolver-merge.ts::mergeMatches` on every result write, NIP-48 tag retention, §6.2 ordering, §6.4 Matches/Suggestions rendering on all three surfaces — discharges audit F3 + F5.4); Phase 4 shipped 2026-07-10 (`scripts/gen-discovery-catalog.ts` + `discovery-catalog.generated.ts`, 500 probed-live entries merged under the curated head — discharges audit F7). **All built phases complete**; remaining items (§7.2 branch 4, §5.1 FASP provider) are deferred behind their stated triggers
**Extends:** `UNIVERSAL-FEED-ADR.md` §V.5.8 (discovery fallback, branches 1–3 shipped 2026-06-08)
**Companion audit:** `docs/audits/RESOLVER-SOURCE-INPUT-AUDIT-2026-07-09.md` (queue: CONSOLIDATED-TODO §0b)
**Audit findings this ADR discharges when built:** F3 (confidence never rendered), F5.4 (context priority ordering), F7 (discovery reach / catalog vs branch 4), plus the F8 orchestration-test prerequisite as Phase 0.
**Post-ship review (2026-07-10, same day):** a five-agent review of the shipped phases found six bugs (all fixed — see FIX-PROGRAMME 2026-07-10 "post-ship review") and drove two owner-decided amendments now reflected in the sections below: the **§8.3 author-deletion tombstone** (migration 151 — the original "honour deletes" claim covered items, not the authors the known-world index surfaces) and the **§4.3 squatter amendment** (an exact native username hit no longer suppresses the external world in subscribe context). Remaining open findings queued in CONSOLIDATED-TODO §0b.

---

## 1. Problem

The discovery fallback (§V.5.8) turns a name into pickable external candidates. Three of four branches shipped (curated catalog, Bluesky `searchActors`, Nostr NIP-50); the audit found the remaining gaps: the catalog is 11 entries, branch 4 (web-search bridge) is unbuilt, **ActivityPub has no discovery branch at all**, confidence tiers are computed but never rendered, matches return in insertion order, and `free_text` Phase A is blind even to the external identities the platform has *already ingested*. Meanwhile the off-the-shelf landscape shifted (see §2), so the "buy vs build" answer changes shape.

## 2. Landscape survey (2026-07-09) — what we can and cannot buy

Recorded here so it isn't re-litigated. Re-check dates before relying on any row.

### 2.1 Ruled out

- **Feedly `v3/search/feeds`** — the obvious name→feed index, but its [API ToS](https://developers.feedly.com/reference/feedly-api-terms-of-service) disqualify us on four independent clauses: **D.2** applications "agree to not compete" with Feedly search and must display results verbatim including sponsored entries; **D.3** business applications must require each end-user to hold a Feedly Pro/Team account (we'd be one server-side integration); **D.4** search is limited to 20 req/user/hour where "user" = Feedly user (one service token = instant breach); **D.1** no mass import/export (also kills catalog-seeding from their index). The API exists for client apps extending Feedly for Feedly's users; all.haus is precisely the competing reader the terms protect against. Enterprise licensing would be a sales negotiation — do not stake a core UX seam on it.
- **feedsearch.dev / `feedsearch-crawler`** — URL→feed autodiscovery, which we already have in-house (audited sound, TS-native, SSRF-hardened). Not name→feed; no gap filled.
- **feedle.world** — name→feed for indie blogs/podcasts but no stable public API; indie-scale index.

### 2.2 Confirmed available, per protocol

- **AT Protocol — solved.** `app.bsky.actor.searchActors` (shipped, branch 2) and `app.bsky.actor.searchActorsTypeahead` are both public, no-auth, on `https://public.api.bsky.app` (AppView adds caching). Typeahead's `q` is a **prefix**, tuned for per-keystroke latency; `searchActors` has broader criteria (recall over precision). Since our discovery is **submit-only by invariant** (§V.5.8 guardrails), `searchActors` remains the correct endpoint; typeahead only matters if submit-only is ever relaxed (don't). Core atproto specs entered IETF standardisation January 2026 — this surface is stabilising, not churning.
- **ActivityPub / Mastodon — newly free.** Since Mastodon 4.0.0, `GET /api/v2/search` **no longer requires a user token**; without one you lose `resolve` (webfinger fetch of unknown remote accounts) and `offset`. So unauthenticated fuzzy account search against large instances works today. `GET /api/v1/accounts/lookup` returns only accounts the instance already knows (no webfinger) — cheap exact-handle path, not needed by us (our exact chain already webfingers). The `resolve` limitation costs us nothing: discovery **nominates**, and a picked candidate re-enters `resolveActivityPubHandle` (resolver.ts ~1350) which does the exact webfinger resolution anyway.
- **FASP / Fediscovery — watch, don't depend.** Mastodon gGmbH + EU NGI Search are specifying pluggable discovery providers (open specs + reference implementation "fediscoverer", mid-2025), including an **`account_search`** spec — exactly the missing fediverse directory layer. Providers index only public content with explicit opt-in to discovery. But adoption is nascent and the politics are live: **Holos Discover, a consent-respecting fediverse search engine, shut down early 2026 under community pressure despite indexing only opted-in accounts.** Consequence for us: (a) build the AP leg behind a provider interface so a production-quality FASP provider can slot in later; (b) inherit the consent posture — see §8.
- **Nostr — unchanged, alive.** NIP-50 remains best-effort per relay (some implement it as case-insensitive exact match, flagged experimental); `relay.nostr.band` is still the search relay of record (open access verified January 2026). Treat results as a **candidate pool, not a ranking** — which our cap+dedupe already does. Restrict to `kinds:[0]` (already done).
- **Cross-protocol — still nobody's product.** No universal fuzzy handle resolver exists. The adjacent art is **bridges**, not search: Bridgy Fed (AP↔atproto), Mostr (Nostr↔AP). Relevance to us is **dedup at the merge step** (§6): the same person's bridged mirror and native identity must not both appear as candidates. NIP-48 defines the `proxy` tag marking bridged Nostr events; host patterns identify the rest (`bsky.brid.gy`, `mostr.pub`, `*.ap.brid.gy`). We already ship exactly this detection in Slice 8 (`feed-ingest/src/tasks/identity-link-detect.ts`, link_type `bridge`, confidence 0.95) — it needs relocating, not inventing.
- **Generic web-search APIs (branch 4's dependency)** — Bing retired August 2025. Brave ≈ $5/1k queries with $5/mo credit; Serper/Tavily/Kagi are alternatives. Fine for a submit-only, flag-gated path (tiny volume). Deferred, not ruled out (§7.2).
- **Catalog seed data** — Wikidata is CC0 and holds publication names, multilingual aliases, and `P1019` (web feed URL); large permissively-licensed community OPML collections exist on GitHub. This is the "template" path for F7's cheap middle: generate, don't curate (§7.1).

## 3. Decision — architecture

**Shape unchanged**: parallel fan-out with incremental `storeAsyncResult` persistence, nomination-not-resolution, submit-only, context-gated, capped. Two new branches, two upgrades, one smarter merge:

| # | Branch | Phase | Status → target |
|---|--------|-------|-----------------|
| 3 | Curated catalog (`catalog_discovery`) | A-adjacent (sync, first) | Shipped · **grow via generated seed** (§7.1) |
| 1 | Bluesky `searchActors` (`bluesky_discovery`) | B | Shipped · keep as-is |
| 2 | Nostr NIP-50 (`nostr_discovery`) | B | Shipped · **retain event `tags`** for NIP-48 (§6.2) |
| **5** | **Known-world index** (local pg_trgm over ingested identities) | **A (sync)** | **New** (§4) |
| **6** | **ActivityPub account search** (`activitypub_discovery`) | **B** | **New**, behind provider interface (§5) |
| 4 | Web-search → URL bridge | B | Deferred behind flag; spec pinned (§7.2) |

Plus: **merge step** gains bridge dedup, confidence-tier ordering, and per-context priority (§6); **frontend** renders the tiers (§6.4). The F8 orchestration test harness is Phase 0 — a hard prerequisite, since every item below is surgery on `resolve()`/`resolveAsync()` (also the prerequisite for the `resolver.ts` decomposition queued in CONSOLIDATED-TODO §8.5).

## 4. Branch 5 — known-world index (Phase A, synchronous)

**Why first:** highest hit-rate per cost. A half-remembered name is very often someone *somebody on the platform already follows* — those identities sit in `external_authors` (minted by the ingest identity trigger) and `external_sources` (minted by every add), and `searchPlatform` (resolver.ts:1459) today searches only `accounts`. The user-notes architecture called this "local pg_trgm cache with write-back"; the write-back half already happens for free on every add/ingest. Zero network I/O, so it runs in **Phase A** next to `searchPlatform` — instant results even before any Phase B chain fires.

### 4.1 Migration (150)

```sql
-- 150_discovery_known_world_trgm.sql
-- pg_trgm is already installed (search). GIN trigram indexes for the
-- known-world discovery branch (RESOLVER-DISCOVERY-ADR §4).
CREATE INDEX idx_external_authors_display_name_trgm
  ON external_authors USING gin (display_name gin_trgm_ops);
CREATE INDEX idx_external_authors_handle_trgm
  ON external_authors USING gin (handle gin_trgm_ops);
CREATE INDEX idx_external_sources_display_name_trgm
  ON external_sources USING gin (display_name gin_trgm_ops);
CREATE INDEX idx_external_sources_handle_trgm
  ON external_sources USING gin (handle gin_trgm_ops);
```

Follow the full schema discipline: regenerate `schema.sql` via pg_dump from a fully-migrated throwaway, re-append the `_migrations` seed in the same step, run `scripts/check-schema-drift.sh`.

### 4.2 Query + mapping

New `searchKnownWorld(query, limit=5)` in the resolver (or the post-decomposition module), called from the `free_text` case (resolver.ts ~360) and the no-exact-hit `platform_username` branch, **gated on `!skipExternal`** (invite/dm are native-only; the existing `skipExternal` derivation applies unchanged). Sketch:

```sql
SELECT protocol, stable_handle AS identity, display_name, handle, avatar, 'author' AS kind,
       GREATEST(similarity(display_name, $1), similarity(handle, $1)) AS score
FROM external_authors
WHERE display_name % $1 OR handle % $1
UNION ALL
SELECT protocol, source_uri AS identity, display_name, handle, avatar_url, 'source',
       GREATEST(similarity(display_name, $1), similarity(handle, $1))
FROM external_sources
WHERE (display_name % $1 OR handle % $1)
  AND is_active AND orphaned_at IS NULL
ORDER BY score DESC
LIMIT 10;   -- over-fetch, then dedupe by (protocol, canonical identity) → cap 5
```

- Results map to `ResolverMatch.externalSource` (`{protocol, sourceUri, displayName, avatar}`) with **`confidence: 'probable'`** — these are verified-real identities we hold, stronger than a remote speculative guess, weaker than an exact identifier.
- **Identity mapping (verified 2026-07-10):** for `external_sources`, `source_uri` re-enters `addSource` directly. For `external_authors`, the canonical identity is `stable_handle` (minted by the identity trigger from `author_uri`): nostr = hex pubkey, atproto = DID, and **activitypub = the actor URI** (schema.sql identity trigger; the `user@domain` acct rides the separate `handle` column) — all three re-enter `addSource` verbatim, no normalisation layer needed (the AP branch validates an https URL, which the actor URI is). An author row and a source row for the same identity dedupe to one match on `(protocol, stable_handle = source_uri)` — the same equivalence `identity-link-detect.ts` already joins on (prefer the source row — it carries subscription metadata). The source leg of the query must also filter `protocol IN ('rss','nostr_external','atproto','activitypub')`: email-protocol sources exist and are not addSource-able.
- **Exclusions:** orphaned/inactive sources excluded (query above). Shadow sources (`is_active = FALSE` profile-hydration anchors, EXTERNAL-AUTHOR-HISTORY-ADR) are therefore excluded as *sources* — but their **authors** still surface via `external_authors`, which is the correct semantics (the identity is real; the source row is plumbing). Bridge mirrors are *not* excluded here; the merge step collapses them (§6.1).
- **Minimum query length 3** after trim — single/double-character trigram scans are noise and an enumeration surface (§8).
- Tier note: `external_authors` is tier-A/B only by CHECK constraint, so every hit has a real identity; no tier-C/D placeholder-byline risk.
- **Deletion tombstone (§8.3, migration 151):** both legs exclude tombstoned authors — the author leg on `deleted_at IS NULL`, the source leg via a `NOT EXISTS` against a deleted author twin (a deleted author's source row must not resurface them).

### 4.3 Squatter amendment (2026-07-10, post-ship review)

As originally specced, `searchKnownWorld` + discovery ran only on the **no-exact-hit** `platform_username` branch — so a native account squatting a publication name ("guardian") permanently shadowed the external world for that name. Amended: in **subscribe context only**, an exact native hit runs known-world + discovery **alongside** it (the exact hit still ranks first — exact > probable > speculative); `invite`/`dm`/`general` keep the short-circuit, and fuzzy native search stays suppressed by an exact hit in all contexts. Pinned by the orchestration harness.

## 5. Branch 6 — `activitypub_discovery` (Phase B, behind a provider interface)

### 5.1 Provider interface — the FASP hedge

```ts
// gateway/src/lib/ap-account-search.ts
export interface ApAccountCandidate {
  acct: string;          // canonical user@domain (always domain-qualified — see 5.2)
  displayName?: string;
  avatar?: string;
  note?: string;         // plain-texted bio excerpt
  url?: string;          // actor/profile URL
}
export interface ApAccountSearchProvider {
  readonly id: string;   // 'mastodon_instances' | 'fasp' | …
  search(query: string, limit: number): Promise<ApAccountCandidate[]>;
}
```

`resolveAsync` registers the chain against the interface, provider chosen by config. v1 ships `MastodonInstanceSearchProvider`; a future `FaspAccountSearchProvider` (Fediscovery `account_search` spec) slots in with **no resolver changes** once a production-quality provider exists. Adoption bar for FASP: spec stable, ≥1 provider with meaningful index coverage, and the consent story settled enough that consuming it isn't reputational risk (Holos precedent).

### 5.2 v1: Mastodon instance search

- `GET https://<instance>/api/v2/search?q=<query>&type=accounts&limit=5` — **unauthenticated** (Mastodon ≥ 4.0), no `resolve` (deliberate — nomination-not-resolution makes it unnecessary; webfinger happens once, at pick time — see next bullet).
- **Pick-path correction (2026-07-10, decided):** the original draft claimed a picked candidate "re-enters `resolveActivityPubHandle`" — false: picks flow `handleAdd → addSource(feedId, opt.add)` directly (`FeedComposer.tsx`/`VesselBar.tsx`), never back through the resolver, and `addSource`'s AP branch requires an https actor URI, so an acct-shaped `sourceUri` would 404 on every pick. **Decision: `addSource` gains acct handling** — an AP `sourceUri` that fails URL-parse but matches the acct shape is webfingered to the actor URI (before the transaction; webfinger failure → the existing 404), reusing `resolveWebFinger`. This keeps the frontend dumb, makes every AP add path acct-tolerant (omnivorous-input rule), and is a down-payment on audit F1 (addSource liveness). Ships with Phase 2.
- Instances from env **`MASTODON_DISCOVERY_INSTANCES`** (comma-separated hosts, default `mastodon.social`; one or at most two — each is a full extra HTTP round-trip per discovery submit). Queried concurrently via `Promise.all`, **each instance fail-soft to `[]`** (per-branch isolation, same as every other chain).
- All fetches via `safeFetch` (SSRF invariant), 5s timeout per instance, standard size cap.
- **Canonicalise `acct`**: Mastodon returns `acct` *without* a domain for accounts local to the queried instance — append the instance host so every candidate is `user@domain`. Dedupe across instances by lowercased canonical acct.
- Map to `ResolverMatch.externalSource` `{protocol:'activitypub', sourceUri: <canonical acct>, displayName, avatar, description: note}` with `confidence:'speculative'`. Dedupe against Phase A known-world hits by canonical identity (known-world wins — it's `probable`).
- **Good-citizen guards:** unauthenticated search on big instances is IP-rate-limited (default ~300 req/5 min); our submit-only volume is far below that, but add (a) a small per-instance in-process LRU memo (5-min TTL, keyed on normalised query — mirrors the existing well-known-RSS memo pattern, resolver.ts) and (b) a per-instance concurrency of 1. If an instance returns 429/5xx, fail soft and let the memo suppress immediate retries.
- Register in `pendingResolutions` as `'activitypub_discovery'` from the same two trigger sites as the existing discovery chains (resolver.ts ~365–371 and the `platform_username` no-exact-hit branch), gated identically (`discover && !skipExternal`).

## 6. Merge step — bridge dedup, ordering, rendered tiers

### 6.1 Bridge dedup (cross-protocol duplicate candidates)

The same person must not appear as both their native identity and a bridge mirror (Bridgy Fed: AP↔atproto; Mostr: Nostr→AP). Detection **already exists** in `feed-ingest/src/tasks/identity-link-detect.ts` (Slice 8 P3): host constants (`bsky.brid.gy`, `mostr.pub`, `*.ap.brid.gy`, `brid.gy`, `web.brid.gy`, `ap.brid.gy`), `decodeApBridgeHandle` (fediverse→Bluesky handle → `user@instance`), `bridgeIdentityKeys` (mirror → original identity keys in the bridged-from network's key-space), `npubToHex`.

- **Relocate the pure helpers to `shared/src/lib/bridge-identity.ts`** (gateway cannot import from feed-ingest; `shared/` is the cross-service home). `identity-link-detect.ts` re-imports from shared — behaviour-identical, its existing tests keep passing and pin the move.
- **Merge rule:** compute each candidate's identity key(s); where a bridge mirror's decoded origin key collides with a native-protocol candidate in the same merged result set, **drop the mirror, keep the native**. A mirror with no native twin present survives (it's still a valid way to follow that person) — annotate rather than suppress if we later want a "bridged" chip.
- **NIP-48:** `searchNostrProfiles` (resolver.ts ~1142, ~1190) currently keeps only `content`/`created_at` — also retain `tags`; a kind-0 carrying `["proxy", <origin-id>, <protocol>]` is a bridged mirror whose origin key joins the collision set. Best-effort (not all bridged profiles carry it); host patterns are the primary signal.

### 6.2 Ordering (discharges audit F5.4)

Matches currently return in insertion order. Sort the merged list by, in order:

1. **Confidence rank**: `exact` > `probable` > `speculative`.
2. **Context priority** (ADR §V.5.3, never implemented): `invite`/`dm` → native before external (mostly moot — `skipExternal` already filters, but Phase A can still mix); `subscribe` → external/known-world before native; `general` → neutral (confidence rank only).
3. **Branch precision** within a tier (stable tie-break): known-world > catalog > Bluesky > AP > Nostr > web-search — precise/verified sources first.

Pure function over the merged list — prime unit-test material for the Phase 0 harness.

*Post-ship fix (2026-07-10):* the alias-dedupe key for a catalog `rss_feed` nomination is `rss:<url>` — the **same key-space** as a known-world `external_source(protocol: rss)` hit, so the same feed reached through both shapes collapses to one candidate (the probable known-world hit wins). The original `rssfeed:`/`rss:` split rendered head-catalog feeds twice, once per section.

### 6.3 Where the merge lives

`resolveAsync` currently appends per-chain results incrementally via `storeAsyncResult`. Keep incremental persistence (partial results are load-bearing UX) but make each `storeAsyncResult` write pass through one `mergeMatches(existing, incoming, context)` that dedupes (per-protocol key-space + cross-protocol bridge keys) and re-sorts (§6.2). One function, one test surface.

### 6.4 Rendered tiers (discharges audit F3)

`web/src/lib/workspace/resolve.ts` already carries `confidence` onto `MatchOption`; no consumer renders it. Split the match well in the three `useResolverInput` surfaces (FeedComposer, VesselBar, IdentityLinkControl — audit refs L127/L28/L54) into two sections: **“Matches”** (`exact` + `probable`) and **“Suggestions”** (`speculative`). Partition once in `resolveMatches` (`web/src/lib/workspace/resolve.ts`) so the consumers just render two filtered maps; IdentityLinkControl partitions *after* its `linkable` filter. Section-header styling follows each surface's contrast regime (2026-07-10 verification): `.label-ui text-grey-600` only on the Glasshouse surface (IdentityLinkControl, which already uses it); FeedComposer uses its `TOKENS.hintFg` vocabulary; VesselBar derives from the vessel `palette.*` (palette-aware rule — a hard-coded grey is a dark-mode regression there). No per-item badge in v1 — the section split is the whole first slice. Persisting confidence onto `external_sources` remains explicitly **out of scope** (unchanged from the audit's note).

## 7. Catalog growth + deferred branch 4

### 7.1 Catalog: generate, don't curate (F7 resolution, near half)

Grow `PUBLICATION_CATALOG` from 11 to ~300–500 entries via an **offline generation script**, keeping the branch's zero-I/O instant-synchronous property:

- `scripts/gen-discovery-catalog.ts`: pulls candidates from (a) **Wikidata** — SPARQL for entities holding `P1019` (web feed URL), restricted to news/media/blog classes, taking labels + multilingual aliases (CC0, no licensing question); (b) curated community **OPML collections** (check each repo's licence before ingesting; prefer MIT/CC).
- **Probe every candidate feed at generation time** (fetch + real rss-parser confirm, the same bar as the runtime cascade) — dead feeds never enter the catalog. Runtime behaviour is unchanged: a stale URL is non-fatal by design (nomination re-enters the exact chain), but don't ship known-dead seeds.
- Emit `gateway/src/lib/discovery-catalog.generated.ts` (marked generated, never hand-edited) merged at load with the hand-curated head entries, which keep priority. Dedupe by feed host.
- Alias hygiene: lowercase, strip diacritics to match `searchCatalog`'s substring-both-directions matching; drop aliases shorter than 3 chars (they'd match everything).
- **Perf ceiling:** the current in-memory linear scan is fine to ~5k entries; beyond that, move the catalog into a DB table under the same trgm indexes as §4. Not expected to be needed.
- *Post-ship fixes (2026-07-10):* (a) the **alias-in-query** match direction requires ≥5-char aliases on word boundaries (`aliasInQuery`) — unbounded `q.includes(a)` let short generic aliases ("thor" in "thorough", "paid") hijack long queries and, via §6.2 branch precision, outrank every network candidate; query-in-alias stays an unbounded substring. (b) The **multi-tenant feed-host set** lives in `discovery-catalog.ts` (the script imports it back) and `mergeCatalogs`' head-collision check dedupes those hosts by full URL — host-level would let one curated feedburner/megaphone entry silently delete every generated tenant on that host at load.

### 7.2 Branch 4 (web-search bridge): deferred, spec pinned

Unchanged in shape from §V.5.8 and back to being the right long-tail design now Feedly is ruled out. When justified: flag **`DISCOVERY_WEBSEARCH_ENABLED`** (default off) + `DISCOVERY_WEBSEARCH_API_KEY`; vendor Brave Search (or equivalent — re-survey at build time); query → top ~5 result URLs → existing `resolveUrl` RSS-autodiscovery cascade concurrently (all `safeFetch`); candidates `speculative`; total branch budget ~8s so it never holds the merged result hostage (incremental persistence already renders the cheap branches first). Build trigger: real users hitting "no results" on the grown catalog + the four search branches — instrument the zero-result rate before spending the API key.

## 8. Consent & privacy invariants (rules, not orientation)

The fediverse's indexing politics are live and unforgiving — Holos Discover died in early 2026 doing consent-respecting search *politely*. These are invariants for everything in this ADR:

1. **No browsable directory, ever.** The known-world index (§4) is reachable only as ranked candidates for a specific typed query (min length 3, capped at 5, per-request); no endpoint enumerates, pages, or dumps external identities. Nothing in this ADR ships a "directory of fediverse users" surface.
2. **Resolution-cache semantics only.** AP search results live solely in `resolver_async_results` (60s TTL, initiator-scoped, pruned) — never persisted as profiles. A real `external_sources`/`external_authors` row is minted only by the existing authoritative path (pick → exact resolve → `addSource`). The local index adds **no new data collection** — it reads rows ingest already holds for feed delivery, the same caching every Mastodon instance performs.
3. **Honour deletes — at the AUTHOR level, because authors are what the index surfaces.** *(Rewritten 2026-07-10 — the original claim ("ingest already applies kind-5 tombstones and AP Deletes; the index inherits that") covered **items** only: no code path ever deleted an `external_authors` row, and AP Deletes aren't even seen by read-only outbox polling — a deleted account stayed a "probable" candidate forever.)* Now: `external_authors.deleted_at` (migration 151) is stamped by the deletion signals each protocol's existing ingest path actually delivers — **ActivityPub**: HTTP 410 Gone on the actor/outbox fetch (the fediverse deletion tombstone; typed `ApFetchStatusError` in the adapter, and a 410 also deactivates the source immediately rather than burning the error budget); **Nostr**: a kind-0 with `deleted: true` riding the existing newest-wins metadata ratchet (stamps; a newer kind-0 without the flag clears — applied in both the poll task and the backfill, since the backfill advances the ratchet and would otherwise swallow the signal). `searchKnownWorld` excludes tombstoned authors on both legs (§4.2). **Deferred, tracked in §0b:** the atproto signal (Jetstream doesn't subscribe account events; `getProfile` error classification is brittle) and whether profile surfaces should also consume `deleted_at` (historical bylines still resolve today — a product call). Any future materialised variant must re-verify the whole property.
4. **Inherit, don't override, network consent policy.** Instance search (§5.2) returns what the instance's own policy allows; we add no scraping around it. A FASP provider is only adopted if its opt-in posture is settled (§5.1).
5. **Discovery stays submit-only and context-gated** (§V.5.8 guardrails) — per-keystroke external fan-out is banned; `invite`/`dm` never see external candidates.

## 9. Phasing, tests, acceptance

**Phase 0 — orchestration harness (prerequisite; audit F8). SHIPPED 2026-07-10.** Tests for `resolve()`/`resolveAsync()` before touching either: Phase A→B assembly; `discover`/`skipExternal`/context gating matrix (incl. "invite/dm never register discovery chains"); incremental partial persistence order (catalog lands before network branches); initiator scoping + missing-initiator fallback (Phase B skipped, Phase A returned); per-chain failure isolation (one chain throwing never fails the resolve). Mock the network chains at function seams — no live I/O in tests. This harness is also the safety net for the queued `resolver.ts` decomposition (CONSOLIDATED-TODO §8.5); do Phase 0 once, both work items ride it. *As built:* `gateway/tests/resolver-orchestration.test.ts` (15 tests over the public `resolve()`/`getAsyncResult()` surface, fake `resolver_async_results` + accounts store, chains mocked at module seams); the Nostr relay leaves (`searchNostrProfiles`/`fetchNostrProfile`/`parseNostrProfileContent`) extracted to `gateway/src/lib/nostr-search.ts` behaviour-identically — the first bite of the §8.5 decomposition, and the mockable seam the harness needed (the NIP-50 chain was in-file, unreachable by `vi.mock`); plus one deliberate hardening — `safeChain` in `resolveAsync` wraps every Phase B chain, making per-chain isolation structural (previously it relied on each leaf catching internally; a throwing chain aborted its siblings and stranded the row `pending` until TTL).

**Phase 1 — known-world index** (§4): migration 150 + schema regen + drift guard; `searchKnownWorld` + wiring into both trigger sites; unit tests (mapping, dedup vs source/author twins, exclusions, min-length). *Accept:* typing a followed external author's name into FeedComposer free-text returns them instantly, pre-Phase-B, as `probable`. **SHIPPED 2026-07-10.** *As built:* per §4.2 with both local searches in `Promise.all`; protocol filter applied to BOTH legs (the enum also holds `farcaster`/`matrix`/`telegram` — future-proofing beyond the email note); dedupe keeps the better-scored position while the source row's data supersedes an author twin in place; 8 tests on the Phase 0 harness. Frontend untouched — hits ride the existing `externalSource` match shape (tier rendering stays Phase 3).

**Phase 2 — `activitypub_discovery`** (§5): interface + Mastodon provider + env + memo/throttle; tests (acct canonicalisation incl. domainless-local-acct, per-instance fail-soft, dedupe, gating). *Accept:* "Guardian" surfaces `@guardian@mastodon.social`-shaped candidates on submit; an unreachable instance degrades to the other branches silently. **SHIPPED 2026-07-10.** *As built:* per §5.1–5.2 — `gateway/src/lib/ap-account-search.ts` (interface + `mastodon_instances` provider; `MASTODON_DISCOVERY_INSTANCES` env, docker-compose + DEPLOYMENT.md rows; per-(instance, query) 5-min LRU memo which also memos error/429 empties, per-instance concurrency 1, 5s timeout, min query length 3 mirroring §8); the provider carries `Account.uri` on `ApAccountCandidate.url` so `discoverActivityPub` dedupes against Phase A known-world hits on both key-spaces (acct + actor URI, known-world wins); the addSource acct handling landed as `resolveApSourceUri` in `activitypub-resolve.ts` (https actor URI passes through, acct webfingers pre-transaction, anything else → the existing 404), covered by 8 unit tests — *subsumed 2026-07-10 by audit F1's `source-liveness.ts::verifySourceLiveness`, which kept the acct→actor behaviour and added the liveness probe + 400/422 error split (FIX-PROGRAMME 2026-07-10)*; 13 provider tests + orchestration-harness extensions (gating matrix, isolation, known-world dedupe). Frontend untouched — candidates ride the existing `externalSource` shape (tier rendering stays Phase 3).

**Phase 3 — merge upgrade** (§6): bridge helpers → `shared/` (feed-ingest re-imports; its tests pin behaviour); `mergeMatches` with bridge-collision drop + §6.2 ordering; retain nostr `tags`; frontend Matches/Suggestions split. *Accept:* a person present as both native Bluesky and `bsky.brid.gy` mirror yields one candidate; speculative rows render under "Suggestions" on all three surfaces. **SHIPPED 2026-07-10.** *As built:* helpers relocated to `shared/src/lib/bridge-identity.ts` (structural `BridgeSourceLike` input — feed-ingest's `DetectSourceRow` passes unchanged; `identity-link-detect.ts` re-imports + re-exports, all 32 existing tests pin the move); the match-shape types moved to the new `gateway/src/lib/resolver-merge.ts` (second bite of §8.5) whose `mergeMatches(existing, incoming, context)` runs alias dedupe (AP acct ↔ actor URI cross-key included) → bridge-collision drop → §6.2 sort on EVERY match-set assembly in `resolve()`/`resolveAsync()`, replacing the raw pushes. Bridge keys come from per-branch identity hints added to `ResolverMatch` (additive wire fields, never rendered): `handle` (Bluesky discovery / atproto exact+probable / known-world / AP exact), `actorUrl` (AP discovery), `proxy` (NIP-48 tag lifted in `discoverNostr` from the now-retained `NostrCandidate.tags`) — so all three bridge directions plus the Mostr acct-only form collapse, and a NIP-48-proxied nostr mirror of a native AP actor drops too. One §6.2 refinement: branch-precision (rule 3) applies only within the *speculative* tier, where branch ≡ match shape (catalog→rss_feed, Bluesky→atproto, AP→activitypub, Nostr→nostr_external) — exact/probable get uniform precision so known-world trgm score order survives the stable sort, and no provenance field was needed. Frontend: `partitionMatchOptions` in `web/src/lib/workspace/resolve.ts`, exposed as `sections` on `useResolverInput`; "Matches"/"Suggestions" headers per surface regime (FeedComposer `TOKENS.hintFg`, VesselBar `palette.barTextMuted`, IdentityLinkControl `.label-ui text-grey-600` partitioned after its `linkable` filter); the Matches header renders only when both sections are present. Tests: 18-case pure suite `gateway/tests/resolver-merge.test.ts`, 3 harness extensions (bridge dedupe e2e, NIP-48 drop, final-row ordering), 4 web partition tests.

**Phase 4 — catalog generation** (§7.1): script + generated file + probe step. Independent of Phases 0–3; can run any time. *Accept:* catalog ≥300 probed-live entries; `searchCatalog` latency unchanged. **SHIPPED 2026-07-10.** *As built:* `scripts/gen-discovery-catalog.ts` per §7.1 — Wikidata-only for v1 (one SPARQL query per class: periodical/news website/blog/news agency/podcast, sitelink-ranked, ~1,000 distinct candidates; the OPML leg is built as an optional operator input `--opml` requiring per-file licence vetting, unused since Wikidata alone cleared the floor); probe = `safeFetch` + rss-parser confirm (the exact `tryRssFetch` bar), rank-ordered with early stop at the 500 target; emitted `discovery-catalog.generated.ts` committed like `schema.sql`. Two §7.1 refinements recorded: (1) host-dedupe carries a **multi-tenant feed-host exemption** (megaphone/libsyn/feedburner/… dedupe by full URL — pure host-dedupe would keep one podcast-platform tenant and silently drop the rest); (2) `searchCatalog` folds diacritics on the **query** side too (`foldDiacritics`), otherwise the generation-side folding would make accented queries miss their own entries. Merge-at-load = `mergeCatalogs` (curated head first and keeps priority; generated entries colliding with a head feed host dropped; generated-vs-generated dedup stays generation-time so the exemption survives). Acceptance floor enforced twice: the script exits 1 below 300, and a test pins ≥300 + per-entry alias hygiene.

**Deferred:** branch 4 (§7.2, behind flag, build-triggered by measured zero-result rate); FASP provider (§5.1, adoption bar).

Log each phase in FIX-PROGRAMME and amend CONSOLIDATED-TODO §0b per the tracker discipline.

## 10. Non-goals

- No per-keystroke external search (invariant, restated).
- No persistence of confidence onto `external_sources` (separate decision, deliberately unmade).
- No Feedly integration in any form (§2.1 — terms).
- No universal cross-protocol fuzzy resolver ambition beyond the fan-out — nobody's product, not becoming ours; we compose per-network primitives.
- No change to `addSource` liveness enforcement (audit F1) or source-lifecycle surfacing (F6) — adjacent, tracked separately in §0b.
