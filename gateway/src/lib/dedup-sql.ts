// =============================================================================
// Slice 8 P1 — cross-source dedup SQL fragments.
//
// Factored out of feeds/items.ts so the integration test (gateway/tests/
// dedup-integration.test.ts) exercises the *exact same* SQL the live feed query
// runs — there is no second copy to drift. The host query is responsible for the
// `matched` CTE (the feed's pre-LIMIT candidate item set) and a `scored` CTE; the
// fragments below slot in between and after.
//
// Param contract: `$1` is the reader id (already threaded through
// sourceFilteredItems). Owner-aware: a link applies when it is global
// (`owner_id IS NULL`, P3 automated detection) or asserted by this reader
// (`owner_id = $1`, P2 "Link to…"), minus any pair this reader has tombstoned
// (P3 `user_unlinked` negative override — see below).
// =============================================================================

// The dedup CTEs. Slot between `matched` and `scored`:
//   WITH feed_mode AS (…), matched AS (…), ${DEDUP_CTES}, scored AS (…)
//
// Two cross-posted copies (e.g. an article on RSS + its Bluesky share) carry
// different effective_score, so they are not page-adjacent — in-page dedup leaks
// the twin. Instead we pick a page-independent winner per fingerprint and
// suppress losers across the whole candidate set (`matched`, pre-LIMIT).
//
// `applicable_links` materialises the links that apply to THIS reader once, and
// linked_sources / suppressed / the provenance lateral all reference it: global
// (owner NULL) ∪ this reader's own assertions, EXCLUDING the `user_unlinked`
// negative override itself and any (ordered) pair the reader has tombstoned with
// one (P3 — a reader can't delete a global fact for everyone, so unlinking a
// detected link writes an owner-scoped tombstone the read path subtracts).
//
// Perf guard: only sources in an applicable link can produce duplicates, so
// `candidates` prefilters to `linked_sources`. Most feeds have zero links → the
// CTEs are empty → near-zero cost. Dedup is free until someone links something.
export const DEDUP_CTES = `
    applicable_links AS (
      SELECT l.source_a_id, l.source_b_id
        FROM external_identity_links l
       WHERE (l.owner_id IS NULL OR l.owner_id = $1)
         AND l.link_type <> 'user_unlinked'
         AND NOT EXISTS (
           SELECT 1 FROM external_identity_links t
            WHERE t.link_type = 'user_unlinked'
              AND t.owner_id = $1
              AND t.source_a_id = l.source_a_id
              AND t.source_b_id = l.source_b_id
         )
    ),
    linked_sources AS (
      SELECT source_a_id AS sid FROM applicable_links
      UNION
      SELECT source_b_id FROM applicable_links
    ),
    candidates AS (
      SELECT m.fi_id, fi.source_id, fi.source_protocol, fi.published_at,
             fi.biddability_tier AS tier, ei.dedup_fingerprint AS fp
        FROM matched m
        JOIN feed_items fi ON fi.id = m.fi_id
        JOIN external_items ei ON ei.id = fi.external_item_id   -- external only
        WHERE ei.dedup_fingerprint IS NOT NULL
          AND fi.source_id IN (SELECT sid FROM linked_sources)  -- the guard
    ),
    -- A candidate is a loser when a linked twin (same fingerprint, linked
    -- sources) ranks ahead of it: higher biddability tier, else earlier
    -- published_at, else lower (source_id, fi.id). tprio: A→0 B→1 C→2 D→3.
    suppressed AS (
      SELECT c.fi_id
      FROM candidates c
      JOIN candidates d
        ON d.fp = c.fp AND d.fi_id <> c.fi_id
      JOIN applicable_links l
        ON ((l.source_a_id = c.source_id AND l.source_b_id = d.source_id)
         OR (l.source_b_id = c.source_id AND l.source_a_id = d.source_id))
      WHERE (
        (CASE d.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END)
        < (CASE c.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END)
      ) OR (
        (CASE d.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END)
        = (CASE c.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END)
        AND (d.published_at, d.source_id, d.fi_id)
          < (c.published_at, c.source_id, c.fi_id)
      )
    )`;

// Drop the loser of a cross-source duplicate pair. Goes in the `scored` WHERE.
export const DEDUP_SUPPRESS_FILTER = `AND fi.id NOT IN (SELECT fi_id FROM suppressed)`;

// Provenance ("ALSO ON BLUESKY · MASTODON"): computed only for survivors (a
// handful of post-filter rows) — the other linked sources carrying the same
// fingerprint. Empty/NULL when the feed has no links, so unlinked feeds are
// untouched. The host `scored` CTE must project `source_id`, `fp`, `fi_id` for
// the join below; `::text` so node-pg returns a real string[] (a custom-enum
// array arrives unparsed as a raw "{atproto,rss}" string and breaks the UI .map).
export const DEDUP_PROVENANCE_LATERAL = `
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT d.source_protocol::text) AS also_on
      FROM candidates d
      JOIN applicable_links l
        ON ((l.source_a_id = scored.source_id AND l.source_b_id = d.source_id)
         OR (l.source_b_id = scored.source_id AND l.source_a_id = d.source_id))
      WHERE d.fp = scored.fp AND d.fi_id <> scored.fi_id
    ) prov ON true`;
