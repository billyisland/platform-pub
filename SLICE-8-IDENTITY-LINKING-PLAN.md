# Slice 8 — Cross-source identity linking (implementation plan)

Re-based implementation plan for FEED-INGEST-ATTACK-PLAN.md § "Slice 8 —
Cross-source identity linking". The original slice spec predates two
architectural changes and must be reconciled before building:

1. **`external_authors` now exists** (migration 099) — the slice spec says
   *"No `external_authors` table yet. Identity linking works at the source
   level."* The table now exists with a `(protocol, stable_handle)` identity
   key and an unused lazy-claim `account_id` slot, and post aggregation is
   already centralised on `feed_items.external_author_id`.
2. **The Subscriptions page was retired** — the slice spec hangs its UI off
   `web/src/pages/subscriptions.tsx` and "subscription management UI". That
   page is gone; external subscriptions are feed-derived. The "Link to…"
   affordance moves to the external **author profile** surface.

This plan supersedes §8C/§8F of the original slice for those two points; §8A,
§8B, §8D, §8E stand.

## Codebase reconciliation (audit 2026-06-20)

Two assumptions in the draft don't match the current code; both are corrected in
the sections below, recorded here so the build doesn't re-trip them.

1. **The resolver does not persist a source.** `POST /api/resolve`
   (`gateway/src/routes/resolve.ts`, `gateway/src/lib/resolver.ts`) is a pure
   classifier — it returns `{ protocol, sourceUri, …metadata }` *matches* with
   **no `external_sources.id`** and writes nothing to `external_sources`. The
   link table FKs `external_sources(id)`, so "Link to…" is a **two-step**:
   resolve → then upsert via the existing `addSource` path
   (`gateway/src/routes/feeds/sources.ts:354`,
   `INSERT … ON CONFLICT (protocol, source_uri) … RETURNING id`). The
   `SourceFollowPicker` in `ProfileFollowControl.tsx` already does exactly this
   resolve-shape → `addSource` dance; model the Link wiring on it. See UI (P2).
2. **There is no stored author→source link.** The external author profile is
   keyed on `external_authors`; its backing `external_sources.id` is computed at
   query time from `(protocol, source_uri)` and surfaces as
   `followTarget.sourceId` (`gateway/src/routes/author.ts:168-190`,
   null when no source row exists yet). For a tier-A/B author shown in-feed that
   row always exists (the author was ingested through it), so it is a valid
   `source_a_id`. Tier-C/D RSS/email have no author profile, so they enter a
   link only as the **target** the user pastes in, or via P3 detection —
   consistent with the source-level grain.

Confirmed as-specced (no change needed): `sourceFilteredItems`'s `$1 = readerId`
(so the owner filter `owner_id IS NULL OR owner_id = $1` needs **no new query
param**); `external_items` is already joined in the `scored` CTE via
`fi.external_item_id` (`gateway/src/lib/feed-sql.ts:97`); `external_items` has
both `canonical_url` and `content_text`; `biddability_tier` lives on `feed_items`
(A/B/C/D); `pgcrypto`/`digest()` is enabled. The next free migration number is
**123** (122 is the highest in `migrations/`).

## Decisions locked

- **Link grain: source-level.** `external_identity_links` references
  `external_sources(id)`, per the original §8C — *not* author-level. Rationale:
  tier-C/D RSS/email rows have no `external_authors` record, and the slice's own
  examples make RSS one of the three cross-posted surfaces, so author-level
  linking can't represent them. Source-level also matches the grain of the
  dedup payoff (item/source-level content fingerprinting).
- **`external_authors.account_id` claim slot: deferred.** Wiring the lazy-claim
  slot belongs to the deferred "constructed external author profile pages" work
  (CARD-BEHAVIOUR-ADR §VI.3), not here.
- **Link ownership: owner-aware hybrid, keyed on provenance** (see below).
- **Fingerprint tiers: canonical-URL + text-hash only.** The §8D tier-2 rule
  (title + published_at ±5 min) is dropped from the hot path — it needs a range
  join, is the lowest-precision signal, and is the expensive one.

## Phasing

| Phase | Work | Effort | Status |
|---|---|---|---|
| **P1 — Dedup core** | link table migration + precomputed fingerprint + query-time dedup CTE in `sourceFilteredItems` + `ALSO ON` provenance | ~1 wk | **shipped 2026-06-20** |
| **P2 — User-asserted links** | "Link to…" / "Unlink" on the external author profile, resolver-backed; owner-scoped links only | ~3–4 days | not started |
| **P3 — Automated detection** | daily `identity_link_detect` task (bridge / cross-link / domain-match); introduces global links + the negative-override unlink | ~3 days | not started |

Total ≈ 2 weeks. No infrastructure gate — pure application logic.

### P1 — what shipped (2026-06-20)

- **Migration 123** (`123_identity_links_and_dedup_fingerprint.sql`):
  `external_identity_links` (ordered-pair `CHECK (source_a_id < source_b_id)`,
  partial unique indexes for the global vs owner-scoped cases, `link_type` CHECK
  carrying the full P2/P3 vocabulary incl. `user_unlinked`), plus
  `external_items.dedup_fingerprint` maintained by a `BEFORE INSERT/UPDATE`
  trigger (`external_items_set_fingerprint` → `external_items_compute_fingerprint`
  → `external_items_norm_text`) so every ingest adapter populates it for free; a
  one-time backfill seeds existing rows. `norm()` lower-cases, strips URLs,
  collapses whitespace, takes the first 200 chars; the fingerprint is the
  canonical URL else a sha256 of the normalised text, **only above a 32-char
  floor** (short/generic posts stay NULL → never deduped). `schema.sql`
  regenerated; `scripts/check-schema-drift.sh` green.
- **Dedup query** (`gateway/src/routes/feeds/items.ts::sourceFilteredItems`):
  `linked_sources` / `candidates` / `suppressed` CTEs + the `fi.id NOT IN
  suppressed` filter + the `also_on` provenance lateral (`source_protocol::text`
  so node-pg returns a real `string[]`). The `source_id IN linked_sources` guard
  keeps zero-link feeds at near-zero cost.
- **`alsoOn`** added to both Post shapes (`gateway/.../post-mapper.ts` +
  `web/src/lib/post/types.ts`) and rendered as a quiet `ALSO ON …` line in
  `web/src/components/post/PostOriginTag.tsx`.
- **Inert until P2.** No links exist yet, so the dedup CTEs return empty and the
  feed is unchanged — exactly the build-order intent below.
- **Not yet done in P1:** the `EXPLAIN ANALYZE` against a seeded large linked
  feed (Risks §), and the test matrix (winner selection / cross-page suppression
  / canonical-vs-hash grouping / zero-links fast path) — both deferred to land
  with P2 once real links make them exercisable.

> Build order note: P1 ships the dedup machinery but it stays inert until P2
> creates the first links. P1+P2 only ever produce owner-scoped links, so the
> owner model's negative-override wrinkle does not exist until P3 (see
> "Link ownership").

## Schema

```sql
-- P1
CREATE TABLE external_identity_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_a_id UUID NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  source_b_id UUID NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN (
    'user_asserted', 'bridge', 'cross_link', 'domain_match'
    -- P3 adds: 'user_unlinked' (owner-scoped negative override)
  )),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  owner_id UUID REFERENCES accounts(id) ON DELETE CASCADE,  -- NULL = global
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- normalise insertion order so source_a_id < source_b_id (avoids A/B vs B/A dupes)
CREATE UNIQUE INDEX uq_idlink_global ON external_identity_links(source_a_id, source_b_id)
  WHERE owner_id IS NULL;                                   -- one global link per pair
CREATE UNIQUE INDEX uq_idlink_owned  ON external_identity_links(source_a_id, source_b_id, owner_id)
  WHERE owner_id IS NOT NULL;                               -- one assertion per user per pair
CREATE INDEX idx_identity_links_source_a ON external_identity_links(source_a_id);
CREATE INDEX idx_identity_links_source_b ON external_identity_links(source_b_id);

-- P1 — precomputed dedup fingerprint on external_items
ALTER TABLE external_items ADD COLUMN dedup_fingerprint text;
--   populated at ingest + one backfill:
--   COALESCE(NULLIF(canonical_url,''),
--            'h:' || encode(digest(norm(content_text), 'sha256'), 'hex'))
--   norm() = lower, strip URLs, collapse whitespace, first 200 chars
CREATE INDEX idx_external_items_dedup_fp ON external_items(dedup_fingerprint);
```

Schema discipline: after the migrations, regenerate `schema.sql` via `pg_dump`
+ re-append the `_migrations` seed in one step, then run
`scripts/check-schema-drift.sh` (CI-enforced). Do not hand-edit `schema.sql`.

## Dedup design (P1)

### Why naïve dedup fails
The workspace feed (`gateway/src/routes/feeds/items.ts:178` `sourceFilteredItems`)
is keyset-paginated by `effective_score DESC, fi_id DESC`. Two cross-posted
copies have *different* `effective_score` (different source weights, micro-
different `published_at`, `random` sampling re-rolls per query), so they are not
adjacent — one copy can be on page 1, its twin on page 3. Window-function /
in-page dedup only sees the current page and leaks the duplicate.

### Approach: page-independent winner + global suppression over the candidate set
Pick the winner by a rule independent of the page and of `effective_score`, then
suppress losers across the feed's whole candidate set (`matched` materialises all
matches *before* the `LIMIT`).

**Winner rule (total order):**
```
rank = (tierPriority ASC, published_at ASC, source_id ASC, fi.id ASC)
       tierPriority: A→0  B→1  C→2  D→3      (highest biddability tier wins, §8D)
```

**Fingerprint:** precomputed `external_items.dedup_fingerprint` folds §8D tier-1
(canonical URL) and tier-3 (normalised text hash) into one equality key. Tier-2
(title + ±5 min) deferred. Scope: external items only — natives aren't
cross-posted through these sources.

### CTEs (added after the existing `matched` CTE)

The critical perf guard: **only linked sources can produce duplicates**, so
prefilter to them. Most feeds have zero links → the dedup CTEs are empty →
near-zero added cost. Dedup is free until someone links something.

```sql
linked_sources AS (                      -- sources appearing in ANY applicable link
  SELECT source_a_id AS sid FROM external_identity_links
    WHERE owner_id IS NULL OR owner_id = $1
  UNION
  SELECT source_b_id FROM external_identity_links
    WHERE owner_id IS NULL OR owner_id = $1
),
candidates AS (                          -- matched items eligible for dedup
  SELECT m.fi_id, fi.source_id, fi.published_at,
         fi.biddability_tier AS tier, ei.dedup_fingerprint AS fp
  FROM matched m
  JOIN feed_items fi ON fi.id = m.fi_id
  JOIN external_items ei ON ei.id = fi.external_item_id        -- external only
  WHERE ei.dedup_fingerprint IS NOT NULL
    AND fi.source_id IN (SELECT sid FROM linked_sources)        -- the guard
),
suppressed AS (                          -- losers: a linked, better-ranked twin exists
  SELECT c.fi_id
  FROM candidates c
  JOIN candidates d
    ON d.fp = c.fp AND d.fi_id <> c.fi_id
  JOIN external_identity_links l
    ON ((l.source_a_id = c.source_id AND l.source_b_id = d.source_id)
     OR (l.source_b_id = c.source_id AND l.source_a_id = d.source_id))
   AND (l.owner_id IS NULL OR l.owner_id = $1)
  WHERE ( tprio(d.tier) <  tprio(c.tier) )
     OR ( tprio(d.tier) =  tprio(c.tier)
          AND (d.published_at, d.source_id, d.fi_id)
            < (c.published_at, c.source_id, c.fi_id) )
)
```
`tprio(t)` inlines as `CASE t WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END`.

One line added to the existing `scored` WHERE:
```sql
AND fi.id NOT IN (SELECT fi_id FROM suppressed)
```

The suppression universe is `candidates` (this feed's own matches), **not** global
`feed_items` — so we never hide `fi` in favour of a winner that isn't itself in
this feed (which would show neither copy).

### Provenance note ("ALSO ON BLUESKY · MASTODON")
Computed only for survivors (a handful of rows, post-filter) via a lateral in the
outer SELECT. Note: the outer select is `SELECT * FROM scored`, and `scored` does
**not** project the fingerprint (`fp` is on `external_items`, outside
`FEED_SELECT`/`POST_SELECT`). So the outer select becomes
`SELECT scored.*, prov.also_on FROM scored LEFT JOIN LATERAL (…) prov ON true`,
and the lateral joins `external_items` on `scored.external_item_id` to recover
`scored.fp` for the match below (or surface `fp`/`source_id` from a wrapping CTE).
Preserve `effective_score`/`fi_id` in the projection — the JS `nextCursor`
(`items.ts:293-300`) reads them.
```sql
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT d.source_protocol) AS also_on
  FROM candidates d
  JOIN external_identity_links l
    ON ((l.source_a_id = scored.source_id AND l.source_b_id = d.source_id)
     OR (l.source_b_id = scored.source_id AND l.source_a_id = d.source_id))
   AND (l.owner_id IS NULL OR l.owner_id = $1)
  WHERE d.fp = scored.fp AND d.fi_id <> scored.fi_id
) prov ON true
```
Surface as an optional `Post.alsoOn?: string[]` — add the field to **both** the
gateway shape (`gateway/src/lib/post-mapper.ts`, read `row.also_on` in
`feedItemToPost`) and its web mirror (`web/src/lib/post/types.ts`, kept
structurally identical). Render a quiet mono-caps line on the winning card in
`web/src/components/post/PostOriginTag.tsx` (reuse its `PROTOCOL_DISPLAY` map +
`TagText` helper: `ALSO ON …`, no hairline — run `scripts/check-hairlines.sh`).
Empty/undefined ⇒ nothing rendered, so unlinked feeds are visually untouched.

## Link ownership (the owner model)

The principle, consistent with the rest of the system: **objective facts are
global; unverifiable assertions are scoped to the asserter.** (`external_sources`
global vs `external_subscriptions` per-owner; the trust graph is viewer-relative
and attributed; `network_presences` earns its global unique key only because it's
OAuth-proven.) A blanket "user-asserted links are global" would be the only place
where one user's unverified claim suppresses content and stamps a public identity
assertion in everyone else's feed — asymmetric harm (one griefer vs marginal
convenience), so scope it down.

| `link_type` | Truth | Scope | Writer |
|---|---|---|---|
| `bridge`, `domain_match`, `cross_link` | objective, re-verifiable | **global** (`owner_id NULL`), confidence < 1.0 | daily detection task (single writer, self-healing) |
| `user_asserted` | one reader's unverified claim | **owner-scoped** (`owner_id = asserter`), confidence 1.0 | the "Link to…" action |

Dedup applies global links **plus the reader's own** assertions, reusing the
`$1 = readerId` param already in `sourceFilteredItems`:
`AND (l.owner_id IS NULL OR l.owner_id = $1)`.

### Unlink semantics (sequenced to phasing)
- Unlinking your **own** `user_asserted` link → `DELETE` the owner-scoped row.
- Unlinking a **global automated** link → can't delete a verified fact for
  everyone; write an owner-scoped **negative override** (a per-reader tombstone
  the query subtracts).

The negative-override complexity exists *only* once global automated links exist:

- **P2 (user-asserted only):** every row has `owner_id NOT NULL`. Unlink = delete.
  Query filter is just `l.owner_id = $1`. No NULL-owner branch, no tombstones.
- **P3 (automated detection lands):** add `owner_id IS NULL` global rows, flip the
  filter to `IS NULL OR = $1`, add the negative override (`link_type =
  'user_unlinked'`, owner-scoped; the `suppressed`/`linked_sources` CTEs exclude
  any pair the reader has tombstoned). UI must then distinguish "you linked this"
  from "automatically detected" so unlink reads honestly.

### Deferred: network-effect recovery (P3+)
Owner-scoping loses the "first linker helps everyone" effect. Recover it safely
via **quorum promotion**: when N independent readers assert the same
`user_asserted` pair, the detection task promotes it to a global link
(`link_type = 'crowd'`, confidence scaled by N) — the trust-graph pattern (many
attributed opinions → a derived fact), never a single actor. Don't build in v1.

## UI (P2) — re-based off the retired Subscriptions page

The "Link to…" / "Unlink" affordances live on the **external author profile**
surface (`AuthorProfileView` full-page + the overlay; the profile-surfaces
invariant already concentrates per-author actions there), not a Subscriptions
page.

- "Link to…" opens a resolver-backed input (`POST /api/resolve`,
  `gateway/src/lib/resolver.ts`) — paste a URL/handle from another platform.
  Omnivorous input per the sitewide rule. **The resolver only classifies; it
  returns no `external_sources.id`** (see Codebase reconciliation #1), so the
  flow is two-step: take the chosen match's `{ protocol, sourceUri }`, **upsert
  it via the `addSource` path** (`gateway/src/routes/feeds/sources.ts:354`,
  `RETURNING id`) to get a persisted `source_b_id`, then insert the owner-scoped
  `user_asserted` link. `source_a_id` is the current author's backing source —
  the `followTarget.sourceId` already on the profile payload (always present for
  a tier-A/B author shown in-feed; see reconciliation #2). Normalise
  `source_a_id < source_b_id` before insert. Reuse the
  `SourceFollowPicker` resolve→`addSource` wiring in `ProfileFollowControl.tsx`.
- New gateway routes: `POST` create-link + `DELETE` unlink (in `author.ts` or a
  sibling). At P2 every row is `owner_id NOT NULL`, so unlink = `DELETE` and the
  read filter is just `l.owner_id = $1` — no NULL-owner branch, no tombstones.
- **Surface placement:** the "Link to…" / "Unlink" affordance sits in
  `AuthorProfileView.tsx`'s actions cell (the `flex-shrink-0` slot beside
  `ProfileFollowControl`, lines ~247-251), the same per-author home the
  profile-surfaces invariant concentrates actions in.
- **Profile payload:** extend `AuthorCardResponse`
  (`gateway/src/lib/author-resolve.ts`) + the `/author/:id/profile` route with
  the viewer's existing linked sources for this author, so the surface can render
  "Unlink" and the `ALSO ON …` grouping the dedup query already emits.

## Risks / validation

- **Dedup correctness is the whole game** — a false-positive merge hides real
  distinct posts. The text-hash fallback can collide on short/generic posts; keep
  `norm()` conservative and consider a minimum-length floor before hashing.
- Detection task (P3) fetches remote profiles → must use the hardened client
  `shared/src/lib/http-client.ts` (SSRF invariant). Schedule it last, behind a
  flag.
- **EXPLAIN ANALYZE the dedup CTE against a seeded large feed** — the
  `candidates` self-join is a hash join on `fp`, bounded by the `linked_sources`
  guard, but verify. Do this together with the deferred audit item #15 ("EXPLAIN
  the `scored` CTE against a large dataset") — same query, one pass.
- Tests (`feed-ingest/.../feed-batching.test.ts` is thin per audit D14): winner
  selection across tiers, cross-page suppression, canonical-URL vs text-hash
  grouping, the zero-links fast path, and (P2) owner-scoped visibility (my
  assertion doesn't leak into another reader's feed).

## References

- FEED-INGEST-ATTACK-PLAN.md § "Slice 8" (original spec; §8C/§8F superseded here).
- `gateway/src/routes/feeds/items.ts:178` (`sourceFilteredItems` — the dedup host).
- `gateway/src/lib/post-mapper.ts` (`Post` shape — add `alsoOn`).
- `gateway/src/lib/resolver.ts`, `gateway/src/routes/resolve.ts` (resolver for "Link to…").
- migration 099 (`external_authors`, the deferred claim slot), 117 (live profile cols).
- CARD-BEHAVIOUR-ADR §VI.3 (constructed external author profiles — the follow-on
  this slice unblocks).
