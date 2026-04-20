# platform-pub: code review findings

Six-area review of the platform-pub codebase (commit as of clone on 2026-04-18), working through areas in the order requested:

1. DM / NIP-17 messages path
2. Universal resolver
3. Feed-ingest adapters
4. Stripe webhook + payout service
5. Dead-code sweep over `web/src/app/` and hooks
6. `knip` / `ts-prune` run across the repo

Common thread across everything below: refactor discipline is uneven. Code gets rewritten; old code stays; types lose their consumers; helpers get introduced and never adopted. Normal for a pre-launch single-developer codebase, but it's the single biggest quality lever available — a root `knip.json` with CI failing on new unused exports would turn refactor-corpses into build errors at the moment of creation.

---

## 1. DM / NIP-17 path (`gateway/src/services/messages.ts` + routes)

### The NIP-17 publish is a fiction

`publishNip17Async` (lines 550–563) signs a kind-14 event with `content: ''` and a single `['conversation', conversationId]` tag, then publishes it to the relay. That's not NIP-17 in any meaningful sense:

- No gift-wrap (kind 1059)
- No seal (kind 13)
- No actual ciphertext on the wire
- Leaks conversation ID to the relay
- Reveals sender
- Contains nothing a NIP-17 client could decrypt

Real message content lives in Postgres as NIP-44 envelopes; the relay is getting empty kind-14s with a platform-internal UUID tag. The `event as any` cast on line 558 is a telltale of something adapted in a hurry.

**Fix:** either rename to something honest (`publishConversationPulse`) or stand up gift-wrap properly. The current name is misleading to the point of being actively dangerous.

### Group DMs almost certainly show duplicates to the sender

`direct_messages` has a single `recipient_id` per row, so a group send inserts N rows (one NIP-44 envelope per recipient). `loadConversationMessages` then pulls:

```sql
WHERE dm.conversation_id = $1 AND (dm.recipient_id = $2 OR dm.sender_id = $2)
```

The sender matches N times on `sender_id`. Either the UI silently dedupes on client (fragile) or group DMs are visibly broken. Given this is one of the flows flagged as "debugging," this is a strong candidate for what's bent.

**Verify first** — determines whether the rework is "tidy the N+1" or "rethink the data model."

### N+1 queries on the send hot path

`sendMessage` (lines 297–308) loops over recipients awaiting `getDmPrice` per recipient (2 queries each). Then lines 317–332: per-recipient sequential encrypt + insert. For a 10-person group chat that's 20+ DB round-trips plus 10 serial HTTP hops to key-custody for NIP-44 encryption.

**Fix:** one pricing query with `ANY()`, one batched encrypt call, single multi-row insert.

### DM pricing is functionally just "blocking with a price label"

Lines 296–308 return HTTP 402 with the price when a recipient charges. Grepped for `dm_payment_required` across the codebase — only hits are the definition and the throw. Nothing consumes the 402 response. No endpoint takes payment and unblocks the send. Until one exists, this feature is a block, not a paywall.

Also all-or-nothing for groups: if *any* recipient charges, the whole message 402s. Comment says "Full per-recipient charging is a fast-follow" (line 296).

### `listInbox` mute filter is wrong

Lines 126–127:

```sql
LEFT JOIN mutes m ON m.muter_id = $1 AND m.muted_id = cm.user_id
WHERE m.muter_id IS NULL
```

The `cm` alias is aggregated across all members, so this filters out the *whole conversation row* if *any* member is muted. In a group DM of 3 where you've muted one person, the entire conversation vanishes from your inbox.

Also: no block filter in the inbox query, even though `createConversation` and `sendMessage` both check blocks. You can't create a new convo with a blocker, but an existing convo with someone who later blocked you still shows up and lets you try to send (which then 403s).

### The `reply_to_counterparty_pubkey` query has a duplicate join

Lines 210–212:

```sql
CASE WHEN rdm.sender_id = $2 THEN rra.nostr_pubkey ELSE rsa2.nostr_pubkey END
```

`rsa` (line 219) joins on `rdm.sender_id` and is used only for the username. `rsa2` (line 221) joins on `rdm.sender_id` *again* and is used only for the pubkey. They're the same join under two aliases. Collapsible to one.

### Silent skip on missing pubkey

Lines 319–322: if a recipient has no `nostr_pubkey`, logs an error and continues. The message is silently not delivered to that recipient, but the send returns success. No way for the caller to know one of the members didn't receive the message.

**Fix:** return "delivered to 2 of 3 recipients" in the response payload, or fail hard.

### Type weirdness: `senderUsername`/`senderDisplayName` nullable on inner join

Line 148+: these are typed `string | null`, but the query uses `JOIN accounts sa ON sa.id = dm.sender_id` (inner join). Username can only be null if the schema allows NULL — which it shouldn't. Either the types are paranoid or the schema is wrong.

---

## 2. Resolver (`gateway/src/lib/resolver.ts`)

### The Bluesky handle regex eats everything with a dot

Line 135: `BLUESKY_HANDLE = /^@?[\w-]+(\.[\w-]+)+$/`. Classification order (lines 143–151) goes: url → npub → nprofile → hex → did → fediverse → **bluesky** → ambiguous_at → platform_username → free_text.

Because `BLUESKY_HANDLE` comes before `AMBIGUOUS_AT` and `PLATFORM_USERNAME`, any dotted string — including bare RSS feed hosts like `myblog.substack.com` — classifies as a Bluesky handle and burns an AppView round-trip before failing. Almost certainly why RSS-only inputs feel slow.

### Nostr inputs skip profile enrichment

For `npub` / `nprofile` / `hex_pubkey`, Phase A adds an `external_source` match with just the hex pubkey in `sourceUri` — no displayName, description, or avatar. There's no Phase B step that fetches the profile (kind 0 event) from the relay.

Contrast Bluesky and fediverse, which both enrich in Phase B via `fetchActorProfile` / `atprotoGetProfile`. Net effect: paste an npub in the subscribe UI, see "unknown account" in the confirmation. This is the "half-wired branch" most clearly present in this file.

### Phase B has an ambiguous completion signal

`resolveAsync` writes `pendingResolutions: []` on finish, but a mid-flight poll sees the seeded partial result with the *original* `pendingResolutions` array. No way to distinguish "still running" from "done, no new matches."

**Fix:** add a `status: 'pending' | 'complete'` column or `completed_at` timestamp.

Also: the seed write (line 296) is fire-and-forget with a `.catch()`, and then `resolveAsync` writes again with the full result. No ordering guarantee — unlikely to race in practice since async does network I/O first, but not enforced.

### `ResolveContext` parameter is dead

Type defined with four values, passed into `resolveAsync` (line 301), never read anywhere. Either remove the parameter or use it.

### Serial well-known-paths loop is a silent amplifier

`tryWellKnownPaths` (lines 499–506): serial loop over 7 paths, each a `safeFetch` with the default timeout. Slow origin → 7 × timeout seconds before giving up. No caching, so two users pasting the same URL hit the origin 14 times.

**Fix:** `Promise.any` or race the first two (`/feed`, `/rss`) then fall back. Memoize results for ~5 min.

### `searchPlatform` uses leading-wildcard ILIKE

Line 697: `pattern = '%' + escaped + '%'`. Leading `%` means Postgres can't use a btree index on `username`. Full scan on every free-text query.

**Fix:** `pg_trgm` GIN index on `username` + `display_name`, or use prefix-only `ILIKE escaped || '%'` for the fast path.

### `resolveUrl` falls through inconsistently

Lines 372–388: Bluesky URL resolution early-returns empty on failure (no RSS fallback); Mastodon URL resolution *does* fall through to RSS. Pick one philosophy.

### Minor: display-name fallback inconsistency

- `lookupByUsername` / `lookupByPubkey` / `lookupByEmail` fall back `display_name ?? username`
- `resolveAtproto` falls back `displayName ?? '@' + handle`
- `resolveActivityPubByActor` falls back `displayName ?? handle ?? actorUri` — so AP sees the raw actor URI when both are missing

Five resolution paths, four formatting variations. Would benefit from a single `formatDisplayName(candidate)` helper.

---

## 3. Feed-ingest

### Jetstream listener is the cleanest thing I read

`listener.ts` does advisory-lock leader election, GREATEST-guarded cursor updates, DNS pinning, self-scheduling timers that can't stack. Well-engineered. But there's one hard scaling ceiling:

### Jetstream subscription has no DID cap

`listener.ts` line 249: `for (const did of this.currentDids) params.append('wantedDids', did)`. Bluesky DIDs are ~32 chars; the HTTP upgrade URL is bounded by Jetstream's server-side limit and intermediate proxies (typically 8-16 KB). At ~200 DIDs you're at the practical ceiling; above that the WebSocket upgrade will 414/431 or silently truncate.

ADR talks about arbitrary scale; this is the pinch point. Needs DID-hash sharding across multiple listeners or wildcard-firehose + client-side filter once count exceeds ~150.

### Jetstream cursor behavior on DID changes is wasteful

Any DID set change tears down and reopens from `oldestCursor()` across all sources (lines 227–239). Adding one new source replays hours of events for every *other* source. ON CONFLICT saves the DB, but bandwidth and CPU are wasted.

**Fix:** second listener scoped to just the new DID(s), running until caught up, then merging.

### Nostr `fetchFromRelay` doesn't send CLOSE on timeout

`feed-ingest-nostr.ts` lines 304–366: 10s timeout (line 319) resolves with whatever's been collected. But never sends `CLOSE` on the timeout path — only on EOSE (line 347). Misbehaving relays that never send EOSE get their subscription held open for 10s and then the connection yanked without a clean CLOSE frame. Some relays interpret this as abuse.

### Nostr sub IDs can collide under load

Line 313: `subId = 'feed-ingest-${Date.now()}'`. Millisecond collisions are possible if two sources land on the same relay at the same tick.

**Fix:** UUID or monotonic counter.

### Nostr `verifyEvent` pins a core

Lines 107–110: schnorr verification runs serially inside the relay fetch loop. Source with 5 relay URLs × 50 events each = 250 schnorr verifications in the ingest hot path.

**Fix:** `Promise.all` across relays, or worker thread if throughput becomes an issue.

### Kind 30023 (NIP-23 long-form) ignores replaceable semantics

REQ asks for kinds `[1, 5, 30023]` (line 328). Kind 30023 is a *replaceable* event — a later version with the same d-tag should supersede the earlier one. Current normaliser stores each under an `nevent` URI (line 384), not an `naddr`. Author updates a draft → second feed item appears instead of superseding the first. The feed will show stale drafts of long-form posts.

### Kind-0 profile updates race the separate metadata-refresh task

Lines 243–268: if a kind-0 event arrives during ingest, updates `display_name` and `avatar_url` on `external_sources`. But there's a separate `source-metadata-refresh` task for the same thing. Two writers, no ordering discipline. If metadata-refresh runs between ingest cycles with stale data, it clobbers a newer kind-0 update. `COALESCE($3, display_name)` on line 264 only handles null, not staleness.

**Fix:** ingest path updates metadata only when strictly newer than stored, or drops the update and lets metadata-refresh own it.

### AP outbox cursor anchors to skipped activities

`activitypub.ts` line 162: `if (newCursor === null && activityId) newCursor = activityId` — regardless of whether the activity passes the Create/Note/isPublic filters. So if the newest outbox activity is an Announce you skip, the cursor anchors to an Announce you never ingested. If that Announce ever changes or disappears (some instances delete/repost), dedup breaks.

**Fix:** only advance cursor past ingestable activities, or use the outbox page's top-level `id`.

### AP `cutoffMs` stop condition is brittle

Lines 175–179: stops paging once `publishedAt < cutoffMs`. Mastodon outboxes can contain scheduled posts dated in the future (bugged instances), and per-page order can be slightly off. A single stray older item ends pagination prematurely. "Pages are newest-first" is an assumption Mastodon *mostly* honours — not guaranteed.

### Mastodon quote posts lose the quote URL on truncation

`outbound-cross-post.ts` line 125 appends the source URL into `text`:

```typescript
text = `${text}${sep}${row.ei_source_item_uri}`
```

Then hands off to `postMastodonStatus`, which calls `truncateWithLink(input.text, { max: maxChars, … })` and truncates the *end* of the combined string. For long quotes, the URL you just appended — the thing that makes it a quote — is what gets cut.

**Fix:** budget is `maxChars − URL length` applied to `text` before append, not after.

### Outbound retry job-key dedup depends on enqueue site

`outbound-cross-post.ts` line 208: retry uses `jobKey: 'outbound_cross_post_${row.id}'` with `maxAttempts: 1`. Correct in isolation. But the first enqueue (not in this file) needs to use the same key. If it used a different key or no key, the retry doesn't dedupe with the original — two concurrent workers can process the same outbound post. Worth verifying the enqueue site in gateway.

---

## 4. Stripe webhook + payout service

### Webhook dedup race

`payment-service/src/routes/webhook.ts` lines 56–78: INSERT marks event as seen *before* handler runs. If the process dies between INSERT and `handleStripeEvent`, the dedup row survives; Stripe's retry hits the duplicate branch and acks; event is lost forever. The `DELETE on catch` (line 71) only helps when the handler *returns* an error inside that try block — a crash bypasses it.

**Fix (defensive):** move INSERT inside `handleStripeEvent`'s transaction so a crash rolls back the dedup row.

**Fix (cleaner):** add `processed_at TIMESTAMP NULL` column, set only on successful completion, check that on re-delivery. Also gives you a log of attempted-but-failed events for reconciliation.

### Stripe API version is two years old

`apiVersion: '2023-10-16'` pinned in both webhook.ts and payout.ts. Line 90 comment already acknowledges the pin is causing problems (`'transfer.paid' not in SDK v14 types`). Worth bumping.

### Stripe transfer can orphan if the transaction rolls back

`initiateWriterPayout` (line 304): Stripe transfer is created (line 342) *before* the transaction commits. If the transaction fails after that point, you've got a Stripe transfer with no corresponding payout row. Idempotency key is `'payout-${writerId}-${randomUUID()}'` — fresh UUID every call — so a retry won't dedupe against the orphan.

Classic distributed-transaction problem. Two fixes:

1. Write the payout row in `pending` state *before* calling Stripe, then update to `initiated` after.
2. Use a stable idempotency key derived from `(writerId, amountPence, period)` so retries land on the same transfer.

### Writer-eligibility rounding bias

Line 261: `SUM(amount_pence - FLOOR(amount_pence * $2 / 10000))`. Per-row floor before summing differs from `total - FLOOR(total * fee / 10000)` by up to N pence (one per row). Writer with many micropayments → rounding accumulates against the platform. 1p read at 5% fee → `floor(1 * 500/10000) = 0`, writer nets 1p, platform takes zero.

Probably intentional (platform absorbs dust) but worth verifying against the accrual tests.

### `confirmPayout` is silent on missing rows

Line 407: straight UPDATE with no `RETURNING`, no rowcount check. If a `transfer.paid` webhook arrives for a `stripe_transfer_id` that isn't in `writer_payouts`, it logs "Writer payout confirmed" and returns success. Stripe thinks everything's fine, no payout record to associate funds with.

**Fix:** log-warn when rowcount is zero, feed into a reconciliation queue.

### `handleFailedPayout` status-machine is underspecified

Rolls back state correctly, but `failed_reason` gets overwritten each time (no history). `completed_at` never cleared — if a payout was `completed` and then receives `transfer.failed` (possible for reversals), row ends up with `status='failed'` *and* `completed_at != NULL`.

### Publication-split DB path duplicates the tested pure function

`computePublicationSplits` has 202 lines of unit tests covering platform fee, flat fees, revenue_bps, standing shares, combined flow, rounding. But `initiatePublicationPayout` (line 511) **reimplements the same logic inline** rather than calling the extracted function. Lines 535–629 are a duplicate implementation with the same steps in the same order.

Consequences:
- Any future bug fix needs to be made in both places
- The "floor absorbs rounding dust" invariant the tests lock in could silently drift in the DB path
- The tests validate a function the actual payout cycle doesn't use

Subtle wrinkle: the DB path does `UPDATE publication_article_shares SET paid_out = TRUE` inside the iteration loop (line 589). The pure function just tracks IDs in `flatFeeShareIds` for the caller to update later. Rolls back correctly with the transaction but by luck, not by design.

### Publication-split Stripe transfers orphan same way as writer payouts

Lines 661–672: transfers created before `publication_payout_splits` rows inserted. If any transfer succeeds and a later step throws (non-Stripe error in account lookup, say), the transaction rolls back and you have Stripe transfers for splits with no DB record. With N splits per publication payout, this multiplies.

**Fix:** write split rows as `pending` first, try transfers, update to `initiated`. Or use stable idempotency keys `pub-split-${payoutId}-${accountId}` without the UUID.

### Dead status-flag block at lines 706–714

```typescript
const allInitiated = splits.every(s => s.amountPence <= 0) ||
  splits.filter(s => s.amountPence > 0).length === 0
if (!allInitiated) {
  UPDATE publication_payouts SET status = 'initiated' ...
}
```

Both disjuncts check the same thing ("no splits with positive amounts"). `allInitiated` is only true when the payout was empty — in which case the row was inserted with status `'initiated'` (line 635) and this UPDATE is a no-op. When it's false (normal case), UPDATE status to `'initiated'` — already what it was. Whole block is dead. Intent was probably to mark `'completed'` when all splits succeeded, but that's not what the code does.

---

## 5. Dead-code sweep over `web/src/`

Custom heuristic scanner + knip run both converged on the same results.

### 8 genuinely orphaned component files in web/src

- `DrivesTab.tsx`, `OffersTab.tsx` — dashboard tabs
- `NoteComposer.tsx` — feed composer
- `FeaturedWriters.tsx` — home-page widget
- `ThereforeMark.tsx` — the ∴ logo component (orphan from Platform → all.haus rename)
- `ErrorBoundary.tsx`, `NotificationBell.tsx`, `UserSearch.tsx` — UI

Plus `public/traffology.js` and six `.test.ts` files whose subjects are themselves orphaned.

### These aren't neglect — they're refactor corpses

Code comments prove it. `ProposalsTab.tsx`:

```typescript
// Offers Section (table rendering from OffersTab)
// Offer Create Form (extracted from OffersTab)
```

`lib/format.ts`:

```typescript
// Consolidated from ArticleCard, NoteCard, FeaturedWriters, [username]/page.
```

Someone did consolidation passes and forgot to delete the originals. Pattern is important — tells you what to expect from the sub-file exports: same story, smaller pieces.

---

## 6. `knip` run on web and gateway workspaces

### Web — unused exports (11)

- `lib/api.ts`: `keys`, `follows`, `search`, `writers` — entire API client groupings unused. Plus a dozen orphan response types (`SignupResult`, `GatePassResponse`, `ResolvedContent`, `Publication`, etc.). An API client with a quarter of its surface dead suggests endpoints were removed from the gateway without cleaning up the client.
- `lib/ndk.ts`: `KIND_VAULT`, `KIND_RECEIPT`, `KIND_DRAFT`, `KIND_CONTACTS`, `KIND_REACTION` all unused. Either these exist only as server-side kinds the client never reads/writes, or they were planned and never landed.
- `lib/vault.ts`: three decrypt/helper functions unused. Orphaned crypto helpers invite confusion.
- `components/editor/EmbedNode.ts` / `ImageUpload.ts` / `PaywallGateNode.ts`: named *and* default export of the same thing. Tiptap extensions end up this way during renames.

### Web — unused deps

`date-fns`, `clsx` in `package.json` but not imported. Free weight to cut.

### Web — unlisted deps

`@tiptap/core` and `prosemirror-state` used by editor nodes but not in `package.json`. Resolving through transitive `@tiptap/react`. Will break if tiptap ever unbundles or upgrades.

### Gateway — `src/lib/errors.ts` is an orphan

15-line `sendError(reply, status, code, message)` helper standardizing error responses. Imported by nothing. Routes (e.g. `routes/messages.ts`) keep throwing raw `reply.status().send()`. Either the pattern was rejected or it's a vision someone wrote and didn't push through.

### Gateway — 9 orphaned exported types

Most striking: **all six public types from `resolver.ts`** (`InputType`, `MatchType`, `Confidence`, `ResolveContext`, `ResolverMatch`, `ResolverResult`) are unused externally. Either only consumed within the module (don't need `export`) or — more interesting — the route handler returns `resolve()`'s raw output without typing the response. Confirms the `ResolveContext` dead code from area 2.

Also: `messages.ts` exports `InboxConversation`, `ConversationMessage`, `SendMessageResult`, `DecryptRequest`, `DecryptResult`, `DmPricingSummary` — **all six** discriminated-union / interface types from area 1 are unused outside the module. Route handler must be ducktyping these away. Means the service-to-route contract is enforced by trust alone.

### False positives to verify rather than act on

- `shared/` files flagged as unused by knip when run in gateway workspace — relative `../shared/src/…` imports aren't being followed. Would be fixed by a root `knip.json` declaring workspaces.
- Gateway `package.json` flagging `pg`, `pino`, `@atproto/oauth-client-node` as unused — probably transitive-through-shared, same fix.

---

## Priority summary

### Verify first (fast, determines downstream scope)

- **Group-DM sender-side duplicates** — affects whether messages.ts rework is "tidy the N+1" or "rethink data model"
- Whether anything consumes the HTTP 402 `dm_payment_required` response (strongly suggests no)

### High-leverage, relatively contained

- Stripe webhook dedup race (`processed_at` column)
- Stripe transfer orphaning in both `initiateWriterPayout` and `initiatePublicationPayout` (stable idempotency keys or write-DB-row-first)
- Root `knip.json` with workspace config + CI hook to fail on new unused exports

### Deeper work

- NIP-17 publish: rename to honest name, or implement gift-wrap properly
- Collapse `initiatePublicationPayout` inline logic to use the tested `computePublicationSplits`
- Jetstream DID-sharding for scale past ~150 external sources
- Kind 30023 replaceable semantics (switch to `naddr` URIs)

### Easy wins

- Delete the 8 orphan component files + `errors.ts` + 6 orphan test files
- Collapse `rsa` / `rsa2` duplicate join in `loadConversationMessages`
- Fix `listInbox` mute filter (and add block filter)
- Remove dead status-flag block at payout.ts 706–714
- Delete or fix the `ResolveContext` parameter
- Remove `clsx` and `date-fns` from package.json
- Move `@tiptap/core` and `prosemirror-state` to package.json explicitly

### Items not completed in this review

- `ts-prune` alongside `knip` (would catch different slivers)
- `knip` on payment-service, feed-ingest, traffology-*, key-custody, key-service
- Full read through gateway route handlers (would confirm the service-to-route ducktyping observation)
- `web/src/stores/` audit for stale Zustand slices (heuristic scan clean, but knip doesn't always catch these)
