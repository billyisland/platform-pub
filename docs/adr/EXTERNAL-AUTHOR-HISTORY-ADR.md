# EXTERNAL-AUTHOR-HISTORY-ADR — External author posting history

**Status: Implemented 2026-07-07 — all four §7 phases shipped (migration 148;
promotion fix in all three writers; `feed_ingest_nostr_backfill`; profile-view
hydration for nostr + atproto + activitypub behind
`AUTHOR_TIMELINE_HYDRATION_ENABLED`, default on). One implementation addition
beyond the spec: the atproto/AP timeline fetchers pin
`external_items.author_uri` to the profile's exact `stable_handle` — the
identity trigger mints `external_authors` from `author_uri` for those
protocols, so an origin-shaped value (bsky.app URL / account web URL) would
attribute the hydrated rows to a different author record and the profile would
stay empty.**

External author profiles — reached from any byline via `/author/:authorId` —
routinely render an empty posting history. For Nostr authors it is empty almost
always. This ADR records why (§1), then specs the two independent fixes:

- **Part A (§2)** — `feed_ingest_nostr_backfill`: subscribe-time historical
  backfill for `nostr_external` sources, bringing Nostr to parity with the
  atproto and activitypub adapters.
- **Part B (§3)** — profile-view timeline hydration: an on-demand, best-effort
  fetch of an author's recent timeline when their profile is opened and the
  ingested history is empty — the fix for the common case of viewing an author
  nobody subscribes to. Nostr first; the same frame extends to atproto and
  activitypub.

Part A fixes "I followed a Nostr author and their profile/feed started empty."
Part B fixes "I clicked a byline and the profile shows nothing" — which is the
experience the ADR exists for, since most profile visits are to unfollowed
authors.

*2026-07-06 verification pass*: every §1 finding and code reference was checked
against the tree and held, with two corrections folded in below — §1.4
understated the ingest-side relay gap (the poll job has **no** fallback at
all), and §3.2's re-subscribe precondition turned out to be already satisfied.
The pass also surfaced three implementation hazards the original spec missed,
now baked into §2.1 (job-key collision), §4.2 (`source_id` re-homing +
deletion matching), and §4.2 (the atproto/AP writers' `DO NOTHING` shape).

---

## 1. Findings — why the history is empty

### 1.1 The post list is DB-only, for every protocol

`GET /author/:authorId/posts` (`gateway/src/routes/author.ts`, `/posts`
handler) never fetches anything live. For an external author it runs one query
over `feed_items fi JOIN external_items ei` with:

```
WHERE fi.deleted_at IS NULL
  AND fi.external_author_id = $1
  AND (ei.is_context_only IS NOT TRUE)
```

So the log is exactly: *posts previously ingested and attributed to that
`external_author_id`, excluding context-only thread-hydration rows*. The
companion `/profile` endpoint does fetch live origin data, but only for the
header (for Nostr: the kind-0 via `fetchNostrAuthorProfile`,
`gateway/src/lib/nostr-relay.ts`) — never posts.

The web side (`web/src/app/author/[authorId]/AuthorProfileView.tsx`) renders
whatever `/posts` returns; an empty `items` array is simply an empty log.

### 1.2 Per-protocol comparison — what subscribe-time ingest pulls

Subscribe dispatch is `externalFetchTask()` in
`gateway/src/routes/feeds/sources.ts:12` — one job enqueued when a source is
added to a feed:

| Protocol | Subscribe job | Historical backfill? |
| --- | --- | --- |
| atproto | `feed_ingest_atproto_backfill` | **Yes** — dedicated task; pages AppView `getAuthorFeed` (5 × 100), cutoff `feed_ingest_atproto_backfill_hours` (default 24h). Live posts via Jetstream thereafter. |
| activitypub | `feed_ingest_activitypub` | **Yes** — first outbox poll with no cursor backfills `feed_ingest_ap_backfill_hours` (default 24h), paged newest-first. |
| rss | `feed_ingest_rss` | Whatever the feed document currently contains. |
| nostr_external | `feed_ingest_nostr` | **No.** The subscribe job *is* the steady-state 60s poll job. First run (no cursor) uses `since = now − 48h` (`DEFAULT_LOOKBACK_SECONDS`, `feed-ingest/src/tasks/feed-ingest-nostr.ts:42,119`), one REQ per relay, one 10s window, no paging back. An author who hasn't posted in 48h yields nothing. |

### 1.3 The structural gap — unsubscribed authors have nothing, on any protocol

A profile is usually reached from a byline for an author the viewer does *not*
follow. No subscription ⇒ no `external_sources` fetch job has ever run for
them ⇒ no non-context rows exist. The only rows that may exist are
`is_context_only = TRUE` thread-hydration rows
(`gateway/src/lib/external-hydration.ts`), which the `/posts` filter
deliberately excludes (they're feed-pipeline pollution guards, GC'd by
`external-context-gc` after 30 days). Bluesky and Mastodon profiles share this
emptiness; Nostr compounds it with §1.2.

### 1.4 NIP-65 is published but never consumed — and ingest has no relay fallback at all

We *emit* our own kind-10002 relay lists (`gateway/src/lib/nostr-events.ts`,
`discovery-publish.ts`) but no ingest/read path ever fetches an external
author's kind 10002 to learn their write relays (verified: every `10002`
reference in gateway + feed-ingest is publish-side).

Relay selection for an external Nostr author splits by path, and the split
matters:

- **Gateway read paths** (profile header fetch, thread hydration) use the
  post's/source's relay hints merged with `NOSTR_FALLBACK_RELAYS`
  (`gateway/src/lib/nostr-relay.ts:18` — nostr.band, damus, nos.lol, primal).
- **The ingest poll job has no fallback whatsoever**: a `nostr_external`
  source with empty `relay_urls` is skipped outright
  (`feed-ingest-nostr.ts:98-101`) — it is never fetched, forever. The only
  relay set ingest ever uses is `external_sources.relay_urls` (user-supplied
  at subscribe, or nprofile hints via the resolver).

So the ingest gap is *worse* than "wrong relays": a relay-less source is dead
on arrival. For authors on smaller relays, neither backfill nor hydration can
succeed without NIP-65 discovery — both parts below depend on the shared
helper in §4.1, and §2.6 repairs the relay-less-source case directly.

### 1.5 A latent promotion bug both parts must not inherit

The context-only mechanism has a one-way door: an event first persisted as
`is_context_only = TRUE` (thread hydration) is **never promoted** when the same
event later arrives through real ingest.

- **nostr** (`feed-ingest-nostr.ts:275-285`): the ratchet upsert
  (`ON CONFLICT … WHERE external_items.published_at < EXCLUDED.published_at`)
  blocks the update for an identical event (equal `published_at`), and even
  when the update runs (a 30023 revision) the `SET` list doesn't touch
  `is_context_only`.
- **atproto** (`feed-ingest/src/lib/atproto-ingest.ts:72,115`) and
  **activitypub** (`feed-ingest/src/lib/activitypub-ingest.ts:46,88`): both
  writers are `ON CONFLICT … DO NOTHING` on both the `external_items` and
  `feed_items` statements — structurally incapable of promotion.

So a post of a *subscribed* author that happened to be thread-hydrated first
stays invisible in feeds and profile forever (until GC deletes it and a future
fetch re-inserts it clean). Part A's backfill would hit this constantly —
backfilled events frequently already exist as context rows. Fix specced in
§4.2; it stands on its own as a bug fix.

There is a second, subtler leg to the same bug: context rows are written with
the **hydrating focal item's** `source_id`, not the author's own (thread
hydration inherits the focal's source — see `persistHydratedThreadNodes`).
Nostr kind-5 deletion application matches on `source_id`
(`feed-ingest-nostr.ts:397-449`), so even a promoted row, if left on the
foreign `source_id`, would dodge its author's deletions forever. Promotion
must re-home `source_id` (§4.2).

---

## 2. Part A — `feed_ingest_nostr_backfill`

A one-shot historical backfill task for a newly subscribed `nostr_external`
source. Twin of `feed_ingest_atproto_backfill` in role, enqueue point, and
idempotency posture.

### 2.1 Enqueue — with a distinct job key (collision hazard)

`externalFetchTask()` (`gateway/src/routes/feeds/sources.ts:12`) returns
`feed_ingest_nostr_backfill` for `nostr_external` (replacing
`feed_ingest_nostr` as the subscribe-time job — the 60s poll scheduler owns
steady state, exactly as Jetstream owns atproto steady state). Update the
function's comment block accordingly.

**The enqueue MUST use its own job key, `'feed_ingest_backfill_' || sourceId`
— not the subscribe path's current `'feed_ingest_' || sourceId`.** The poll
scheduler (`feed-ingest-poll.ts:114-121`) enqueues steady-state jobs under
`jobKey: feed_ingest_<sourceId>`, and a freshly subscribed source has
`last_fetched_at IS NULL`, so it is due on the very next 60s tick. With a
shared key, graphile-worker's job-key replacement would swap the still-queued
backfill for a plain poll job — the backfill would silently never run, almost
every time. (Precedent for the distinct-key pattern: the atproto enrichment
job's `feed_ingest_enrich_<id>`.) A poll job running *concurrently* with the
backfill is safe: both write through the same ratchet upsert (idempotent) and
the cursor handoff is forward-only (§2.4).

Re-runs are safe: every write is the existing `(protocol, source_item_uri)`
ratchet upsert.

### 2.2 Relay set — NIP-65 first

1. Fetch the author's kind 10002 via the shared helper (§4.1) using the
   source's `relay_urls` + `NOSTR_FALLBACK_RELAYS` as the discovery set.
2. Query set = author write relays ∪ source `relay_urls` ∪ fallbacks, deduped,
   scheme-checked, capped at 6 (match `NOSTR_THREAD_RELAY_CAP`,
   `gateway/src/lib/external-hydration.ts:368`).
3. **Persist** the discovered write relays into `external_sources.relay_urls`
   (union with existing, existing entries first, cap 10 — never dropping
   user-supplied entries) so every subsequent poll also queries relays that
   actually carry the author. This is the first place NIP-65 becomes
   load-bearing for ingest.

### 2.3 Paging backwards

Nostr REQ has no server cursor; page with `until`:

```
REQ { kinds: [1, 5, 6, 16, 30023], authors: [pubkey], until, limit: 100 }
```

- First page: `until = now`; the first page's REQ also carries the poll job's
  second filter `{ kinds: [0], authors: [pubkey], limit: 1 }` so the source's
  display metadata is fresh at subscribe time (applied through the same
  newest-wins metadata ratchet the poll uses — shared via §4.3). Next page:
  `until = (oldest accepted created_at) − 1`.
- Stop on: cutoff reached (`created_at < now − feed_ingest_nostr_backfill_hours`),
  empty/undersized page, `MAX_PAGES = 5`, or total-accepted cap
  `NOSTR_BACKFILL_MAX_ITEMS = 200`.
- Same per-event validation as the poll job (future-drift window, pubkey
  match, `verifyEvent`), via the shared writer (§4.3).
- Kind 5s within the window are applied with the poll job's existing deletion
  handling (also shared via §4.3) so we don't backfill posts their author has
  deleted.
- Kind 6/16 → `recordRepostEdge`, same as the poll path.

Relay-free identity encoding (`nostrEventUri`/`nostrAddrUri`) is inherited
from the shared writer — backfill must never mint a different `source_item_uri`
for an event the poll path would key differently (the C1 invariant).

### 2.4 Cursor handoff

On completion, advance `external_sources.cursor` to the newest `created_at`
seen — **only forward**, guarding against a concurrently completed poll:

```sql
cursor = CASE WHEN cursor IS NULL OR cursor::bigint < $newest
              THEN $newest::text ELSE cursor END
```

and stamp `last_fetched_at = now()`. The next poll is then incremental.
Errors follow the poll job's existing error-count/backoff accounting.

### 2.5 Config

- `feed_ingest_nostr_backfill_hours` — platform_config, **default 168** (7
  days), read code-side with a `?? "168"` fallback (the established pattern; no
  seed row needed). Deliberately wider than atproto's 24h: Nostr long-form
  authors post infrequently, and the whole point is a non-empty profile/feed on
  follow. Feed placement is `published_at`-ordered, so week-old posts land deep
  in the feed, not at the top; the item cap (§2.3) bounds volume for chatty
  accounts.

### 2.6 Repair: relay-less sources stop being skipped

Per corrected §1.4, `feed-ingest-nostr.ts` currently *skips* a source whose
`relay_urls` is empty — permanently dead ingest. Change the skip to a
fallback: `const relays = source.relay_urls?.length ? source.relay_urls :
NOSTR_FALLBACK_RELAYS` (the constant already exists in
`feed-ingest/src/lib/nostr-relay.ts:29`). Do **not** write the fallback set
into the row — it's a query-time default, not discovered author data (§2.2's
NIP-65 persistence is the durable fix, and it only reaches sources that get a
backfill). This one-liner also resurrects any pre-existing subscribed sources
that were minted without relay hints.

---

## 3. Part B — profile-view timeline hydration

On-demand, best-effort hydration of an external author's recent timeline into
the DB substrate the `/posts` endpoint already reads — the profile twin of
thread hydration (`hydrateExternalThreadContext`). Ship Nostr first (§3.6);
the trigger, persistence and client contract are protocol-agnostic.

### 3.1 Trigger and contract

In the `/posts` handler (`gateway/src/routes/author.ts`), external-author
branch, first page only (no cursor):

1. Run the existing DB query.
2. If hydration would run (kill switch §3.7 on, protocol supported, AND
   per-author TTL guard clear — a module-level `Map<authorId, until>`
   mirroring `hydrateGuard`'s shape *including its size-capped eviction*
   (`external-hydration.ts:77,517-519`), but with a **10-minute** TTL rather
   than its 60s), kick `hydrateAuthorTimeline(xa)` **in the background**
   (`void`, never awaited — mind the root eslint no-floating-promises gate)
   and include `hydrating: true` in the response.
3. Client behaviour (`AuthorProfileView.tsx`): when `hydrating` and the page
   came back empty (or short), show a quiet "fetching recent posts from the
   network…" line and refetch once after ~2.5s (single retry, then rest — the
   thread projector's established pattern).

Trigger on *empty or not*: hydrate whenever the guard is clear, not only when
the log is empty — a stale cache (last hydrated a month ago, since GC'd or
gone quiet) should refresh on view. The TTL guard is what bounds cost.

### 3.2 Persistence — where unsubscribed authors' rows live

`external_items.source_id` is NOT NULL, and an unsubscribed author often has no
source row. Hydration therefore **upserts a shadow source row**. Because
`ON CONFLICT DO NOTHING RETURNING id` returns no row on conflict, this is a
two-step:

```
INSERT INTO external_sources (protocol, source_uri, is_active, relay_urls, …)
VALUES ($protocol, $followUri, FALSE, …)
ON CONFLICT (protocol, source_uri) DO NOTHING
RETURNING id
-- no row returned ⇒ row exists ⇒
SELECT id FROM external_sources WHERE protocol = $1 AND source_uri = $2
```

Never touch `is_active` on an existing row — a real subscribed source must not
be flipped, and a previously shadowed row stays shadowed.

- `source_uri` = `authorFollowUri(xa)` (`routes/author.ts:103`) — the same
  identity the subscribe path keys on, so a later real subscribe lands on this
  exact row (the `addSource` upsert reactivates it). The unique constraint
  this conflicts on exists: `unique_source UNIQUE (protocol, source_uri)`.
- `is_active = FALSE` ⇒ the poll scheduler never fetches it
  (`feed-ingest-poll.ts` selects `WHERE is_active = TRUE`).
- No `external_subscriptions` row is written — **the feed-derived-subscriptions
  invariant is untouched**; this is a storage anchor, not a follow.
- `external_sources_gc` treats it as an orphan: deactivate (no-op) after grace,
  hard-delete + cascade after the 90-day cull. That is the intended lifecycle —
  profile-hydrated history is a self-refreshing cache, not an archive.
  **Verified 2026-07-06 — no work needed on re-subscribe:** `addSource`
  already clears the orphan stamp on *both* of its paths (`SET is_active =
  TRUE, orphaned_at = NULL` — existing-id branch `sources.ts:284`, and the
  `(protocol, source_uri)` upsert `sources.ts:361-362`), and the GC's cull
  additionally re-checks `NOT EXISTS external_subscriptions` as a belt. A
  later real subscribe cleanly reactivates a shadow row.
- For Nostr, persist the NIP-65 write relays onto the shadow row's
  `relay_urls` (same union/cap rule as §2.2) so a later real subscribe
  inherits a working relay set.

Authors with no derivable `authorFollowUri` (shouldn't occur for tier-A/B
nostr/atproto/activitypub, but the function can return null) are simply not
hydrated.

### 3.3 Row marking — in the profile, out of the feeds (migration)

Hydrated timeline rows must be excluded from feeds (nobody chose this source)
but *included* in `/posts` — the exact filter `is_context_only` was built to
enforce in the opposite direction. Rather than a parallel exclusion mechanism:

- **Migration 148** (`148_external_items_profile_hydrated.sql`):
  `ALTER TABLE external_items ADD COLUMN is_profile_hydrated boolean NOT NULL
  DEFAULT FALSE;` (+ the usual `schema.sql` regeneration + `_migrations` seed
  + drift-guard run — note the guard's residual gap is exactly `ADD COLUMN`,
  so the regenerate-and-seed-in-one-step discipline is load-bearing here). No
  new index: `/posts` is driven by the `feed_items` author index; the flag is
  a post-join residual filter.
- Hydrated timeline rows are written with `is_context_only = TRUE` **and**
  `is_profile_hydrated = TRUE`. They inherit, for free: feed exclusion (the
  workspace feed query `gateway/src/routes/feeds/items.ts` and the source
  surface `gateway/src/routes/sources.ts` both filter on `is_context_only`),
  GC (`external-context-gc`, 30-day retention — its predicate
  `is_context_only = TRUE` needs no change), and the thread projector's
  ability to expand them.
- `/posts` filter becomes:
  `AND (ei.is_context_only IS NOT TRUE OR ei.is_profile_hydrated IS TRUE)`.
- Real ingest promotion (§4.2) clears both flags — once the author is actually
  subscribed, their rows graduate to first-class and stop being GC bait.

### 3.4 Writer reuse

Persist through `persistHydratedThreadNodes`
(`gateway/src/lib/external-hydration.ts:97`) extended with an options arg
(`{ profileHydrated?: boolean }`):

- **Insert path:** `is_profile_hydrated` = the option (TRUE for profile
  hydration, FALSE — today's behaviour — for thread hydration).
- **Conflict path:** add to the existing `DO UPDATE SET` list:
  `is_profile_hydrated = external_items.is_profile_hydrated OR
  EXCLUDED.is_profile_hydrated`. The OR gives exactly the right lattice:
  thread hydration (EXCLUDED = FALSE) never changes anything; profile
  hydration *graduates a pre-existing thread-context row of this author into
  the profile view* (without it, such a row would block the insert and the
  post would stay invisible in `/posts` — the §1.5 one-way door in miniature);
  and setting the flag on an already-real row is harmless (real rows pass the
  `/posts` filter via `is_context_only IS NOT TRUE` regardless, and GC only
  looks at `is_context_only`).
- **Never demote:** the existing conflict path already leaves
  `is_context_only` untouched (verified — the `SET` list gap-fills
  linkage/content only), so hydration colliding with a really-ingested row
  cannot mark it context. Keep it that way; §4.2 is the promotion mirror.

The dual-write, dedup/gap-fill `ON CONFLICT`, and the identity trigger (which
mints `post_id`/`external_author_id`, attributing rows to the same
`external_authors` record the profile is keyed on) are exactly what's needed.

### 3.5 `hydrateAuthorTimeline` — per-protocol fetchers

New `gateway/src/lib/author-timeline-hydration.ts` (sibling of
`external-hydration.ts`; same never-throws, bounded, logged posture).

**nostr_external (phase 1):**
1. Relay set: NIP-65 write relays (§4.1) ∪ shadow/real source `relay_urls` ∪
   `NOSTR_FALLBACK_RELAYS`, cap 6.
2. One REQ via the existing gateway-side `fetchNostrEvents(relays, filters,
   timeoutMs)`: `{ kinds: [1, 30023], authors: [pubkey], limit: 50 }` plus
   `{ kinds: [0], authors: [pubkey], limit: 1 }` in the same REQ, ~6s timeout
   (the thread-hydration budget). No paging — this is a request-path warm, not
   an archive pull; depth is Part A's job.
3. Validate (pubkey match + `verifyEvent` — gateway has `nostr-tools ^2.3.0`,
   so the verifier is available. The gateway path currently trusts relays for
   thread hydration; author timelines feed a profile claiming to BE this
   author, so verification is required here).
4. Normalise via `normaliseNostrThreadNode(event, relays, profile)`
   (`nostr-thread.ts:141`) with the kind-0 parsed through the existing
   `parseNostrProfile` — relay-free URIs guaranteed by construction.
5. Persist per §3.3/§3.4.

**atproto (phase 2):** one `app.bsky.feed.getAuthorFeed` page (public AppView,
no auth; `filter=posts_no_replies`, limit 30), mapped through the existing
`collectBlueskyThreadNodes`-style extraction (`external-items-shared.ts`
helpers).

**activitypub (phase 2):** actor outbox first page (public JSON-LD; the
`feed-ingest-activitypub` adapter's parsing, or the Mastodon REST
`/api/v1/accounts/:id/statuses` fallback the profile header already uses).

**rss/email (tier C/D):** out of scope — no `external_authors` record, no
`/author` route (plain-text bylines).

### 3.6 Phasing

1. §4 groundwork + migration.
2. Nostr hydration (the acute gap — and the cheapest: indexer relays like
   nostr.band aggregate most authors).
3. atproto + activitypub hydration (both are one public GET each; small).

### 3.7 Kill switch

`AUTHOR_TIMELINE_HYDRATION_ENABLED` (gateway env, default **on**; `"0"` /
`"false"` disables). Part B is the platform's first *request-path-triggered*
outbound fetch fan-out; even bounded and backgrounded, it deserves an operator
brake that doesn't need a deploy. Checked once at the §3.1 trigger — when off,
the response simply omits `hydrating` and behaviour is exactly today's.

---

## 4. Shared groundwork

### 4.1 NIP-65 helper — parse in `shared/`, fetch per package

Both packages need this (Part A runs in feed-ingest, Part B in gateway), but
`shared/` should not grow `ws`/`nostr-tools` dependencies. Split it:

- **`shared/src/lib/nip65.ts`** — the pure parser, no deps:
  `pickNostrWriteRelays(events: {created_at, tags}[]): string[]`. Keep the
  newest event by `created_at`; take `r` tags with no marker or marker
  `write`; scheme-check (`wss://`/`ws://`), dedupe, cap 8. Empty/no event ⇒
  `[]`. Unit-tested in `shared/` (markers, malformed tags, newest-wins, cap).
- **`gateway/src/lib/nostr-relay.ts`** —
  `fetchNostrWriteRelays(pubkey, hintRelays)`: one
  `fetchNostrEvents(hints ∪ NOSTR_FALLBACK_RELAYS, [{ kinds: [10002],
  authors: [pubkey], limit: 1 }], 6000)` (collect from all relays, the parser
  picks the newest) → `pickNostrWriteRelays`.
- **`feed-ingest/src/lib/nostr-ingest.ts`** (§4.3) — a twin wrapper over the
  generic relay fetch extracted there, calling the same shared parser. The
  parsing rules therefore cannot drift between packages.

Callers fall back to hints + `NOSTR_FALLBACK_RELAYS` on `[]`. All sockets stay
on `pinnedWebSocketOptions` (SSRF invariant) — both packages' relay runners
already do.

### 4.2 Promotion on real ingest (standalone bug fix — see §1.5)

**nostr** (the writer extracted in §4.3): on conflict,

- extend the ratchet gate:
  `WHERE external_items.published_at < EXCLUDED.published_at
   OR external_items.is_context_only IS TRUE`
  (so a pure promotion — identical event, equal `published_at` — runs);
- extend the `SET` list: `is_context_only = FALSE, is_profile_hydrated =
  FALSE, source_id = EXCLUDED.source_id`. The `source_id` re-home is
  load-bearing, not hygiene: context rows carry the hydrating focal's
  `source_id`, and kind-5 deletion application matches on `source_id` — a
  promoted row left on the foreign source would dodge its author's deletions
  forever. Unconditional assignment is safe: only the author's own source
  ever polls their events, so `EXCLUDED.source_id` differs from the stored
  value only in the promotion case.
- the `feed_items` dual-write's `DO UPDATE SET` likewise gains
  `source_id = EXCLUDED.source_id` (feed membership queries resolve through
  `feed_sources.source_id`, so an un-re-homed promoted post would surface in
  the *wrong* feeds — or none). Its refresh of title/preview/`deleted_at`
  already runs whenever the `external_items` write went through, so a
  promoted post enters feed queries with no further change.

**atproto** (`atproto-ingest.ts:72,115`) and **activitypub**
(`activitypub-ingest.ts:46,88`): both writers are `ON CONFLICT DO NOTHING` and
collide with thread-hydration context rows today. Convert each to a
promotion-*gated* update that preserves exact `DO NOTHING` semantics for real
rows:

```sql
ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
  is_context_only = FALSE,
  is_profile_hydrated = FALSE,
  source_id = EXCLUDED.source_id,
  deleted_at = NULL
WHERE external_items.is_context_only IS TRUE
RETURNING id
```

— a real row makes the `WHERE` false, no row returns, and callers (which
already treat "no row" as already-present) are unaffected; a context row
returns its id, and the writer then applies the same promotion-gated refresh
(`source_id`, preview fields, `deleted_at = NULL`) to the `feed_items` row the
hydration dual-write left behind.

This ships in groundwork, before either part, as its own commit — it fixes a
live bug (a subscribed author's post that was thread-hydrated first is
invisible today).

### 4.3 Extract `insertNostrItem`

Factor the poll job's per-event machinery out of `feed-ingest-nostr.ts` into
`feed-ingest/src/lib/nostr-ingest.ts`, mirroring `insertAtprotoItem` — the
backfill task and the poll job must share one writer so identity encoding,
ratchet semantics, and the §4.2 promotion can't drift. Contents:

- the `NostrEvent` shape + per-event validation (future-drift window, pubkey
  match, `verifyEvent`);
- `nostrEventUri`/`nostrAddrUri`/`isParameterizedReplaceable` +
  `normaliseNostrEvent` (C1: one encoder for every write path in the package);
- `insertNostrItem` — the per-event transaction (external_items ratchet
  upsert + feed_items dual-write), carrying the §4.2 promotion;
- the kind-5 deletion applier;
- `detectNostrRepost` (moves along; update the `repost-detect.test.ts`
  import);
- the source metadata (kind-0) newest-wins ratchet, so §2.3's first-page
  profile refresh reuses it;
- `fetchNostrRelayEvents(relayUrl, filters, wsOpts, timeoutMs)` — the
  existing `fetchFromRelay` generalised to take a filter array (the poll
  passes its current two filters verbatim; the backfill passes the `until`
  pager; the NIP-65 twin passes the kind-10002 filter).

`feed-ingest-nostr.ts` becomes orchestration only (load source, cursor math,
loop, source bookkeeping). This step is behaviour-identical except for §4.2;
existing tests must pass with import-path changes only.

---

## 5. Cost & abuse posture

- Part A: one bounded task per new subscription (≤5 REQ pages × ≤6 relays,
  10s/relay timeout) — same envelope as the atproto backfill.
- Part B: rides `/posts`'s existing 60/min per-user rate limit
  (`author.ts:461`), plus the per-author 10-min TTL guard shared across
  viewers; a hot profile hydrates once, not per viewer. Fetches are bounded
  (one REQ / one page, caps above) and background — the response never waits
  on relays. Operator kill switch: §3.7.
- Storage: shadow sources + hydrated rows are GC'd (30-day context GC for
  items, 90-day source cull) — steady-state size tracks *recently viewed*
  authors only.

## 6. Resolved decisions (were open questions)

1. **Backfill depth** — 168h / 200 items stands, one window for all kinds.
   The config key allows retuning without a deploy; a per-kind split (deeper
   for 30023 long-form) is a later refinement if real profiles look thin.
2. **Bridged authors (Slice 8)** — hydration keys strictly off the one
   `external_authors` row; cross-identity dedup is feed-read-time
   (`dedup-sql.ts`) and structurally unaffected. Covered by a test in Phase 3
   (hydrated rows for a linked author don't suppress or get suppressed in
   `/posts`, which doesn't dedup), not by code.
3. **Ephemerality** — accepted: profile history for unfollowed authors
   truncates to ~50 items / 30 days by design. Revisit only if profiles grow
   a "load full history" affordance (which would want Part A's pager exposed
   on demand).

---

## 7. Build plan

Four phases, each independently shippable and gated. Phase 1 fixes a live bug
on its own; Phases 2 and 3 are Parts A and B (nostr); Phase 4 extends Part B.
Order within a phase is the build order.

### Phase 1 — Groundwork (+ the §4.2 bug fix)

**1.1 Migration 148** — `migrations/148_external_items_profile_hydrated.sql`:

```sql
ALTER TABLE external_items
  ADD COLUMN is_profile_hydrated boolean NOT NULL DEFAULT FALSE;
```

Apply to dev (`npx tsx shared/src/db/migrate.ts`), regenerate `schema.sql`
from a throwaway fully-migrated DB **and** re-append the `_migrations` seed
(now including 148) in the same step, then run
`scripts/check-schema-drift.sh` — must exit 0. The column must ship before any
code that references it (1.3 onwards); it's additive with a default, so old
code is unaffected — on prod, run the migration before restarting services.

**1.2 NIP-65 parser + wrappers** (§4.1) —
`shared/src/lib/nip65.ts` (pure) + `fetchNostrWriteRelays` in
`gateway/src/lib/nostr-relay.ts`. The feed-ingest twin lands with 1.3 (it
needs the generic fetch extracted there).
*Tests:* shared vitest — marker selection (`write`/no-marker in, `read` out),
newest-wins across multiple 10002s, scheme rejection, dedupe, cap, empty ⇒
`[]`.

**1.3 Extract `feed-ingest/src/lib/nostr-ingest.ts`** (§4.3) — mechanical
move + `fetchFromRelay` generalisation + the feed-ingest NIP-65 wrapper.
Behaviour-identical; `feed-ingest-nostr.ts` shrinks to orchestration.
*Gate:* existing feed-ingest tests pass with only import-path updates.

**1.4 Promotion fix** (§4.2) — in the freshly extracted nostr writer, plus
`insertAtprotoItem` and the activitypub writer.
*Tests (feed-ingest vitest, against a test DB or the query-shape harness the
existing ingest tests use):*
- context row + real ingest of the identical event (equal `published_at`) ⇒
  promoted: both flags FALSE, `source_id` re-homed on **both** tables,
  `feed_items.deleted_at` NULL;
- real row + re-ingest ⇒ atproto/AP writers still no-op (the `DO NOTHING`
  contract), nostr ratchet still blocks non-promotions;
- promoted nostr row is then hit by its author's kind-5 ⇒ deletion lands
  (the `source_id` re-home rationale, proven);
- thread hydration onto a real row ⇒ still never demotes.

*Phase gate:* `npm run test` in `shared/` + `feed-ingest/`; root `npm run
lint` at 0 errors; `scripts/check-schema-drift.sh` exit 0. Commit and (if
desired) deploy — the promotion fix is user-visible value on its own.

### Phase 2 — Part A: `feed_ingest_nostr_backfill`

**2.1 The task** — `feed-ingest/src/tasks/feed-ingest-nostr-backfill.ts` per
§2.2–§2.5, built entirely on `nostr-ingest.ts` (writer, validation, deletion
applier, metadata ratchet, generic fetch) + the NIP-65 wrapper. Register in
`feed-ingest/src/index.ts` `taskList` as `feed_ingest_nostr_backfill`.

**2.2 Enqueue switch** — `externalFetchTask()` returns
`feed_ingest_nostr_backfill` for `nostr_external`; both `add_job` call sites
in `gateway/src/routes/feeds/sources.ts` (≈:288, :387) use the **distinct**
key `'feed_ingest_backfill_' || sourceId` *for the backfill task only* (other
protocols keep the current key), `max_attempts := 1` as today. Update the
`externalFetchTask` comment block (nostr now backfills; the poll scheduler
owns steady state).

**2.3 Relay-less repair** (§2.6) — the poll job falls back to
`NOSTR_FALLBACK_RELAYS` instead of skipping.

*Tests (feed-ingest vitest, relay fetch mocked):*
- pager: `until` descends past each page's oldest accepted event; stops on
  cutoff / empty page / `MAX_PAGES` / 200-item cap;
- relay set: NIP-65 ∪ hints ∪ fallbacks dedup + cap 6; persistence unions
  onto `relay_urls` keeping user entries, cap 10;
- cursor: `GREATEST`-style forward-only handoff when a concurrent poll
  advanced it first;
- identity: a backfilled kind-1 and kind-30023 mint byte-identical
  `source_item_uri`s to the poll path (C1);
- enqueue: `nostr_external` maps to the backfill task under
  `feed_ingest_backfill_<id>` (guards the §2.1 collision from regressing).

*Phase gate:* feed-ingest + gateway tests; root lint. *Manual verify (dev):*
add a known long-form Nostr author to a feed → `external_items` rows older
than 48h appear; `external_sources.relay_urls` gained the author's write
relays; next poll tick is incremental (cursor advanced); `/author/:id` shows
the history.

### Phase 3 — Part B: profile-view hydration (nostr)

**3.1 Writer options** (§3.4) — `persistHydratedThreadNodes` gains
`{ profileHydrated?: boolean }`; insert value + the OR-fold on conflict.

**3.2 Hydration lib** (§3.5 nostr + §3.2 shadow source) —
`gateway/src/lib/author-timeline-hydration.ts`: kill-switch check, shadow
source two-step upsert, NIP-65 + relay-set assembly, one `fetchNostrEvents`
REQ, `verifyEvent` + pubkey validation, `normaliseNostrThreadNode`, persist
with `profileHydrated: true`, NIP-65 persistence onto the shadow row.
Never-throws: every failure logs and returns.

**3.3 Route change** (§3.1 + §3.3) — `gateway/src/routes/author.ts` `/posts`:
the widened filter
(`AND (ei.is_context_only IS NOT TRUE OR ei.is_profile_hydrated IS TRUE)`),
the 10-min TTL guard, the `void hydrateAuthorTimeline(xa)` kick, `hydrating:
true` in the first-page response.

**3.4 Client** — `web/src/lib/api/post.ts` `authorPosts` return type gains
`hydrating?: boolean`; `AuthorProfileView.tsx` initial-load effect: when
`hydrating`, schedule one ~2.5s refetch of the first page (respecting the
effect's `cancelled` flag; replace `items` + `cursor` from the refetch) and,
while waiting with an empty log, render the quiet status line (design tokens,
not hand-rolled sizes — `text-ui-xs text-grey-600` or `.label-ui` register).

*Tests:*
- gateway vitest: filter matrix over the four flag combinations (real row in;
  pure context row out; profile-hydrated row in; promoted row in);
  shadow-source two-step (fresh insert / existing active source untouched /
  existing shadow reused); TTL guard (second request within 10 min doesn't
  re-kick; `hydrating` only on first page); kill switch off ⇒ no kick, no
  flag; OR-fold (thread-hydration write never flips the flag, profile write
  graduates an existing context row);
- the §6.2 bridged-author case: hydrated rows keyed to one
  `external_authors` row don't leak into a linked twin's `/posts`.

*Phase gate:* gateway + web tests; root lint 0 errors; `next build`
pre-flight; `scripts/check-hairlines.sh <touched web files>`; then
`docker compose build web` + a user-performed restart for the runtime check.
*Manual verify (dev):* open `/author/:id` for a never-subscribed Nostr author
→ first response `hydrating: true`, status line shows, refetch renders posts;
`external_sources` gained an `is_active = FALSE` row keyed on the author's
64-hex pubkey with **no** `external_subscriptions` row; then add that author
to a feed → the shadow row reactivates (`is_active = TRUE`, `orphaned_at`
NULL), backfill runs, and the hydrated rows promote (flags cleared,
`source_id` re-homed) and appear in the feed.

### Phase 4 — Part B: atproto + activitypub fetchers

One public GET each (§3.5 phase 2), plugged into the Phase-3 frame: extend
`hydrateAuthorTimeline`'s protocol switch; no new persistence, trigger, or
client work. Tests mirror Phase 3's per-protocol normalisation cases.

### Definition of done

- [ ] Migration 148 applied; `schema.sql` regenerated + seeded; drift guard exit 0
- [ ] Promotion bug fixed in all three writers, with the kind-5 re-home test
- [ ] Poll job no longer skips relay-less sources
- [ ] Subscribe to a Nostr author ⇒ ≥7-day history within one job run, under a job key the poll can't clobber
- [ ] Unfollowed-author profile ⇒ posts within ~3s, no `external_subscriptions` row, no feed leakage
- [ ] Later subscribe of a hydrated author ⇒ shadow row reactivated, rows promoted
- [ ] Root lint 0 errors; all service test suites green; `next build` clean; hairline check clean on touched files
- [ ] Kill switch verified both ways
