# Feed Ingest — Build Plan

Extending `feed-ingest` toward an omnivorous stream ingester.

## Governing principle

all.haus ingests **streams**, not **places**. A source qualifies if its native
unit is a timestamped event whose meaning is fixed at the moment of creation —
"an account emits a dated thing." Sources whose native unit is a persistent,
revisitable, editable object (Reddit, Wikipedia, forums, wikis, Discord-as-server)
are _places_; they are out of scope by design, not by engineering limitation.
Where a place exposes a stream _surface_ (a "new posts" RSS feed), that surface
is a legitimate source, but ingesting it means ingesting the doorway, not the
building.

## What exists today

| Protocol                    | Read | Write | Mechanism                                                        |
| --------------------------- | ---- | ----- | ---------------------------------------------------------------- |
| Nostr (`nostr_external`)    | ✓    | ✓     | Relay subs; outbound kind 1 + kind 7 signed events               |
| ActivityPub (`activitypub`) | ✓    | ✓     | Outbox poll; outbound status + like + repost + reply + poll vote |
| AT Protocol (`atproto`)     | ✓    | ✓     | Jetstream firehose + backfill; outbound via OAuth DPoP           |
| RSS/Atom/JSON Feed (`rss`)  | ✓    | —     | `rss-parser` + JSON Feed native parse, ETag/Last-Modified        |
| Email (`email`)             | ✓    | —     | Postmark inbound webhook, push-only                              |

Every new read adapter normalises into `external_items` + dual-writes
`feed_items`. Every write adapter consumes `outbound_posts`. No parallel
pipelines.

### Cross-cutting capabilities (shipped alongside protocol slices)

These capabilities cross-cut all adapters. New adapters inherit the
framework — they just need protocol-branch implementations.

| Capability              | Mechanism                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Engagement refresh      | 30-min cron; Bluesky batch `getPosts`, Mastodon per-instance `GET /statuses/:id`      |
| Parent context prefetch | Enqueued at ingest time when `source_reply_uri` is non-null; stores `is_context_only` |
| Thread expansion        | Bluesky `getPostThread`, Mastodon `GET /context`; Nostr/RSS empty (deferred)          |
| Cross-platform like     | Nostr kind 7, Bluesky `createRecord`, Mastodon `POST /favourite`                      |
| Cross-platform repost   | Bluesky `createRecord`, Mastodon `POST /reblog`; Nostr/RSS rejected                   |
| Cross-platform reply    | Nostr kind 1, Bluesky `createRecord`, Mastodon `POST /statuses`; RSS rejected         |
| Poll voting             | Mastodon `POST /polls/:id/votes`                                                      |
| Content warnings        | AP `sensitive` + `summary` extracted at ingest                                        |
| Context-only GC         | Daily 02:30 UTC cron; 30-day TTL on unreferenced context items                        |
| Outbound token refresh  | 30-min cron; proactive atproto session touch                                          |
| Relay outbox            | All Nostr publishing via durable queue + worker retry (6-phase programme)             |
| Newsletter sanitisation | Tracking pixel strip, table collapse, MSO comments, canonical URL extraction          |

---

## Per-adapter contract (checklist)

Every adapter touches the same set of files. This is the definitive list:

### Read path

| #   | File                                                   | What to do                                                                                     |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1   | `migrations/0XX_*.sql`                                 | Extend `external_protocol` enum + `protocol_tier_consistency` CHECK                            |
| 2   | `feed-ingest/src/adapters/<p>.ts`                      | Export `Normalised<P>Item` type + `fetch<P>(source, opts)` function                            |
| 3   | `feed-ingest/src/lib/<p>-ingest.ts`                    | Export `insert<P>Item(client, source, item, counts?)` dual-write helper                        |
| 4   | `feed-ingest/src/tasks/feed-ingest-<p>.ts`             | Per-source task: load source → fetch → insert in txn → update cursor/errors                    |
| 5   | `feed-ingest/src/tasks/feed-ingest-poll.ts`            | Add `protocol → task_name` mapping in the dispatch chain (line 78)                             |
| 6   | `feed-ingest/src/index.ts`                             | Import task, add to `taskList`                                                                 |
| 7   | `gateway/src/routes/external-feeds.ts`                 | Add protocol to `Body` type union, `validateSubscribeInput`, and the protocol guard (line 152) |
| 8   | `feed-ingest/src/tasks/external-engagement-refresh.ts` | Add protocol branch (or skip with comment if platform has no public counts API)                |
| 9   | `feed-ingest/src/tasks/external-parent-prefetch.ts`    | Add protocol branch (or skip if source has no threading)                                       |
| 10  | `web/src/components/cards/ExternalVesselCard.tsx`      | Protocol badge (`VIA <P>`) + any rendering quirks                                              |

### Write path (where applicable)

| #   | File                                           | What to do                                           |
| --- | ---------------------------------------------- | ---------------------------------------------------- |
| 11  | `feed-ingest/src/adapters/<p>-outbound.ts`     | `post<P>()`, `like<P>()`, etc.                       |
| 12  | `feed-ingest/src/tasks/outbound-cross-post.ts` | Add protocol case to the dispatch switch (line 129+) |
| 13  | `gateway/src/routes/linked-accounts.ts`        | OAuth or auth flow for the new protocol              |

### Streaming sources (Matrix, Farcaster) additionally need:

| #   | File                                                | What to do                                                                   |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| 14  | `feed-ingest/src/<p>/listener.ts`                   | Long-lived listener (advisory lock leader, health flag, reconnect backoff)   |
| 15  | `feed-ingest/src/tasks/feed-ingest-<p>-backfill.ts` | Poll-based fallback task for when listener is unhealthy                      |
| 16  | `feed-ingest/src/index.ts`                          | Start listener alongside Jetstream; wire health-flag exclusion in poll query |

---

## Slice 0 — Schema migration (prerequisite, blocks everything) ✅ DONE

Two migrations: enum values first (must commit before they can be referenced),
then the CHECK constraint update. The migration runner auto-detects
`ALTER TYPE ... ADD VALUE` and runs those migrations outside a transaction.

**Migration `094_external_protocol_expansion.sql`** (no-transaction):

```sql
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'farcaster';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'matrix';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'telegram';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'email';
```

**Migration `095_external_protocol_check_constraint.sql`:**

```sql
ALTER TABLE external_items DROP CONSTRAINT protocol_tier_consistency;
ALTER TABLE external_items ADD CONSTRAINT protocol_tier_consistency CHECK (
  (protocol = 'nostr_external' AND tier = 'tier2')
  OR (protocol IN ('atproto', 'activitypub', 'farcaster') AND tier = 'tier3')
  OR (protocol IN ('rss', 'telegram', 'matrix', 'email') AND tier = 'tier4')
);
```

Also extend `validateSubscribeInput` in `gateway/src/routes/external-feeds.ts`
with stub validation for the new protocol values (reject them with "not yet
supported" until the adapter ships). This prevents the subscribe endpoint from
accepting a protocol the backend can't ingest.

**Also:** `outbound_posts.protocol` references `external_protocol`, so the
enum extension automatically covers outbound. No separate migration needed.

**Effort:** 1 hour. **Risk:** None — additive enum values, no data change.

**Status:** Shipped. Migrations 094 + 095 + gateway stub rejection +
`schema.sql` sync. Split into two migrations because PostgreSQL requires
`ALTER TYPE ADD VALUE` to commit before new values can be used in constraints.

**Do not add a `lemmy` enum value.** Lemmy speaks ActivityPub. Slice 2 will
confirm whether the existing adapter covers it; if so, Lemmy sources just use
`protocol = 'activitypub'` and the only work is UI labelling.

---

## Slice 1 — RSS-family enrichment (no schema changes) ✅ DONE

These need no new protocol, no new enum value, no new outbound path. They are
RSS by another name. Each stores as `protocol = 'rss'`, `tier = 'tier4'`.

### 1A: JSON Feed ✅ DONE

A content-type/shape sniff in `adapters/rss.ts`. If the response is
`application/feed+json` or `application/json` and parses as a JSON Feed
object (`version` starts with `https://jsonfeed.org/version/`), map
`items[]` to `NormalisedItem` directly instead of routing through
`rss-parser`. Share the same `NormalisedItem` type — no new ingest helper.

**Files:**

- `feed-ingest/src/adapters/rss.ts` — add `parseJsonFeed()` branch in
  `fetchRssFeed()`, before the `parser.parseString()` call. Check
  content-type header first, then try JSON parse as fallback for feeds
  served as `text/plain`.

**Acceptance:** A JSON Feed URL (e.g. `https://www.jsonfeed.org/feed.json`)
ingests correctly, items appear in the user's following feed with title,
content, and media.

**Effort:** 2–3 hours.

**Status:** Shipped. `fetchRssFeed()` auto-detects JSON Feed via content-type
header or shape-sniff, parses natively with `parseJsonFeed()`, falls through
to `rss-parser` for RSS/Atom. Handles both JSON Feed 1.0 (`author`) and
1.1 (`authors[]`), maps attachments and images into existing `NormalisedItem`.

### 1B: Podcast enrichment ✅ DONE

Already ingestible as plain RSS. The work is parsing the `podcast:`
namespace into richer `media` JSONB.

**Files:**

- `feed-ingest/src/adapters/rss.ts` — extend `customFields` on the
  `rss-parser` instance to capture `podcast:transcript`,
  `podcast:chapters`, `podcast:value`, `itunes:duration`,
  `itunes:image`. Map these into `media` entries (type `audio`) and
  `interaction_data` (duration, chapters URL, value splits).

**Acceptance:** A Podcasting 2.0 feed ingests with audio media entries
that carry duration and chapter links. `ExternalVesselCard` renders audio
items with a play indicator.

**Effort:** Half a day.

**Status:** Shipped. `rss-parser` item custom fields extended with
`itunes:duration`, `itunes:image`, `itunes:author`, `itunes:summary`,
`itunes:episode`, `itunes:season`, `podcast:transcript`,
`podcast:chapters`. Audio enclosures now carry `duration_in_seconds`,
`size_in_bytes`, and `thumbnail` (episode artwork falling back to
feed-level `itunes:image`). `itunes:author` falls back as author name.
`interaction_data` populated with `chaptersUrl`, `transcriptUrl`,
`episode`, `season` from Podcasting 2.0 namespace. JSON Feed attachments
also carry `duration_in_seconds` and `size_in_bytes`. RSS ingest task
dual-writes `interaction_data`. `ExternalCard` renders audio items with
native `<audio controls preload="none">` player and mono-caps duration
label.

### 1C: YouTube channel RSS ✅ DONE

Every channel exposes
`https://www.youtube.com/feeds/videos.xml?channel_id=…`.
Free, unlimited, no API key.

**Files:**

- `gateway/src/lib/resolver.ts` — `resolveYouTubeChannel()` detects
  `youtube.com/channel/UC...` (direct ID extraction), `/@handle`, `/c/`,
  and `/user/` paths (page fetch → channel_id from canonical link,
  itemprop meta, or embedded JSON). Returns the Atom feed URL as an
  `rss_feed` match.
- `web/src/components/feed/ExternalCard.tsx` — `extractYouTubeVideoId()`
  detects YouTube video URLs in video media attachments or source URIs.
  YouTube videos render as inline privacy-enhanced iframes
  (`youtube-nocookie.com/embed/`); non-YouTube videos keep the existing
  "Watch on source" link.

**Acceptance:** User pastes a YouTube channel URL or `@handle` in the
subscribe input. Resolver resolves it to the RSS feed URL. Videos appear
in the following feed with titles, thumbnails, and inline playback on
expand.

**Effort:** Half a day (mostly the handle→channel_id resolution).

**Status:** Shipped. Resolver `resolveYouTubeChannel()` handles
`/channel/`, `/@handle`, `/c/`, `/user/` URL patterns. `ExternalCard`
renders YouTube videos as inline iframes.

### 1D: Substack publication RSS ✅ DONE

Every Substack publication exposes `/feed`. Plain RSS.

**Files:**

- `gateway/src/lib/resolver.ts` — `resolveSubstackFeed()` detects
  `*.substack.com` URLs (excluding bare `substack.com`) and constructs
  the `/feed` URL. Custom-domain Substacks fall through to the generic
  HTML link discovery path which finds the `<link rel="alternate">`
  tag.

**Acceptance:** User pastes a Substack URL or `name.substack.com` handle.
Resolver returns the RSS feed. Posts appear in the following feed.

**Effort:** 2–3 hours.

**Status:** Shipped. Resolver `resolveSubstackFeed()` handles
`*.substack.com` → `/feed` construction. Custom-domain Substacks covered
by existing HTML link discovery.

**Slice 1 total: ~2 days. Large surface-area gain, zero risk. All four
sub-slices shipped.**

---

## Slice 2 — Lemmy / PieFed / Mbin (AP compatibility check) ✅ DONE

Before writing any code, confirm whether the existing `activitypub`
adapter already resolves Lemmy/PieFed/Mbin actors and ingests their
outboxes.

### 2A: Compatibility audit ✅ DONE

Code audit confirmed the existing AP adapter works for Lemmy/PieFed/Mbin
with one fix: Lemmy posts use `Page` type (not `Note`), which was being
filtered out. Actor fetch, outbox pagination, content extraction,
threading (`inReplyTo`), and WebFinger all work out of the box.

**What was fixed:**

- **AP adapter**: Added `Page` to the accepted object type filter
  (`Note`, `Article`, `Page`). This was the only blocker — without it,
  Lemmy posts were silently dropped.
- **AP adapter**: Added `title` field to `NormalisedActivityPubItem`
  (Lemmy `Page` objects carry titles via the AP `name` property;
  previously all AP items were titleless).
- **AP adapter**: Captures `audience` field in `interactionData` (Lemmy
  posts carry a community actor URI here, e.g.
  `https://lemmy.world/c/technology`).
- **AP ingest helper**: Writes `title` to both `external_items` and
  `feed_items`. Changed "Mastodon user" fallback to "Unknown".
- **Resolver**: Added `extractFromThreadiverseUrl()` in
  `activitypub-resolve.ts` — detects `/c/<community>`, `/m/<magazine>`
  (Mbin), and `/u/<user>` URL paths, extracts a WebFinger-ready
  `acct:name@host` handle. Wired into `resolveUrl()` after the
  Mastodon URL check.
- **Timeline**: Pipes `audience` from `interaction_data` to the
  frontend `ExternalFeedItem` type.
- **VesselCard**: `SourceAttribution` now maps protocol names to
  friendly labels (`ACTIVITYPUB` → `FEDIVERSE`, `ATPROTO` → `BLUESKY`,
  `NOSTR_EXTERNAL` → `NOSTR`). When `audience` is present,
  `extractCommunityName()` parses the community name from the URL path
  and shows it: `VIA FEDIVERSE · technology`.
- **Tests**: `gateway/tests/activitypub-resolve.test.ts` covers both
  `extractFromMastodonUrl` and `extractFromThreadiverseUrl` (11 tests).

**Known limitations (acceptable):**

- **Engagement refresh**: Uses Mastodon REST API (`/api/v1/statuses/:id`)
  which may not return correct results for Lemmy instances. Fails
  gracefully — engagement counts stay at ingest-time values (0 for
  outbox-polled items). Lemmy API v3 support can be added later if
  users want live engagement counts for threadiverse sources.
- **Parent prefetch**: Same Mastodon REST API limitation. Reply context
  incomplete for Lemmy items but items still ingest fine.

**No new enum value, no new adapter, no migration.** Lemmy/PieFed/Mbin
sources use `protocol = 'activitypub'`, `tier = 'tier3'`.

### 2B: Write-back (deferred)

Lemmy's REST API supports `POST /api/v3/comment` with a JWT token.
This makes Lemmy a real bidirectional candidate via `outbound_posts`.
The existing outbound path dispatches by `external_protocol` — since
Lemmy uses `activitypub`, outbound replies go through
`postMastodonStatus()`. Lemmy exposes a Mastodon-compatible API at
`/api/v1/statuses` — if that works for posting, the write path is
already covered with zero changes. Needs live testing against a Lemmy
instance to confirm.

**Effort:** 0–4 hours depending on Mastodon API compatibility.

**Slice 2 total: 2A shipped; 2B deferred until live instance testing.**

---

## Slice 3 — Email newsletter ingestion ✅ DONE

Strategically the highest-value non-protocol source. Entirely in-stack —
the platform already runs Postmark/Resend.

### 3A: Inbound mail infrastructure ✅ DONE

**Migration `096_email_ingest.sql`:**

```sql
-- Per-source ingest mailbox
ALTER TABLE external_sources ADD COLUMN ingest_address TEXT;
CREATE UNIQUE INDEX idx_ext_sources_ingest_addr
  ON external_sources(ingest_address) WHERE ingest_address IS NOT NULL;

-- Dedup fingerprint for newsletters (URL-based canonical matching)
ALTER TABLE external_items ADD COLUMN canonical_url TEXT;
CREATE INDEX idx_ext_items_canonical
  ON external_items(canonical_url) WHERE canonical_url IS NOT NULL;
```

**Files:**

- `gateway/src/routes/inbound-mail.ts` — new route. Receives the
  inbound-parse webhook from Postmark/Resend. Payload: sender, subject,
  HTML body, text body, attachments. Look up `external_sources` by
  `ingest_address` matching the `To:` address. If no match, discard
  (spam/noise). Otherwise enqueue `feed_ingest_email` task.
- `feed-ingest/src/adapters/email.ts` — `normaliseEmail(payload)`.
  Extract `From:` display name, sanitise HTML body (newsletter HTML is
  hostile — inline styles, tracking pixels, layout tables). Use the
  existing `sanitizeContent()` + extend with newsletter-specific rules:
  strip tracking pixels (`<img>` with 1×1 dimensions or known tracker
  domains), collapse layout tables to semantic HTML, strip inline styles
  except basic formatting. Extract a `canonical_url` from "View in
  browser" links (common in newsletters). Extract images from HTML into
  `media[]`.
- `feed-ingest/src/lib/email-ingest.ts` — dual-write helper. Before
  inserting, check for `canonical_url` dedup: if a matching
  `external_items` row already exists (same source, same canonical URL),
  skip. This handles the Substack/Ghost/Buttondown overlap where a user
  subscribes to both the RSS feed and the email.
- `feed-ingest/src/tasks/feed-ingest-email.ts` — task that receives
  `{ sourceId, emailPayload }` and calls the adapter + ingest helper.

### 3B: Subscription flow ✅ DONE

- `gateway/src/routes/external-feeds.ts` — when `protocol = 'email'`,
  generate a unique ingest address (`<uuid>@ingest.all.haus` or similar),
  store it on `external_sources.ingest_address`, and return it to the
  user. The user then subscribes to the newsletter using that address.
- `web/src/components/subscriptions/SubscribeInput.tsx` — when email
  protocol is selected, display the generated ingest address with a copy
  button and instructions.

### 3C: Dedup strategy ✅ DONE

Newsletter-to-RSS overlap is common. Two dedup layers:

1. **Canonical URL match:** Extract "View in browser" / "Read online"
   links from email HTML. If an `external_items` row with the same
   `canonical_url` already exists for any source owned by the same user,
   skip the email insert.
2. **Title + date fuzzy match:** If no canonical URL, check for an
   existing item from the same author with the same title published
   within ±1 hour. This catches newsletters without a "view online" link.

### 3D: Card rendering ✅ DONE

- `web/src/components/cards/ExternalVesselCard.tsx` — `VIA EMAIL` badge.
  Email items get the reader pane treatment on click (reuse the existing
  `ReaderPane` overlay), since newsletter HTML is long-form content that
  doesn't belong inline in a feed card.

**Effort:** ~1 week. The HTML sanitisation is the bulk of the work — newsletter
HTML is the worst HTML on the internet. Budget 2–3 days for the sanitiser alone.

**Status:** Shipped. Migration 096 adds `ingest_address` on
`external_sources` and `canonical_url` on `external_items`. Postmark
inbound webhook at `POST /inbound-mail/:secret` receives newsletter
emails, enqueues `feed_ingest_email` tasks. Email adapter
(`feed-ingest/src/adapters/email.ts`) handles newsletter-specific HTML
sanitisation: strips tracking pixels (1×1 images, known tracker
domains), collapses table-based layouts, strips MSO conditional
comments, then runs through the standard `sanitizeContent()` allowlist.
Canonical URL extraction from "view in browser" links enables
cross-source dedup against RSS. Dual-write helper
(`feed-ingest/src/lib/email-ingest.ts`) checks canonical URL and
title+date fuzzy match before inserting. Subscribe flow generates a
unique `<sourceId>@ingest.all.haus` address returned to the user with
copy-to-clipboard UI. Email sources excluded from poll dispatch (push
only). VesselCard renders `VIA EMAIL` badge and opens ReaderPane on
click (same as RSS articles). Engagement actions (like, repost, reply,
thread) suppressed for email items (tier4, no engagement API).

**Slice 3 total: ~1 week. All four sub-slices shipped.**

---

## Slice 4 — Telegram public channels (read-only, fragile)

**Gate:** Only build this if there is real user demand. The scraping approach
is guaranteed to break without warning when Telegram changes their markup.

### 4A: Read adapter

Telegram channels (broadcast, dated) pass the stream test; groups (places) do
not. Only build the channel path.

**Mechanism:** Fetch `https://t.me/s/<channel>` (public preview page).
Server-side HTML parse into `NormalisedItem[]`. No API, no bot token.

**Files:**

- `feed-ingest/src/adapters/telegram.ts` — `fetchTelegramChannel(channelName)`.
  Fetch the page via `safeFetch`. Parse with `cheerio` (already in the
  dependency tree via other adapters) or `htmlparser2`. Extract message
  divs (`.tgme_widget_message`), parse text content, media thumbnails,
  timestamps. Version the selectors — when they break, the adapter
  returns an empty array and backs off, it doesn't crash.
- `feed-ingest/src/lib/telegram-ingest.ts` — dual-write helper.
- `feed-ingest/src/tasks/feed-ingest-telegram.ts` — poll task. Cursor
  stores the `data-post` attribute of the newest message seen. Set a
  conservative `fetch_interval_seconds` (900 = 15 min) to avoid
  hammering.
- `gateway/src/lib/resolver.ts` — detect `t.me/<channel>` URLs and
  `@<channel>` inputs with Telegram context.

### 4B: Defensive parsing contract

The adapter **must** handle:

- Selector changes → return `{ items: [], parseError: true }`, increment
  error_count, do not deactivate (temporary markup changes shouldn't
  kill the source).
- Cloudflare challenges → detect challenge page, return empty, warn.
- Rate limiting → respect `Retry-After`, never poll faster than 15 min.

No write path. There is no write path for a channel you do not
administer.

**Effort:** 3–4 days including defensive parsing. Add 1 day if `cheerio`
isn't already available and a lighter parser is needed.

**Slice 4 total: ~4 days. Ship behind a feature flag (`telegram_ingest_enabled`
in `platform_config`) so it can be killed instantly when Telegram changes
their markup.**

---

## Slice 5 — Farcaster (bidirectional, requires operating a hub)

### 5A: Infrastructure decision

Farcaster reads come from the open hub network (Snapchain). The cheapest
route is running your own hub, which avoids the Neynar paid API. The hub
gives you a push event stream — follow the Jetstream listener pattern.

**Decision gate:** Commit to operating a hub before writing adapter code.
If the ops cost is disproportionate, defer Farcaster entirely — do not
reach for Neynar without revisiting the no-paid-API rule explicitly.

If proceeding:

### 5B: Read path (listener + backfill)

**Files:**

- `feed-ingest/src/farcaster/listener.ts` — long-lived hub event
  subscriber. Advisory-locked leader election (reuse the Jetstream
  pattern). Subscribe to `CastAdd` events filtered by active FIDs.
  Health flag: `farcaster_hub_healthy` in `platform_config`.
- `feed-ingest/src/adapters/farcaster.ts` — `normaliseFarcasterCast()`.
  Map cast content (text + embeds + mentions) to `NormalisedItem`.
  Farcaster casts carry cryptographic authorship (ed25519 signatures on
  FID-delegated signers) — `tier3` is justified.
- `feed-ingest/src/lib/farcaster-ingest.ts` — dual-write helper.
- `feed-ingest/src/tasks/feed-ingest-farcaster-backfill.ts` — poll
  fallback when hub is unhealthy. Fetch via hub HTTP API
  (`/v1/castsByFid`).
- `feed-ingest/src/tasks/feed-ingest-poll.ts` — exclude `farcaster`
  when `farcaster_hub_healthy = 'true'` (same pattern as atproto).
- `feed-ingest/src/index.ts` — start `FarcasterListener` alongside
  `JetstreamListener`.
- Engagement: Farcaster hubs expose reaction counts — wire into
  `external-engagement-refresh.ts`.
- Threading: casts have `parentCastId` — wire into parent prefetch.

### 5C: Write path

The user authorises a Farcaster _signer_ (a delegated key). all.haus
signs and submits cast messages. The signer-approval flow is
OAuth-shaped and fits the linked-accounts model.

**Files:**

- `gateway/src/routes/linked-accounts.ts` — Farcaster signer approval
  flow (generate signer keypair → user approves on Warpcast →
  store encrypted signer key in `linked_accounts`).
- `feed-ingest/src/adapters/farcaster-outbound.ts` — sign cast with
  signer key, submit to hub via HTTP API.
- `feed-ingest/src/tasks/outbound-cross-post.ts` — add `farcaster` case.

**Effort:** 2–3 weeks including ops shakeout for the hub.

**Slice 5 total: 2–3 weeks. The risk is the hub, not the code.**

---

## Slice 6 — Matrix public rooms (bidirectional, requires homeserver presence)

### 6A: Infrastructure decision

Same shape as Farcaster: commit to operating a homeserver presence
(lightweight appservice or bot account on an existing homeserver) before
writing adapter code.

### 6B: Read path (listener)

**Files:**

- `feed-ingest/src/matrix/listener.ts` — long-lived `/sync` consumer.
  Advisory-locked leader. `since` token stored in `external_sources.cursor`.
  Health flag: `matrix_sync_healthy`.
- `feed-ingest/src/adapters/matrix.ts` — `normaliseMatrixEvent()`. The
  event model is heavier than ActivityPub: state events, redactions,
  edits (`m.replace`), threads (`m.thread`). Collapse edits onto the
  original `external_items` row (UPDATE, not INSERT). Honour redactions
  as soft-deletes. Map `m.thread` to `source_reply_uri`.
- `feed-ingest/src/lib/matrix-ingest.ts` — dual-write helper with
  edit-aware upsert: `ON CONFLICT (protocol, source_item_uri) DO UPDATE
SET content_text = EXCLUDED.content_text, content_html = EXCLUDED.content_html`
  only when the event is an edit.
- `feed-ingest/src/tasks/feed-ingest-matrix-backfill.ts` — poll fallback
  using `/messages` API for room history.

### 6C: Write path

The same `/sync` homeserver posts messages via
`PUT /rooms/{id}/send`. So Matrix is fully bidirectional — the
difficulty is the standing homeserver, not the protocol.

**Files:**

- `feed-ingest/src/adapters/matrix-outbound.ts` — `postMatrixMessage()`.
- `feed-ingest/src/tasks/outbound-cross-post.ts` — add `matrix` case.
- No OAuth flow needed — the bot/appservice token is server-configured,
  not per-user. Users don't link a Matrix account; they reply from
  the all.haus identity through the platform's homeserver presence.

**Effort:** 2–4 weeks. The normalisation layer (edits, redactions,
threads) is the bulk of the work. The homeserver setup is a one-time
ops task.

**Slice 6 total: 2–4 weeks.**

---

## Slice 7 — ActivityPub inbox (push delivery, real-time AP)

The existing AP adapter polls outboxes — it visits each followed actor's
outbox on a schedule and pages backward looking for new items. This works
but carries inherent limitations:

- **Polling lag.** A 30-minute poll interval means items can be up to 30
  minutes stale. Shortening the interval hits instance rate limits.
- **No deletion signal.** Outboxes list what the actor published; they
  have no record of what the actor deleted. The current `CLAUDE.md` notes
  this explicitly: "delete propagation waits for inbox delivery."
- **No edit signal.** Mastodon edits (`Update` activities) are pushed to
  followers, not appended to outboxes. The platform cannot see edits at
  all under outbox polling.
- **Proportional cost.** Polling N sources costs N outbound requests per
  cycle regardless of whether anything changed. An inbox receives only
  actual activity.

The fix is operating an ActivityPub inbox — a publicly-reachable endpoint
that receives pushed activities from remote instances. This is how
ActivityPub was designed to work; outbox polling is the read-only fallback
for observers who are not participants.

### 7A: Infrastructure — all.haus as an AP actor

all.haus must become a recognisable ActivityPub actor:

- A public-facing actor document (e.g. `GET /ap/actor`) returning the
  right JSON-LD (`type: Application`, `inbox`, `outbox`, `publicKey`).
- A WebFinger response at `/.well-known/webfinger` for the actor
  (e.g. `acct:relay@all.haus`).
- An inbox endpoint at the actor's `inbox` URL accepting signed `POST`s.
- HTTP Signature verification on every incoming activity.

The actor is the _platform_, not individual users. all.haus operates one
application-level actor that follows sources on behalf of its users. When
a user subscribes to a Mastodon account, the platform actor sends a
`Follow` to that instance; the instance then delivers `Create`, `Update`,
`Delete`, `Announce` activities to the inbox.

This is the same pattern as Lemmy, PeerTube, and other platform-level
AP actors. It is well-understood and does not require per-user identity
on the fediverse.

**Decision gate:** This is a posture commitment. The platform becomes a
participant in the fediverse, not just an observer. The operational
surface grows: incoming HTTP traffic from any instance, signature
verification, Follow lifecycle management. Decide whether this is
acceptable before writing code.

### 7B: Read path (inbox receiver)

**Files:**

- `gateway/src/routes/activitypub-inbox.ts` — `POST /ap/inbox`. Verify
  HTTP Signatures against the sender's public key (fetch + cache the
  actor document). Validate the activity shape. Dispatch by type:
  - `Create` → enqueue `feed_ingest_activitypub_inbox` task.
  - `Update` → same task with an `isEdit: true` flag.
  - `Delete` → soft-delete the `external_items` row, remove from
    `feed_items`.
  - `Announce` (boost) → currently ignored by the outbox adapter;
    same treatment here unless boost-forwarding is later desired.
  - `Undo` → handle `Undo Follow` (cleanup if the remote instance
    unfollows us) and `Undo Like/Announce` (ignore — we don't track
    reverse engagement).
  - Everything else → 202 (accepted, not processed).
- `feed-ingest/src/tasks/feed-ingest-activitypub-inbox.ts` — the task.
  Reuses `normaliseActivityPubItem()` from the existing adapter and
  `insertActivityPubItem()` from the dual-write helper. For edits:
  `UPDATE external_items SET content_text = ..., content_html = ...
WHERE protocol = 'activitypub' AND source_item_uri = ...`. This is
  the first adapter with edit support — the upsert shape serves as
  precedent for Matrix (Slice 6).
- `gateway/src/routes/activitypub-actor.ts` — `GET /ap/actor` returns
  the actor document. Nginx routes `/.well-known/webfinger` queries for
  the actor to the gateway (alongside the existing OAuth client metadata
  route).
- `shared/src/lib/http-signatures.ts` — HTTP Signature verification.
  Verify `(request-target)`, `host`, `date`, `digest` headers against
  the sender actor's `publicKey`. Actor documents cached (5-min TTL,
  LRU). Reject signatures older than 5 minutes. This is the
  fediverse-standard verification — libraries exist but the core is
  small enough to own.

### 7C: Follow lifecycle

When a user subscribes to an AP source, the platform must send a `Follow`
activity. When they unsubscribe, send `Undo Follow`.

**Files:**

- `gateway/src/routes/external-feeds.ts` — on AP subscribe, after
  creating the `external_subscriptions` row, enqueue a
  `send_activitypub_follow` task. On unsubscribe, enqueue
  `send_activitypub_undo_follow`.
- `feed-ingest/src/tasks/send-activitypub-follow.ts` — signs and POSTs
  the `Follow` activity to the remote actor's inbox using the platform
  actor's private key. Records the Follow state on `external_sources`
  (`follow_state: 'pending' | 'accepted' | 'rejected'`).
- `feed-ingest/src/tasks/feed-ingest-activitypub-inbox.ts` — also
  handles incoming `Accept Follow` and `Reject Follow`: updates
  `follow_state` on the source row.
- `migrations/0XX_ap_inbox.sql` — `follow_state` and
  `last_inbox_delivery_at` on `external_sources`. Platform actor
  keypair in `platform_config` (or env vars — implementer's call).

### 7D: Coexistence with outbox polling

Inbox delivery and outbox polling must coexist:

- Not all instances accept Follows from unknown actors (allowlist-only
  instances, instances that block the platform's domain).
- The Follow→Accept round-trip is asynchronous and may never complete.
- Polling is the universal fallback; inbox delivery is the optimisation.

The poll task checks `last_inbox_delivery_at` per source. If delivery
arrived within 2× the poll interval, skip the outbox poll for that
source. If delivery goes stale, resume polling. This is conservative —
polling only stops when inbox delivery is proven active.

**Effort:** 2–3 weeks. HTTP Signature verification and Follow lifecycle
are the bulk. Normalisation reuses existing adapter code.

**Slice 7 total: 2–3 weeks. The risk is policy (fediverse participation
posture), not code.**

---

## Slice 8 — Cross-source identity linking

As the platform accumulates external sources across protocols, a pattern
emerges: the same human posts on Mastodon _and_ Bluesky _and_ publishes
an RSS newsletter. A reader who follows all three sees the same content
three times.

### 8A: The problem

Identity fragmentation across protocols:

- A Mastodon profile and a Bluesky profile belong to the same person but
  share no identifier (different handle systems, different key systems,
  different instance domains).
- Cross-posted content (the same text on both platforms, via Bridgy Fed,
  IFTTT, or manual copy-paste) creates duplicate feed items with no link
  between them.
- The reader's feed becomes noisier with each surface they follow for the
  same person.

This is a _platform_ problem, not a per-protocol problem. No single
adapter can solve it. The fix lives in the shared layer above adapters.

### 8B: Identity signals

Several signals can link identities across platforms, ordered by strength:

1. **User assertion.** The reader tells the platform "these sources are
   the same person." Strongest signal — override everything. Stored as
   an explicit link. Surfaced in the subscription management UI: a
   "Link to…" action on any source, backed by the resolver so the user
   can paste a URL/handle from another platform.
2. **Bridge markers.** Items arriving via protocol bridges carry metadata
   linking the original and bridged identities.
   `bridgy-fed.superfeedr.com` accounts are Bluesky mirrors;
   `mostr.pub` accounts are Nostr mirrors. The bridge domain is a
   reliable signal that two sources share an author.
3. **Explicit cross-links.** Many profiles include links to their other
   accounts: a Mastodon bio contains a Bluesky handle, a Bluesky
   profile links to a personal site with an RSS feed. These are strong
   signals but require fetching and parsing profile metadata.
4. **Shared verified domain.** An RSS feed at `alice.example.com/feed`
   and a Mastodon profile that verifies `alice.example.com` likely
   belong to the same person. Medium-confidence — domain verification
   is meaningful but not infallible.

### 8C: Schema

**Migration:**

```sql
CREATE TABLE external_identity_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_a_id UUID NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  source_b_id UUID NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN (
    'user_asserted', 'bridge', 'cross_link', 'domain_match'
  )),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_a_id, source_b_id)
);
CREATE INDEX idx_identity_links_source_a ON external_identity_links(source_a_id);
CREATE INDEX idx_identity_links_source_b ON external_identity_links(source_b_id);
```

Symmetric link between two `external_sources`. Normalise order
(`source_a_id < source_b_id`) to avoid duplicates.

No `external_authors` table yet. Identity linking works at the source
level. A constructed `external_authors` entity is the
CARD-BEHAVIOUR-ADR §VI.3 concern and is deferred alongside it — the
linking infrastructure here is a prerequisite for it.

### 8D: Content dedup at query time

When sources are linked, the feed query deduplicates items that share the
same content fingerprint:

- **Same canonical URL** (for items that carry one — email canonical URLs,
  RSS GUIDs that are URLs, Bluesky/Mastodon post URLs embedded in
  cross-posts).
- **Title + timestamp match** (same title, published within ±5 minutes)
  for items without canonical URLs.
- **Text-content hash match** as a fallback — first 200 chars normalised
  (lowercased, whitespace-collapsed, stripped of URLs) hashed. Catches
  manual copy-paste cross-posts that share no structural metadata.

The highest-biddability-tier version wins; losers are suppressed. The
winning card renders a quiet provenance note: `ALSO ON BLUESKY ·
MASTODON`.

Dedup is a **query-time filter**, not an ingest-time merge. Both items
exist in `external_items`. This preserves the ability to unlink sources
without data loss, and means the dedup logic can be tuned without
reingesting anything.

Implementation: a CTE or subquery in the feed query that groups linked
items by content fingerprint, ranks by biddability tier, and filters to
the winner. The cost is a join through `external_identity_links` —
bounded by the number of linked sources per user (small).

### 8E: Detection (automated)

A periodic task (`identity_link_detect`, daily) scans `external_sources`
for cross-reference signals:

- **Bridge domains:** match `bridgy-fed.superfeedr.com` and `mostr.pub`
  source URIs to their mirrored counterparts. `link_type = 'bridge'`,
  `confidence = 0.95`.
- **Profile URL cross-links:** for Bluesky and Mastodon sources, fetch
  the profile (already cached by `source-metadata-refresh`) and parse
  links in the bio against known source URIs. `link_type = 'cross_link'`,
  `confidence = 0.8`.
- **Domain verification:** match RSS source domains against Mastodon
  verified links. `link_type = 'domain_match'`, `confidence = 0.7`.

User-asserted links override automated ones (`confidence = 1.0`) and are
never revisited by the detection task.

### 8F: Subscription management UI

- `web/src/pages/subscriptions.tsx` — sources that are linked display
  as a group with a link icon. Clicking the group expands to show
  individual sources with protocol badges.
- "Link to…" action on each source opens a resolver-backed input where
  the user can paste a URL/handle from another platform. Creates a
  `user_asserted` link.
- "Unlink" action breaks a link. Dedup immediately stops for that pair.

**Effort:** 1–2 weeks for the linking schema + query-time dedup +
subscription UI. Automated detection adds ~3 days.

**Slice 8 total: 2–3 weeks. No infrastructure gate — pure application
logic.**

---

## Slice 9 — Feed-side support for CARD-BEHAVIOUR-ADR

`docs/adr/CARD-BEHAVIOUR-ADR.md` introduces a unified card interaction
model that requires two ingest-path changes. These are small and additive
but must ship before the card-behaviour frontend work can land.

### 9A: `is_reply` on `feed_items`

The card-behaviour spec renders a `↳ REPLYING TO @handle` provenance line
on reply items. The feed list query must know "is this card a reply"
**without joining `external_items`**.

**Migration:**

```sql
ALTER TABLE feed_items ADD COLUMN is_reply BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: external items
UPDATE feed_items fi SET is_reply = TRUE
FROM external_items ei
WHERE fi.source_id = ei.id
  AND fi.item_type = 'external'
  AND ei.source_reply_uri IS NOT NULL;

-- Backfill: native notes (kind 1 with e-tag = reply)
UPDATE feed_items fi SET is_reply = TRUE
FROM notes n
WHERE fi.item_type = 'note'
  AND fi.source_id = n.id
  AND n.reply_to_event_id IS NOT NULL;
```

Populate on write in all dual-write paths:

- External ingest helpers: `is_reply = (source_reply_uri IS NOT NULL)`.
- Note creation in `gateway/src/routes/notes.ts`: `is_reply = TRUE`
  when the note carries an `e`-tag reply target.
- Articles: always `FALSE`.

Add to `feed_items_reconcile` drift-check query.

### 9B: Biddability tier on the feed API

The card-behaviour spec defines four biddability tiers (A/B/C/D) — a
UI-capability classification computed from protocol + metadata. This is a
**derived value**, not a stored column. Compute it in the feed response
projection:

- Native or external-Nostr or Bluesky → `A` (threaded & resolvable)
- ActivityPub → `B` (threaded, best-effort)
- RSS with `author_uri` → `C` (standalone, attributed)
- RSS without `author_uri`, or any item with missing metadata → `D`
  (standalone, sparse)

Expose as `biddabilityTier: 'A' | 'B' | 'C' | 'D'` on the feed API
item shape so the client receives it without duplicating the logic.

**Effort:** 1–2 days. Both changes are small. The migration is the only
risk (dual-write column on `feed_items` — same discipline as every
prior column addition).

**Slice 9 total: 1–2 days.**

---

## Recommended sequence

| Order | Slice                                                                         | Effort    | Depends on               |
| ----- | ----------------------------------------------------------------------------- | --------- | ------------------------ |
| 1     | **Slice 0** — schema migration ✅                                             | 1 hour    | —                        |
| 2     | **Slice 1** — RSS family (JSON Feed ✅, podcasts ✅, YouTube ✅, Substack ✅) | 2 days    | —                        |
| 3     | **Slice 2** — Lemmy AP compatibility check + wiring ✅                        | 1–3 days  | —                        |
| 4     | **Slice 3** — Email newsletters ✅                                            | 1 week    | Slice 0                  |
| 5     | **Slice 9** — CARD-BEHAVIOUR-ADR feed support (`is_reply`, biddability) ✅    | 1–2 days  | —                        |
| 6     | **Slice 8** — Cross-source identity linking                                   | 2–3 weeks | —                        |
| 7     | **Slice 7** — ActivityPub inbox (push delivery)                               | 2–3 weeks | Posture commitment       |
| 8     | **Slice 4** — Telegram channels                                               | 4 days    | Slice 0 + user demand    |
| 9     | **Slice 5** — Farcaster                                                       | 2–3 weeks | Slice 0 + ops commitment |
| 10    | **Slice 6** — Matrix                                                          | 2–4 weeks | Slice 0 + ops commitment |

**Next up:** Slice 9 is the smallest unit of work and unblocks the
CARD-BEHAVIOUR-ADR frontend. Slice 8 (identity linking) is the
highest-value remaining application-logic slice — no infrastructure gate,
pure product improvement that gets more valuable as the source count
grows.

Slice 7 (AP inbox) requires a posture decision: is all.haus a fediverse
_participant_ or just an _observer_? If participant, Slice 7 unlocks
real-time AP delivery, edit propagation, and delete propagation — the
three things outbox polling cannot do. Schedule it when the decision is
made.

Slices 5 and 6 each require an infrastructure commitment (hub /
homeserver) that should be made deliberately, not as a side effect of
adapter development. Schedule them when there is appetite to operate
another server.

Slice 4 (Telegram) remains last among the non-infrastructure slices.
The scraping approach is guaranteed to break without warning. Only build
it if users are asking for it.

---

## Definition of done, per adapter

- [ ] Migration extends enum + CHECK if needed; tier mapping decided
- [ ] Read: `adapters/<p>.ts` returns normalised items; `lib/<p>-ingest.ts`
      dual-writes `external_items` + `feed_items` with `ON CONFLICT DO NOTHING`
- [ ] Task wired into poll loop (pull) or health-flagged listener (push)
- [ ] Subscribe flow works end-to-end: user subscribes → source created →
      first fetch runs → items appear in following feed
- [ ] Cards render correctly: author, content, media, provenance badge,
      reply lineage. No field faked to satisfy the schema
- [ ] Engagement refresh: protocol branch added (even if it's "skip — no
      public counts API")
- [ ] Parent prefetch: protocol branch added (even if it's "skip — no
      threading")
- [ ] Write (where applicable): outbound adapter in `adapters/<p>-outbound.ts`,
      dispatch case in `outbound-cross-post.ts`, handles `reply`/`quote`/
      `original`, truncates with canonical link, idempotent under retry
- [ ] Failure is quiet: dead source increments `error_count`/`last_error`
      and backs off; never stalls the poll loop or floods logs

---

## Appendix — Out of reach

These are streams (they pass the stream/place test) that no compliant,
sustainable path exists for under the "no paid API" constraint. They are
blocked by corporate policy, not engineering.

**X / Twitter** — Closed both directions. The 2026 pay-per-use model is
priced and capped against a polling aggregator. No compliant path.
Revisit only if X changes its pricing model.

**Threads** — No third-party ingest API. Partial exception: Threads
accounts that opt into fediverse sharing are already ingestible through
the existing `activitypub` adapter for free. That subset grows as Meta
expands the feature. No dedicated work needed.

**Instagram / Facebook** — Graph API serves only accounts the developer
owns or manages. No mechanism to subscribe to an arbitrary account's
stream. Closed.

**TikTok** — Display API is own-content-only with app approval. Closed.

**LinkedIn** — Content-read API access is partner-gated. Closed.

**YouTube comment ingestion / write-back** — Free Data API quota (~10k
units/day) caps platform-wide comment posting at ~200/day. Blocked by
quota ceiling. Channel-RSS read is fully achievable and is in Slice 1.

**Reddit** — Excluded on principle: a place, not a stream. If a specific
subreddit's "new posts" surface is ever wanted, that is a plain RSS
source (the doorway, not the building).
