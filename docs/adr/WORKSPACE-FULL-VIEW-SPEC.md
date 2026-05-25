# Workspace Full View — Build Spec

**Status:** Phase 6B shipped (2026-05-25, branch `workspace-experiment`). All phases complete. Phase 6B: reply grouping — pure `groupReplies()` post-processing in `sourceFilteredItems()` groups external items sharing the same `source_reply_uri` (2+ siblings) into `reply_group` envelopes; new `ReplyGroupCard` component renders `ParentContextTile` once + chronological `ExternalPlayscriptEntry` list. Phase 6A fixes: context-only items filtered from feeds, engagement counts added to platform timeline, grandparent tag persisted in `interaction_data` JSONB (both gateway parent-fetch and feed-ingest prefetch), missing `source_reply_uri`/`content_text` columns added to Mastodon prefetch INSERT, `WorkspaceFeedApiExternal` type completed (`contentWarning`, `poll`), `useLiveEngagement` cache aligned to 30s with error-recovery reset. Phase 5 adds: (5A) Mastodon content warnings — migration 093 adds `content_warning` column to `external_items`, AP adapter captures `spoiler_text` from sensitive notes, `ContentWarning` component wraps content with reveal toggle. (5B) Poll display + voting — AP adapter extracts `oneOf`/`anyOf` poll data into `interaction_data.poll`, `PollDisplay` component renders option bars with interactive voting, `POST /external-items/:id/poll-vote` endpoint enqueues via `enqueuePollVote`, feed-ingest `voteMastodonPoll` resolves remote status and POSTs to `/api/v1/polls/:id/votes`. (5C) Reader pane — `GET /api/v1/extract?url=` endpoint using `@mozilla/readability` + `jsdom` with SSRF-hardened fetch and 1h cache, `useReader` Zustand store, `ReaderPane` overlay component (scrim + 640px serif panel), RSS article clicks open reader pane. (5D) Inline video embeds — `MediaBlock` detects YouTube/Vimeo URLs, fetches oEmbed HTML from existing proxy on expand, renders iframe inline with `prefers-reduced-motion` respect. (5E) Pull-to-refresh + empty states — `PullToRefresh` component (touch + wheel overscroll, 60px threshold; desktop wheel accumulates upward delta at scrollTop 0 with 400ms decay), `EmptyFeedTile` with no-sources/no-items/caught-up variants, wired into Vessel and WorkspaceView; caught-up tile renders above existing items when refresh yields no new content. (5F) Context-only GC cron — `external_context_gc` task (daily 02:30 UTC) deletes unreferenced `is_context_only` items older than 30 days.

## Overview

This spec defines two rendering fidelity modes for workspace feed items — **Full** and **Compact** — and the backend infrastructure they require. Fidelity is orthogonal to sampling mode: sampling controls _which_ items appear; fidelity controls _how much_ of each item the user sees.

The goal is to make workspace feeds feel like a fully functional social reader. Regardless of source protocol, every item should be a legible, interactive social object — not a truncated reference to content that lives elsewhere.

---

## 1. Rendering Fidelity Modes

### 1.1 Compact

The default density. Shows:

- **Byline**: mono-caps author name, timestamp, protocol badge
- **Headline / snippet**: title (if article-type) or first ~140 chars of content
- **Engagement counts**: like, reply, repost counts (snapshot from ingest time, refreshed periodically — not live)
- No inline media, no action row, no thread expansion

**Click behavior**: expands to Full in-place (the compact tile grows to reveal the full rendering). No navigation.

### 1.2 Full

The richest rendering. Everything in Compact, plus:

- **Live engagement counts** (fetched when the tile appears, streamed in asynchronously — see §2)
- **Full content rendering** with paragraph breaks, inline media (images, galleries, GIFs, embedded content), video players, content warnings
- **Parent context tile** for replies (see §3)
- **Thread expansion** on click (playscript format — see §4)
- **Interactive action row**: reply, like/upvote, repost/boost, quote (per-protocol availability — see §5)
- **Reader pane** trigger for article-type items (see §6)
- **Interactive polls** (Mastodon — see §7)

---

## 2. Engagement Counts

### 2.1 Data model

Add denormalised count columns to `external_items`:

```sql
ALTER TABLE external_items ADD COLUMN like_count    INT DEFAULT 0;
ALTER TABLE external_items ADD COLUMN reply_count   INT DEFAULT 0;
ALTER TABLE external_items ADD COLUMN repost_count  INT DEFAULT 0;
```

These columns serve as the snapshot for Compact mode and as the cache seed for Full mode.

### 2.2 Snapshot refresh (Compact mode)

A periodic background task in feed-ingest refreshes counts for recent items (e.g., items published within the last 7 days). Cadence: every 30–60 minutes.

- **Bluesky**: batch `getPosts` (up to 25 URIs per call)
- **Mastodon**: individual `GET /api/v1/statuses/:id` calls, parallelised per instance, respecting rate limits
- **External Nostr**: REQ for kind 7 reactions + kind 1 replies referencing each event, per relay
- **RSS**: no counts; columns stay at 0, engagement row omitted in UI

### 2.3 Live fetch (Full mode)

When a tile renders in Full mode, the frontend fires a request to a new gateway endpoint that fetches fresh counts from the source platform in real time.

**Endpoint**: `GET /api/v1/external-items/:id/engagement`

Returns: `{ likeCount, replyCount, repostCount, protocol, fetchedAt }`

The gateway dispatches by protocol:

| Protocol       | Method                     | Latency    | Notes                                   |
| -------------- | -------------------------- | ---------- | --------------------------------------- |
| atproto        | `getPosts` batch (AppView) | ~100ms     | Batch up to 25 URIs per call            |
| activitypub    | `GET /api/v1/statuses/:id` | ~200-400ms | One call per item per instance          |
| nostr_external | REQ to source relays       | ~1-2s      | Count kind 7 + kind 1 referencing event |
| rss            | N/A                        | —          | Return stored zeros                     |

The frontend streams counts in: tiles render immediately with snapshot counts from the feed response, then update when live counts arrive. For a feed page, Bluesky items batch into one call; Mastodon and Nostr items fire in parallel.

### 2.4 Normalised iconography

All protocols use the same icon set:

| Icon          | Meaning                        | Maps from                                      |
| ------------- | ------------------------------ | ---------------------------------------------- |
| Heart         | Likes / favourites / reactions | Bluesky like, Mastodon favourite, Nostr kind 7 |
| Speech bubble | Replies                        | All protocols                                  |
| Repost arrows | Reposts / boosts               | Bluesky repost, Mastodon reblog                |

---

## 3. Parent Context Tiles

When a feed item is a reply (has `source_reply_uri`), the workspace must show what it's replying to.

### 3.1 Immediate parent

The parent post renders as a **first-class tile** in the feed — full content, full engagement counts, full action row. It is not collapsed, ghosted, or visually diminished. The reply tile appears directly below it.

The parent is fetched from the source platform if not already in `external_items`:

- **Bluesky**: `getPostThread` or `getPosts` with the parent URI
- **Mastodon**: `GET /api/v1/statuses/:id` using the `inReplyTo` value from `interaction_data`
- **External Nostr**: REQ to source relays for the referenced event ID

The fetched parent is stored in `external_items` as a **context item** — it exists in the table for rendering and reference but is not independently surfaced in feeds unless a subscription covers its author. New column:

```sql
ALTER TABLE external_items ADD COLUMN is_context_only BOOLEAN DEFAULT FALSE;
```

Context-only items are excluded from `feed_items` insertion (they don't appear in feeds on their own) but are joinable by items that reference them.

### 3.2 Grandparent and above

If the parent tile is itself a reply, it shows a compact tag at the top:

```
→ REPLYING TO @username
```

No further ancestor rendering. The tag uses the grandparent's author display name, fetched alongside the parent.

### 3.3 Reply grouping

When two or more subscribed users reply to the same external post, the parent tile appears **once** with all replies grouped beneath it. The group is positioned at the **timestamp of the most recent reply** (the group floats up).

Implementation: the feed query detects items sharing the same `source_reply_uri`, deduplicates the parent, and orders the group by the latest reply's `published_at`.

If grouping is missed (race condition, pagination boundary), it's acceptable to render the parent tile twice.

### 3.4 Shadow items for dual-write replies

When a user replies to an external post from the workspace (see §5.1), the reply is also stored as an all.haus note. That note carries a reference to the external parent item. Wherever the note appears (the user's all.haus profile, another user's feed), the external parent tile renders above it as context.

This requires storing a durable local copy of the external parent — the `is_context_only` external item serves this purpose. The all.haus note references it via a new column:

```sql
ALTER TABLE notes ADD COLUMN external_parent_id UUID REFERENCES external_items(id) ON DELETE SET NULL;
```

---

## 4. Thread Expansion

Clicking a feed item in Full mode expands its reply thread inline, rendered in **playscript format** (the existing `PlayscriptThread` pattern).

### 4.1 Thread fetch

**Endpoint**: `GET /api/v1/external-items/:id/thread`

Returns: `{ ancestors: ExternalThreadEntry[], descendants: ExternalThreadEntry[] }`

Where `ExternalThreadEntry` is:

```typescript
{
  id: string; // source platform ID
  authorName: string;
  authorHandle: string;
  authorUri: string;
  contentHtml: string;
  contentText: string;
  publishedAt: string;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  parentId: string | null; // for threading within the playscript
  protocol: string;
}
```

Dispatch by protocol:

| Protocol       | Method                                | Caching        |
| -------------- | ------------------------------------- | -------------- |
| atproto        | `app.bsky.feed.getPostThread`         | Live fetch     |
| activitypub    | `GET /api/v1/statuses/:id/context`    | Live fetch     |
| nostr_external | REQ to source relays for reply events | 5-minute cache |
| rss            | N/A                                   | No threads     |

### 4.2 Playscript rendering

Thread entries render using the playscript pattern:

- **Speaker line**: mono-caps 11px, author name, colon
- **Dialogue line**: Jost 14.5px, 1.55 line height
- **Non-adjacent parent**: `→ PARENT:` prefix when the reply's parent isn't the previous entry
- **Reply tag**: each playscript entry has a small `REPLY` tag that, when clicked, opens an inline text field for composing a reply to that specific entry (see §5.1)
- **Flat chronological order**: no nesting or indentation beyond the single 32px step-in from the parent card

### 4.3 Pagination

First 10 entries, then `SHOW N MORE REPLIES` (mono-caps, grey-400, underlined on hover).

---

## 5. Cross-Platform Interactions

All interactions require a **linked account** for the source platform. If the user doesn't have one:

- Action buttons render **greyed out**
- Clicking a greyed action shows a prompt: "Connect your [Platform] account to interact" with a link to `/settings` (LinkedAccountsPanel)

### 5.1 Reply

**Trigger**: clicking the `REPLY` tag on any playscript entry or the reply action on a feed tile.

**UX**: an inline text field appears below the target entry (within the thread expansion) or below the tile. The field shows which platform the reply will be posted to. Submit sends the reply.

**Dual-write**: the reply is sent to the source platform AND stored as an all.haus note with `external_parent_id` referencing the item being replied to. This means the reply appears in the user's all.haus note history and carries its parent context wherever it's displayed.

**Outbound dispatch** (existing `outbound_cross_post` infrastructure, extended):

| Protocol       | Method                                                                         |
| -------------- | ------------------------------------------------------------------------------ |
| atproto        | `com.atproto.repo.createRecord` with reply strong-refs from `interaction_data` |
| activitypub    | `POST /api/v1/statuses` with `in_reply_to_id`                                  |
| nostr_external | Kind 1 with NIP-10 `e`/`p` tags, published to source relays                    |

### 5.2 Like / Favourite

**New outbound action type**: `like`

| Protocol       | Method                                                  |
| -------------- | ------------------------------------------------------- |
| atproto        | `app.bsky.feed.like` (createRecord)                     |
| activitypub    | `POST /api/v1/statuses/:id/favourite`                   |
| nostr_external | Kind 7 reaction event (`+`), published to source relays |
| rss            | N/A (action hidden)                                     |

### 5.3 Repost / Boost

**New outbound action type**: `repost`

| Protocol       | Method                                          |
| -------------- | ----------------------------------------------- |
| atproto        | `app.bsky.feed.repost` (createRecord)           |
| activitypub    | `POST /api/v1/statuses/:id/reblog`              |
| nostr_external | No standard mechanism (action hidden for Nostr) |
| rss            | N/A (action hidden)                             |

### 5.4 Quote

**Existing outbound action type**: `quote` (already implemented)

| Protocol       | Method                                              |
| -------------- | --------------------------------------------------- |
| atproto        | `createRecord` with `app.bsky.embed.record`         |
| activitypub    | Not natively supported (action hidden for Mastodon) |
| nostr_external | Kind 1 with `q` tag                                 |
| rss            | N/A                                                 |

### 5.5 Action availability matrix

| Action    | Bluesky | Mastodon | Ext. Nostr | RSS |
| --------- | ------- | -------- | ---------- | --- |
| Reply     | ✓       | ✓        | ✓          | —   |
| Like      | ✓       | ✓        | ✓          | —   |
| Repost    | ✓       | ✓        | —          | —   |
| Quote     | ✓       | —        | ✓          | —   |
| Poll vote | —       | ✓        | —          | —   |

Actions not available for a given protocol are hidden (not greyed out — that treatment is reserved for "available but needs linked account").

---

## 6. Reader Pane

For article-type items (RSS articles, long-form blog posts linked from social posts), clicking opens a **reader pane overlay**.

### 6.1 Component

New component: `ReaderPane` — a modal overlay similar to `ComposeOverlay`.

- **Scrim**: 40% dark overlay behind the pane
- **Pane**: centred, max-width `article` (640px), white background, vertical scroll
- **Content**: Readability-extracted article body (clean HTML — text, images, headings, blockquotes)
- **Header**: source attribution (site name, original URL), publish date
- **Actions**: "Open in new tab" button (opens original URL), close (X) button
- **Dismiss**: click scrim, press Escape, or click X

### 6.2 Extraction

New gateway endpoint: `GET /api/v1/extract?url=<encoded-url>`

Server-side Readability extraction (Mozilla's `@mozilla/readability` + `jsdom`). Returns:

```typescript
{
  title: string;
  content: string; // clean HTML
  textContent: string; // plain text fallback
  excerpt: string;
  siteName: string;
  byline: string;
  length: number; // character count
  success: boolean;
}
```

**Caching**: extracted content cached in-memory or Redis with a 1-hour TTL keyed by URL. Extraction is expensive; avoid re-parsing on every click.

**Failure handling**: if extraction fails or returns `success: false`, fall back to opening the original URL in a new browser tab. No degraded view.

**SSRF**: the extraction endpoint must use the existing SSRF-hardened HTTP client (`shared/src/lib/http-client.ts`) for fetching.

### 6.3 Video items

Items linking to video content (YouTube, Vimeo, etc.) do **not** open the reader pane. Instead, the video plays inline in the feed tile via oEmbed iframe embedding. The existing oEmbed proxy in `gateway/src/routes/media.ts` handles this.

---

## 7. Content Fidelity

### 7.1 Paragraph breaks

Fix: audit RSS sanitisation in `feed-ingest/src/adapters/rss.ts` and `ExternalCard` / `ExternalVesselCard` rendering. Ensure `<p>` tags are preserved through normalisation and rendered with proper spacing.

### 7.2 Content warnings (Mastodon)

Mastodon posts with `spoiler_text` render collapsed by default:

- Show the spoiler text as a label
- `SHOW CONTENT` toggle (mono-caps) to reveal
- Content stays revealed for the session; state not persisted

Requires capturing `spoiler_text` at ingest time. New column:

```sql
ALTER TABLE external_items ADD COLUMN content_warning TEXT;
```

### 7.3 Polls (Mastodon)

Display poll options with current vote counts and percentages. If the user has a linked Mastodon account on the poll's instance, show interactive vote buttons.

**Voting endpoint**: `POST /api/v1/external-items/:id/poll-vote` — proxies to `POST /api/v1/polls/:pollId/votes` on the source Mastodon instance.

**Display-only** for all other protocols (Bluesky has no native poll primitive; Nostr NIP-69 adoption is negligible).

Poll data stored in `interaction_data`:

```typescript
// Mastodon poll shape in interaction_data
{
  poll: {
    id: string;
    expiresAt: string | null;
    expired: boolean;
    multiple: boolean; // multi-select poll
    options: Array<{
      title: string;
      votesCount: number;
    }>;
    votesCount: number;
    votersCount: number;
  }
}
```

### 7.4 Media rendering

Full mode renders all media at full fidelity:

- **Images**: full-width or gallery layout (2-4 images in grid)
- **GIFs**: autoplay (respecting `prefers-reduced-motion`)
- **Video embeds**: oEmbed iframe (YouTube, Vimeo, etc.) — plays inline
- **Link preview cards**: title + description + thumbnail for URLs, similar to how source platforms render them

---

## 8. Pull-to-Refresh

### 8.1 Trigger

Overscroll gesture: when the user is at the top of the feed and scrolls up, a refresh indicator appears. Releasing triggers a feed refresh. Works on both desktop (wheel event accumulation while scrollTop is 0, 400ms decay timer resets between scroll bursts) and mobile (touch overscroll via `findScrollParent` DOM traversal). `PullToRefresh` does not create its own scroll container — it delegates to the Vessel's content div.

### 8.2 Refresh behaviour

Re-fetches the feed from the gateway with no cursor (latest items). New items prepend to the top of the feed.

### 8.3 Empty states

Three distinct states, each rendered as a temporary tile:

**No sources** (feed has zero `feed_sources`):

> "You're not following anyone yet. Add some sources to get started."

Clicking opens the subscription management UI (existing SubscribeInput / subscriptions flow).

**No items** (feed has sources but zero items):

> "No new items. Add more sources or check back later."

Clicking also opens subscription management.

**Caught up** (refresh returned no new content — all item keys match the pre-refresh set):

> "Nothing new. Follow more accounts or add sources to see more here."

Rendered _above_ existing items (not replacing them). `loadVesselItems` snapshots item keys before the fetch; if every returned item was already present, it sets `caughtUp: true` on the vessel state. Cleared on the next load.

All tiles are dismissible and do not persist across sessions.

---

## 9. Schema Changes Summary

### New columns on `external_items`

```sql
ALTER TABLE external_items ADD COLUMN like_count       INT DEFAULT 0;
ALTER TABLE external_items ADD COLUMN reply_count      INT DEFAULT 0;
ALTER TABLE external_items ADD COLUMN repost_count     INT DEFAULT 0;
ALTER TABLE external_items ADD COLUMN content_warning  TEXT;
ALTER TABLE external_items ADD COLUMN is_context_only  BOOLEAN DEFAULT FALSE;
```

### New column on `notes`

```sql
ALTER TABLE notes ADD COLUMN external_parent_id UUID REFERENCES external_items(id) ON DELETE SET NULL;
```

### New action types on `outbound_posts`

Extend the `action_type` check constraint:

```sql
ALTER TABLE outbound_posts DROP CONSTRAINT outbound_posts_action_type_check;
ALTER TABLE outbound_posts ADD CONSTRAINT outbound_posts_action_type_check
  CHECK (action_type IN ('reply', 'quote', 'repost', 'original', 'like', 'poll_vote'));
```

---

## 10. New Gateway Endpoints

| Method | Path                                    | Purpose                                         |
| ------ | --------------------------------------- | ----------------------------------------------- |
| GET    | `/api/v1/external-items/:id/engagement` | Live engagement counts from source platform     |
| GET    | `/api/v1/external-items/:id/thread`     | Fetch reply thread from source platform         |
| POST   | `/api/v1/external-items/:id/like`       | Like/favourite on source platform               |
| POST   | `/api/v1/external-items/:id/repost`     | Repost/boost on source platform                 |
| POST   | `/api/v1/external-items/:id/reply`      | Reply on source platform + create all.haus note |
| POST   | `/api/v1/external-items/:id/poll-vote`  | Vote on Mastodon poll                           |
| GET    | `/api/v1/extract`                       | Readability article extraction                  |

All interaction endpoints (`like`, `repost`, `reply`, `poll-vote`) require auth and a valid linked account for the item's protocol. They enqueue via the existing `outbound_cross_post` task infrastructure (extended with new action types).

---

## 11. New Frontend Components

| Component          | Location                                            | Purpose                                                            |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------ |
| `ReaderPane`       | `web/src/components/workspace/ReaderPane.tsx`       | Article overlay with Readability-extracted content                 |
| `InlineReplyBox`   | `web/src/components/workspace/InlineReplyBox.tsx`   | Text field for replying to external items within thread expansion  |
| `EngagementCounts` | `web/src/components/workspace/EngagementCounts.tsx` | Normalised heart/speech-bubble/repost display with live-fetch hook |
| `ContentWarning`   | `web/src/components/workspace/ContentWarning.tsx`   | Collapsible CW wrapper for Mastodon spoiler text                   |
| `PollDisplay`      | `web/src/components/workspace/PollDisplay.tsx`      | Poll rendering with optional interactive voting                    |
| `PullToRefresh`    | `web/src/components/workspace/PullToRefresh.tsx`    | Touch + wheel overscroll refresh handler                           |
| `EmptyFeedTile`    | `web/src/components/workspace/EmptyFeedTile.tsx`    | "No sources" / "No items" / "Caught up" temporary tiles            |

---

## 12. Feed-Ingest Changes

### 12.1 Engagement snapshot refresh

New periodic task: `external_engagement_refresh` (every 30–60 minutes). For items published within the last 7 days, batch-fetch current engagement counts from source platforms and update `like_count`, `reply_count`, `repost_count` on `external_items`.

### 12.2 Content warning capture

Update ActivityPub adapter to capture `spoiler_text` from Mastodon statuses into the new `content_warning` column.

### 12.3 Poll data capture

Update ActivityPub adapter to capture poll data (options, counts, expiry) into `interaction_data.poll` when the status has a `poll` attachment.

### 12.4 New outbound action handlers

Extend `outbound-cross-post.ts` dispatcher with handlers for:

- `like` → protocol-specific like/favourite/reaction
- `repost` → protocol-specific repost/reblog
- `poll_vote` → Mastodon `POST /api/v1/polls/:id/votes`

### 12.5 Paragraph break fix

Audit `rss.ts` adapter normalisation to ensure `<p>` tags and line breaks in `content:encoded` / `description` are preserved through to `content_html`.

---

## 13. Dependencies and Risks

| Risk                                                                  | Mitigation                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Mastodon rate limits (300/5min per instance) on live engagement fetch | Parallel fetch with per-instance rate tracking; degrade gracefully to snapshot counts if limited |
| Nostr relay latency for engagement counts and threads                 | Accept 1-2s async streaming; 5-min thread cache                                                  |
| Readability extraction fails on JS-heavy sites                        | Fall back to opening original URL in new tab                                                     |
| Outbound interaction failures (token expiry, API changes)             | Existing retry infrastructure in outbound_cross_post; surface errors in UI                       |
| Parent context fetch increases feed load time                         | Fetch parents eagerly at ingest time where possible; lazy-fetch on render as fallback            |
| `is_context_only` items accumulating without cleanup                  | GC cron: delete context-only items with no referencing feed items older than 30 days             |

---

## 14. Build Order

Suggested phasing (each phase is independently shippable):

**Phase 1 — Content fidelity + Compact/Full toggle**

- Fix RSS paragraph breaks
- Implement Compact/Full fidelity toggle on vessel cards
- Add engagement count columns, snapshot refresh task
- Render snapshot counts in both modes

**Phase 2 — Live engagement + parent context**

- Gateway engagement endpoint + live fetch by protocol
- Frontend async count streaming
- Parent context tile fetching and rendering
- `is_context_only` items, reply grouping, grandparent tag

**Phase 3 — Thread expansion**

- Gateway thread endpoint
- Playscript rendering for external threads
- Inline reply tags on thread entries

**Phase 4A — Interaction foundation + like/favourite**

_One context-window unit._

Schema:

- Migration: add `like` and `poll_vote` to `outbound_posts.action_type` constraint
- Migration: add `external_parent_id UUID REFERENCES external_items(id) ON DELETE SET NULL` to `notes`

Linked account gating (frontend):

- Workspace cards fetch user's linked accounts on mount (reuse existing `linkedAccountsApi.list()`)
- Determine per-item action availability by matching item's `sourceProtocol` against linked accounts
- Actions available for the protocol but missing a linked account render **greyed out**
- Clicking a greyed action shows a prompt: "Connect your [Platform] account to interact" with link to `/settings`
- Actions not available for the protocol are **hidden** (not greyed)

Like/favourite (full pipeline):

- Gateway: `POST /api/v1/external-items/:id/like` — requires auth, validates linked account for item's protocol, enqueues via `enqueueCrossPost` with `actionType: 'like'`
- Feed-ingest dispatcher: new `like` handler in `outbound-cross-post.ts`:
  - atproto: `com.atproto.repo.createRecord` with collection `app.bsky.feed.like`, record `{ subject: { uri, cid }, createdAt }`
  - activitypub: `POST /api/v1/statuses/:id/favourite` (source item's `source_id` is the status ID)
  - nostr_external: kind 7 reaction event (`+` content), `e` tag referencing source event, published to source relays
- Frontend: interactive heart button on `ExternalVesselCard` action row, optimistic count increment, error rollback

**Phase 4B — Repost/boost**

_One context-window unit._

- Gateway: `POST /api/v1/external-items/:id/repost` — same auth + linked account validation pattern
- Feed-ingest dispatcher: new `repost` handler:
  - atproto: `com.atproto.repo.createRecord` with collection `app.bsky.feed.repost`, record `{ subject: { uri, cid }, createdAt }`
  - activitypub: `POST /api/v1/statuses/:id/reblog`
  - nostr_external: hidden (no standard repost mechanism for external relays)
  - rss: hidden
- Frontend: repost-arrows button on action row (hidden for nostr_external and rss per §5.5 matrix), optimistic count increment
- Action availability follows the §5.5 matrix; button hidden vs greyed logic from 4A applies

**Phase 4C — Inline reply + dual-write**

_One context-window unit._

Inline reply box:

- New `InlineReplyBox` component (`web/src/components/workspace/InlineReplyBox.tsx`)
- Triggered by `REPLY` action on feed tiles and `REPLY` tag on playscript thread entries
- Shows target platform badge, text field, submit button
- Requires linked account for source protocol (greyed/prompt if missing)

Dual-write flow:

- On submit: gateway `POST /api/v1/external-items/:id/reply` creates an all.haus note (Nostr kind 1, signed via key-custody) with `external_parent_id` set to the target item, AND enqueues outbound cross-post with `actionType: 'reply'`
- The all.haus note appears in the user's note history and carries parent context wherever displayed
- Feed-ingest dispatcher `reply` handler already exists for all three protocols — no new dispatcher work needed, just the gateway endpoint + frontend

Parent context on native notes:

- When rendering an all.haus note that has `external_parent_id`, fetch and display the external parent tile above it (reuses `ParentContextTile` from Phase 2)

**Phase 5 — Reader pane + polish**

- Readability extraction endpoint
- ReaderPane overlay component
- Inline video players for video-type items
- Content warnings (Mastodon)
- Interactive polls (Mastodon)
- Pull-to-refresh (touch + wheel) + empty state tiles (no-sources / no-items / caught-up)
- Context-only item GC cron

---

## 15. Post-Ship Fixes (Phases 6A + 6B)

Post-ship audit (2026-05-25) identified bugs, data gaps, and one unimplemented spec feature. Organised into two slices — 6A is a single session of small targeted fixes; 6B is the larger reply-grouping feature.

### Phase 6A — Bug fixes + data gaps

_One context-window unit. All items are independent and can land in any order._

**6A-1. Context-only items leak into feeds (bug)**

Neither `timeline.ts` nor `feeds.ts` filters `is_context_only = TRUE` external items. Parent posts prefetched as reply context appear as standalone feed cards.

Fix: add `AND (fi.item_type != 'external' OR ei.is_context_only IS NOT TRUE)` to:

- `timeline.ts` `followingFeed` WHERE clause (~line 277)
- `feeds.ts` `sourceFilteredItems` WHERE clause (~line 1595)

Explore feed already excludes external items entirely, so no change needed there.

**6A-2. Platform timeline missing engagement counts (bug)**

`timeline.ts` `FEED_SELECT` omits `ei.like_count`, `ei.reply_count`, `ei.repost_count`. External items on the platform `/feed` endpoint have undefined engagement counts — compact mode always shows zero. Workspace feeds (`feeds.ts`) are unaffected (they already select these columns).

Fix: add `ei.like_count AS ei_like_count, ei.reply_count AS ei_reply_count, ei.repost_count AS ei_repost_count` to `timeline.ts` `FEED_SELECT`, and include `likeCount`, `replyCount`, `repostCount` in `feedItemToResponse`.

**6A-3. `extractGrandparentTag` stub (dead feature)**

`extractGrandparentTag()` in `external-items.ts:1400-1407` always returns `null`. The "→ REPLYING TO @username" tag works on first fetch (Bluesky/Mastodon helpers construct it inline) but never renders from the DB cache on subsequent requests.

Decision: persist grandparent metadata in the parent's `interaction_data` JSONB as `{ grandparent: { authorName, authorHandle } }`. No migration needed — `interaction_data` is an existing JSONB column already used for polls, embed refs, etc. This data is purely for display (the tag line on the parent card); it has no bearing on entity relationships, feed membership, or follow behaviour.

Fix:

- `fetchBlueskyParent` and `fetchMastodonParent` in `external-items.ts`: write `grandparent` into `interaction_data` on INSERT/upsert
- `external-parent-prefetch.ts` Bluesky and Mastodon branches: same
- `extractGrandparentTag`: read from `row.interaction_data?.grandparent`

**6A-4. Parent prefetch missing `source_reply_uri` (data gap)**

`external-parent-prefetch.ts` Mastodon branch (~line 166) omits `source_reply_uri` and `content_text` from the INSERT. Prefetched parents can't show their own reply relationship, and grandparent derivation from the DB row fails.

Fix: add `source_reply_uri` and `content_text` to the INSERT column list in both the Mastodon and Bluesky branches of the prefetch task.

**6A-5. `WorkspaceFeedApiExternal` TypeScript type incomplete (type gap)**

`web/src/lib/api/feeds.ts` `WorkspaceFeedApiExternal` interface is missing `contentWarning`, `poll`, and `interactionData` fields that the backend returns. Works at runtime but defeats type-checking.

Fix: add `contentWarning?: string | null`, `poll?: PollData | null` to the interface.

**6A-6. Minor: cache TTL alignment + error handling**

- `useLiveEngagement.ts` caches for 60s, backend caches for 30s — align both to 30s
- `useLiveEngagement.ts:55-57` catch block silently swallows errors — reset to snapshot counts on failure so the UI doesn't freeze on stale values

### Phase 6B — Reply grouping (shipped 2026-05-25)

Pure `groupReplies()` post-processing function in `gateway/src/routes/feeds.ts`, wired into `sourceFilteredItems()` after `rowToItem()` mapping. No SQL or cursor changes.

**Backend**: Groups external items sharing the same `source_reply_uri` (2+ siblings) into `reply_group` envelopes. Group positioned at the first occurrence (highest effective_score). Children sorted by `publishedAt ASC`. Singletons and non-reply items pass through unchanged. Cursor unaffected — derived from raw DB rows before grouping.

**Frontend**: New `WorkspaceFeedApiReplyGroup` type (`web/src/lib/api/feeds.ts`), `ReplyGroupItem` type (`web/src/lib/ndk.ts`, kept out of base `FeedItem` union — workspace-only via `WorkspaceItem`). `mapApiItem()` in `WorkspaceView.tsx` handles `reply_group` via extracted `mapExternalApiItem()` helper. New `ReplyGroupCard` component (`web/src/components/workspace/ReplyGroupCard.tsx`): renders `ParentContextTile` once (using first reply's ID, module cache deduplicates), then chronological `ExternalPlayscriptEntry` list (5 initial, "Show N more" pagination). Grey-300 left bar. Compact density shows summary line.
