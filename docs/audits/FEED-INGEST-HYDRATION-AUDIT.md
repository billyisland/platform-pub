# Feed ingestion + hydration — deep audit

Scope: `feed-ingest/*` (poll dispatcher, RSS, Jetstream, engagement refresh, parent prefetch) and the read path (`gateway/routes/post-feed.ts`, `timeline.ts` `FEED_SELECT`/`FEED_JOINS`, `lib/post-mapper.ts`, `web/lib/post/map-feed-item.ts`).

> **Status (2026-06-04):** Tranche A shipped — #11 (A1, `ei_reply_to_handle` composite-index
> fix), #10b (A2, boost CTE scoped to candidates), #13 (A3, attribution `LATERAL` limit),
> #10a (A4, recency-bound boost + migration 104), #4 (A5, `platform_config` process cache),
> and #14 (`following` native 30-day bound). Remaining: Tranche B (#2/#5/#8/#9/#3/#7) and
> Tranche C (#1/#6/#12/#11-denormalise). See `FEED-INGEST-HYDRATION-PLAN.md`.

Severity is **scaling severity**, not launch severity. At 20–30 writers nothing here hurts. The HIGHs are what break as `repost_edges` / external-item count / followee-history grow.

---

## Quick wins (localised, high-leverage)

1. Batch the RSS dual-write (#2).
2. Filter attribution in SQL instead of in JS (#13).
3. Scope the boost CTE to candidate posts (#10b).
4. Add an index on `external_items(source_item_uri)` (#11).
5. Batch the Jetstream cursor advance (#5).

---

## Ingestion

### #1 — `feed_ingest_poll` has a throughput ceiling [HIGH at scale]
The poll runs every 60s, selects up to 100 due sources, but caps enqueues at `maxConcurrent` (default **10**) *per tick*. Steady-state fetch capacity is therefore ~10/min ≈ 600/hr no matter how many sources are due. With default 300s intervals you saturate at roughly **50 sources** (demand `N/300` fetches/s vs ceiling `10/60` ≈ 0.167/s), after which sources fall behind and `last_fetched_at` ages without bound.

The cap is also in the wrong layer: `maxConcurrent` here governs *enqueue rate*, while real concurrency is `run({ concurrency: 10 })` plus the per-source `jobKey`. They're conflated. Per-host slicing + the global `break` also starves hosts late in the `byHost` Map within a tick (self-heals via `ORDER BY last_fetched_at NULLS FIRST`, but adds latency jitter).

**Fix:** decouple enqueue-rate from worker concurrency — but mind the ordering, because the per-tick cap is currently doing double duty as *accidental backpressure*. It's the only thing bounding how hard the fetcher hits any single origin host, so lifting it naively trades a throughput ceiling for a thundering herd (runner concurrency 10 could fire 10 simultaneous fetches at one host — e.g. ten Substack feeds). So:
1. **First**, move per-host politeness out of the enqueue step (where the global `break` makes it lossy and order-dependent) into the fetch task — a per-host advisory lock or per-host job queue — so concurrency *to a single host* is bounded no matter how many jobs are queued.
2. **Then** the per-tick enqueue cap is safe to lift: let the poll enqueue all due sources (`jobKey` dedups, runner concurrency bounds self-load).

The safe one-liner, if you want the ceiling gone today without the per-host work: just raise the per-tick cap well above the runner concurrency. That removes the throughput ceiling immediately and is safe on its own; the per-host relocation is the prerequisite for actually enqueueing *all* due sources.

### #2 — RSS does one transaction per item [HIGH]
`feedIngestRss` loops items and calls `withTransaction` per item, each doing two inserts (`external_items` + `feed_items`). 50 items = 50 round-trip transactions / ~100 statements per source fetch.

**Fix:** one multi-row `INSERT … ON CONFLICT DO NOTHING RETURNING id, source_item_uri` for `external_items`, then one batched `feed_items` insert keyed off the returned ids. 100 round trips → 2. Same shape applies to the per-event Jetstream writes (#5).

### #3 — Adaptive polling interval is clobbered [MED]
Every success *and* every `notModified` resets `fetch_interval_seconds = 300`. The 304 (`notModified`) is precisely the signal that the feed is quiet and you should back off; a fresh insert is the signal to poll sooner. You already pay for the conditional GET — capitalise on it.

**Fix:** multiplicative interval adjustment (increase on 304/no-new, decrease on new items, clamp to `[min, max]`). Cuts wasted fetches on dormant feeds and tightens latency on active ones.

### #4 — `platform_config` re-queried per job [MED]
Both the poll and every RSS job `SELECT … FROM platform_config`. It's on every job.

**Fix:** in-process cache with a short TTL (30–60s).

### #5 — Jetstream cursor write amplification [HIGH at scale]
`ingest()` does, per matched event: an insert transaction, **a separate** prefetch-enqueue query, and **a separate** `UPDATE external_sources … cursor`. The per-event cursor write is one row-update to `external_sources` for every ingested post. In wildcard mode that's a write per matched event off the whole firehose.

**Fix:** accumulate `max(time_us)` per source in memory, flush every N events / M ms in a single batched `UPDATE`. Fold the durable cursor write into the insert transaction (the split is only safe today because of the `GREATEST` guard, and it doubles write traffic for no gain).

### #6 — Wildcard mode = parse the entire Bluesky firehose in one process [HIGH at scale]
Above `WILDCARD_DID_THRESHOLD` (150) the listener subscribes to the whole firehose and filters client-side, `JSON.parse`-ing every event on the network. This is a single-process CPU cliff; correctness is fine but it scales with Bluesky, not with your subscriptions.

**Fix (robust path):** shard into K filtered WebSockets each carrying ≤150 `wantedDids` (server-side filter). CPU and bandwidth stay proportional to subscription count. This is more work than the current wildcard fallback, but it's the difference between "scales past 200" and "scales".

### #7 — `external_engagement_refresh` is unbounded + uniform cadence [MED→HIGH at scale]
Every 30 min it refreshes **all** atproto/activitypub items from the last 7 days, regardless of age or whether anyone's looking. A 6-day-old item is polled as often as a 1-hour-old one. Cost grows linearly with subscription volume and hammers `public.api.bsky.app` and Mastodon instances. Engagement is a long-tail decay; uniform polling is the wrong shape.

**Fix:** age-tiered cadence (e.g. <6h → 30m, <24h → hourly, <7d → daily) and/or a per-run budget cap; ideally restrict to items currently surfacing in feeds.

### #8 — Engagement refresh writes per-item, even when unchanged [MED]
Bluesky path batch-*fetches* 25 but issues 25 `UPDATE`s; no skip when counts are identical.

**Fix:** single batched `UPDATE … FROM (VALUES …)` / `unnest`; compare before writing.

### #9 — Parent prefetch isn't batched; grandparent fetched serially [MED]
Each reply enqueues a job doing `alreadyStored` SELECT → `getPosts` (1 URI) → sometimes a second `getPosts` for the grandparent tag. `getPosts` takes 25 URIs/call. On a reply-heavy firehose this is a storm of single-URI fetches plus serial round trips.

**Fix:** debounce-batch pending parent/quote URIs into 25-URI `getPosts` calls; resolve grandparent tags in the same batch where possible.

---

## Hydration (read path)

### #10 — Boost CTE is a full-table aggregate per feed request [HIGH at scale]
```
boost AS (SELECT target_post_id, SUM(trust_weight·decay), COUNT(*)
          FROM repost_edges GROUP BY target_post_id)
```
No `WHERE`. It aggregates the **entire** repost graph on every feed page, then `LEFT JOIN`s to use ~20 rows. As `repost_edges` grows this becomes the dominant cost. (`repost_edges(target_post_id)` is indexed, but an index doesn't help an unbounded full GROUP BY; there is **no** `boosted_at` index.)

**Fix (complementary):**
- **(b), bigger win:** scope the CTE to the candidate `post_id`s — compute boost mass only for the THINGs in the `scored` set (semijoin against candidates), not the whole table.
- **(a):** recency-bound it — boosts older than ~5× `boostHalflifeHours` contribute <3% of ceiling. Add `WHERE boosted_at > now() - interval '…'`, backed by a new `repost_edges(boosted_at)` (or composite `(target_post_id, boosted_at)`) index.

### #11 — Correlated subqueries in `FEED_SELECT`/`POST_SELECT` run across the full candidate set [HIGH at scale]
Per candidate row, the projection executes up to ~5 correlated subqueries — but only **one** of them is unindexed, and that one carries the HIGH:
- `tag_names` `array_agg` (articles) — index-backed (`article_tags`).
- `note_reply_to_name` — notes+accounts, keyed on `n_p.nostr_event_id = n.reply_to_event_id`, so the lookup hits `notes_nostr_event_id_key` (the unique on the *parent note's* `nostr_event_id`). Note: **not** `idx_notes_reply_to` — that index covers the *outer* row's `reply_to_event_id` (the value being fed in), not the column being searched. Index-backed point lookup either way.
- `nostrTargetPostId` ×2 — articles by `nostr_event_id`, index-backed via `articles_nostr_event_id_key`.
- `ei_reply_to_handle` — `external_items` lookup **by `source_item_uri` alone**. **This is the unindexed one.**

The sharp one is `ei_reply_to_handle`: the only index touching `source_item_uri` is `UNIQUE (protocol, source_item_uri)` with **protocol leading**, so a `source_item_uri`-only equality can't use the composite prefix → seq scan **per row**. The other four are per-row *point lookups* — cheap individually, but still N of them; the seq scan is what makes this HIGH. And because the `scored` CTE materialises before `LIMIT` (see #12), all of these run over every candidate, not just the page.

**Fix:**
- Add `CREATE INDEX … ON external_items(source_item_uri)` (or constrain that subquery on `protocol` too so it hits the composite prefix).
- Convert the per-row reply-author lookups to `LEFT JOIN`s against a derived set, or — better — denormalise reply-parent author onto the row at ingest. You already run `feed_items_author_refresh`; extend it to carry `reply_to_author`.

### #12 — Pagination does no work reduction [HIGH at scale]
`score_live` is computed at query time (it must be — it's a function of `now()` and live `repost_edges`), so it can't be indexed. The `scored → deduped` CTE therefore **materialises and sorts the entire candidate set on every page**, and the keyset clause only trims afterward. Page 10 redoes page 1's work. Cost is O(candidates) × pages. The pinned `scoreNow` in the cursor stabilises ordering (good — fixes the boundary-duplication bug noted in the code) but doesn't reduce work.

This is the structural cost of live scoring, and it's amplified by #10 + #11. `explore` is bounded (48h membership window); **`following`'s native arm has no recency bound** — it scores the full history of every followee.

**Fix (in order of effort):**
- Add a recency window to the `following` native membership (mirror the external 30d cap).
- Bound max page depth.
- At real scale: two-phase read (cheap candidate-id pull, then hydrate only the page), or a materialised per-reader candidate pool refreshed by a worker.

### #13 — `fetchAttribution` over-fetches then discards [MED]
It pulls **every** `repost_edge` for the page's `post_id`s with `ROW_NUMBER()`, returns all rows, then drops `rn > 25` in JS. A viral post with thousands of edges ships thousands of rows to be thrown away.

**Fix:** push the limit into SQL — wrap in a subquery with `WHERE rn <= 25`, or `LATERAL (… ORDER BY boosted_at DESC LIMIT 25)`. The `target_post_id` index makes the LATERAL cheap.

### #14 — Membership asymmetry [LOW / decision]
`explore` keeps a 48h hard membership window; `following` native is unbounded. Deliberate-looking but it's the root of #12's worst case. Make it an explicit decision, not an accident.

### #15 — Verify the big-CTE plan [LOW]
`follows`/`publication_follows` IN-subqueries are fine on indexes (PKs `(follower_id, …)` cover the lookups), and the `blocks`/`mutes` `NOT EXISTS` are proper semijoins. But the whole `scored` CTE is large — `EXPLAIN ANALYZE` it against a seeded large dataset to confirm the planner hashes the follow sets once rather than re-probing, and watch the correlated-subquery line items from #11.

---

## Architectural verdict

- **Live scoring** is the right call for freshness (no stale materialised score) and is the root of the read-path cost. The honest tradeoff: free at launch, then #10+#11+#12 compound the moment `repost_edges` and followee history grow. Design the materialised-candidate path *before* you need it; you'll know you need it when feed p95 starts tracking total `repost_edges` size.
- **Dual-write** (`external_items` + `feed_items`) doubles write volume and creates two truth sources reconciled daily by `feed_items_reconcile`. Acceptable, but ensure both writes always share one transaction (RSS does; confirm `insertAtprotoItem` / `activitypub-ingest` do too) so drift is only ever from missed rows, never partial writes.
- **Keep:** conditional GET, leader-election advisory lock, backoff + source deactivation, pinned-IP SSRF defence, `GREATEST` cursor idempotency, `jobKey` dedup. Robustness is genuinely solid.

The pattern across both paths is the same: **work scoped to "everything" where it should be scoped to "the page" or "the candidates"** — boost aggregate (#10), correlated subqueries (#11), full re-materialisation (#12), attribution over-fetch (#13), engagement refresh (#7). Fixing the scoping is most of the win.
