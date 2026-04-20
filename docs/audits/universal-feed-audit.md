# Universal Feed — Audit Findings

Deep code audit of Phases 1–5B (migrations 052–059, feed-ingest service, gateway routes/libs, shared libs, web components).

Issues are grouped by severity. Each entry has a problem description, file/line reference, and a concrete fix.

**Status (2026-04-14, pass 2):** All pass-1/pass-2 audit items resolved. Pass 1 closed C1–C4, S2, S3, S5, S6, D1, D2, and partial S1. Pass 2 closed S1 pinning (undici Agent with `connect.lookup` hook), S4 (initiator binding via new `resolver_async_results` table), K1–K6, D3 (DB-backed resolver results, migration 061 + 5-min prune cron), D4 (protocol-specific OAuth state cookies), D5 (requireAuth on Bluesky callback), D6 (key version byte with multi-key decryption), and the remaining minors (Nostr last_error truncation, resolver ILIKE escape, enqueueCrossPost transactional).

**Status (2026-04-15, pass 3):** Deep second-look audit opened new items C5–C8, S7–S11, K7–K15, D7–D9 below — none overlap with pass-1/pass-2 fixes. Most critical: forged-signature and arbitrary-author deletions in external Nostr ingestion (C6/C7), broken explore-feed pagination (C5), and non-transactional article soft-delete dual-write (C8).

**Status (2026-04-15, pass 3 triage complete):** All 21 pass-3 items resolved across migrations 062–064 and code changes in feed-ingest, gateway, shared, and web. Notable: undici Agent-pinned IPv6 + WebSocket DNS pinning (S7/S11), env-controlled crypto key rotation (S8), `NULLS NOT DISTINCT` unique constraint on `outbound_posts` for idempotent cross-posts (K7), grapheme-aware truncation via `Intl.Segmenter` shared across Bluesky and Mastodon adapters (K15), daily `external_sources_gc` task with `orphaned_at` grace/cull windows (K11), and per-initiator row cap on `resolver_async_results` (D8). `feed_items_reconcile` now logs drift at WARN with per-case counts so dual-write regressions surface on-call (D7).

---

## Critical

These are broken behaviours affecting production paths. Fix these first.

### C1. Explore feed silently discards score ranking — ✅ FIXED

**Problem:** The SQL query orders by `score DESC`, but a post-merge `sort()` in JS re-orders everything chronologically. The entire scoring pipeline is invisible to users — the "explore" tab is currently a recency feed with a misleading name.

**Location:** `gateway/src/routes/feed.ts:291-302`

```js
const items = [...contentRes.rows.map(...), ...newUsersRes.rows.map(...)]
items.sort((a, b) => (b.publishedAt ?? b.joinedAt) - (a.publishedAt ?? a.joinedAt))
```

**Fix:**
- Either interleave content + new-user items without resorting (preserve SQL ordering for content, insert new-user rows at fixed positions), or
- Drive everything through a single query with `UNION ALL` and `ORDER BY score DESC, published_at DESC`.

---

### C2. Jetstream listener is not leader-elected — ✅ FIXED

**Problem:** The Bluesky Jetstream WebSocket listener runs at module load, so any replica of feed-ingest opens its own connection. At >1 replica you get duplicate ingestion, doubled DB pressure, and cursor contention. Nothing enforces the single-replica assumption documented in `CLAUDE.md`.

**Location:** `feed-ingest/src/jetstream/listener.ts`

**Related issue (same file):** `refreshDids()` uses `setInterval(…, 60_000)` that fires regardless of whether the previous refresh is still in flight — on a slow DB this produces overlapping reconnect storms.

**Fix:**
- Wrap listener startup in `pg_try_advisory_lock(<const>)`; only the holder runs the WS. Release on shutdown; other replicas poll for the lock periodically.
- For `refreshDids`: replace `setInterval` with a self-scheduling `setTimeout` that only re-arms after the previous run completes.

---

### C3. RSS `fetch_interval_seconds` never resets after errors resolve — ✅ FIXED

**Problem:** When an RSS feed errors, the interval is exponentially backed off (up to ~5 h after a few failures). The success-path UPDATE resets `error_count` and `last_error` but **not** `fetch_interval_seconds`. Once a feed recovers, it stays stuck on the backed-off schedule indefinitely.

**Location:** `feed-ingest/src/tasks/feed-ingest-rss.ts:144-154`

**Fix:** Reset `fetch_interval_seconds` to the default (load from `platform_config` or hard-code 300s) in the success UPDATE:

```sql
UPDATE external_sources SET
  last_fetched_at = now(),
  cursor = $2,
  display_name = COALESCE($3, display_name),
  description = COALESCE($4, description),
  error_count = 0,
  last_error = NULL,
  fetch_interval_seconds = 300,  -- add this
  updated_at = now()
WHERE id = $1
```

---

### C4. `action_type='quote'` on Mastodon posts unrelated content — ✅ FIXED

**Problem:** The outbound cross-post dispatcher's activitypub branch only handles `action_type='reply'`. When a user clicks "Quote" on a Mastodon card, the worker silently posts a top-level status with no reference to the source — worse than a visible error because the user doesn't know it failed.

**Location:** `feed-ingest/src/tasks/outbound-cross-post.ts:108-118`

**Fix:** Either:
- Reject `actionType='quote'` at enqueue time for activitypub accounts in `gateway/src/lib/outbound-enqueue.ts`, returning a clear error to the UI; or
- In the adapter, append the source URL to the body when `actionType='quote'` (Mastodon has no native quote-post semantics; link-appending is the conventional workaround).

Recommended: do both — reject at enqueue *and* have the adapter treat unknown actionType as a bug not silent success.

---

### C5. Explore feed pagination is broken at cursor boundaries — ✅ FIXED

**Problem:** `exploreFeed` orders by `fi.score DESC, fi.published_at DESC` but its cursor filter is only `AND EXTRACT(EPOCH FROM fi.published_at)::bigint < $3`. The cursor carries `ts` (published_at of the last row on page N), not score. Because page N was sorted by `score DESC` first, its last row can have an arbitrary score and a high published_at. Page N+1 then:
- returns items with higher scores than some items on page N (duplicates across pages), and
- silently drops items whose `published_at > cursor.ts` that weren't in page N's top-N by score (items lost forever).

**Location:** `gateway/src/routes/feed.ts:248-276`

**Fix:** Make the cursor a compound `(score, published_at, id)` tuple and use a keyset filter `AND (fi.score, fi.published_at, fi.id) < ($3, to_timestamp($4), $5::uuid)`. `followingFeed` already uses the compound pattern — mirror it.

---

### C6. No Nostr event signature verification — ✅ FIXED

**Problem:** Events received from external Nostr relays are inserted into `external_items` as-is. No `verifyEvent` / `verifySignature` call anywhere in `feed-ingest/`. A hostile relay (or any relay that accepts unsigned/forged events) can ship events claiming any pubkey — including the source's — and we ingest them as that author. `nostr-tools` (already imported for `nip19`) exposes `verifyEvent` — we just don't call it.

**Location:** `feed-ingest/src/tasks/feed-ingest-nostr.ts:89-101`

**Fix:** Call `verifyEvent(event)` from `nostr-tools` inside the per-event loop; drop events whose signature is invalid or whose `pubkey` doesn't match `source.source_uri`.

---

### C7. Kind-5 deletions accept arbitrary pubkey — ✅ FIXED

**Problem:** The delete loop matches on `(source_id, interaction_data->>'id')` but never checks the deletion event's `pubkey` against the deleted event's author. Any kind-5 received over the source's relays tombstones any id it references. Combined with C6 (no signature verification), a hostile relay can trivially delete any content we've ingested from that source.

**Location:** `feed-ingest/src/tasks/feed-ingest-nostr.ts:184-211`

**Fix:** Require `delEvent.pubkey === source.source_uri` (and require a valid signature per C6) before applying each deletion. Reject with a log line otherwise.

---

### C8. Article soft-delete dual-write is not transactional — ✅ FIXED

**Problem:** `DELETE /articles/:id` runs two sequential `pool.query` calls: `UPDATE articles SET deleted_at = now()` then `UPDATE feed_items SET deleted_at = now()`. If the second fails (connection drop, constraint violation, process kill), the article is tombstoned but `feed_items` retains live rows pointing at a deleted article — it stays in everyone's following feed until the 05:00 `feed_items_reconcile` cron catches it. Up to 24h of stale-live drift.

**Location:** `gateway/src/routes/articles.ts:809-817`

**Fix:** Wrap both UPDATEs in `withTransaction`. Same pattern for any future soft-delete dual-write path.

---

## Security

### S1. DNS-rebinding TOCTOU in `safeFetch` — ✅ FIXED (IP ranges extended + DNS pinned)

**Problem:** `validateHost()` resolves a hostname to IPs and checks against private ranges, then `fetch()` performs its own independent DNS lookup. A hostile DNS server can return a public IP during validation and a private IP for the actual request. The IP-range check doesn't cover:
- IPv4-mapped IPv6 (`::ffff:127.0.0.1`)
- Multicast (224.0.0.0/4)
- IPv6 unique-local (fc00::/7)

**Location:** `shared/src/lib/http-client.ts:45-102`

**Fix:**
- Pin the resolved IP: build a custom `undici` Dispatcher with a `connect` hook that uses the already-validated address.
- Extend IP range checks to cover IPv4-mapped IPv6, multicast, and ULA.
- Defence in depth: run feed-ingest and gateway in a network namespace that blocks RFC1918 egress.

---

### S2. No SSRF validation on Nostr WebSockets — ✅ FIXED

**Problem:** Both Nostr ingestion and Nostr outbound feed `relay_urls` (user-provided via `POST /feeds/subscribe`) directly into `new WebSocket(url)` with no validation. A user can subscribe with `relay_urls: ["ws://169.254.169.254/..."]` and cause the service to probe cloud-metadata or internal endpoints. `safeFetch` exists for HTTP but was never extended to WS.

**Locations:**
- `feed-ingest/src/tasks/feed-ingest-nostr.ts:243`
- `feed-ingest/src/adapters/nostr-outbound.ts`

**Fix:**
- Add a `validateWebSocket(url)` helper in `shared/src/lib/http-client.ts` that parses the URL, checks scheme is `wss:`/`ws:`, runs `validateHost()` on the hostname, then returns the resolved address.
- Call it before every `new WebSocket()`. Use the pinned address when constructing the socket, the same way the TOCTOU fix for S1 works.

---

### S3. Future-timestamp cursor poisoning on Nostr sources — ✅ FIXED

**Problem:** The Nostr adapter advances its cursor to `max(event.created_at)` from received events, but `created_at` is attacker-controlled. A hostile relay can send an event with `created_at = 4102444800` (year 2100), and the cursor is then locked into the future — all subsequent polls use `since = <year 2100>`, excluding real events for ~75 years.

**Location:** `feed-ingest/src/tasks/feed-ingest-nostr.ts:166-204`

**Fix:** Reject events with `created_at > now() + drift_window` (e.g. 10 minutes) before using them to advance the cursor. The atproto adapter already has a 24h future-rejection window — mirror that pattern here.

---

### S4. `GET /resolve/:requestId` has no user binding — ✅ FIXED

**Problem:** The Phase B poll endpoint looks up `asyncResults` by requestId alone. UUID guessing is impractical, but nothing prevents user A from polling user B's resolve request if the UUID leaks (logs, referrer header, etc.). A resolver result may include emails, handles, or profile data the initiator wouldn't want exposed.

**Location:** `gateway/src/routes/resolve.ts`

**Fix:** Store `{ result, expiresAt, initiatorId }` in `asyncResults`. On GET, compare `initiatorId === req.session.sub`; return 404 if not (don't distinguish "not yours" from "doesn't exist").

---

### S5. Subscribe input not validated against declared protocol — ✅ FIXED

**Problem:** `POST /feeds/subscribe` accepts `{ protocol, sourceUri }` but never checks they're consistent. A user can submit `protocol=atproto, sourceUri=bogus-string` and downstream adapters crash or behave unexpectedly. `displayName`, `description`, and `avatarUrl` also pass through unsanitised and uncapped.

**Location:** `gateway/src/routes/feeds.ts` (the subscribe handler)

**Fix:** Per-protocol validation in the Zod schema or a refine step:
- `rss`: `sourceUri` is a valid http(s) URL, length ≤ 2048
- `atproto`: `sourceUri` matches `^did:(plc|web):[a-zA-Z0-9.:_-]+$`
- `activitypub`: `sourceUri` is a valid https URL
- `nostr_external`: `sourceUri` is 64 hex chars (pubkey)
- `displayName`/`description`: length ≤ 200/1000, strip control chars
- `avatarUrl`: valid https URL, length ≤ 2048

---

### S6. `relayUrls` array has no cap or scheme check — ✅ FIXED

**Problem:** The subscribe handler accepts `relayUrls: string[]` as-is — no array length cap, no per-URL scheme validation. Combined with S2, this is the attack surface that makes Nostr WS SSRF exploitable.

**Location:** `gateway/src/routes/feeds.ts`

**Fix:**
- Cap array length at 10.
- Validate each URL: parse, require scheme `ws:` or `wss:`, length ≤ 2048.
- In prod, consider rejecting `ws:` entirely (insecure transport).

---

### S7. IPv6 SSRF bypass via non-canonical address notation — ✅ FIXED

**Problem:** `PRIVATE_RANGES` uses literal-string regexes like `/^::1$/`, `/^fe80:/i`, `/^fc00:/i`, `/^fd/i`. An attacker-controlled DNS record pointing at `0:0:0:0:0:0:0:1` or `::0001` (both valid RFC 5952 forms of loopback) or `fc00:0:0::1` (ULA) passes these regex checks. IPv4 octal/hex notations are usually rejected by Node's URL parser, but IPv6 inputs flow through `dns.resolve6` whose output isn't always canonicalised to the regex-expected form.

**Location:** `shared/src/lib/http-client.ts:28-51`

**Fix:** Normalise IPv6 addresses numerically before range checking: parse via `net.isIPv6` → expand to 8-group 16-bit words → range-check against a numeric table. The same pattern removes the entire class of regex-bypass bugs.

---

### S8. Crypto key rotation is unreachable without a code deploy — ✅ FIXED

**Problem:** `CURRENT_KEY_VERSION = 1` is a compile-time constant. `getKeyForVersion(1)` delegates to `getCurrentKey()` which reads `LINKED_ACCOUNT_KEY_HEX`. To rotate keys, the operator must:
1. Deploy new code with `CURRENT_KEY_VERSION = 2`,
2. Move old key to `LINKED_ACCOUNT_KEY_HEX_V1`,
3. Set new key as `LINKED_ACCOUNT_KEY_HEX`.

If the operator follows the obvious path (swap `LINKED_ACCOUNT_KEY_HEX` in place), every v1 row becomes undecryptable — the stored version byte still says 1, but the current key is now a different value. There's no env-controlled way to "rotate to v2" without shipping code. Pass-2 closed D6 by adding the version byte; the rotation workflow remains unusable in practice.

**Location:** `shared/src/lib/crypto.ts:25, 42-47`

**Fix:** Expose the current version as env (`LINKED_ACCOUNT_KEY_VERSION=2`) or re-key on a `LINKED_ACCOUNT_KEY_HEX_V{n}` naming convention where writes target whichever version is highest. Document the rotation runbook alongside the env var.

---

### S9. Avatar/media hotlinking leaks reader IP to source instances — ✅ FIXED

**Problem:** `ExternalCard` loads avatar URLs and embedded media (where visible) directly from Mastodon/Bluesky/source servers. Every render leaks the reader's IP + user-agent to the source instance, enabling fingerprinting of all.haus readers by any third-party instance. Particularly sensitive given the platform's "pay to read" model.

**Location:** `web/src/components/feed/ExternalCard.tsx`

**Fix:** Proxy avatars and media through the gateway (reuse `safeFetch` for SSRF safety) via a `/media/proxy?url=...` endpoint, cached aggressively. As a cheap interim, set `referrerpolicy="no-referrer"` on all external `<img>` tags — reduces but doesn't eliminate the leak.

---

### S10. Mastodon `Idempotency-Key` uses a weak 32-bit hash — ✅ FIXED

**Problem:** `hashIdempotency` is a 32-bit FNV-1a variant. Space is 2^32; birthday collision at ~65K distinct posts inside Mastodon's 24h dedup window. Per-account scoping limits the real-world blast radius, but:
- retries that *should* dedup can miss if Mastodon's internal scoping is broader than per-token,
- two different replies from the same user that happen to hash-collide → second is silently treated as a duplicate (user sees "sent" but remote has only the first).

**Location:** `feed-ingest/src/adapters/activitypub-outbound.ts:117-126`

**Fix:** Use `crypto.createHash('sha256').update(src).digest('hex').slice(0, 32)`. Negligible cost, zero-collision in practice.

---

### S11. `validateWebSocketUrl` DNS-rebinding TOCTOU still open — ✅ FIXED

**Problem:** `validateWebSocketUrl` performs the validation but does NOT pin the resolved IP — explicitly documented as an S1 follow-up. The `ws` library runs its own independent DNS lookup when it opens the socket. A hostile authoritative DNS server can answer a public IP during validation and `169.254.169.254` during the socket open.

**Location:** `shared/src/lib/http-client.ts:244-258` (plus callers: `feed-ingest-nostr.ts`, `nostr-outbound.ts`, `jetstream/listener.ts`)

**Fix:** The `ws` package accepts `agent` / `lookup` options on `WebSocket` construction. Build a custom `http.Agent` (or `https.Agent` for `wss:`) with a `lookup` hook that returns the pinned address, mirroring `buildPinnedAgent` for undici. Thread the agent into every `new WebSocket(url)` call.

---

## Correctness

### K1. Kind 5 deletion matching breaks if relay list changes — ✅ FIXED

**Problem:** Deletions are matched by recomputing the nevent URI from `{id, relays: source.relay_urls}`. But the original ingest stored a nevent using whatever `relay_urls` was at insert time. If `relay_urls` has since changed, the new nevent doesn't match the stored one, and the deletion is silently dropped.

**Location:** `feed-ingest/src/tasks/feed-ingest-nostr.ts:177`

**Fix:** Store the raw event id separately at ingest time in `external_items.interaction_data->>'id'` (already done — see line 335), then match deletions on that field directly:

```sql
UPDATE external_items SET deleted_at = now()
WHERE source_id = $1 AND protocol = 'nostr_external'
  AND interaction_data->>'id' = $2
  AND deleted_at IS NULL
```

---

### K2. RSS items beyond `maxItems` lost forever on first poll — ✅ FIXED

**Problem:** `result.items.slice(0, maxItems)` truncates before any item is stored, then the etag/lastModified are saved. A feed returning 200 items on its first poll will have items 51–200 permanently skipped — they'll never appear even on subsequent polls, because etag-gating jumps straight past them.

**Location:** `feed-ingest/src/tasks/feed-ingest-rss.ts:72`

**Fix:** Either:
- Process the *newest* `maxItems` (sort by `publishedAt` DESC first, then slice), so at worst the oldest history is the casualty — not the most recent content; or
- Schedule a follow-up job to process the remainder, only saving etag once the full set is consumed.

---

### K3. Bluesky truncation drops content without an all.haus link — ✅ FIXED

**Problem:** The truncator appends `…` when a reply exceeds 300 graphemes. Migration 057's `platform_config` description says "replies longer than the limit are truncated with an all.haus link" — the all.haus link is missing, so the Bluesky audience sees a cropped preview with no way to reach the full reply on all.haus.

**Location:** `feed-ingest/src/adapters/atproto-outbound.ts:89-102`

**Fix:** Build the all.haus canonical URL from the outbound row's `nostr_event_id`, compute its grapheme cost, and truncate the body to `max - linkLen - 2` (space + ellipsis) graphemes:

```ts
const link = `${ALL_HAUS_BASE}/n/${nostrEventId}`
const linkCost = graphemeCount(`\n\n${link}`)
const budget = max - linkCost
// truncate body to budget, append ellipsis, append link
```

Pipe `ALL_HAUS_BASE` into the adapter via env or `platform_config`.

---

### K4. `feed-ingest-poll` wastes slots on atproto sources when Jetstream is healthy — ✅ FIXED

**Problem:** The poll task selects up to 100 "due" sources each tick, then resolves a `taskName` for each. When `platform_config.jetstream_healthy=true`, atproto sources resolve to `null` (no polling needed) and are discarded — but they still consumed a slot in the `LIMIT 100`. High-volume deployments see RSS/ActivityPub sources starved while atproto rows are repeatedly picked and dropped.

**Location:** `feed-ingest/src/tasks/feed-ingest-poll.ts`

**Fix:** Add a SQL filter:

```sql
WHERE (protocol != 'atproto' OR $jetstream_healthy = false)
```

Read `jetstream_healthy` from `platform_config` once per poll tick and pass it as a parameter.

---

### K5. `AMBIGUOUS_AT` regex rejects valid emails with `+` addressing — ✅ FIXED

**Problem:** The regex `^[\w.-]+@[\w.-]+\.[\w]+$` excludes `+`, so inputs like `alice+tag@site.com` fall through to `free_text` classification and never trigger the ambiguous-identifier chain. `+` addressing is common (Gmail, Fastmail, etc.).

**Location:** `gateway/src/lib/resolver.ts:96`

**Fix:** Add `+` to the local-part character class:

```js
const AMBIGUOUS_AT = /^[\w.+-]+@[\w.-]+\.[\w]+$/
```

While you're there, consider extending the TLD match beyond `[\w]+` to handle multi-label TLDs (`.co.uk` etc.) — `[\w.]+` is enough.

---

### K6. `outbound_token_refresh` logs noise for missing sessions — ✅ FIXED

**Problem:** The cron selects dormant atproto `linked_accounts` rows and calls `client.restore(did, 'auto')`. If `atproto_oauth_sessions` was deleted out-of-band (or never existed), `restore()` throws and the row is flipped to `is_valid=false`. End state is correct, but each missing session produces a `warn`-level log entry that looks alarming.

**Location:** `feed-ingest/src/tasks/outbound-token-refresh.ts:64-92`

**Fix:** Filter the SELECT to only include rows that have a session:

```sql
WHERE protocol = 'atproto'
  AND is_valid = TRUE
  AND (last_refreshed_at IS NULL OR last_refreshed_at < now() - INTERVAL '7 days')
  AND EXISTS (
    SELECT 1 FROM atproto_oauth_sessions WHERE did = external_id
  )
```

Handle the no-session-found case separately — log it once at `info`, mark `is_valid=false`, move on.

---

### K7. `outbound_posts` has no UNIQUE constraint for idempotent cross-posts — ✅ FIXED

**Problem:** Migration 057 adds UNIQUE on `linked_accounts (account_id, protocol, external_id)` and on `oauth_app_registrations` — but not on `outbound_posts`. Two concurrent `POST /notes` with the same `crossPost` body (double-click, client retry) each hit `enqueueCrossPost`, each INSERT succeeds, worker processes both → duplicate cross-post on Mastodon/Bluesky. Mastodon's `Idempotency-Key` catches some cases; Bluesky has no equivalent.

**Location:** `migrations/057_universal_feed_outbound.sql` (table definition), `gateway/src/lib/outbound-enqueue.ts` (enqueue path)

**Fix:** Add `UNIQUE (account_id, nostr_event_id, action_type, protocol)` to `outbound_posts`. Catch the unique-violation in `enqueueCrossPost` and treat it as a no-op (job already enqueued). Same for `enqueueNostrOutbound`.

---

### K8. Nostr `deletionEvents` array is unbounded — ✅ FIXED

**Problem:** Regular events cap at `maxItems=50` via `slice(0, maxItems)`, but `deletionEvents` is a plain array filled from every relay with no cap. A chatty relay (legitimate or hostile) with long delete history can ship thousands of kind-5s per fetch cycle; we enumerate all of them and issue 2 UPDATEs per delete.

**Location:** `feed-ingest/src/tasks/feed-ingest-nostr.ts:80, 97-98`

**Fix:** Cap `deletionEvents.length` (sort by `created_at` DESC, keep newest N). Reasonable cap: same as `maxItems`, or a separate `feed_ingest_max_deletes_per_fetch` config key defaulting to 100.

---

### K9. External Nostr author metadata stuck at subscribe-time snapshot — ✅ FIXED

**Problem:** `normaliseNostrEvent` returns `authorName: null` / `authorHandle: null` always. The dual-write falls back to `source.display_name`, which is set once at subscribe and only refreshed by the daily `feed_items_author_refresh` cron. External Nostr ingestion never fetches kind-0 (profile) events, so if a source updates their name/avatar/NIP-05 it's invisible to readers until the cron runs — and even then only if something else populated the new metadata in `external_sources`.

**Location:** `feed-ingest/src/tasks/feed-ingest-nostr.ts:346-348`

**Fix:** Add `kind: [0]` to the `REQ` filter in `fetchFromRelay`; parse the profile JSON; UPDATE `external_sources.display_name` / `avatar_url` when newer than the stored metadata.

---

### K10. In-memory Jetstream cursor can regress across reconnects — ✅ FIXED

**Problem:** `source.cursor = String(timeUs)` is set from the latest event received, not `max(existing, event.time_us)`. Jetstream doesn't strictly order across accounts, and on reconnect the server can replay from an older `time_us` than a previous tick already acked. The DB cursor is fine (each ingest is idempotent on `source_item_uri`), but the in-memory copy used to build the next reconnect's `?cursor=` query param can regress, causing re-ingestion churn or a brief gap window.

**Location:** `feed-ingest/src/jetstream/listener.ts` (search for `source.cursor = String`)

**Fix:** Use `source.cursor = String(Math.max(Number(source.cursor ?? '0'), timeUs))`.

---

### K11. Orphaned `external_sources` after last unsubscribe — ✅ FIXED

**Problem:** `DELETE /feeds/:id` removes only the `external_subscriptions` row. The `external_sources` row and all its `external_items` remain forever, and the poll cron continues to fetch them. Over months of churn this grows unbounded and burns fetch budget on sources nobody subscribes to.

**Location:** `gateway/src/routes/feeds.ts:261-270`

**Fix:** After DELETE, check remaining subscribers for the source. If zero, either:
- flip `external_sources.is_active = FALSE` (poll skips inactive rows), or
- add a daily `external_sources_gc` task that deactivates sources with zero subscribers for >7 days and optionally deletes very old inactive rows.

Recommend the cron approach — lets a re-subscribe within a few days resurrect the source with its history intact.

---

### K12. Note dual-write uses `ON CONFLICT DO NOTHING` inconsistent with article's `DO UPDATE` — ✅ FIXED

**Problem:** Articles re-publish via `ON CONFLICT ... DO UPDATE`, keeping `feed_items` metadata in sync with the article. Notes use `ON CONFLICT DO NOTHING`, so any future note-edit feature (or the current soft-delete + repost workaround) leaves stale `content_preview` in `feed_items`. No user-visible bug today (notes are not editable), but it's a latent foot-gun.

**Location:** `gateway/src/routes/notes.ts` (note dual-write, around line 110)

**Fix:** Switch to `ON CONFLICT ... DO UPDATE SET content_preview = EXCLUDED.content_preview, updated_at = now()`. Matches the article pattern.

---

### K13. `POST /feeds/:id/refresh` has no per-user rate limit — ✅ FIXED

**Problem:** A logged-in user can POST to this endpoint in a loop. `graphile_worker.add_job` with the same `job_key` is idempotent (good — only one job ever runs), but each request still runs SELECT + INSERT against the jobs queue and, when the job fires, hits Mastodon/Bluesky. The gateway has `@fastify/rate-limit` registered globally — confirm whether this route falls under a restrictive bucket or inherits the default.

**Location:** `gateway/src/routes/feeds.ts:372-409`, `gateway/src/index.ts:95`

**Fix:** Attach a route-specific rate limit (e.g. 5 refreshes per user per hour) via Fastify's `config.rateLimit`. Same hygiene for `POST /feeds/subscribe` if not already covered.

---

### K14. Subscription limit check is read-then-insert race — ✅ FIXED

**Problem:** `COUNT(*)` runs, then INSERT. Two concurrent subscribes from the same user can each read `count = 199`, each pass the check, each succeed — user ends with 201 subscriptions. Harm is low (one extra row), but pattern violates its own intent.

**Location:** `gateway/src/routes/feeds.ts:122-132`

**Fix:** Either:
- wrap check+insert in an advisory lock keyed by `subscriber_id`, or
- drop the pre-check and rely on a `CHECK` via a trigger on `external_subscriptions` that counts and rejects at insert time (atomic against concurrent inserts).

---

### K15. Mastodon truncation counts UTF-16 units, not graphemes — ✅ FIXED

**Problem:** `truncate()` compares `text.length <= max` — `.length` is UTF-16 code units. Mastodon's char count is grapheme-aware. Posts heavy in emoji or combining characters will be truncated aggressively (each emoji counts as 2 UTF-16 units), or — more dangerously — `text.slice(0, budget)` can cut mid-surrogate and send malformed UTF-16 to the instance. The Bluesky adapter already uses `Intl.Segmenter`.

**Location:** `feed-ingest/src/adapters/activitypub-outbound.ts:110-115`

**Fix:** Mirror the Bluesky adapter's grapheme-aware truncation using `Intl.Segmenter('und', { granularity: 'grapheme' })`. Factor it into a shared helper if both adapters can use the same code path.

---

## Design / Scaling

### D1. `MemoryStateStore` is per-replica; breaks Bluesky OAuth at scale — ✅ FIXED (migration 060)

**Problem:** The PKCE verifier + DPoP key for the authorize→callback round-trip lives in a per-process `Map`. With ≥2 gateway replicas behind a load balancer, ~50% of Bluesky connections fail because replica A wrote the state and replica B handles the callback. Works today because only one gateway runs — tomorrow's scaling breaks it silently.

**Location:** `shared/src/lib/atproto-oauth.ts:57-79`

**Fix:** Add a DB-backed state store — new table `atproto_oauth_pending_states` with a short TTL:

```sql
CREATE TABLE atproto_oauth_pending_states (
  key TEXT PRIMARY KEY,
  state_data_enc TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON atproto_oauth_pending_states(expires_at);
```

Implement `DbStateStore` the same way `DbSessionStore` is implemented in the same file; encrypt state with the existing `LINKED_ACCOUNT_KEY_HEX`. Add a cleanup job that deletes rows where `expires_at < now()` (every few minutes).

---

### D2. `clientPromise` singleton caches rejected promises forever — ✅ FIXED

**Problem:** If `buildClient()` throws on first call (transient DB hiccup, JWK parse error, etc.), the rejected promise is cached and every subsequent caller gets the same rejection until process restart.

**Location:** `shared/src/lib/atproto-oauth.ts:81-86`

**Fix:** Null the cache on rejection:

```ts
let clientPromise: Promise<NodeOAuthClient> | null = null
export function getAtprotoClient(): Promise<NodeOAuthClient> {
  if (!clientPromise) {
    clientPromise = buildClient().catch((err) => {
      clientPromise = null  // retry on next call
      throw err
    })
  }
  return clientPromise
}
```

---

### D3. `asyncResults` cache is per-replica — ✅ FIXED

**Problem:** Same shape as D1: Phase B of the universal resolver stores results in a per-process `Map`, so a poll hitting a different replica returns a cache miss.

**Location:** `gateway/src/lib/resolver.ts:64`

**Fix:** Two options:
- **DB-backed table** (consistent with D1 approach): `resolver_async_results(request_id uuid pk, initiator_id uuid, result jsonb, expires_at timestamptz)`.
- **Accept cache-miss by re-running resolve** on Phase B polls. The resolve is idempotent — duplicating it is cheaper than adding a new persistent cache, and fails gracefully.

Recommend the DB-backed option if D1 lands, because the plumbing becomes trivial.

---

### D4. `oauth_state` cookie name collides between Mastodon and Bluesky flows — ✅ FIXED

**Problem:** Both flows write a cookie called `oauth_state`. If a user starts the Mastodon flow, leaves the tab, starts a Bluesky flow in another tab, then returns to the Mastodon tab and completes it, the Mastodon callback sees the Bluesky state and rejects.

**Locations:**
- `gateway/src/routes/linked-accounts.ts:196` (Mastodon)
- `gateway/src/routes/linked-accounts.ts:345` (Bluesky)

**Fix:** Protocol-specific cookie names:

```ts
reply.setCookie('oauth_state_mastodon', ...)  // Mastodon flow
reply.setCookie('oauth_state_bluesky', ...)   // Bluesky flow
```

Update both callback handlers to read the matching cookie.

---

### D5. Bluesky callback has no `requireAuth` preHandler — ✅ FIXED

**Problem:** Mastodon callback has `{ preHandler: requireAuth }`, Bluesky callback doesn't. Bluesky derives userId from the signed cookie, so it works — but a logged-out user with a still-valid signed cookie could complete the link, and the inconsistency makes auth audits harder.

**Locations:**
- Mastodon: `gateway/src/routes/linked-accounts.ts:229-230`
- Bluesky: `gateway/src/routes/linked-accounts.ts:380-386`

**Fix:** Add `{ preHandler: requireAuth }` to the Bluesky callback registration, or document the intentional asymmetry in a comment (if the signed cookie is meant to be the sole auth path).

---

### D6. AES-256-GCM has no key rotation path — ✅ FIXED

**Problem:** Ciphertext is `base64url(iv || tag || ct)` — no key version byte. Rotating `LINKED_ACCOUNT_KEY_HEX` requires re-encrypting every `linked_accounts.credentials_enc` and `atproto_oauth_sessions.session_data_enc` row in a single deploy, with no way to run two keys concurrently during rollover.

**Location:** `shared/src/lib/crypto.ts`

**Fix:** Add a 1-byte key version prefix:

```ts
// New format: base64url(version_byte || iv || tag || ct)
const CURRENT_KEY_VERSION = 1
```

Support decryption with multiple keys keyed by version byte. Env becomes `LINKED_ACCOUNT_KEY_HEX_V1`, `LINKED_ACCOUNT_KEY_HEX_V2`, etc.; writes always use the latest. Existing rows without a version byte can be detected by length and assumed to be v0.

Not urgent, but worth scheduling before the first real rotation event.

---

### D7. `feed_items_reconcile` silently papers over dual-write bugs — ✅ FIXED

**Problem:** The 05:00 reconcile cron catches cases 4–5 (stale-live `feed_items` pointing at deleted content) and fixes them. Good safety net — but its presence means non-transactional dual-writes (C8) can leak rows for up to 24h with zero operator signal. The reconcile should emit a metric/log when it corrects drift, so engineers notice when a code path is leaking rather than silently swallowing it.

**Location:** `feed-ingest/src/tasks/feed-items-reconcile.ts`

**Fix:** Count fixed rows per case; log `warn` (not `info`) if any case > 0; emit a Prometheus/OTel counter. Treat non-zero drift as an on-call signal rather than routine cleanup.

---

### D8. `resolver_async_results` has no per-initiator row cap — ✅ FIXED

**Problem:** Pass-2 fix (migration 061) made resolver results durable with a 5-min prune cron. No per-user cap — a spammy client can create thousands of rows between prunes, bloating the table and slowing the index. Low severity (prune catches up), but defence in depth.

**Location:** `migrations/061_resolver_async_results.sql`, `gateway/src/lib/resolver.ts`

**Fix:** On INSERT, DELETE any older row for the same `initiator_id` beyond a cap (LIMIT 100). Or add the cap logic to the 5-min prune cron.

---

### D9. `exploreFeed` implicit shared parameter semantics — ✅ FIXED

**Problem:** The two parallel queries in `exploreFeed` share the same `params` array. `$3` is a `published_at` epoch in the content query but an `account.created_at` epoch in the new-users query — unrelated semantics that happen to be numeric-comparable. Works today, but any future change to the cursor shape (e.g. C5's compound cursor fix) silently breaks the new-users subquery.

**Location:** `gateway/src/routes/feed.ts:246-289`

**Fix:** Split the parameter arrays — `contentParams` and `newUsersParams` — or use explicit named placeholders. Document that the two queries' cursor semantics are independent.

---

## Minor

- ✅ FIXED **`external_sources.last_error` not truncated** (`feed-ingest/src/tasks/feed-ingest-rss.ts:172`, `feed-ingest/src/tasks/feed-ingest-nostr.ts:221`). A multi-MB stack trace from a weird upstream goes straight into `TEXT`. Slice to 1000 chars before the UPDATE.

- **Sanitizer strips `target` attribute** (`feed-ingest/src/lib/sanitize.ts`). External links open in the same tab, breaking scroll position. Either allow `target` in `allowedAttributes.a` (with a forced `rel="noopener noreferrer nofollow"` transform) or inject `target="_blank"` at render time in `ExternalCard`.

- **`ExternalCard` hides sanitised images** (`web/src/components/feed/ExternalCard.tsx:173`, `[&_img]:hidden`). Intentional per the scroll-feed design, but RSS articles with embedded media render as near-empty previews. Product decision: allow one lead image, or keep hidden?

- ✅ FIXED **Resolver ILIKE special chars not escaped** (`gateway/src/lib/resolver.ts`). A query containing `%` or `_` is treated as a wildcard. Escape both before interpolating into ILIKE patterns.

- ✅ FIXED **`enqueueCrossPost` is not a single transaction** (`gateway/src/lib/outbound-enqueue.ts:52-76`). INSERT into `outbound_posts` and the `graphile_worker.add_job` call are separate statements. If the process crashes between them, the `outbound_posts` row stays `pending` forever with no job to process it. Wrap both in `withTransaction`.

---

## Recommended triage order

### Pass 1/2 (closed)

1. **C1** (explore feed) — user-visible, single-line fix in one file.
2. **C3** (RSS backoff) — silent data staleness, single-line fix.
3. **S2 + S3 + S6** (Nostr attack surface) — medium effort, meaningful security gain.
4. **C4** (Mastodon quote bug) — embarrassing user-facing behaviour.
5. **D1** (OAuth state store) — not breaking now, but blocks any gateway scale-out.
6. **C2** (Jetstream leader election) — same: not breaking now, blocks feed-ingest scale-out.
7. Everything else as time allows.

### Pass 3 (open)

1. **C6 + C7** (Nostr forgery + arbitrary deletion) — one-file fix, closes two criticals together. Any external Nostr source is currently an untrusted input channel capable of impersonating its own author and deleting any content we've ingested from them.
2. **C5** (explore pagination at cursor boundaries) — user-visible feed breakage; compound-cursor pattern already exists in `followingFeed` to copy.
3. **C8** (transactional article soft-delete) — up to 24h visibility of deleted articles.
4. **S7 + S11** (IPv6 bypass + WebSocket pinning) — closes the remaining SSRF gaps.
5. **K7** (outbound UNIQUE), **K13** (refresh rate limit), **K15** (grapheme truncation) — small, high-leverage correctness fixes.
6. **S8** (crypto rotation workflow) — operational trap; fix before first real rotation.
7. **S9** (media hotlink privacy) — product/privacy call as much as engineering.
8. **S10** (weak idempotency hash), **K8–K14**, **D7–D9** — as capacity allows.

---

## Out of scope but worth noting

- No automated test coverage was audited — this report is static analysis only. If the test suite covers any of the above, note it and close as "already caught".
- The native content paths (articles, notes, feed-items dual-write from native tables) were *not* audited in depth — focus was on the universal-feed additions. Worth a separate pass on `articles → feed_items` and `notes → feed_items` dual-writes, since those drive the unified timeline.
- Performance/indexes on `feed_items` were not profiled against realistic row counts. The compound cursor `(published_at, id)` pattern is sound, but verify the supporting index exists.
