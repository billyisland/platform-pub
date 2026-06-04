# Feed ingestion + hydration — implementation plan

Companion to `FEED-INGEST-HYDRATION-AUDIT.md`. The audit's findings were validated
against the current code (June 2026); file:line references below are confirmed. This
doc is the **scoped build plan** — tranches by effort/risk/dependency, the migrations
required, and the decisions already taken.

**Framing:** every finding is *scaling* severity, not launch severity. At 20–30 writers
none of this hurts. The order below front-loads the localised, behaviour-preserving
wins and defers the structural rewrites until feed p95 actually starts tracking
`repost_edges` / followee-history size.

**Decisions taken (this pass):**
- **#14 — `following` native recency bound: 30 days.** Mirror the external arm's
  existing `INTERVAL '30 days'` cap so the native arm stops scoring the full history of
  every followee. This is the root cause of #12's worst case; bounding it is a
  prerequisite, not an optimisation.

---

## Tranche A — pure scoping, no behaviour change [✅ DONE 2026-06-04]

Localised, behaviour-preserving, kills the worst read-path cliffs. Target ~half a day.

**Status:** all of A1–A5 + C1#14 shipped. Migration 104 added (`idx_repost_edges_target_boosted`
composite, redundant `idx_repost_edges_target` dropped); `schema.sql` regenerated via pg_dump
and `scripts/check-schema-drift.sh` passes all three checks. gateway + feed-ingest build clean,
`npm run lint` 0 errors, gateway (95) + feed-ingest (144) tests green. `EXPLAIN` confirms the
boost CTE now semijoins `candidates` + applies the recency window.

### A1 · #11 — fix `ei_reply_to_handle` to use the existing composite index
`gateway/src/routes/timeline.ts:202` looks up `external_items` by `source_item_uri`
**alone**; the only index touching that column is `UNIQUE(protocol, source_item_uri)`
(protocol-leading) → seq scan per candidate row.

The subquery already has `ei.protocol` in scope. Add `AND ei_p.protocol = ei.protocol`
so it hits the composite prefix. **One line, no migration** — strictly cheaper than the
new `external_items(source_item_uri)` index the audit proposed. (Skip that index unless a
later, protocol-agnostic `source_item_uri` lookup appears.)

### A2 · #10b — scope the boost CTE to candidate posts
`gateway/src/routes/post-feed.ts:115-122` — the `boost` CTE aggregates the **entire**
`repost_edges` graph (`GROUP BY target_post_id`, no `WHERE`) then `LEFT JOIN`s ~20 rows.
Add a semijoin so boost mass is computed only for the THINGs in the candidate set, e.g.
`WHERE target_post_id IN (SELECT post_id FROM <candidates>)`. Restructure so the
candidate `post_id`s are available to the CTE (may require lifting candidate selection
into an earlier CTE). Biggest single read-path win.

### A3 · #13 — push the attribution limit into SQL
`gateway/src/routes/post-feed.ts:133-166` (`fetchAttribution`) pulls **every**
`repost_edge` for the page's `post_id`s with `ROW_NUMBER()`, then drops `rn > 25` in JS
(`ATTRIBUTION_PER_POST`, line 131). A viral post ships thousands of rows to discard.
Wrap in a subquery with `WHERE rn <= 25`, or rewrite as
`LATERAL (… ORDER BY boosted_at DESC LIMIT 25)`. The `idx_repost_edges_target` index
makes the LATERAL cheap.

### A4 · #10a — recency-bound the boost CTE + new index [migration]
Complementary to A2. Boosts older than ~5× `boostHalflifeHours` contribute <3% of
ceiling. Add `WHERE boosted_at > now() - interval '…'` to the boost CTE, backed by a new
index.
- **Migration 104:** `CREATE INDEX idx_repost_edges_boosted_at ON repost_edges(boosted_at)`
  (or composite `(target_post_id, boosted_at)` to also serve A3's LATERAL).
- Then regenerate `schema.sql` via `pg_dump`, re-append the `_migrations` seed, and run
  `scripts/check-schema-drift.sh` (see CLAUDE.md — never hand-edit `schema.sql` or the
  seed line).

### A5 · #4 — cache `platform_config` per task run
Every feed-ingest task `SELECT`s from `platform_config` on each job
(`feed-ingest-poll.ts:14`, `feed-ingest-rss.ts:37`, `-activitypub.ts:47`, `-nostr.ts:103`,
`listener.ts:208`). Add a small in-process cache with a 30–60s TTL in `feed-ingest/src/lib`
and route the reads through it. No behaviour change at steady state.

---

## Tranche B — batching + cadence [behaviour-equivalent, test with care]

Each item is independently shippable. Target ~2–3 days.

### B1 · #2 — batch the RSS dual-write
`feed-ingest/src/tasks/feed-ingest-rss.ts:92-165` wraps **each** item in its own
`withTransaction` (2 inserts each) → 50 items = 50 txns / ~100 statements. Replace with
one multi-row `INSERT INTO external_items … ON CONFLICT (protocol, source_item_uri) DO
NOTHING RETURNING id, source_item_uri`, then one batched `feed_items` insert keyed off the
returned ids. 100 round-trips → 2. **Preserve** the `ON CONFLICT` dedup and the
returned-id → `feed_items.external_item_id` mapping (rows that conflicted return no id and
must be skipped, not null-keyed).

### B2 · #5 — batch the Jetstream cursor advance
`feed-ingest/src/jetstream/listener.ts:464-499` does, per matched event: an insert txn, a
**separate** prefetch-enqueue query, and a **separate** `UPDATE external_sources … cursor`.
Accumulate `max(time_us)` per source in memory, flush a single batched `UPDATE` every N
events / M ms, and fold the durable cursor write into the insert transaction. **Keep** the
`GREATEST(COALESCE(cursor,0), …)` guard (idempotency under out-of-order delivery) and the
in-memory mirror at `listener.ts:501-506`.

### B3 · #8 — batch the engagement-refresh writes
`feed-ingest/src/tasks/external-engagement-refresh.ts:130-192` (Bluesky path) batch-*fetches*
25 (`BSKY_BATCH_SIZE`) but issues 25 individual `UPDATE`s (lines 170-180); same shape in the
Mastodon path. Replace each batch with a single
`UPDATE external_items SET … FROM (VALUES …) v(id,like,reply,repost) WHERE …` (or `unnest`),
and **skip rows whose counts are unchanged** before writing.

### B4 · #9 — batch the parent/quote prefetch
`feed-ingest/src/tasks/external-parent-prefetch.ts` does `alreadyStored` SELECT → single-URI
`getPosts` → sometimes a second serial `getPosts` for the grandparent tag (lines 57-143,
471-500). On a reply-heavy firehose this is a single-URI fetch storm. Debounce-batch pending
parent/quote URIs into 25-URI `getPosts` calls; resolve grandparent tags in the same batch
where possible. Changes timing, not correctness.

### B5 · #3 — multiplicative adaptive polling interval
`feed-ingest/src/tasks/feed-ingest-rss.ts` resets `fetch_interval_seconds = DEFAULT_INTERVAL`
(300) on **both** success (lines 182-191) and `notModified`/304 (lines 80-81). The 304 is the
signal to *back off*; a fresh insert is the signal to *poll sooner*. Switch to multiplicative
adjustment (increase on 304/no-new, decrease on new items, clamp to `[min, max]` from
`platform_config`). The conditional GET is already paid for — capitalise on it.

### B6 · #7 — age-tier the engagement refresh cadence
`external_engagement_refresh` (every 30 min, `index.ts:97`) refreshes **all**
atproto/activitypub items from the last 7 days uniformly — a 6-day-old item is polled as often
as a 1-hour-old one (`external-engagement-refresh.ts:88-101`). Engagement is long-tail decay.
Introduce age-tiered cadence (e.g. <6h → 30m, <24h → hourly, <7d → daily) and/or a per-run
budget cap; ideally restrict to items currently surfacing in feeds. Reduces load on
`public.api.bsky.app` and Mastodon instances.

---

## Tranche C — structural scaling [defer until metrics demand]

Premature at current scale. Build the design before you need it; you'll know you need it when
feed p95 starts tracking total `repost_edges` size / followee history.

### C1 · #14 + #12 — bound `following`, then reduce pagination work
- **#14 (cheap, do alongside Tranche A if convenient):** add
  `AND fi.published_at > now() - INTERVAL '30 days'` to the `following` native membership in
  `gateway/src/routes/post-feed.ts` (the scored CTE, ~lines 270-292), mirroring the external
  arm. **Decision taken: 30 days.**
- **#12 (heavy):** live `score_live` can't be indexed (function of `now()` + live
  `repost_edges`), so the `scored → deduped` CTE materialises and sorts the whole candidate set
  every page; page 10 redoes page 1's work. Real fix is a **two-phase read** (cheap candidate-id
  pull, then hydrate only the page) or a **materialised per-reader candidate pool** refreshed by
  a worker. Also bound max page depth. Largest single item.

### C2 · #1 — decouple enqueue rate from per-host politeness
`feed-ingest/src/tasks/feed-ingest-poll.ts` — `maxConcurrent` (default 10) is doing double duty
as both the per-tick enqueue cap and the *only* thing bounding how hard the fetcher hits one
origin host; the `byHost` slice + global `break` make politeness lossy/order-dependent. Order
matters:
1. **First** move per-host politeness into the fetch task (per-host advisory lock or per-host
   job queue) so concurrency *to a single host* is bounded regardless of queue depth.
2. **Then** lift the per-tick cap and let the poll enqueue all due sources (`jobKey` dedups,
   runner `concurrency: 10` in `index.ts:55` bounds self-load).
- **Safe one-liner today (no per-host work):** raise the per-tick cap well above runner
  concurrency. Removes the throughput ceiling immediately; the per-host relocation is the
  prerequisite for actually enqueueing *all* due sources.

### C3 · #6 — shard the Jetstream firehose
`feed-ingest/src/jetstream/listener.ts:60` — above `WILDCARD_DID_THRESHOLD` (150) the listener
subscribes to the **whole** Bluesky firehose and `JSON.parse`s every event client-side
(single-process CPU cliff that scales with Bluesky, not with subscriptions). Robust fix: shard
into K filtered WebSockets each carrying ≤150 `wantedDids` (server-side filter) so CPU/bandwidth
stay proportional to subscription count. Only matters past ~200 subscriptions.

### C4 · #11 (denormalise) — carry reply-parent author on the row [migration]
The cleaner long-term form of A1: convert the per-row reply-author lookups to denormalised
columns. Add `feed_items.reply_to_author` (migration), populate it at ingest, and extend
`feed-ingest/src/tasks/feed-items-author-refresh.ts` (currently refreshes `author_name` /
`author_avatar` / `author_username`) to maintain it — native via `notes.reply_to_event_id`,
external via `external_items.source_reply_uri`. Migration + cron change + `schema.sql` regen.

---

## Cross-cutting checklist

- **Migrations:** 104 (`repost_edges(boosted_at)`, Tranche A) and one more if C4 lands. Each:
  add numbered SQL in `migrations/`, regenerate `schema.sql` with `pg_dump` from a fully-migrated
  DB, re-append the `_migrations` seed in the same step, run `scripts/check-schema-drift.sh`
  (CI-enforced). Never hand-edit `schema.sql` or the seed line.
- **Dual-write invariant (verdict §):** confirm `insertAtprotoItem` (`lib/atproto-ingest.ts`) and
  `insertActivityPubItem` (`lib/activitypub-ingest.ts`) keep both writes in one transaction (RSS
  does after B1) so drift is only ever missed rows, never partial writes.
- **Keep untouched:** conditional GET, leader-election advisory lock, backoff + source
  deactivation, pinned-IP SSRF defence, `GREATEST` cursor idempotency, `jobKey` dedup.
- **#15 — verify the plan:** `EXPLAIN ANALYZE` the `scored` CTE against a seeded large dataset
  after Tranche A to confirm the planner hashes the follow sets once and the correlated-subquery
  line items (#11) have collapsed.
- **Hairline check:** none of this is frontend, but if any card-adjacent change sneaks in, run
  `scripts/check-hairlines.sh` on touched files.

## Recommended order

`A1 → A3 → A2 → A4 → A5` (front-load the no-migration one-liners, then the indexed work) →
`C1#14` (cheap, pairs with A) → Tranche B in any order (each independent) → re-measure (#15) →
Tranche C only if p95 demands it.
