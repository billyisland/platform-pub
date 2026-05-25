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

| Protocol                    | Read | Write | Mechanism                                            |
| --------------------------- | ---- | ----- | ---------------------------------------------------- |
| Nostr (`nostr_external`)    | ✓    | ✓     | Relay subscriptions; outbound signed events          |
| ActivityPub (`activitypub`) | ✓    | ✓     | Outbox poll; outbound `POST /api/v1/statuses`        |
| AT Protocol (`atproto`)     | ✓    | ✓     | Jetstream firehose + backfill; outbound via user PDS |
| RSS/Atom (`rss`)            | ✓    | —     | `rss-parser` poll, ETag/Last-Modified conditional    |

Every new read adapter normalises into `external_items` + dual-writes
`feed_items`. Every write adapter consumes `outbound_posts`. No parallel
pipelines.

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

One migration that extends the enum and CHECK for every protocol this plan
will add. Do it once so adapter work is never blocked on a migration.

**Migration `094_external_protocol_expansion.sql`:**

```sql
-- New protocol values
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'farcaster';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'matrix';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'telegram';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'email';

-- Replace the CHECK with one that covers all protocols.
-- (rss stays tier4; telegram and email are unverified → tier4;
--  farcaster has crypto authorship → tier3; matrix → tier4)
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

**Status:** Shipped. Migration `094_external_protocol_expansion.sql` + gateway
stub rejection + `schema.sql` sync.

**Do not add a `lemmy` enum value.** Lemmy speaks ActivityPub. Slice 2 will
confirm whether the existing adapter covers it; if so, Lemmy sources just use
`protocol = 'activitypub'` and the only work is UI labelling.

---

## Slice 1 — RSS-family enrichment (no schema changes)

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

### 1C: YouTube channel RSS

Every channel exposes
`https://www.youtube.com/feeds/videos.xml?channel_id=…`.
Free, unlimited, no API key.

**Files:**

- `gateway/src/lib/resolver.ts` — add a `youtube` classification chain
  in the universal resolver. Detect `youtube.com/channel/`, `/@handle`,
  `/c/` URLs. For handle/custom URLs, fetch the channel page and extract
  `channel_id` from the `<link rel="canonical">` or `externalId` in the
  page source. Return the RSS feed URL as the resolved `sourceUri` with
  `protocol: 'rss'`.
- `web/src/components/cards/ExternalVesselCard.tsx` — detect YouTube
  video URLs in RSS items and render inline video embed via the existing
  `MediaBlock` YouTube iframe path.

**Acceptance:** User pastes a YouTube channel URL or `@handle` in the
subscribe input. Resolver resolves it to the RSS feed URL. Videos appear
in the following feed with titles, thumbnails, and inline playback on
expand.

**Effort:** Half a day (mostly the handle→channel_id resolution).

### 1D: Substack publication RSS

Every Substack publication exposes `/feed`. Plain RSS.

**Files:**

- `gateway/src/lib/resolver.ts` — add a `substack` classification in
  the resolver. Detect `*.substack.com` URLs and bare `<name>.substack.com`
  inputs. Append `/feed` to produce the RSS source URI. Also probe
  custom-domain Substacks by checking for `<link type="application/rss+xml">`
  in the page head.

**Acceptance:** User pastes a Substack URL or `name.substack.com` handle.
Resolver returns the RSS feed. Posts appear in the following feed.

**Effort:** 2–3 hours.

**Slice 1 total: ~2 days. Large surface-area gain, zero risk.**

---

## Slice 2 — Lemmy / PieFed / Mbin (AP compatibility check)

Before writing any code, confirm whether the existing `activitypub`
adapter already resolves Lemmy/PieFed/Mbin actors and ingests their
outboxes.

### 2A: Compatibility audit (1–2 hours)

1. Stand up a test subscription to a Lemmy community's ActivityPub actor
   URL (e.g. `https://lemmy.ml/c/linux`) and a Lemmy user actor URL.
2. Check: does `fetchActor()` find the outbox? Does `fetchOutbox()`
   return parseable `Create → Note` activities? Are `content_html` and
   threading (`inReplyTo`) correct?
3. Check PieFed and Mbin — same test with their public instances.

**If it works (likely):** Lemmy is already covered. The only work is:

- Resolver: detect `lemmy.*/c/*`, `lemmy.*/u/*` URLs and resolve to AP
  actor URIs.
- UI: display community/user context in `ExternalVesselCard` (Lemmy
  posts carry a community `audience` field that the AP adapter currently
  ignores — surface it as a `VIA LEMMY · c/linux` provenance line).
- **No new enum value, no new adapter, no migration.** A few hours of work.

**If it doesn't work:** Lemmy's AP representation is lossy in ways that
matter (vote counts missing, post body in `source` not `content`, etc.).
Build a thin REST adapter against `GET /api/v3/post/list` and
`GET /api/v3/comment/list`. This is a new protocol (`lemmy`) with its
own enum value — revisit the Slice 0 migration to add it.

**Effort:** 2 hours for the audit, then either 3 hours (AP works) or
1 week (need REST adapter). Bet on AP working.

### 2B: Write-back (fast follow, only if AP works)

Lemmy's REST API supports `POST /api/v3/comment` with a JWT token.
This makes Lemmy a real bidirectional candidate via `outbound_posts`.

**Files (if needed):**

- `feed-ingest/src/adapters/lemmy-outbound.ts` — `postLemmyComment()`
- `feed-ingest/src/tasks/outbound-cross-post.ts` — but this dispatches
  by `external_protocol`, and if Lemmy uses `activitypub` protocol,
  outbound replies already go through `postMastodonStatus()`. Check
  whether Mastodon-style status posting works against a Lemmy instance
  (Lemmy exposes a Mastodon-compatible API at `/api/v1/statuses`). If
  so: zero work.

**Effort:** 0–4 hours depending on Mastodon API compatibility.

**Slice 2 total: 1–3 days.**

---

## Slice 3 — Email newsletter ingestion

Strategically the highest-value non-protocol source. Entirely in-stack —
the platform already runs Postmark/Resend.

### 3A: Inbound mail infrastructure

**Migration `095_email_ingest.sql`:**

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

### 3B: Subscription flow

- `gateway/src/routes/external-feeds.ts` — when `protocol = 'email'`,
  generate a unique ingest address (`<uuid>@ingest.all.haus` or similar),
  store it on `external_sources.ingest_address`, and return it to the
  user. The user then subscribes to the newsletter using that address.
- `web/src/components/subscriptions/SubscribeInput.tsx` — when email
  protocol is selected, display the generated ingest address with a copy
  button and instructions.

### 3C: Dedup strategy

Newsletter-to-RSS overlap is common. Two dedup layers:

1. **Canonical URL match:** Extract "View in browser" / "Read online"
   links from email HTML. If an `external_items` row with the same
   `canonical_url` already exists for any source owned by the same user,
   skip the email insert.
2. **Title + date fuzzy match:** If no canonical URL, check for an
   existing item from the same author with the same title published
   within ±1 hour. This catches newsletters without a "view online" link.

### 3D: Card rendering

- `web/src/components/cards/ExternalVesselCard.tsx` — `VIA EMAIL` badge.
  Email items get the reader pane treatment on click (reuse the existing
  `ReaderPane` overlay), since newsletter HTML is long-form content that
  doesn't belong inline in a feed card.

**Effort:** ~1 week. The HTML sanitisation is the bulk of the work — newsletter
HTML is the worst HTML on the internet. Budget 2–3 days for the sanitiser alone.

**Slice 3 total: ~1 week.**

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

## Recommended sequence

| Order | Slice                                                                   | Effort    | Depends on               |
| ----- | ----------------------------------------------------------------------- | --------- | ------------------------ |
| 1     | **Slice 0** — schema migration ✅                                       | 1 hour    | —                        |
| 2     | **Slice 1** — RSS family (JSON Feed ✅, podcasts ✅, YouTube, Substack) | 2 days    | —                        |
| 3     | **Slice 2** — Lemmy AP compatibility check + wiring                     | 1–3 days  | —                        |
| 4     | **Slice 3** — Email newsletters                                         | 1 week    | Slice 0                  |
| 5     | **Slice 4** — Telegram channels                                         | 4 days    | Slice 0                  |
| 6     | **Slice 5** — Farcaster                                                 | 2–3 weeks | Slice 0 + ops commitment |
| 7     | **Slice 6** — Matrix                                                    | 2–4 weeks | Slice 0 + ops commitment |

Slices 1 and 2 are independent of Slice 0 (they don't add new enum
values). Start them in parallel with or before the migration.

Slices 5 and 6 each require an infrastructure commitment (hub /
homeserver) that should be made deliberately, not as a side effect of
adapter development. Schedule them when there is appetite to operate
another server.

Slice 4 (Telegram) is last among the non-infrastructure slices because
it is the one source guaranteed to break without warning. Only build it
if users are asking for it.

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
