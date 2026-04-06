# Feature Implementation Spec

This document describes 10 new features for platform.pub. Implement them in tier order (Tier 1 first, then Tier 2, then Tier 3). Within each tier, implement in the order listed. Each feature section includes the exact files to create or modify, the database changes needed, and the expected behaviour.

## Conventions to follow

Study the existing codebase patterns before writing any code:

- **Gateway routes**: Fastify, Zod validation, `pool` / `withTransaction` from `shared/src/db/client.js`, `requireAuth` / `optionalAuth` middleware from `../middleware/auth.js`. Register new routes in `gateway/src/index.ts` with `{ prefix: '/api/v1' }`.
- **API client**: All new endpoints get typed wrappers in `web/src/lib/api.ts` using the existing `request<T>()` helper.
- **Migrations**: Numbered SQL files in `migrations/`. Next available number is `012`. Use `gen_random_uuid()` for PKs, `TIMESTAMPTZ NOT NULL DEFAULT now()` for timestamps. Follow the existing naming and comment style.
- **Components**: React functional components with `'use client'` directive, Tailwind CSS using the project's custom design tokens (`text-content-primary`, `bg-surface`, `border-surface-strong`, `text-content-muted`, `text-ui-xs`, `font-serif`, etc.). Match existing component patterns.
- **Notifications**: Insert into the `notifications` table with a `.catch()` wrapper so failures don't break the parent operation. See `gateway/src/routes/follows.ts` line 57 and `gateway/src/routes/replies.ts` line 133 for the pattern.
- **NIP-23 tags**: Push `['tagname', 'value']` arrays onto `event.tags` in `web/src/lib/publish.ts` → `buildNip23Event()`.

---

## Tier 1 — Small, self-contained features

---

### Feature 1: Article Dek / Standfirst

An optional subtitle field in the article editor. When populated, it displays as a standfirst above the article body. When empty, it has no effect.

#### Why no migration is needed

The `articles` table already has a `summary TEXT` column (see `schema.sql` line 108). The `ArticleEvent` interface already has a `summary` field, and `parseArticleEvent` in `web/src/lib/ndk.ts` already reads `['summary', ...]` tags from NIP-23 events. The column is simply not populated by the publishing pipeline.

#### Changes

**`web/src/components/editor/ArticleEditor.tsx`**

1. Add state: `const [dek, setDek] = useState(initialDek ?? '')`.
2. Add `initialDek?: string` to `EditorProps`.
3. Add `dek: string` to the `PublishData` interface.
4. Add a text input between the title `<input>` and the toolbar `<div>`. Style it as:
   ```tsx
   <input
     type="text"
     value={dek}
     onChange={(e) => setDek(e.target.value)}
     placeholder="Add a subtitle or standfirst…"
     className="w-full border-none bg-transparent font-serif text-lg text-content-secondary italic placeholder:text-ink-300 focus:outline-none mb-3"
   />
   ```
5. Include `dek` in the `PublishData` object passed to `onPublish`.
6. Include `dek` in the auto-save payload passed to `saveDraft`.

**`web/src/lib/publish.ts`**

In `buildNip23Event`, after the `['title', data.title]` tag, add:
```ts
if (data.dek?.trim()) {
  event.tags.push(['summary', data.dek.trim()])
}
```

In `publishArticle`, pass `summary: data.dek?.trim() || undefined` in both `articlesApi.index()` calls.

**`web/src/lib/api.ts`**

Add `summary?: string` to the `articles.index()` data parameter type.

**`gateway/src/routes/articles.ts`**

1. Add `summary: z.string().optional()` to `IndexArticleSchema`.
2. In the INSERT query, add `summary` to the column list and parameter list.
3. In the ON CONFLICT DO UPDATE, add `summary = EXCLUDED.summary`.

**`web/src/components/article/ArticleReader.tsx`**

After the `<h1>` title in both the hero-image and standard-header branches, render:
```tsx
{article.summary && (
  <p className="font-serif text-xl text-content-secondary italic leading-relaxed mt-4 mb-2">
    {article.summary}
  </p>
)}
```

**`web/src/app/write/page.tsx`**

When loading edit data, extract the summary tag: `const summary = event.tagValue('summary') ?? ''` and pass it as `initialDek` to `ArticleEditor`.

**`web/src/lib/drafts.ts`**

Add `dek` to the draft save/load payload so auto-save preserves the standfirst.

**`gateway/src/routes/drafts.ts`**

If the drafts table doesn't have a summary/dek column, the draft content_raw already stores the full draft state — include dek in whatever JSON or fields the draft stores. Check the existing draft schema and follow its pattern.

---

### Feature 2: Clickable Notifications + Counter Reset

Make every notification row a clickable link to the relevant content. Ensure the unread counter resets to zero when the user views notifications.

#### Migration: `migrations/012_notification_note_id.sql`

```sql
-- Add note_id FK so notifications for notes/quotes can link to content
ALTER TABLE notifications ADD COLUMN note_id UUID REFERENCES notes(id) ON DELETE CASCADE;
CREATE INDEX idx_notifications_note ON notifications(note_id) WHERE note_id IS NOT NULL;
```

#### Changes

**`gateway/src/routes/notifications.ts`**

1. Add `n.note_id` to the SELECT and join `LEFT JOIN notes no ON no.id = n.note_id`.
2. Return `note_nostr_event_id` in the response so the frontend can construct a link (notes don't have a dedicated page yet, but they do appear in feeds by event ID).
3. Also return `article_writer_username` by joining through `articles → accounts` so the frontend can construct `/article/{slug}` links reliably. The current query already joins `articles ar` — also select `aw.username AS article_writer_username` via `LEFT JOIN accounts aw ON aw.id = ar.writer_id`.

**`web/src/lib/api.ts`**

Update the `Notification` interface to include the new fields:
```ts
article: { id: string; title: string | null; slug: string | null; writerUsername: string | null } | null
note: { id: string; nostrEventId: string | null } | null
```

**`web/src/components/ui/NotificationBell.tsx`**

1. Compute a destination URL for each notification:
   - `new_follower` → `/${actor.username}`
   - `new_reply` → `/article/${article.slug}` if article exists, otherwise `#`
   - `new_subscriber` → `/${actor.username}`
   - `new_quote` → `/article/${article.slug}` if article exists, otherwise `#`
   - `new_mention` → `/article/${article.slug}` if article exists, otherwise `#`
2. Wrap each `NotificationItem` in a `<Link href={destinationUrl}>` that also calls `setOpen(false)` on click.
3. The existing `handleOpen` already calls `readAll()` and sets `unreadCount` to 0 — this is correct. Make the `setUnreadCount(0)` call happen immediately when the panel opens (before the API response), not after. Move it before the `try` block.

**`web/src/app/notifications/page.tsx`**

1. Apply the same destination-URL logic to `NotificationRow`.
2. Wrap each row in a `<Link href={destinationUrl}>` so the entire row is clickable.
3. Change the `readAll` call from a 1-second `setTimeout` to immediate — call it right after the list loads.

**`gateway/src/routes/replies.ts`**

When inserting `new_reply` notifications (around line 133), also pass `note_id` when the reply target is a note rather than an article. Check `targetKind` — if it's `1` (note), look up the note's UUID and include it.

---

### Feature 3: Share to External Platforms

A share button on articles for copy-link, Twitter/X share, and email share. Pure frontend — no backend changes.

#### Changes

**`web/src/components/ui/ShareButton.tsx`** (new file)

Create a share button component that:
1. Accepts `url: string` and `title: string` props.
2. On mobile/supported browsers, uses the Web Share API (`navigator.share()`).
3. On desktop, shows a small dropdown with three options:
   - **Copy link** — copies `url` to clipboard, shows a brief "Copied!" confirmation.
   - **Share on X** — opens `https://x.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}` in a new tab.
   - **Share via email** — opens `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`.
4. Style the button as a small icon or text label (`text-ui-xs text-content-muted`) consistent with the existing action buttons (quote, vote, report).
5. Use a click-outside-to-close pattern matching `NotificationBell`.

**`web/src/components/article/ArticleReader.tsx`**

Add `<ShareButton url={articleUrl} title={article.title} />` next to the `<ReportButton>` in both the hero-image and standard-header branches. Construct the URL as:
```ts
const articleUrl = typeof window !== 'undefined'
  ? `${window.location.origin}/article/${article.dTag}`
  : `/article/${article.dTag}`
```

**`web/src/components/feed/ArticleCard.tsx`**

Optionally add a small share icon in the metadata row alongside the quote and vote buttons. Keep it minimal — `<ShareButton url={'/article/' + article.dTag} title={article.title} />`.

---

### Feature 4: Reading History

A user-facing page showing previously-read articles. The data already exists in `read_events`.

#### Changes

**`gateway/src/routes/articles.ts`** (or create a new `gateway/src/routes/history.ts`)

Add a new route:

```
GET /my/reading-history?limit=50&offset=0
```

Query:
```sql
SELECT DISTINCT ON (re.article_id)
  re.article_id,
  re.read_at,
  a.title,
  a.slug,
  a.nostr_d_tag,
  a.word_count,
  a.is_paywalled,
  w.username AS writer_username,
  w.display_name AS writer_display_name,
  w.avatar_blossom_url AS writer_avatar
FROM read_events re
JOIN articles a ON a.id = re.article_id AND a.deleted_at IS NULL
JOIN accounts w ON w.id = a.writer_id
WHERE re.reader_id = $1
ORDER BY re.article_id, re.read_at DESC
```

Then sort the results by `read_at DESC` in application code (or use a subquery) and apply limit/offset. Return an array of `{ articleId, readAt, title, slug, dTag, wordCount, isPaywalled, writer: { username, displayName, avatar } }`.

If creating a new route file, register it in `gateway/src/index.ts`.

**`web/src/lib/api.ts`**

Add a `readingHistory` namespace:
```ts
export const readingHistory = {
  list: (limit = 50, offset = 0) =>
    request<{ items: ReadingHistoryItem[] }>(`/my/reading-history?limit=${limit}&offset=${offset}`),
}
```

Define `ReadingHistoryItem` with the fields above.

**`web/src/app/history/page.tsx`** (new file)

A page at `/history` that:
1. Requires auth (redirect to login if not authenticated, same pattern as notifications page).
2. Fetches reading history on mount.
3. Renders a list of articles with title, writer name, and "read X ago" timestamp.
4. Each item links to `/article/{dTag}`.
5. Shows a skeleton loader while loading, and an empty state ("You haven't read any articles yet") when empty.
6. Follow the visual style of the notifications page — simple list with borders, serif typography.

**`web/src/components/layout/Nav.tsx`**

Add a "History" link in the sidebar navigation, between the existing items. Follow the pattern of the other nav links.

---

## Tier 2 — Medium complexity

---

### Feature 5: Bookmarks / Save for Later

A personal bookmarking system for saving articles and notes.

#### Migration: `migrations/013_bookmarks.sql`

```sql
CREATE TABLE bookmarks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_nostr_event_id TEXT NOT NULL,
  target_kind INT NOT NULL,  -- 30023 = article, 1 = note
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_bookmark UNIQUE (user_id, target_nostr_event_id)
);

CREATE INDEX idx_bookmarks_user ON bookmarks(user_id, created_at DESC);
CREATE INDEX idx_bookmarks_target ON bookmarks(target_nostr_event_id);
```

#### Gateway: `gateway/src/routes/bookmarks.ts` (new file)

Three routes:

1. **`POST /bookmarks`** (auth required) — Toggle bookmark. Body: `{ targetEventId: string, targetKind: number }`. If bookmark exists, delete it (unbookmark). If not, insert it. Return `{ bookmarked: boolean }`.

2. **`GET /bookmarks`** (auth required) — List bookmarks with pagination. Join `bookmarks` with `articles` (for kind 30023) and `notes` (for kind 1) to return enough metadata for display. Return `{ items: BookmarkItem[] }`. Include article title, slug, writer info, or note content preview.

3. **`GET /bookmarks/check?eventIds=id1,id2,...`** (auth required) — Batch check which event IDs the current user has bookmarked. Return `{ bookmarked: Record<string, boolean> }`. Follow the same pattern as `GET /votes/mine`.

Register in `gateway/src/index.ts`.

#### Web

**`web/src/lib/api.ts`** — Add `bookmarks` namespace with `toggle`, `list`, and `check` methods.

**`web/src/components/ui/BookmarkButton.tsx`** (new file) — A small toggle button (outline bookmark icon when not saved, filled when saved). Accepts `targetEventId`, `targetKind`, and `initialBookmarked` props. Calls `bookmarks.toggle()` on click and updates local state optimistically.

**`web/src/components/feed/ArticleCard.tsx`** — Add `<BookmarkButton>` in the metadata row, wrapped in a `stopPropagation` span (same pattern as `VoteControls`).

**`web/src/components/feed/NoteCard.tsx`** — Same treatment.

**`web/src/components/article/ArticleReader.tsx`** — Add `<BookmarkButton>` near the share/report buttons.

**`web/src/app/bookmarks/page.tsx`** (new file) — A `/bookmarks` page listing saved items. Requires auth. Fetches from `bookmarks.list()`. Renders each item as a card linking to the content. Empty state: "No saved articles yet."

**`web/src/components/layout/Nav.tsx`** — Add "Saved" link to the sidebar.

**Feed integration**: In `FeedView.tsx`, batch-fetch bookmark status alongside vote tallies (call `bookmarks.check()` with the event IDs on the page) and pass `initialBookmarked` down to each card.

---

### Feature 6: Hashtags / Topics / Tags

Tag-based browsing using NIP-23 `t` tags.

#### Migration: `migrations/014_article_tags.sql`

```sql
CREATE TABLE article_tags (
  article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (article_id, tag)
);

CREATE INDEX idx_article_tags_tag ON article_tags(tag);
```

#### Editor changes

**`web/src/components/editor/ArticleEditor.tsx`**

1. Add state: `const [tags, setTags] = useState<string[]>(initialTags ?? [])`.
2. Add `initialTags?: string[]` to `EditorProps`.
3. Add `tags: string[]` to `PublishData`.
4. Add a tag input below the editor content, above the price control. A comma-separated text input or a chip-style input where pressing Enter/comma creates a tag chip. Limit to 5 tags. Normalise to lowercase, strip non-alphanumeric except hyphens.
5. Render existing tags as removable chips.

**`web/src/lib/publish.ts`**

In `buildNip23Event`, push `['t', tag]` for each tag:
```ts
for (const tag of data.tags) {
  event.tags.push(['t', tag.toLowerCase().trim()])
}
```

Pass `tags` through in the `articlesApi.index()` calls.

**`web/src/lib/api.ts`**

Add `tags?: string[]` to the `articles.index()` data parameter.

#### Gateway changes

**`gateway/src/routes/articles.ts`**

1. Add `tags: z.array(z.string()).max(5).optional()` to `IndexArticleSchema`.
2. After inserting/upserting the article row, if tags are provided, delete existing tags for this article and bulk-insert the new ones:
   ```sql
   DELETE FROM article_tags WHERE article_id = $1;
   INSERT INTO article_tags (article_id, tag) VALUES ($1, unnest($2::text[]));
   ```
3. In `GET /articles/:dTag`, also fetch tags: `SELECT tag FROM article_tags WHERE article_id = $1` and include in the response.

**`gateway/src/routes/tags.ts`** (new file)

1. **`GET /tags`** — Return popular tags: `SELECT tag, COUNT(*) AS count FROM article_tags GROUP BY tag ORDER BY count DESC LIMIT 30`.
2. **`GET /tags/:tag/articles`** — Return articles with a given tag, paginated. Join `article_tags` with `articles` and `accounts`. Return the same shape as the feed.

Register in `gateway/src/index.ts`.

#### Web — tag display and browse

**`web/src/lib/ndk.ts`** — In `parseArticleEvent`, extract `t` tags: `const tags = event.tags.filter(t => t[0] === 't').map(t => t[1])`. Add `tags: string[]` to `ArticleEvent`.

**`web/src/components/feed/ArticleCard.tsx`** — Optionally display tags as small labels below the excerpt. Each tag links to `/tag/{tag}`.

**`web/src/components/article/ArticleReader.tsx`** — Display tags at the bottom of the article, above the reply section, as clickable links.

**`web/src/app/tag/[tag]/page.tsx`** (new file) — A tag browse page. Fetches `GET /tags/${tag}/articles` and renders results as article cards.

**`web/src/app/write/page.tsx`** — When loading edit data, extract tags from the event's `t` tags and pass as `initialTags`.

---

### Feature 7: Writer Analytics

Per-article read counts, vote counts, and reply counts for writers.

#### Changes

**`gateway/src/routes/articles.ts`** (or new `gateway/src/routes/analytics.ts`)

Add a route:

```
GET /my/analytics
```

Auth required. The writer ID comes from `req.session.sub`. Query:

```sql
SELECT
  a.id,
  a.title,
  a.slug,
  a.nostr_event_id,
  a.published_at,
  a.word_count,
  COALESCE(re.read_count, 0) AS read_count,
  COALESCE(vt.upvote_count, 0) AS upvote_count,
  COALESCE(vt.downvote_count, 0) AS downvote_count,
  COALESCE(vt.net_score, 0) AS net_score,
  COALESCE(cm.comment_count, 0) AS comment_count,
  COALESCE(rev.revenue_pence, 0) AS revenue_pence
FROM articles a
LEFT JOIN (
  SELECT article_id, COUNT(*) AS read_count
  FROM read_events GROUP BY article_id
) re ON re.article_id = a.id
LEFT JOIN vote_tallies vt ON vt.target_nostr_event_id = a.nostr_event_id
LEFT JOIN (
  SELECT target_event_id, COUNT(*) AS comment_count
  FROM comments WHERE deleted_at IS NULL GROUP BY target_event_id
) cm ON cm.target_event_id = a.nostr_event_id
LEFT JOIN (
  SELECT article_id, SUM(amount_pence) AS revenue_pence
  FROM read_events WHERE state != 'provisional' GROUP BY article_id
) rev ON rev.article_id = a.id
WHERE a.writer_id = $1 AND a.deleted_at IS NULL
ORDER BY a.published_at DESC
```

Return an array of `{ articleId, title, slug, publishedAt, wordCount, readCount, upvoteCount, downvoteCount, netScore, commentCount, revenuePence }`.

**`web/src/lib/api.ts`** — Add `analytics.list()` method.

**`web/src/app/dashboard/page.tsx`** (or a new tab) — The dashboard already has tabs for articles, drafts, and earnings. Add an "Analytics" tab that renders a table/list of articles with their stats. Keep it simple — a sortable table with columns for title, reads, votes, replies, and revenue. Use the same design language as the existing dashboard tabs.

---

## Tier 3 — Larger scope

---

### Feature 8: Reposts / Reshares

A plain repost mechanism (Nostr kind 6) that surfaces someone else's content in your followers' feeds.

#### Migration: `migrations/015_reposts.sql`

```sql
CREATE TABLE reposts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reposter_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_nostr_event_id TEXT NOT NULL,
  target_kind           INT NOT NULL,  -- 30023 = article, 1 = note
  target_author_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  nostr_event_id        TEXT UNIQUE,   -- kind 6 event ID
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_repost UNIQUE (reposter_id, target_nostr_event_id)
);

CREATE INDEX idx_reposts_reposter ON reposts(reposter_id, created_at DESC);
CREATE INDEX idx_reposts_target ON reposts(target_nostr_event_id);
```

#### Gateway: `gateway/src/routes/reposts.ts` (new file)

1. **`POST /reposts`** (auth required) — Body: `{ targetEventId, targetKind }`. Resolve the target author. Insert into `reposts`. Sign and publish a Nostr kind 6 event via the signing service (the event content is the JSON of the original event, tags include `['e', targetEventId]` and `['p', targetAuthorPubkey]`). Insert a `new_repost` notification for the target author. Return `{ repostId, nostrEventId }`.

2. **`DELETE /reposts/:targetEventId`** (auth required) — Delete the repost row. Optionally publish a kind 5 deletion event for the kind 6 repost. Return `{ ok: true }`.

3. **`GET /reposts/check?eventIds=id1,id2,...`** (auth required) — Batch check. Return `{ reposted: Record<string, boolean> }`.

Register in `gateway/src/index.ts`.

#### Notification

Add `'new_repost'` as a notification type. Update the migration 012 or create a separate one if needed (the `type` column is TEXT, not ENUM, so no schema change is required for the column itself — just insert with the new type string).

Update the notification UI components (`NotificationBell.tsx` and `notifications/page.tsx`) to handle `new_repost`: "{actor} reposted your {article/note}".

#### Feed integration

**`web/src/components/feed/FeedView.tsx`** — When assembling the feed, also query reposts by users the current reader follows. Reposts appear as the original content with a "Reposted by {username}" label above it. This requires a new gateway endpoint or extending the existing feed endpoint to include reposts.

**Gateway feed endpoint** — If there's a feed-assembly route (check `gateway/src/routes/` for a feed route), extend it to UNION reposts into the feed query. If feed assembly happens client-side via NDK relay queries, then the repost kind 6 events need to be fetched from the relay and resolved client-side.

**`web/src/components/ui/RepostButton.tsx`** (new file) — A toggle button similar to BookmarkButton. Shows repost count. Placed alongside quote and vote buttons on article and note cards.

---

### Feature 9: Email-on-Publish

Email notifications to followers when a writer publishes a new article.

#### Migration: `migrations/016_email_preferences.sql`

```sql
ALTER TABLE accounts
  ADD COLUMN email_on_new_article BOOLEAN NOT NULL DEFAULT true;
```

#### Sending logic

**`gateway/src/routes/articles.ts`**

After a successful INSERT (not an ON CONFLICT UPDATE — check `result.command` or use a `RETURNING` clause that distinguishes insert from update, e.g. `xmax = 0` means insert), queue email notifications:

1. Query followers who have `email_on_new_article = true` and a non-null `email`:
   ```sql
   SELECT a.email, a.display_name, a.username
   FROM follows f
   JOIN accounts a ON a.id = f.follower_id
   WHERE f.followee_id = $1
     AND a.email IS NOT NULL
     AND a.email_on_new_article = true
     AND a.status = 'active'
   ```
2. For each follower, send an email using the existing email service in `shared/src/email/`. The email should contain:
   - Subject: `New from {writerDisplayName}: {articleTitle}`
   - Body: Article title, dek/summary if present, first ~200 chars of free content, and a link to `/article/{dTag}`.
3. **Rate limiting**: Do not send more than ~100 emails per publish event. If a writer has more followers than that, paginate and process in batches. Consider making this a background job in `payment-service` workers rather than blocking the publish response.
4. **Deduplication**: Only send for genuinely new articles. When the ON CONFLICT clause fires (meaning this is a re-publish/edit of an existing d-tag), skip email sending. The cleanest way: check if the INSERT actually inserted by examining `xmax` in the returned row, or by doing a separate SELECT first to see if the d-tag already exists for this writer.

**`shared/src/email/`** — Add an email template function for article notifications. Follow the pattern of the existing magic-link email template.

#### Settings

**`web/src/app/settings/page.tsx`** — Add a toggle: "Email me when writers I follow publish new articles." This calls a new endpoint `PATCH /my/settings` (or extend the existing profile/settings endpoint) to update `email_on_new_article`.

**`gateway/src/routes/auth.ts`** (or wherever the settings endpoint lives) — Add handling for the `email_on_new_article` field in the settings update route.

---

### Feature 10: Direct Messages

Private messaging between users using NIP-44 encryption.

> **Note**: This is the largest feature and may warrant its own implementation phase. The spec below is a complete blueprint but expect it to take significantly longer than the other features.

#### Migration: `migrations/017_direct_messages.sql`

```sql
CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_a   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  participant_b   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_conversation UNIQUE (participant_a, participant_b),
  CONSTRAINT ordered_participants CHECK (participant_a < participant_b)
);

CREATE INDEX idx_conversations_a ON conversations(participant_a, last_message_at DESC);
CREATE INDEX idx_conversations_b ON conversations(participant_b, last_message_at DESC);

CREATE TABLE direct_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  content_enc     TEXT NOT NULL,  -- NIP-44 encrypted content
  nostr_event_id  TEXT UNIQUE,    -- kind 4 or kind 1059 event ID
  read            BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dm_conversation ON direct_messages(conversation_id, created_at ASC);
CREATE INDEX idx_dm_sender ON direct_messages(sender_id);
```

#### Gateway: `gateway/src/routes/messages.ts` (new file)

1. **`GET /messages/conversations`** (auth required) — List conversations for the current user, most recent first. Join with `accounts` to get the other participant's name/avatar. Include last message preview (truncated, decrypted server-side via key service) and unread count.

2. **`GET /messages/conversations/:conversationId`** (auth required) — List messages in a conversation, paginated. Verify the current user is a participant. Return encrypted content — decryption happens client-side.

3. **`POST /messages`** (auth required) — Send a message. Body: `{ recipientId: string, content: string }`. The gateway:
   - Finds or creates the conversation (normalise participant order so `participant_a < participant_b`).
   - Calls the key service to NIP-44 encrypt the content for both participants.
   - Inserts into `direct_messages`.
   - Updates `conversations.last_message_at`.
   - Inserts a `new_message` notification.
   - Optionally publishes a Nostr kind 4 / kind 1059 event.
   - Returns `{ messageId, conversationId }`.

4. **`POST /messages/:conversationId/read`** (auth required) — Mark all messages in a conversation as read.

Register in `gateway/src/index.ts`.

#### Key service

The key service already handles NIP-44. Add an endpoint (or extend an existing one) for DM encryption/decryption using the custodial keypairs.

#### Web

**`web/src/app/messages/page.tsx`** (new file) — A `/messages` page with:
- Left panel: conversation list with avatars, names, last message preview, unread badges.
- Right panel: message thread for the selected conversation.
- A compose input at the bottom of the thread.
- On mobile: conversation list and thread as separate views with back navigation.

**`web/src/components/layout/Nav.tsx`** — Add "Messages" link with an unread badge (similar to notification bell pattern). Fetch unread DM count on mount.

**`web/src/lib/api.ts`** — Add `messages` namespace with `listConversations`, `getConversation`, `send`, and `markRead` methods.

---

## Implementation notes

### Migration ordering

Run migrations in numeric order. If implementing features in parallel, reserve the migration numbers listed above. The current latest is `011_store_ciphertext.sql`, so:

| Migration | Feature |
|-----------|---------|
| 012 | Notification note_id (Feature 2) |
| 013 | Bookmarks (Feature 5) |
| 014 | Article tags (Feature 6) |
| 015 | Reposts (Feature 8) |
| 016 | Email preferences (Feature 9) |
| 017 | Direct messages (Feature 10) |

Features 1, 3, 4, and 7 require no migrations.

### Testing approach

After implementing each feature:
1. Run `cd gateway && npx tsc --noEmit` to check for type errors.
2. Run `cd web && npm run build` to verify the frontend compiles.
3. Run the migration against a fresh database to verify SQL syntax.
4. If the service has tests (`cd <service> && npm test`), ensure they still pass.

### Files that will need the most changes

- `web/src/lib/api.ts` — Every feature adds types and methods here.
- `gateway/src/index.ts` — Every new route file must be registered here.
- `web/src/components/layout/Nav.tsx` — Features 4, 5, and 10 add nav links.
- `web/src/components/feed/FeedView.tsx` — Features 5 and 8 integrate into the feed.
- `web/src/components/editor/ArticleEditor.tsx` — Features 1 and 6 add editor fields.
- `web/src/lib/publish.ts` — Features 1 and 6 add NIP-23 tags.
