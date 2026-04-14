# UNIVERSAL-FEED-ADR: The Social Reader

**all.haus Architectural Decision Record**
**Status:** Draft — April 2026
**Author:** Ed Lake / Claude (design partner)
**Depends on:** platform-pub-adr-v07, TRAFFOLOGY-MASTER-ADR-2

---

## I. Problem statement

all.haus currently operates as a closed social–publishing platform. Users follow writers on all.haus, read articles and notes in a unified feed, and interact via comments and quote-comments — but only within the platform's own Nostr relay. The `content_tier` enum already anticipates four tiers of content (native, federated Nostr, bridged fediverse, external RSS), but tiers 2–4 are unpopulated placeholders.

The ambition is to turn all.haus into a **universal social reader**: a single interface through which users consume and interact with content from Bluesky, Mastodon, RSS/Atom feeds, and the wider Nostr network — while ensuring that every interaction originates as a Nostr event on all.haus and optionally cross-posts to the source platform.

The strategic logic is simple: **the platform that owns the reading experience owns the social layer**. If all.haus can pull content in from everywhere and push replies back out, it becomes the gravitational centre of the user's social life — a super-aggregator in the tradition of Google Reader, but with the social features Google never built and the attribution model Google never cared about.

---

## II. Design principles

1. **Nostr-first.** Every interaction a user makes on all.haus is always a Nostr event on the platform relay, regardless of where the source content originated. The Nostr event is the canonical version. Cross-posting to external platforms is secondary and optional.

2. **Origin metadata preserved.** External content is normalised into a canonical schema but never stripped of its provenance. The UI always shows where content came from. Users are never deceived about authorship or origin.

3. **User-controlled outbound.** Cross-posting replies to external platforms requires the user to explicitly link their account and choose (per-post or via default) whether to cross-post. all.haus never posts to an external platform without clear user intent.

4. **Additive, not invasive.** The feature introduces new tables and a new service. It does not modify the existing `notes`, `articles`, or `accounts` tables in any breaking way. The existing feed continues to work unchanged; external items are mixed in alongside native content.

5. **Graphile Worker on Postgres.** Consistent with the Traffology architecture (`traffology-worker`), all background processing uses Graphile Worker running on the shared Postgres database. No Redis, no separate message broker. The one exception is persistent WebSocket connections (Jetstream), which run as a standalone long-lived process within the same service container.

6. **Protocol adapters are plugins.** Each external protocol (AT Protocol, ActivityPub, RSS, external Nostr) is implemented as an independent adapter module. Adding a new protocol means writing one ingestion adapter and one outbound adapter. The core feed assembly and reply routing are protocol-agnostic.

7. **Single-write timeline (Phase 2).** External content is ultimately normalised into a shared `feed_items` timeline table at ingestion time, not assembled via UNION ALL at query time. Phase 1 uses a three-stream merge (articles + notes + external items in application code) to validate the external content pipeline without introducing the denormalised table or dual-write paths. The `feed_items` migration lands in Phase 2, once the ingestion pipeline is proven and the data model is stable. This avoids shipping the riskiest architectural change (denormalised table + transactional dual-writes + reconciliation job) alongside the riskiest product change (external content in the feed).

8. **Canonical items, shared across subscribers.** If 50 users subscribe to the same Bluesky account, the platform stores one copy of each post. Subscriptions and items are decoupled via a many-to-many relationship through shared sources.

9. **Omnivorous input.** Wherever all.haus asks a user to identify a person, feed, or resource, the input field should accept whatever the user has — a URL, a handle, an email, an npub, a DID, a username — and resolve it. This is a **sitewide design principle**, not specific to the universal feed. The universal resolver (§V.5) is the shared infrastructure; the feed subscribe flow is its first major consumer, but every identity input across the platform should converge on this pattern. Users should come to trust that they can throw anything at a text field and get a good result. Not LLM-smart — deterministic, fast, and robust.

---

## III. Taxonomy: content tiers made real

The existing `content_tier` enum maps cleanly onto the universal feed:

| Tier | Enum value | Source | Ingestion method | Outbound reply |
|------|-----------|--------|------------------|----------------|
| 1 | `tier1` | Native all.haus | Direct write to relay + DB | N/A (already native) |
| 2 | `tier2` | External Nostr relays | WebSocket subscription via strfry/NDK | Publish to source relay |
| 3 | `tier3` | Bluesky (AT Protocol) / Mastodon (ActivityPub) | Jetstream / outbox polling | AT Protocol `createRecord` / ActivityPub `POST` |
| 4 | `tier4` | RSS / Atom feeds | HTTP polling | N/A (RSS is read-only) |

The tier determines both how content enters the system and whether replies can be routed back to the source.

---

## IV. New database schema

### IV.1 New enum: `external_protocol`

```sql
CREATE TYPE external_protocol AS ENUM (
  'atproto',       -- Bluesky / AT Protocol
  'activitypub',   -- Mastodon / Fediverse
  'rss',           -- RSS and Atom feeds
  'nostr_external' -- Nostr relays outside the platform relay
);
```

### IV.2 `external_sources` — canonical external accounts/feeds

Each row represents one unique external source: a Bluesky account, a Mastodon actor, an RSS URL, or an external Nostr pubkey. Shared across all subscribers — if 50 users follow the same Bluesky account, there is one `external_sources` row and one set of `external_items`.

```sql
CREATE TABLE external_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol        external_protocol NOT NULL,

  -- Canonical source identifier (protocol-specific)
  --   atproto:        DID (e.g. did:plc:abc123...)
  --   activitypub:    Actor URI (e.g. https://mastodon.social/users/alice)
  --   rss:            Feed URL (e.g. https://example.com/feed.xml)
  --   nostr_external: Hex pubkey
  source_uri      TEXT NOT NULL,

  -- Display metadata (cached from source, refreshed periodically)
  display_name    TEXT,
  avatar_url      TEXT,
  description     TEXT,

  -- Relay hints (nostr_external only)
  relay_urls      TEXT[],

  -- Polling / sync state (owned by the ingestion worker)
  last_fetched_at TIMESTAMPTZ,
  cursor          TEXT,              -- protocol-specific cursor
                                     --   atproto: Jetstream time_us
                                     --   activitypub: last seen activity ID
                                     --   rss: ETag or Last-Modified
                                     --   nostr_external: newest event created_at
  fetch_interval_seconds INT NOT NULL DEFAULT 300,
  error_count     INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT unique_source UNIQUE (protocol, source_uri)
);

CREATE INDEX idx_ext_sources_protocol   ON external_sources(protocol) WHERE is_active = TRUE;
CREATE INDEX idx_ext_sources_next_fetch ON external_sources(last_fetched_at)
  WHERE is_active = TRUE;
```

### IV.3 `external_subscriptions` — user-to-source subscriptions

A lightweight join table. A user subscribes to a source; the source's items appear in their feed.

```sql
CREATE TABLE external_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,

  -- Per-subscription preferences
  is_muted      BOOLEAN NOT NULL DEFAULT FALSE,  -- hide from feed without unsubscribing
  daily_cap     INT,                              -- max items/day from this source (NULL = unlimited)

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT unique_subscription UNIQUE (subscriber_id, source_id)
);

CREATE INDEX idx_ext_subs_subscriber ON external_subscriptions(subscriber_id);
CREATE INDEX idx_ext_subs_source     ON external_subscriptions(source_id);
```

### IV.4 `external_items` — normalised foreign content

Every ingested post, toot, skeet, or RSS entry becomes one row. Shared across subscribers — items belong to a source, not to an individual user's subscription.

```sql
CREATE TABLE external_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         UUID NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  protocol          external_protocol NOT NULL,
  tier              content_tier NOT NULL,

  -- Enforce protocol→tier mapping (tier is deterministic from protocol)
  CONSTRAINT protocol_tier_consistency CHECK (
    (protocol = 'nostr_external' AND tier = 'tier2') OR
    (protocol IN ('atproto', 'activitypub') AND tier = 'tier3') OR
    (protocol = 'rss' AND tier = 'tier4')
  ),

  -- Origin identity
  source_item_uri   TEXT NOT NULL,

  -- Author (may differ from source owner, e.g. repost/boost)
  author_name       TEXT,
  author_handle     TEXT,
  author_avatar_url TEXT,
  author_uri        TEXT,

  -- Normalised content
  content_text      TEXT,
  content_html      TEXT,
  summary           TEXT,
  title             TEXT,
  language          TEXT,             -- BCP-47 tag if available

  -- Media (see media schema below)
  media             JSONB DEFAULT '[]',

  -- Embeds and references
  source_reply_uri  TEXT,
  source_quote_uri  TEXT,
  is_repost         BOOLEAN NOT NULL DEFAULT FALSE,
  original_item_uri TEXT,

  -- Interaction metadata (for outbound reply routing)
  interaction_data  JSONB DEFAULT '{}',
  --   atproto: { uri, cid, rootUri, rootCid }
  --   activitypub: { id, inReplyTo, attributedTo, statusId, instanceUrl }
  --   nostr_external: { id, pubkey, relays[] }

  -- Timestamps
  published_at      TIMESTAMPTZ NOT NULL,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Deletion tracking
  deleted_at        TIMESTAMPTZ,      -- set when source deletion detected

  -- Deduplication
  CONSTRAINT unique_source_item UNIQUE (protocol, source_item_uri)
);

CREATE INDEX idx_ext_items_source_id    ON external_items(source_id);
CREATE INDEX idx_ext_items_published_at ON external_items(published_at DESC);
CREATE INDEX idx_ext_items_author_uri   ON external_items(author_uri);
CREATE INDEX idx_ext_items_source_reply ON external_items(source_reply_uri)
  WHERE source_reply_uri IS NOT NULL;
```

**Media JSONB schema:**

The `media` column on both `external_items` and `feed_items` is a JSONB array. Each element conforms to this shape (enforced at the adapter layer, not by a database constraint):

```typescript
interface MediaAttachment {
  type: 'image' | 'video' | 'audio' | 'link';
  url: string;              // source URL
  thumbnail?: string;       // preview/thumbnail URL (video, link cards)
  alt?: string;             // alt text (images)
  width?: number;           // intrinsic width in px
  height?: number;          // intrinsic height in px
  mime_type?: string;       // e.g. 'image/jpeg', 'video/mp4'
  title?: string;           // link card title
  description?: string;     // link card description
}
```

Protocol-specific mapping: Bluesky `embed.images` → `type: 'image'`; Bluesky `embed.external` → `type: 'link'`; ActivityPub `attachment` → type inferred from `mediaType`; RSS `<enclosure>` → type inferred from MIME type; RSS `<media:content>` → same.

### IV.5 `feed_items` — unified timeline table (Phase 2)

The core architectural optimisation: a single denormalised timeline table that all content types write to at creation/ingestion time. The feed query reads only this table. **This table is introduced in Phase 2**, after the external content pipeline (ingestion, resolver, ExternalCard, subscription management) is validated in Phase 1 using a three-stream merge in application code. Phase 1 queries articles, notes, and external_items separately and merges the results; Phase 2 collapses them into a single-table scan.

```sql
CREATE TABLE feed_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type       TEXT NOT NULL CHECK (item_type IN ('article', 'note', 'external')),

  -- Foreign key to the source table (exactly one is non-null)
  article_id      UUID REFERENCES articles(id) ON DELETE CASCADE,
  note_id         UUID REFERENCES notes(id) ON DELETE CASCADE,
  external_item_id UUID REFERENCES external_items(id) ON DELETE CASCADE,

  -- Author identity (denormalised for single-query feed rendering)
  author_id       UUID REFERENCES accounts(id) ON DELETE SET NULL,  -- NULL for external
  author_name     TEXT NOT NULL,
  author_avatar   TEXT,
  author_username TEXT,               -- NULL for external items

  -- Content preview (denormalised)
  title           TEXT,
  content_preview TEXT,               -- first ~200 chars, plain text
  content_html    TEXT,               -- for external items with rich HTML

  -- Metadata
  nostr_event_id  TEXT,
  tier            content_tier NOT NULL DEFAULT 'tier1',
  published_at    TIMESTAMPTZ NOT NULL,

  -- External-only fields
  source_protocol TEXT,               -- 'atproto', 'activitypub', 'rss', 'nostr_external'
  source_item_uri TEXT,               -- link to original on source platform
  source_id       UUID REFERENCES external_sources(id) ON DELETE CASCADE,
  media           JSONB,

  -- Scoring (written by the feed scoring worker)
  score           FLOAT NOT NULL DEFAULT 0,

  -- Soft delete
  deleted_at      TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT exactly_one_source CHECK (
    (article_id IS NOT NULL)::int +
    (note_id IS NOT NULL)::int +
    (external_item_id IS NOT NULL)::int = 1
  ),

  -- Native content is always tier1; external tiers are determined by protocol
  CONSTRAINT tier_consistency CHECK (
    (item_type IN ('article', 'note') AND tier = 'tier1') OR
    (item_type = 'external')
  )
);

-- The primary feed query index: compound cursor for stable pagination
-- (see §VII.1 — cursor is (published_at, id), not published_at alone)
CREATE INDEX idx_feed_items_cursor      ON feed_items(published_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_feed_items_author      ON feed_items(author_id, published_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_feed_items_source      ON feed_items(source_id, published_at DESC)
  WHERE source_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_feed_items_score       ON feed_items(score DESC, published_at DESC)
  WHERE deleted_at IS NULL;

-- Unique partial indexes: enforce one feed_items row per source row.
-- These also make the backfill migration idempotent (ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX idx_feed_items_article  ON feed_items(article_id)
  WHERE article_id IS NOT NULL;
CREATE UNIQUE INDEX idx_feed_items_note     ON feed_items(note_id)
  WHERE note_id IS NOT NULL;
CREATE UNIQUE INDEX idx_feed_items_external ON feed_items(external_item_id)
  WHERE external_item_id IS NOT NULL;
```

**Write paths (Phase 2) — all writes are transactional:**
- **Articles:** Gateway inserts into `articles` and the corresponding `feed_items` row in the **same Postgres transaction**. If either INSERT fails, both roll back. An article without a `feed_items` row is invisible in the feed — this is a correctness requirement, not an optimisation.
- **Notes:** Same pattern — `notes` INSERT + `feed_items` INSERT in a single transaction.
- **External items:** `feed-ingest` worker inserts into `external_items` and `feed_items` in a single transaction.
- **Edits:** When a native article's title, content preview, or metadata changes, the corresponding `feed_items` row must be updated in the same transaction. The article edit handler already touches the `articles` row; it must also update `feed_items.title`, `content_preview`, and `published_at` (if the publish date changes). Note edits follow the same pattern.
- **Deletions:** Set `feed_items.deleted_at` (and `external_items.deleted_at` for external). The feed query filters on `deleted_at IS NULL`.

In Phase 1, none of these write paths exist — the gateway writes articles and notes as it does today, and external items are written only to `external_items`. The three-stream merge query reads from the source tables directly. The dual-write paths are introduced in Phase 2 alongside the `feed_items` table.

This is a deliberate denormalisation trade-off. The write path does slightly more work (one extra INSERT or UPDATE per item), but the read path — which runs on every feed load for every user — becomes a single-table scan with a single composite index.

**Denormalised data update paths:**

The `author_name`, `author_avatar`, and `author_username` columns are snapshots taken at write time. When a native user changes their display name or avatar, or when `source_metadata_refresh` updates an external source's metadata, the corresponding `feed_items` rows must be updated. The `feed_items_author_refresh` worker job (see §V.2) handles this propagation. Staleness window: up to 24 hours for native authors, up to 24 hours for external sources (matching the `source_metadata_refresh` cron). This is acceptable — author metadata changes are infrequent, and the feed is not the system of record for identity.

Content edits (article title, preview text) are propagated synchronously in the edit transaction, not by a background job — content staleness is not acceptable for the author's own posts.

**Column population by `item_type`:**

The `feed_items` table is polymorphic — different columns are populated depending on `item_type`. Implementors should not assume all fields are present for all item types.

| Column | `article` | `note` | `external` |
|--------|-----------|--------|------------|
| `article_id` | set | NULL | NULL |
| `note_id` | NULL | set | NULL |
| `external_item_id` | NULL | NULL | set |
| `author_id` | set | set | NULL |
| `author_username` | set | set | NULL |
| `title` | set (article title) | NULL | set if RSS, NULL otherwise |
| `content_preview` | set (plain text) | set (plain text) | set (plain text) |
| `content_html` | NULL | NULL | set for RSS + ActivityPub |
| `nostr_event_id` | set | set | NULL |
| `source_protocol` | NULL | NULL | set |
| `source_item_uri` | NULL | NULL | set |
| `source_id` | NULL | NULL | set |
| `media` | NULL | NULL | set (JSONB array) |

### IV.6 `linked_accounts` — user credentials for outbound posting

Stores OAuth tokens and credentials for the user's accounts on external platforms. Multiple accounts per protocol are allowed (e.g. accounts on different Mastodon instances).

```sql
CREATE TABLE linked_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  protocol          external_protocol NOT NULL,

  -- Identity on the external platform
  external_id       TEXT NOT NULL,
  external_handle   TEXT,
  instance_url      TEXT,             -- Mastodon instance URL; NULL for non-instance protocols

  -- Credentials (encrypted at rest with LINKED_ACCOUNT_KEY_HEX)
  credentials_enc   TEXT,

  -- Token lifecycle
  token_expires_at  TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  is_valid          BOOLEAN NOT NULL DEFAULT TRUE,

  -- User preferences
  cross_post_default BOOLEAN NOT NULL DEFAULT TRUE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One account per external identity (but multiple identities per protocol allowed)
  CONSTRAINT unique_linked_identity UNIQUE (account_id, protocol, external_id)
);

CREATE INDEX idx_linked_accounts_account ON linked_accounts(account_id);
CREATE INDEX idx_linked_accounts_refresh ON linked_accounts(token_expires_at)
  WHERE is_valid = TRUE AND credentials_enc IS NOT NULL;
```

### IV.7 `outbound_posts` — audit log for cross-posted content

Every time a reply, quote, or repost is cross-posted to an external platform, a row is created here for audit, retry, and deduplication.

```sql
CREATE TABLE outbound_posts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  linked_account_id UUID NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
  protocol          external_protocol NOT NULL,

  -- The native all.haus event
  nostr_event_id    TEXT NOT NULL,
  action_type       TEXT NOT NULL CHECK (action_type IN ('reply', 'quote', 'repost', 'original')),

  -- The external item being responded to (if reply/quote/repost)
  source_item_id    UUID REFERENCES external_items(id) ON DELETE SET NULL,

  -- Result
  external_post_uri TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed', 'retrying')),
  error_message     TEXT,
  retry_count       INT NOT NULL DEFAULT 0,
  max_retries       INT NOT NULL DEFAULT 3,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ
);

CREATE INDEX idx_outbound_posts_account ON outbound_posts(account_id);
CREATE INDEX idx_outbound_posts_pending ON outbound_posts(status)
  WHERE status IN ('pending', 'retrying');
```

### IV.8 `oauth_app_registrations` — per-instance app credentials

Mastodon uses dynamic client registration: the gateway registers as an OAuth app on each instance the first time a user connects. The resulting `client_id` and `client_secret` are app-level, not user-level, and must be stored separately from user tokens in `linked_accounts`.

```sql
CREATE TABLE oauth_app_registrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol        external_protocol NOT NULL,
  instance_url    TEXT NOT NULL,         -- e.g. https://mastodon.social

  client_id       TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,       -- encrypted with LINKED_ACCOUNT_KEY_HEX

  scopes          TEXT,                  -- e.g. 'read:statuses write:statuses'
  redirect_uri    TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT unique_app_registration UNIQUE (protocol, instance_url)
);
```

When a user connects a Mastodon account, the gateway checks for an existing `oauth_app_registrations` row for that instance. If found, it reuses the app credentials. If not, it registers a new app via `POST /api/v1/apps`, stores the result, then proceeds with the user-level OAuth flow. This avoids re-registering the app for every user on the same instance.

### IV.9 `platform_config` additions

```sql
INSERT INTO platform_config (key, value, description) VALUES
  ('feed_ingest_rss_interval_seconds',    '300',   'Default RSS polling interval (5 min)'),
  ('feed_ingest_rss_min_interval_seconds','60',    'Minimum RSS polling interval'),
  ('feed_ingest_ap_interval_seconds',     '120',   'Default ActivityPub outbox polling interval'),
  ('feed_ingest_max_items_per_fetch',     '50',    'Max items to ingest per poll cycle'),
  ('feed_ingest_error_backoff_factor',    '2',     'Exponential backoff multiplier on fetch errors'),
  ('feed_ingest_max_error_count',         '10',    'Deactivate source after N consecutive errors'),
  ('feed_ingest_daily_cap_default',       '100',   'Default max items/day per source (safety valve)'),
  ('feed_ingest_max_per_host',           '2',     'Max concurrent fetch jobs per hostname'),
  ('feed_ingest_max_concurrent',         '10',    'Global max concurrent fetch jobs'),
  ('outbound_max_retries',               '3',     'Max retry attempts for outbound cross-posts'),
  ('outbound_retry_delay_seconds',       '30',    'Base delay between outbound retries'),
  ('external_items_retention_days',      '90',    'Days to retain external items before pruning'),
  ('max_subscriptions_per_user',         '200',   'Max external source subscriptions per user');
```

---

## V. New service: `feed-ingest`

### V.1 Role

A new Docker Compose service (`feed-ingest`) containing two processes:

1. **Graphile Worker** — handles scheduled polling jobs (RSS, ActivityPub, external Nostr), outbound cross-posts, token refresh, and pruning. Follows the same pattern as `traffology-worker`.
2. **Jetstream listener** — a standalone long-lived process maintaining a persistent WebSocket connection to Bluesky's Jetstream. This is *not* a Graphile job; it runs as a separate entrypoint within the same container.

Both share the Postgres database. The Jetstream listener writes directly to `external_items` (and `feed_items` in Phase 2+). Graphile Worker processes its job queue as normal.

```yaml
# docker-compose.yml addition
feed-ingest:
  build:
    context: .
    dockerfile: feed-ingest/Dockerfile
  restart: unless-stopped
  env_file: feed-ingest/.env
  depends_on:
    postgres:
      condition: service_healthy
  environment:
    DATABASE_URL: postgresql://platformpub:${POSTGRES_PASSWORD}@postgres:5432/platformpub
    LINKED_ACCOUNT_KEY_HEX: ${LINKED_ACCOUNT_KEY_HEX}   # Phase 5 (outbound); omit in Phases 1–4
    JETSTREAM_URL: ${JETSTREAM_URL:-wss://jetstream1.us-east.bsky.network/subscribe}  # Phase 3+
```

The service has no HTTP API. Health is inferred from Graphile Worker's heartbeat and a simple liveness file written by the Jetstream process.

### V.2 Graphile Worker job types

| Job | Schedule | Phase | Description |
|-----|----------|-------|-------------|
| `feed_ingest_poll` | Cron: every 60s | 1 | Finds `external_sources` due for polling, enqueues per-source jobs (with per-host concurrency limits — see below) |
| `feed_ingest_rss` | Per-source | 1 | Fetches an RSS/Atom feed, parses, upserts into `external_items` (Phase 1) or `external_items` + `feed_items` (Phase 2+) |
| `feed_ingest_activitypub` | Per-source | 4 | Fetches an ActivityPub actor's outbox, upserts items |
| `feed_ingest_nostr` | Per-source | 2 | Subscribes to external relay for a pubkey, fetches recent events |
| `outbound_cross_post` | Per-event | 5 | Dispatches a queued outbound post via the appropriate adapter |
| `outbound_token_refresh` | Cron: every 30min | 5 | Refreshes OAuth tokens nearing expiry in `linked_accounts` |
| `external_items_prune` | Cron: daily | 1 | Deletes `external_items` older than retention period, excluding items with user interactions (see §XV.3) |
| `source_metadata_refresh` | Cron: daily | 1 | Refreshes `display_name`, `avatar_url`, `description` on active sources |
| `feed_items_author_refresh` | Cron: daily | 2 | Propagates changed author metadata (native accounts + external sources) to denormalised `feed_items` rows |
| `feed_items_reconcile` | Cron: daily | 2 | Checks for orphaned or missing `feed_items` rows and repairs them (see §XV.7) |

**Per-host ingestion rate limiting:**

The `feed_ingest_poll` job must enforce per-host concurrency limits when enqueuing per-source fetch jobs. Without this, a cron tick with 500 RSS sources across 300 unique domains fires hundreds of outbound HTTP requests in a burst — poor citizenship and likely to trigger rate limiting from source servers.

Implementation: the poll job groups sources by hostname and enqueues at most **2 concurrent fetch jobs per host**. Excess sources for the same host are deferred to the next poll cycle. Additionally, a **global concurrency cap** on the Graphile Worker pool (e.g., `concurrency: 10` for fetch-type jobs) prevents the worker from saturating outbound bandwidth. These limits are configurable via `platform_config`:

- `feed_ingest_max_per_host` (default 2): max concurrent fetch jobs for the same hostname
- `feed_ingest_max_concurrent` (default 10): global max concurrent fetch jobs across all hosts

### V.3 Jetstream listener (standalone process)

The Jetstream connection is architecturally distinct from Graphile jobs because it is a persistent, long-lived WebSocket — not a discrete unit of work.

**Lifecycle:**
- On startup, queries all active `external_sources WHERE protocol = 'atproto'`, collects DIDs.
- Opens a WebSocket to the configured Jetstream endpoint with `wantedDids` and `wantedCollections=['app.bsky.feed.post']`.
- Processes incoming events: normalise → upsert `external_items` (Phase 1) or `external_items` + `feed_items` (Phase 2+).
- Handles deletion events (`app.bsky.feed.post` delete commits) by setting `deleted_at` on the relevant tables.

**DID list management:**
- Polls `external_sources` every 60 seconds for changes to the active atproto DID set.
- On change, disconnects and reconnects with the updated `wantedDids` list.
- Jetstream supports up to ~10,000 DIDs per connection. If the platform exceeds this, the listener opens multiple parallel connections with partitioned DID sets. The partition boundary is documented in the Jetstream docs and should be checked at implementation time.

**Cursor management:**
- Jetstream provides a `time_us` (microsecond timestamp) cursor.
- Stored per-source in `external_sources.cursor`.
- **New source initialisation:** When a new atproto source is created (user subscribes to a Bluesky account), its cursor is initialised to the current `time_us` (i.e., `now`). The source's recent post history is backfilled separately via a one-time `getAuthorFeed` API call (enqueued as a Graphile Worker job). This prevents new subscriptions from dragging the global Jetstream cursor backward — the listener only sees the new DID on its next 60-second poll and starts receiving events from that point forward.
- On reconnection, resume from the oldest cursor across all active atproto sources. Because new sources are initialised to `now` (not to zero), the oldest cursor reflects the listener's last disconnect time, not an unrelated subscription event. The deduplication constraint (`UNIQUE (protocol, source_item_uri)`) handles any overlap via `ON CONFLICT DO NOTHING`.
- If the oldest cursor is too old (Jetstream retains ~72h), fall back to fetching recent posts via `getAuthorFeed` for each DID whose cursor exceeds the retention window, then update those cursors to `now` and reconnect.

**Failure modes:**
- WebSocket disconnect: automatic reconnect with exponential backoff (1s → 2s → 4s → ... → 30s max).
- Jetstream service outage (both endpoints): fall back to polling `getAuthorFeed` via `feed_ingest_poll` for atproto sources until Jetstream recovers. The poll job checks a `jetstream_healthy` flag set by the listener process.

### V.4 Protocol adapters

Each adapter implements two interfaces:

```typescript
interface IngestAdapter {
  /** Fetch new items from the source and return normalised items. */
  fetch(source: ExternalSource): Promise<NormalisedItem[]>;
  /** Resolve display metadata for a source (name, avatar, description). */
  resolve(sourceUri: string): Promise<SourceMetadata>;
}

interface OutboundAdapter {
  /** Post a reply/quote/repost to the external platform. */
  send(post: OutboundPost, credentials: DecryptedCredentials): Promise<{ externalUri: string }>;
  /** Refresh OAuth tokens. Returns updated credentials or throws. */
  refreshTokens?(credentials: DecryptedCredentials): Promise<DecryptedCredentials>;
}
```

### V.5 Universal resolver

The universal resolver is the platform's shared identity resolution engine. It takes an arbitrary string — whatever the user has — and resolves it to one or more candidate identities: a native all.haus account, an external source (for subscription), or both.

This is the implementation of design principle #9 (omnivorous input). The feed subscribe flow is its first consumer, but the resolver is a gateway-level library used by any endpoint that accepts identity input.

#### V.5.1 Input classification

The resolver classifies input by pattern matching, then dispatches to the appropriate resolution chain. Classification is deterministic, not probabilistic — every input maps to exactly one chain (or the ambiguous-identifier chain, which tries multiple).

| Pattern | Classification | Resolution chain |
|---------|---------------|------------------|
| `https://...` or `http://...` | URL | URL resolver (§V.5.2) |
| `npub1...` | Nostr NIP-19 pubkey | Decode bech32 → hex pubkey → platform account lookup + external Nostr source |
| `nprofile1...` | Nostr NIP-19 profile | Decode bech32 → hex pubkey + relay hints → same as npub + populate `relay_urls` |
| 64-char hex string | Nostr hex pubkey | Platform account lookup (by `nostr_pubkey`) + external Nostr source |
| `did:plc:...` or `did:web:...` | AT Protocol DID | Resolve DID → Bluesky handle → external atproto source |
| `@handle.bsky.social` (or any `@handle.tld`) | Possible Bluesky handle | Try AT Protocol handle resolution (`com.atproto.identity.resolveHandle`) |
| `@user@instance.tld` | Fediverse handle | WebFinger resolution → ActivityPub actor URI → external activitypub source |
| `user@domain.tld` (no `@` prefix) | Ambiguous: email, NIP-05, or fediverse | Ambiguous chain (§V.5.3) |
| Alphanumeric, no `@`, no `.` | Platform username | Platform account lookup (by `username`) |
| Anything else | Free-text | Platform search (writers + publications) |

#### V.5.2 URL resolver

URLs are the richest input type — a single URL can resolve to an RSS feed, a social profile, or a native all.haus page. The resolver tries strategies in order, returning the first match:

1. **Platform URL.** If the URL matches `all.haus/writer/:username` or `all.haus/:pubSlug`, resolve directly to the native account or publication. Short-circuit — no external fetch needed.

2. **Known social platform URL patterns:**
   - `bsky.app/profile/:handleOrDid` → extract handle/DID, resolve as atproto source.
   - `mastodon.social/@:user`, `hachyderm.io/@:user`, etc. → extract instance + username, resolve as ActivityPub actor via WebFinger. (Maintain a list of known fediverse domains, but also fall through to generic ActivityPub resolution for unknown domains.)
   - `twitter.com/:user`, `x.com/:user` → not supported; return a clear message ("Twitter/X feeds are not available — try following this person on Bluesky or Nostr instead").
   - `njump.me/:identifier`, `nostr.com/:identifier` → extract Nostr identifier, re-enter resolver.

3. **RSS/Atom discovery.** Fetch the URL (respecting the SSRF rules from §XVI.3). Try in order:
   - Parse directly as RSS/Atom XML.
   - Parse as HTML, extract `<link rel="alternate" type="application/rss+xml">` or `type="application/atom+xml"`.
   - Try well-known paths: `/feed`, `/rss`, `/atom.xml`, `/feed.xml`, `/index.xml`, `/feed/rss`, `/blog/feed`.

4. **ActivityPub actor probe.** Fetch the URL with `Accept: application/activity+json`. If the response is a valid ActivityPub actor, resolve as activitypub source.

5. **No match.** Return the URL as-is with a "couldn't resolve" status and suggest the user check the address.

All external fetches in the URL resolver share the hardened HTTP client (SSRF rules, 10s timeout, 5MB limit, 3 redirect max).

#### V.5.3 Ambiguous identifier chain (`user@domain.tld`)

The `user@domain` pattern is genuinely ambiguous — it could be an email (for a platform invite), a NIP-05 identifier (for Nostr resolution), or a fediverse handle (for ActivityPub resolution). The resolver tries all three in parallel and returns all matches, letting the calling context decide:

1. **Platform account lookup** — check if the email matches an existing `accounts.email`. If found, return the native account.
2. **NIP-05 resolution** — fetch `https://domain.tld/.well-known/nostr.json?name=user`. If valid, extract the hex pubkey. Check for a native account with that pubkey; also return as a potential external Nostr source.
3. **WebFinger resolution** — fetch `https://domain.tld/.well-known/webfinger?resource=acct:user@domain.tld`. If valid, extract the ActivityPub actor URI. Return as a potential activitypub source.

The calling context determines priority:
- **Feed subscribe flow:** prefer external source results (NIP-05 or WebFinger). If both match, present both as options.
- **Publication invite flow:** prefer native account (email match). If no email match, fall through to NIP-05/WebFinger and offer to subscribe instead of invite.
- **DM / mention flow:** prefer native account. External identities can't receive DMs.

#### V.5.4 Resolver response

The resolver returns a structured result, not a single answer:

```typescript
interface ResolverResult {
  /** What the resolver understood the input to be */
  inputType: 'url' | 'npub' | 'nprofile' | 'hex_pubkey' | 'did' |
             'bluesky_handle' | 'fediverse_handle' | 'ambiguous_at' |
             'platform_username' | 'free_text';

  /** Matches found, ordered by confidence */
  matches: ResolverMatch[];

  /** If no matches, a human-readable explanation */
  error?: string;
}

interface ResolverMatch {
  type: 'native_account' | 'external_source' | 'rss_feed';
  confidence: 'exact' | 'probable' | 'speculative';

  /** Non-null if this is a native all.haus account */
  account?: { id: string; username: string; displayName: string; avatar?: string };

  /** Non-null if this is an external source (for subscription) */
  externalSource?: {
    protocol: ExternalProtocol;
    sourceUri: string;
    displayName?: string;
    avatar?: string;
    description?: string;
    relayUrls?: string[];  // nostr_external only
  };

  /** Non-null if this is a discovered RSS feed */
  rssFeed?: { feedUrl: string; title?: string; description?: string };
}
```

The UI renders this as a dropdown of matches when there's more than one result. For single exact matches, it resolves immediately.

#### V.5.5 Sitewide adoption

The universal resolver is the shared primitive. Each existing identity input across the platform should migrate to it over time. Current state and target:

| Feature | Current input | Current location | Target |
|---------|--------------|------------------|--------|
| **Publication invite** | Email only | `MembersTab.tsx:199` | Email, username, npub, NIP-05, fediverse handle. Resolve to native account; if external-only, offer "invite by email" fallback. |
| **DM new conversation** | Username only | `messages/page.tsx:114` | Username, email, npub, NIP-05. Resolve to native account only (DMs require platform membership). |
| **DM pricing override** | Username only | `DmFeeSettings.tsx:116` | Same as DM — username, email, npub, NIP-05. Native accounts only. |
| **Feed subscribe** | (New) | `POST /api/feeds/subscribe` | Full resolver: URLs, handles, npubs, DIDs, NIP-05, fediverse handles, RSS URLs. |
| **Search** | Free-text query | `search/page.tsx:68` | Add resolver as a pre-pass: if the query looks like an identifier (URL, handle, npub), resolve first and show the resolved result above search results. |
| **Publication ownership transfer** | UUID only | `publications.ts:495` | Username, email, npub. Resolve to native account (must be platform member). |

Migration priority: feed subscribe (Phase 1), publication invite (Phase 1 — low effort, high visibility), search pre-pass (Phase 2), DM flows (Phase 3). The resolver library ships in Phase 1; downstream adoption is incremental.

#### V.5.6 Gateway endpoint

```
POST /api/resolve
Body: { query: string, context?: 'subscribe' | 'invite' | 'dm' | 'general' }
Response: ResolverResult
```

The `context` parameter controls priority ordering and filtering (e.g., `dm` context filters to native accounts only). The endpoint is authenticated — resolver fetches count toward rate limits to prevent abuse as an open proxy.

#### V.5.7 Two-phase resolution UX

The resolver does network I/O (NIP-05, WebFinger, RSS discovery, AT Protocol handle resolution) that can take seconds. A synchronous request that blocks the UI for 5–10 seconds while probing RSS well-known paths and WebFinger endpoints is a poor experience. The resolver uses a two-phase approach:

**Phase A — instant local classification (< 50ms):**
The resolver classifies the input by pattern matching (§V.5.1) and performs local-only lookups: platform username → `accounts` table, npub/nprofile → bech32 decode + `accounts.nostr_pubkey` lookup. These return immediately. The response includes `inputType` and any local matches, plus a `pendingResolutions` array listing the remote resolution chains that will be attempted.

The frontend renders immediately: "Looks like a Bluesky handle — resolving..." or "Checking for RSS feed..." with the input classification visible and any local matches already shown.

**Phase B — async remote resolution (streaming):**
The endpoint returns Phase A results immediately. Remote resolutions (NIP-05 fetch, WebFinger, RSS discovery, AT Protocol handle resolution) run asynchronously. The frontend polls a follow-up endpoint (`GET /api/resolve/:requestId`) or the initial response includes all results if remote resolution completes within a short timeout (500ms). For slow resolutions, the frontend polls at 1-second intervals (max 3 polls, then stops and shows whatever results are available plus "couldn't reach [source] — try pasting a direct URL").

This avoids the worst case (user stares at a spinner for 10 seconds) without requiring WebSockets or SSE. The resolution request ID is ephemeral — stored in memory or a short-TTL cache, not in the database.

---

## VI. Protocol-specific design

### VI.1 RSS / Atom (tier 4)

The simplest channel. Read-only — no outbound adapter.

**Ingestion:**
- Standard HTTP GET with `If-None-Match` (ETag) and `If-Modified-Since` headers.
- Parse with a robust library (`feedparser-promised` or `rss-parser`). Do not hand-roll XML parsing.
- Each `<item>` or `<entry>` becomes one `external_items` row (and one `feed_items` row in Phase 2+).
- `source_item_uri` = `<guid>` or `<link>` (in that order of preference).
- `content_text` = stripped HTML from `<description>` or `<content:encoded>`.
- `content_html` = raw `<content:encoded>` or `<description>`.
- `title` = `<title>`.
- `published_at` = `<pubDate>` or `<updated>`.
- `media` = extracted from `<enclosure>` elements and `<media:content>`.

**Content sanitisation:**
- HTML content is sanitised with a strict allowlist (no `<script>`, `<iframe>`, `<object>`, event handlers) before storage in `content_html`. Use `sanitize-html` or equivalent.
- Image URLs in media are proxied through the gateway's existing media proxy (or stored as direct URLs with a CSP that permits external images). Decision deferred to implementation.

**Polling interval:**
- Defaults to `feed_ingest_rss_interval_seconds` (5 min).
- Respects `Cache-Control: max-age` and `Retry-After` headers from the source.
- Exponential backoff on errors: interval × `feed_ingest_error_backoff_factor` ^ `error_count`.
- Source deactivated after `feed_ingest_max_error_count` consecutive errors.

**Deduplication:**
- `UNIQUE (protocol, source_item_uri)` constraint on `external_items`. `ON CONFLICT DO NOTHING`.

**Volume control:**
- `feed_ingest_max_items_per_fetch` (default 50) caps items per poll cycle. This is enforced at ingestion time — the adapter stops processing after this many new items per fetch.
- `feed_ingest_daily_cap_default` (default 100) provides a platform-wide safety valve at the ingestion layer: sources that produce more than this many items per day have excess items dropped (oldest first). This is a source-level cap, not per-subscriber.
- Per-subscriber `daily_cap` (on `external_subscriptions`) is enforced at **feed query time**, not at ingestion. Because items are shared across subscribers (principle #8), the ingestion layer cannot enforce per-subscriber caps without affecting other subscribers to the same source. The feed query applies a windowed row-number filter per source (see §VII.1).

**Feed discovery:**
- The user enters any identifier into the subscribe input. The universal resolver (§V.5) handles classification and URL-based RSS discovery (§V.5.2, step 3), including `<link rel="alternate">` extraction and well-known path probing.
- Feed discovery is a real-world rabbit hole (Cloudflare challenges, broken XML, CDATA-wrapped HTML, feeds that serve HTML to non-reader User-Agents). The resolver's URL fetcher uses a User-Agent string that identifies as a feed reader. The SSRF-hardened HTTP client (§XVI.3) enforces 10-second timeouts and 5MB response limits. Accept partial success — if discovery fails, the UI shows a clear error with the option to paste a direct feed URL.
- On success, creates the `external_sources` row (or finds the existing one), creates the `external_subscriptions` row, and triggers an immediate `feed_ingest_rss` job.

**Deletion:**
- RSS has no deletion signal. Items removed from the feed XML are not deleted from `external_items`; they simply stop appearing in future fetches. They age out via the retention pruning job.

### VI.2 External Nostr relays (tier 2)

**Why this comes before Bluesky/Mastodon:** The platform already understands Nostr events, already has relay infrastructure (strfry), and already renders notes and articles. External Nostr ingestion reuses the existing event parsing logic and rendering components with minimal new code. It validates the multi-source feed assembly pipeline before introducing OAuth, foreign content formats, and protocol-specific rendering.

**Ingestion:**
- For each `external_sources` row with `protocol = 'nostr_external'`, the `feed_ingest_nostr` job opens a temporary WebSocket to each relay in `relay_urls`.
- Sends a `REQ` filter for `kinds: [1, 30023]` by the specified pubkey, with `since` set to the stored cursor (or 48 hours ago if no cursor).
- Collects events, closes the connection, normalises into `external_items` (and `feed_items` in Phase 2+).
- `source_item_uri` = `nevent1...` (NIP-19 encoded).
- `content_text` = event `.content`.
- `interaction_data` = `{ id: event.id, pubkey: event.pubkey, relays: source.relay_urls }`.
- For replies: `source_reply_uri` = the `e` tag with `reply` marker (or last `e` tag per NIP-10).

**Cursor:** `created_at` of the newest event processed, stored in `external_sources.cursor`.

**Outbound:**
- Publishes the user's Nostr reply event (already created on the all.haus relay) to the source relays listed in `interaction_data.relays`.
- Uses the user's custodial keypair via `key-custody` (HTTP call from `feed-ingest` to `key-custody` service).
- The event is already signed; this is just a relay publish (same fire-and-forget WebSocket pattern as `nostr-publisher.ts` in the gateway).

**Deletion:**
- Kind 5 deletion events from the source relay set `external_items.deleted_at` (and `feed_items.deleted_at` in Phase 2+).

### VI.3 Bluesky / AT Protocol (tier 3)

**Ingestion — Jetstream:**

See §V.3 for Jetstream listener architecture.

**Normalisation:**
- `source_item_uri` = AT URI (`at://did:plc:.../app.bsky.feed.post/rkey`).
- `content_text` = `record.text`.
- `content_html` = rendered from facets (mentions → links, URIs → links). Use `@atproto/api`'s `RichText` class for facet rendering rather than hand-rolling.
- `media` = extracted from `record.embed` (images, external links, video).
- `interaction_data` = `{ uri, cid }` (minimum needed for reply/quote threading).
- For replies: `source_reply_uri` = `record.reply.parent.uri`. Also store `{ rootUri, rootCid, parentUri, parentCid }` in `interaction_data` (AT Protocol requires both `parent` and `root` strong references).
- For quote posts: `source_quote_uri` = `record.embed.record.uri` (when embed type is `app.bsky.embed.record`).
- For reposts: `is_repost = TRUE`, `original_item_uri` = the reposted post's AT URI.

**Deletion:**
- Jetstream delivers `delete` commits. The listener sets `deleted_at` on `external_items` (and `feed_items` in Phase 2+).

**Outbound — AT Protocol OAuth + `createRecord`:**

Reply structure (AT Protocol requires both `parent` and `root` strong references):

```typescript
const record = {
  $type: 'app.bsky.feed.post',
  text: outboundPost.text,
  createdAt: new Date().toISOString(),
  reply: {
    root: {
      uri: interactionData.rootUri ?? interactionData.uri,
      cid: interactionData.rootCid ?? interactionData.cid,
    },
    parent: {
      uri: interactionData.parentUri ?? interactionData.uri,
      cid: interactionData.parentCid ?? interactionData.cid,
    },
  },
};

await agent.api.com.atproto.repo.createRecord({
  repo: linkedAccount.externalId,
  collection: 'app.bsky.feed.post',
  record,
});
```

Quote-post structure:

```typescript
const record = {
  $type: 'app.bsky.feed.post',
  text: outboundPost.text,
  createdAt: new Date().toISOString(),
  embed: {
    $type: 'app.bsky.embed.record',
    record: {
      uri: interactionData.uri,
      cid: interactionData.cid,
    },
  },
};
```

**OAuth flow:**

AT Protocol uses OAuth as the primary auth mechanism. all.haus implements the confidential web client flow:

1. User clicks "Connect Bluesky" in settings.
2. all.haus publishes a client metadata document at `https://all.haus/.well-known/oauth-client-metadata`.
3. User enters their Bluesky handle. Gateway resolves handle → DID → PDS → authorization server.
4. Standard OAuth authorization code flow with PKCE and DPoP.
5. Tokens stored encrypted in `linked_accounts.credentials_enc`.
6. Refresh handled by the `outbound_token_refresh` cron job.

Scoped permissions: request `atproto:write` and `atproto:read`. Adopt granular Auth Scopes as they stabilise in the AT Protocol ecosystem.

### VI.4 Mastodon / ActivityPub (tier 3)

**Ingestion — outbox polling:**

- Each `external_sources` row with `protocol = 'activitypub'` stores an actor URI.
- The adapter fetches the actor's outbox (`GET {actorUri}/outbox`) and paginates through `OrderedCollectionPage` items.
- Normalises `Create` activities containing `Note` objects.
- `source_item_uri` = the Note's `id`.
- `content_html` = `content` (ActivityPub notes are HTML).
- `content_text` = stripped HTML.
- `media` = extracted from `attachment` array.
- `interaction_data` = `{ id, inReplyTo, attributedTo, statusId, instanceUrl }`.
- `source_reply_uri` = `inReplyTo`.

**Known limitations of outbox polling:**
- Many Mastodon instances restrict outbox access to authenticated requests, return inconsistent pagination, or rate-limit aggressively.
- Some instances return only public posts; followers-only posts are invisible to outbox polling.
- The adapter must handle: 401/403 responses (mark source with error), missing pagination links (stop at first page), varying `Content-Type` headers, and instances that return HTML instead of JSON-LD to unknown User-Agents.
- **Mitigation:** Set realistic user expectations in the UI. When subscribing to a Mastodon account, show a notice: "Some posts may not be available depending on the instance's privacy settings." Log per-instance success rates to identify problematic instances.

**Cursor:** The `id` of the most recent activity processed, stored in `external_sources.cursor`.

**Deletion:**
- Outbox polling has no reliable deletion signal. Items that disappear from the outbox are not proactively deleted. They age out via retention pruning.
- Future: inbox delivery (Phase 4) would receive `Delete` activities and could set `deleted_at`.

**Outbound — Mastodon OAuth + REST API:**

```typescript
const response = await fetch(`${instanceUrl}/api/v1/statuses`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${credentials.accessToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    status: outboundPost.text,
    in_reply_to_id: interactionData.statusId,
  }),
});
```

**OAuth flow:**

Mastodon uses OAuth 2.0 with dynamic client registration:

1. User clicks "Connect Mastodon" and enters their instance URL.
2. Gateway validates the URL, then checks `oauth_app_registrations` for an existing registration on that instance. If none exists, registers as an OAuth application via `POST /api/v1/apps` and stores the `client_id` / `client_secret` in `oauth_app_registrations` (see §IV.8). Subsequent users on the same instance reuse the existing app registration.
3. Standard OAuth authorization code flow using the app credentials from `oauth_app_registrations`.
4. Scopes: `read:statuses write:statuses`.
5. Tokens stored in `linked_accounts.credentials_enc`. `instance_url` stored on the `linked_accounts` row (needed for all API calls).

---

## VII. Unified feed assembly

### VII.1 Feed query

#### Phase 1: three-stream merge (application code)

Phase 1 queries articles, notes, and external items separately. The gateway fetches each stream with matching cursor parameters and merges the results in application code, sorted by `published_at DESC`. This is the same architecture as the existing two-stream feed, with one additional stream.

Each stream uses a **compound cursor** `(published_at, id)` for stable pagination — `published_at` alone is not unique and will skip or duplicate items at page boundaries:

```sql
-- Stream 1: articles from followed authors or publications
SELECT a.id, a.title, a.published_at, 'article' AS item_type, ...
FROM articles a
WHERE a.deleted_at IS NULL
  AND (a.published_at, a.id) < ($2, $3)           -- compound cursor
  AND (
    a.writer_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
    OR a.writer_id = $1
    OR a.publication_id IN (
      SELECT pf.publication_id FROM publication_follows pf WHERE pf.follower_id = $1
    )
  )
  AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = a.writer_id)
  AND NOT EXISTS (SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = a.writer_id)
ORDER BY a.published_at DESC, a.id DESC
LIMIT $4;

-- Stream 2: notes from followed authors
SELECT n.id, n.published_at, 'note' AS item_type, ...
FROM notes n
WHERE n.deleted_at IS NULL
  AND (n.published_at, n.id) < ($2, $3)
  AND (
    n.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
    OR n.author_id = $1
  )
  AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = n.author_id)
  AND NOT EXISTS (SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = n.author_id)
ORDER BY n.published_at DESC, n.id DESC
LIMIT $4;

-- Stream 3: external items from subscriptions (with daily cap)
WITH capped AS (
  SELECT ei.id,
         ROW_NUMBER() OVER (
           PARTITION BY ei.source_id
           ORDER BY ei.published_at DESC
         ) AS rn,
         COALESCE(es.daily_cap, $5) AS cap
  FROM external_items ei
  JOIN external_subscriptions es
    ON es.source_id = ei.source_id
   AND es.subscriber_id = $1
   AND es.is_muted = FALSE
  WHERE ei.deleted_at IS NULL
    AND ei.published_at >= now() - INTERVAL '24 hours'  -- rolling 24h window for cap
)
SELECT ei.*, 'external' AS item_type, xs.display_name AS source_name,
       xs.avatar_url AS source_avatar, xs.protocol AS source_protocol
FROM external_items ei
JOIN capped c ON c.id = ei.id AND c.rn <= c.cap
JOIN external_sources xs ON xs.id = ei.source_id
WHERE (ei.published_at, ei.id) < ($2, $3)
ORDER BY ei.published_at DESC, ei.id DESC
LIMIT $4;
```

The gateway merges the three result sets, sorts by `(published_at DESC, id DESC)`, takes `LIMIT` items, and returns the compound cursor `(published_at, id)` of the last item for the next page.

**Note on daily_cap and pagination:** The daily cap uses a rolling 24-hour window (`now() - INTERVAL '24 hours'`), not `CURRENT_DATE`. This prevents the cap boundary from shifting at midnight, which would cause external items to appear/disappear as users paginate across the day boundary. Items older than 24 hours are uncapped — the cap exists to prevent feed flooding from high-volume sources, not to limit historical browsing.

**Note on `NOT EXISTS` vs `IN`:** Block/mute filtering uses `NOT EXISTS` (correlated subquery) rather than `NOT IN` (subquery). Postgres optimises `NOT EXISTS` into an anti-join, which scales to large block/mute sets without per-row scans.

#### Phase 2: single-table feed query (feed_items)

Once `feed_items` is populated (Phase 2), the three streams collapse into a single-table scan. The same fixes apply: compound cursor, rolling 24h cap window, `NOT EXISTS` for exclusions.

```sql
-- Following feed (Phase 2 — single-table)
WITH capped_external AS (
  SELECT fi.id AS feed_item_id,
         ROW_NUMBER() OVER (
           PARTITION BY fi.source_id
           ORDER BY fi.published_at DESC
         ) AS rn,
         COALESCE(es.daily_cap, $4) AS cap
  FROM feed_items fi
  JOIN external_subscriptions es
    ON es.source_id = fi.source_id
   AND es.subscriber_id = $1
   AND es.is_muted = FALSE
  WHERE fi.item_type = 'external'
    AND fi.deleted_at IS NULL
    AND fi.published_at >= now() - INTERVAL '24 hours'  -- rolling 24h window
)
SELECT fi.*
FROM feed_items fi
WHERE fi.deleted_at IS NULL
  AND (fi.published_at, fi.id) < ($2, $3)             -- compound cursor
  AND (
    -- Native content: from followed authors or self
    (fi.item_type IN ('article', 'note')
     AND (
       fi.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
       OR fi.author_id = $1
       OR fi.article_id IN (
         SELECT a.id FROM articles a
         JOIN publication_follows pf ON pf.publication_id = a.publication_id
         WHERE pf.follower_id = $1
       )
     ))
    OR
    -- External content: from active, unmuted subscriptions, within daily cap
    (fi.id IN (
       SELECT feed_item_id FROM capped_external WHERE rn <= cap
     ))
  )
  -- Block/mute filters (native content only — external items have no author_id)
  AND NOT EXISTS (
    SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = fi.author_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = fi.author_id
  )
ORDER BY fi.published_at DESC, fi.id DESC
LIMIT $5;
```

```sql
-- Explore feed (scored, native content only until scoring worker ships)
--
-- External items are excluded from explore until the feed scoring worker
-- (specced in FEED-ALGORITHM.md) is implemented. Without scoring, all
-- external items have score = 0 and would appear as an unranked
-- reverse-chronological dump, overwhelming the curated native content.
-- Once the scoring worker writes meaningful scores to feed_items.score,
-- remove the item_type filter to include external items.
SELECT fi.*
FROM feed_items fi
WHERE fi.deleted_at IS NULL
  AND fi.published_at > now() - INTERVAL '48 hours'
  AND fi.item_type IN ('article', 'note')
  AND fi.author_id != $1
  AND NOT EXISTS (
    SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = fi.author_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = fi.author_id
  )
ORDER BY fi.score DESC, fi.published_at DESC
LIMIT $2;
```

The Phase 2 query replaces the three-stream merge with a single-table scan. The compound cursor index `(published_at DESC, id DESC)` supports stable keyset pagination. The CTE for daily cap enforcement scans only the rolling 24-hour window of external items for the user's subscriptions, and the windowed `ROW_NUMBER` is efficient with the `(source_id, published_at DESC)` index.

### VII.2 Writing to `feed_items` (Phase 2)

**Phase 1:** No `feed_items` writes. Articles and notes are written as they are today. External items are written to `external_items` only. The three-stream merge query (§VII.1) reads from the source tables directly.

**Phase 2 onward — all writes are transactional:**

The gateway writes to `articles`/`notes` and the corresponding `feed_items` row in the **same database transaction**. If either INSERT fails, both roll back. An article without a `feed_items` row is invisible in the feed — this is a correctness requirement, not an optimisation.

```typescript
// In the article publish handler — MUST be within the same transaction:
const client = await pool.connect();
try {
  await client.query('BEGIN');

  const { rows: [article] } = await client.query(`
    INSERT INTO articles (id, writer_id, title, ..., published_at)
    VALUES ($1, $2, $3, ..., $9) RETURNING id
  `, [articleId, writerId, title, /* ... */ publishedAt]);

  await client.query(`
    INSERT INTO feed_items (item_type, article_id, author_id, author_name,
      author_avatar, author_username, title, content_preview,
      nostr_event_id, tier, published_at)
    VALUES ('article', $1, $2, $3, $4, $5, $6, $7, $8, 'tier1', $9)
  `, [articleId, writerId, displayName, avatar, username, title, preview, eventId, publishedAt]);

  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

**External content (feed-ingest):**

The ingestion worker inserts into `external_items` and `feed_items` in a single transaction.

**Backfill migration:**

Migration `007-backfill-feed-items.sql` populates `feed_items` from existing `articles`, `notes`, and `external_items`. Run once. Idempotent via `ON CONFLICT DO NOTHING` on the unique partial indexes (`idx_feed_items_article`, `idx_feed_items_note`, `idx_feed_items_external` — see §IV.5). The migration must batch inserts (e.g., 1000 rows per `INSERT...SELECT` with an `id`-keyed pagination loop) to avoid locking the target table for the entire duration. See §XII for details.

### VII.3 Feed rendering

External items render in the same card layout as native notes but with distinct visual treatment:

**Provenance badge:**
- Sits below the author name, uses `.label-ui` class (11px mono, uppercase, 0.06em tracking — per design system).
- Text: `VIA BLUESKY`, `VIA MASTODON`, `VIA RSS`, `VIA NOSTR`.
- Colour: `text-crimson` (functional label, not decorative).

**External card differences from NoteCard:**
- Author avatar: loaded from `author_avatar_url` (external URL) instead of the platform's `/media/` path. Falls back to a protocol-specific default icon.
- Author name: not a link to an all.haus profile (no profile exists). Instead, links to the source platform profile via `author_uri`.
- Content: renders `content_html` (sanitised) for RSS and ActivityPub items. Renders `content_text` for Bluesky and Nostr items.
- Title: shown above content for RSS items (articles have titles; social posts generally don't).
- Media: renders `media` array as inline images/video thumbnails. External URLs; no platform media proxy (for now).
- Footer: shows "View original" link to `source_item_uri`. Reply/quote actions available; vote/bookmark actions available (these are all.haus-native interactions).

**New component:** `ExternalCard` in `web/src/components/feed/`. Props mirror the `feed_items` columns for `item_type = 'external'`. Rendered by `FeedView` alongside `ArticleCard` and `NoteCard`.

### VII.4 Interaction model

When a user interacts with an external item in the feed:

| Action | Native behaviour | Outbound behaviour (if linked) |
|--------|-----------------|-------------------------------|
| **Reply** | Creates `kind:1` note on all.haus relay. The note's `reply_to_event_id` is NULL (it's a top-level note that references the external item via a new `external_reply_to` field). | Cross-posts reply to source platform via outbound adapter. |
| **Quote** | Creates `kind:1` note with `q` tag + embedded card showing the external item. | Cross-posts as quote-post (AT Protocol: `embed.record`; ActivityPub: link in body; Nostr: `q` tag). |
| **Repost** | Creates `kind:6` repost event on all.haus relay. | Cross-posts as repost/boost on source platform. |
| **Bookmark** | Saves to user's all.haus bookmarks (local only). | No outbound action. |
| **Vote** | Standard all.haus vote (platform-native, no cross-post). | No outbound action. |

The reply/quote composer shows a toggle: "Also post to [Bluesky/Mastodon]". Default state from `linked_accounts.cross_post_default`. Hidden if no linked account exists for the source protocol. Hidden for RSS items (read-only protocol).

---

## VIII. Outbound reply routing

### VIII.1 Flow

```
User composes reply to external item
  → Gateway creates kind:1 Nostr event on all.haus relay
  → Gateway creates row in notes table + feed_items row (native)
  → If user has linked account for source protocol AND toggle is on:
      → Gateway enqueues outbound_cross_post job in Graphile Worker
      → feed-ingest worker picks up the job
      → Worker decrypts linked_account credentials
      → Worker calls outbound adapter for the protocol
      → Adapter constructs platform-specific reply (with parent/root refs)
      → Adapter posts to external API
      → Worker updates outbound_posts with result (external_post_uri or error)
  → If cross-post fails:
      → Retry with exponential backoff (up to max_retries)
      → On permanent failure: mark as failed, surface in user's settings
      → The native Nostr event on all.haus is never affected by outbound failure
```

### VIII.2 Text transformation

Different platforms have different constraints:

| Platform | Max length | Formatting | Link handling |
|----------|-----------|------------|---------------|
| Bluesky | 300 graphemes | Facets (mentions, links) | Detect and encode as facets |
| Mastodon | ~500 chars (instance-dependent) | HTML subset | Plain URLs auto-linked |
| Nostr | Unlimited | Markdown | Markdown links |

If the user's reply exceeds the target platform's limit, the adapter truncates with an ellipsis and appends a link back to the full reply on all.haus. The canonical, full-length version always lives on all.haus.

### VIII.3 Outbound security

Outbound cross-posting is the highest-trust operation in the system. Credentials are decrypted in memory only for the duration of the API call, then discarded. The `outbound_posts` audit table provides a full record of every external action taken on behalf of a user.

Outbound jobs run in `feed-ingest`, not in the gateway. This keeps credential decryption out of the request-serving process. The gateway enqueues jobs; the worker executes them.

---

## IX. User-facing error states

External integrations fail. The design must surface errors clearly rather than silently degrading.

| Error | User sees | System action |
|-------|-----------|---------------|
| RSS feed returns 404 for 3+ days | Badge on subscription: "Feed unavailable" | `error_count` increments; deactivated at threshold |
| RSS feed returns 403 (Cloudflare challenge) | Badge: "Feed blocked by source" | Same backoff; deactivated at threshold |
| Bluesky OAuth token expires, refresh fails | Banner in settings: "Reconnect your Bluesky account" | `linked_accounts.is_valid = FALSE`; outbound paused |
| Mastodon instance goes offline | Badge on subscription: "Instance unavailable" | Backoff; items resume when instance recovers |
| Outbound cross-post fails permanently | Notification: "Your reply couldn't be posted to Bluesky. It's still on all.haus." | `outbound_posts.status = 'failed'` |
| Source returns content that fails sanitisation | Item silently skipped | Logged; does not increment `error_count` |

Settings page includes a "Connected accounts" section showing linked account status, and a "Subscriptions" section showing per-source health.

---

## X. Gateway API additions

### X.1 Universal resolver

```
POST   /api/resolve                 — Resolve any identifier to candidate identities (§V.5).
                                     Body: { query: string, context?: 'subscribe' | 'invite' | 'dm' | 'general' }
                                     Response: ResolverResult. Authenticated; rate-limited.
                                     Returns local matches immediately; includes requestId if
                                     remote resolutions are pending (see §V.5.7).
GET    /api/resolve/:requestId      — Poll for async remote resolution results.
                                     Returns updated ResolverResult with remote matches appended.
                                     Short-lived (60s TTL); results cached in-memory, not DB.
```

This is the shared endpoint backing all omnivorous input fields across the platform. The frontend calls `POST /api/resolve` on input blur or after a 300ms debounce, receives instant local results, then polls `GET /api/resolve/:requestId` at 1-second intervals (max 3 polls) for remote resolution results (see §V.5.7 for the two-phase UX).

### X.2 Feed subscriptions

```
POST   /api/feeds/subscribe        — Subscribe to an external source (creates source + subscription).
                                     Accepts a resolver match (protocol + sourceUri) or a raw query string
                                     (which is passed through the resolver internally).
                                     Returns 429 if user has reached max_subscriptions_per_user (default 200).
DELETE /api/feeds/:id               — Remove a subscription
GET    /api/feeds                   — List user's external feed subscriptions (with source health)
PATCH  /api/feeds/:id               — Update subscription preferences (is_muted, daily_cap)
POST   /api/feeds/:id/refresh       — Force immediate re-fetch of a source
```

### X.3 Linked accounts

```
GET    /api/linked-accounts              — List user's linked accounts (with status)
POST   /api/linked-accounts/bluesky      — Initiate Bluesky OAuth flow
POST   /api/linked-accounts/mastodon     — Initiate Mastodon OAuth flow (accepts instance_url)
GET    /api/linked-accounts/callback     — OAuth callback handler
DELETE /api/linked-accounts/:id          — Disconnect a linked account
PATCH  /api/linked-accounts/:id          — Update preferences (cross_post_default)
```

### X.4 Feed (extended)

```
GET    /api/feed?reach=following         — Existing feed, now includes external items (no breaking change)
GET    /api/feed?reach=explore           — Existing explore feed (native content only until scoring worker ships)
```

No separate `include_external` parameter. External items are part of the following feed if the user has subscriptions. The unified timeline table means they're included by default at no query cost. Users who want to exclude external items can mute all their subscriptions. External items are excluded from the explore feed until the feed scoring worker (FEED-ALGORITHM.md) ships meaningful scores — without scoring, external items would appear as an unranked reverse-chronological dump.

---

## XI. Environment variables

| Variable | Service | Phase | Purpose |
|----------|---------|-------|---------|
| `LINKED_ACCOUNT_KEY_HEX` | feed-ingest, gateway | 5 | AES-256 key for encrypting linked account credentials |
| `JETSTREAM_URL` | feed-ingest | 3 | Bluesky Jetstream WebSocket URL |
| `OAUTH_CALLBACK_URL` | gateway | 5 | Callback URL for OAuth flows (`https://all.haus/api/linked-accounts/callback`) |

---

## XII. Migration plan

Three migration files, shipped across two phases:

**Phase 1 migrations:**

1. **`006-universal-feed-external.sql`** — New types (`external_protocol`), tables (`external_sources`, `external_subscriptions`, `external_items`), indexes, and `platform_config` inserts from §IV.1–IV.4 and §IV.9. Non-destructive: no alterations to existing tables. Does **not** include `feed_items` (Phase 2), `linked_accounts`, `outbound_posts`, or `oauth_app_registrations` (Phase 5) — Phase 1 reads from source tables directly via the three-stream merge (§VII.1).

**Phase 2 migrations (shipped when feed_items is introduced):**

2. **`007-feed-items-schema.sql`** — Creates the `feed_items` table, indexes, and constraints from §IV.5. Non-destructive.

3. **`008-backfill-feed-items.sql`** — Populates `feed_items` from existing `articles`, `notes`, and `external_items`. Idempotent via `ON CONFLICT DO NOTHING` on the unique partial indexes (`idx_feed_items_article`, `idx_feed_items_note`, `idx_feed_items_external`). Must run after `007`. **Performance requirement:** the backfill must process rows in batches (1000 per iteration) using an `id`-keyed pagination loop. Each batch should commit independently so that a failure mid-backfill doesn't discard all progress and a restart picks up where it left off. Monitor: log batch count and elapsed time. On the current dataset this should complete in seconds, but the pattern must be safe for larger datasets.

The Phase 2 gateway code changes (dual-write paths for articles/notes, edit propagation) must ship simultaneously with migration `007` — otherwise new content won't appear in the unified feed. The feed route switchover (three-stream → single-table) ships in the same deploy.

---

## XIII. Implementation phases

### Phase 1 — RSS reader + three-stream feed (the foundation)

**Scope:**
- `external_sources`, `external_subscriptions`, `external_items` tables (migration `006`)
- **No `feed_items` table** — Phase 1 uses the three-stream merge (§VII.1): articles + notes + external items, merged in application code
- Feed route extended to include external items stream alongside existing article/note queries
- `feed-ingest` service with Graphile Worker + RSS adapter only
- Universal resolver library + `POST /api/resolve` + `GET /api/resolve/:requestId` endpoints (§V.5) — the omnivorous input primitive with two-phase resolution UX (§V.5.7). Ships with URL resolution (RSS discovery), platform username lookup, npub/nprofile/hex pubkey resolution, and free-text search fallback. Bluesky handle, fediverse handle, and DID resolution chains are stubs that return "not yet supported" until Phases 3–4.
- Per-user subscription limit enforcement (`max_subscriptions_per_user`, default 200)
- Per-host ingestion rate limiting (§V.2)
- Subscribe UI backed by universal resolver (single smart input field), `ExternalCard` component, provenance badges
- Publication invite flow migrated to universal resolver — accept username, email, npub, or NIP-05 (low effort, high visibility win for the omnivorous input principle)
- Per-source error states and subscription management UI
- External items excluded from explore feed until scoring worker ships (following feed only)

**What Phase 1 deliberately omits:** The `feed_items` denormalised table, dual-write transaction paths, the backfill migration, the reconciliation job, and the author-refresh job. These are all Phase 2 concerns. Phase 1 validates the entire external content pipeline — ingestion, resolver, rendering, subscription management — without introducing the riskiest architectural change.

**Why first:** RSS is the simplest protocol — no OAuth, no outbound, no WebSocket state. The real value of Phase 1 is proving that external content works end-to-end in the feed: ingestion, rendering, subscription management, error states. If the three-stream merge proves slow or unwieldy with real usage data, that data informs the `feed_items` design in Phase 2. If it performs fine, Phase 2 remains a valuable optimisation but is no longer on the critical path.

**Estimated effort:** 2–3 weeks.

### Phase 2 — Unified timeline + external Nostr (tier 2)

**Scope:**
- `feed_items` table, indexes, constraints (migration `007`)
- Backfill migration `008` (articles + notes + external_items → feed_items)
- Gateway dual-write paths: article/note creation and edits write `feed_items` rows in the same transaction
- Feed route rewritten to single-table query (§VII.1 Phase 2 queries)
- `feed_items_reconcile` nightly job — catches transactional bugs and drift early
- `feed_items_author_refresh` nightly job — propagates metadata changes to denormalised rows
- `feed_ingest_nostr` job + external Nostr ingestion adapter
- Outbound: publish replies to external Nostr relays via key-custody
- Kind 5 deletion handling

**Why combine feed_items with Nostr?** The `feed_items` table is a pure optimisation — it doesn't unlock new user-facing features. Bundling it with external Nostr ingestion (which does unlock user-facing features) ensures the phase has visible value. Nostr ingestion is low-risk: the platform already understands Nostr events, and rendering reuses existing NoteCard/ArticleCard components. The outbound path is simple (relay publish, no API auth).

**Estimated effort:** 3–4 weeks.

### Phase 3 — Bluesky ingestion (read-only)

**Scope:**
- Jetstream listener (standalone process in feed-ingest)
- AT Protocol ingestion adapter with facet rendering
- New source cursor initialisation: cursor set to `now()`, recent history backfilled via one-time `getAuthorFeed` job (see §V.3 cursor management)
- Protocol-specific `ExternalCard` rendering (facets, embeds, media)
- Universal resolver: activate Bluesky handle resolution chain (`@handle.bsky.social`) and DID resolution chain (`did:plc:...`). Bluesky profile URL pattern (`bsky.app/profile/...`) added to URL resolver.

**What Phase 3 omits:** Bluesky OAuth and linked accounts. Jetstream is a public firehose that requires no authentication for read-only ingestion. `com.atproto.identity.resolveHandle` and DID resolution are also unauthenticated. OAuth is only needed for outbound posting, which ships in Phase 5. This keeps Phase 3 focused on the most architecturally novel component (Jetstream listener) without the complexity of credential management.

**Why third:** Jetstream is well-documented and the AT Protocol client libraries (`@atproto/api`) handle most of the complexity. Read-only means no outbound adapter, no token refresh, no credential decryption. The Jetstream listener is the most architecturally novel component and benefits from being introduced in isolation.

**Estimated effort:** 2–3 weeks.

### Phase 4 — Mastodon ingestion (read-only)

**Scope:**
- ActivityPub outbox polling adapter
- HTML content rendering in `ExternalCard`
- Per-instance error handling, user-facing health indicators, and per-instance success rate logging
- Universal resolver: activate fediverse handle resolution chain (`@user@instance.tld`), WebFinger for the ambiguous `user@domain` chain, and fediverse profile URL patterns. The `user@domain` ambiguous chain (§V.5.3) is now fully operational — email, NIP-05, and fediverse all resolve.
- UI: gate Mastodon subscriptions behind a "beta" label — outbox polling is inherently unreliable and users should have calibrated expectations

**What Phase 4 omits:** Mastodon OAuth and `oauth_app_registrations`. Outbox polling for public posts does not require authentication. OAuth is deferred to Phase 5 (outbound posting). This mirrors the Phase 3 decision for Bluesky — read-only ingestion doesn't need credential infrastructure.

**Why separate from Bluesky:** ActivityPub outbox polling is the least reliable ingestion method. Separating it from Bluesky allows shipping Bluesky support without being blocked by Mastodon instance compatibility issues. It also gives time to assess whether outbox polling delivers enough value to justify the effort, or whether to skip directly to inbox delivery. Per-instance success rate logging (instrumented from day one) provides the data needed to make that call.

**Estimated effort:** 2–3 weeks.

### Phase 5 — Outbound reply router (the piracy)

Split into two sessions to match the "one coherent commit per phase" rhythm.

**Session A (shipped):** Mastodon OAuth outbound + foundation.
- Migration 057 — `linked_accounts`, `outbound_posts`, `oauth_app_registrations` tables + `outbound_*` `platform_config` keys
- `shared/src/lib/crypto.ts` — AES-256-GCM credential encryption via `LINKED_ACCOUNT_KEY_HEX`
- Gateway `/api/v1/linked-accounts/*` — list/remove/update + Mastodon OAuth start + callback; dynamic client registration cached per instance in `oauth_app_registrations`
- `POST /notes` accepts optional `crossPost: { linkedAccountId, sourceItemId, actionType }` and calls `enqueueCrossPost` (best-effort)
- feed-ingest `outbound_cross_post` task + `activitypub-outbound` adapter — `POST /api/v1/statuses` with `Idempotency-Key`, federated reply target resolution via `/api/v2/search?resolve=true`, exponential backoff retries, terminal `status = 'failed'`
- `LinkedAccountsPanel` on `/settings` — connect/disconnect + per-account `cross_post_default` toggle; `?linked=mastodon|error` callback banner

**Session B (shipped):**
- Migration 058 — `outbound_posts.linked_account_id` nullable + `signed_event jsonb` so external-Nostr outbound rides the unified queue without an OAuth linked account
- Migration 059 — `atproto_oauth_sessions (did PK, session_data_enc)` as the DB-backed `NodeSavedSessionStore` for `@atproto/oauth-client-node`, AES-256-GCM encrypted under `LINKED_ACCOUNT_KEY_HEX`
- Cross-post toggle UI in `ExternalCard` reply/quote composer (hidden when no linked account for the item's protocol); `useLinkedAccounts` module-level cache so multiple cards share one fetch
- `shared/src/lib/atproto-oauth.ts` — singleton `NodeOAuthClient` factory, confidential client with `private_key_jwt` (ES256), PKCE + DPoP + PAR; loopback `client_id` fallback for local dev, `ATPROTO_CLIENT_BASE_URL` + `ATPROTO_PRIVATE_JWK` in prod
- Gateway `/.well-known/oauth-client-metadata.json` + `/.well-known/jwks.json` (nginx-routed to the gateway), `POST /linked-accounts/bluesky` (handle → authorize URL), `GET /linked-accounts/bluesky/callback` (session → `linked_accounts` row with `external_id = did`, `credentials_enc = NULL`)
- feed-ingest `atproto-outbound.ts` — `com.atproto.repo.createRecord` via `OAuthSession.fetchHandler`, DPoP-bound; 300-grapheme truncation via `Intl.Segmenter`; reply strong-refs (root + parent from `external_items.interaction_data`), `app.bsky.embed.record` quotes; extended `outbound_cross_post` with an atproto branch
- External Nostr outbound moved out of the inline `publishToExternalRelays` path into `enqueueNostrOutbound` → `outbound_cross_post` → `nostr-outbound.ts` WS publisher (uses `external_sources.relay_urls`); `POST /notes` signs on the client, the worker just replays
- `outbound_token_refresh` cron (every 30m) — atproto branch proactively calls `client.restore(did, 'auto')` on dormant accounts weekly so refresh tokens don't lapse; Mastodon/`credentials_enc`-based branch is a stub (Mastodon tokens don't expire)
- `LinkedAccountsPanel` gains a Bluesky handle input; `?linked=bluesky` callback banner on `/settings`

**Why last:** This is the highest-complexity, highest-trust feature. By this point, all four ingestion pipelines are battle-tested, the feed UI handles all external content types cleanly, and the outbound adapters can build on the same protocol-specific code and libraries used for ingestion. Consolidating all credential management (OAuth flows, token refresh, encrypted storage, linked account UI) into a single phase avoids scattering security-sensitive code across multiple releases. Credential management and outbound error handling are the hardest parts of the system — they benefit from the most runway.

### Future — ActivityPub inbox delivery

Not phased because it requires implementing the ActivityPub server side (inbox endpoint, HTTP signatures, WebFinger, actor representation). This is a substantial undertaking that replaces outbox polling with push-based delivery. Evaluate after Phase 4 based on the reliability and coverage of outbox polling.

---

## XIV. Relationship to existing roadmap items

| Roadmap item | Relationship |
|-------------|-------------|
| **Feed ranking algorithm** | External items participate in ranking via `feed_items.score`. The scoring worker (specced in FEED-ALGORITHM.md, not yet built) writes scores to `feed_items` instead of `feed_scores`. The `feed_scores` table can be dropped or retained as a staging table. `feed_engagement` gains `'external_click'` and `'external_reply'` engagement types. |
| **Federation + self-hosted packaging** | External Nostr ingestion (Phase 2) is the application-layer complement to relay-level federation via negentropy sync. |
| **Mostr bridge** | Mostr bridges at the protocol level (Nostr ↔ ActivityPub). The universal feed bridges at the application layer. Complementary: Mostr handles passive federation; the universal feed handles active, user-controlled cross-posting. |
| **Traffology** | The Traffology analytics pipeline can ingest `external_items` as a signal: when an external post links to an all.haus article, it registers as a referral source. The `outbound_posts` table feeds the "outbound URL search" channel in Traffology's four-channel model. |
| **Feed scoring worker** | The unbuilt scoring worker from FEED-ALGORITHM.md should target `feed_items.score` directly rather than the separate `feed_scores` table. This simplifies the explore feed query to a single-table scan with an index on `(score DESC, published_at DESC)`. |

---

## XV. Open questions

1. **Jetstream DID cardinality.** Jetstream supports filtering by DID list, but the maximum cardinality per connection is not formally documented. Testing suggests ~10,000 DIDs works. If the platform grows beyond this, the listener must partition DIDs across multiple connections. The partitioning logic should be designed from the start (even if initially there's only one partition) to avoid a rewrite later.

2. **Content moderation.** External items may contain content that violates all.haus community standards. Launch approach: mark external items as unmoderated. Users can report; reported items are hidden from all feeds pending review. Graduate to automated pre-filtering (keyword/pattern matching) as moderation tooling matures.

3. **Storage growth and pruning safety.** `external_items` and `feed_items` will grow significantly faster than native content. The 90-day retention prune handles `external_items`; the corresponding `feed_items` rows are cascade-deleted. **However, external items with user interactions (bookmarks, votes, replies) must be excluded from pruning** — otherwise bookmarks silently vanish and reply threads lose their parent context. The `external_items_prune` job must check for referencing rows in `bookmarks`, `votes`, and `notes` (via `external_reply_to`) before deleting. Items with interactions retain their metadata (author, title, source_item_uri) but may have `content_text`/`content_html` set to NULL after a longer retention window (e.g., 1 year) to reclaim storage while preserving references. Monitor table sizes monthly. Consider partitioning `feed_items` by `published_at` (range partitioning) if the table exceeds ~50M rows.

4. **Feed fatigue.** A user who subscribes to many external sources may be overwhelmed. Defences, in order: (a) per-user subscription limit (`max_subscriptions_per_user`, default 200 — enforced at subscribe time); (b) per-subscription `daily_cap` (enforced at feed query time, see §VII.1); (c) per-subscription muting. Post-launch: "digest mode" (batch external items into periodic summaries) and per-protocol volume weighting in the feed.

5. **Mastodon outbox reliability.** Outbox polling is known to be inconsistent across Mastodon instances. Phase 4 should include per-instance success rate logging. If outbox polling proves unreliable for >30% of subscribed instances, accelerate the inbox delivery future phase.

6. **Image and media proxying.** External items reference images on third-party servers. Options: (a) hotlink directly (simplest, but leaks user IPs to source servers and breaks if source removes images); (b) proxy through gateway at render time; (c) cache to local media volume at ingestion time. Recommendation: (a) for launch with CSP headers permitting external images, graduating to (b) post-launch.

7. **`feed_items` consistency (Phase 2).** The denormalised `feed_items` table can drift from its source tables if a bug skips the write or if a manual DB edit touches `articles`/`notes` without updating `feed_items`. Mitigation: the `feed_items_reconcile` nightly job (see §V.2) checks for orphaned or missing `feed_items` rows and repairs them. **This is a Phase 2 launch requirement, not a deferred nice-to-have.** The reconciliation job is how we detect transactional bugs in the dual-write path early, before they silently accumulate invisible content. It also catches manual DB edits and any edge cases in the backfill migration. In Phase 1 (three-stream merge), this problem does not exist — there is no denormalised table to drift.

---

## XVI. Security considerations

1. **Credential storage.** Linked account credentials are encrypted at rest with `LINKED_ACCOUNT_KEY_HEX`, following the same pattern as `accounts.nostr_privkey_enc`. The key is available to `feed-ingest` and the gateway; it never leaves the server.

2. **Token refresh.** OAuth tokens are short-lived. The `outbound_token_refresh` cron job runs every 30 minutes and refreshes tokens within 80% of their expiry window. If refresh fails, `linked_accounts.is_valid` is set to `FALSE` and the user sees a reconnection prompt in settings.

3. **SSRF mitigation.** The RSS and ActivityPub ingestion adapters fetch user-supplied URLs. All fetch operations must: reject private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, ::1), reject `file://`, `ftp://`, and other non-HTTP schemes, enforce a 10-second timeout, enforce a 5MB response size limit, and follow at most 3 redirects (re-validating each hop against the same rules). Use a hardened HTTP client wrapper shared across all adapters.

4. **User consent.** No data is ever posted to an external platform without explicit user action (clicking the cross-post toggle). The `cross_post_default` preference is user-controlled and initially `TRUE` only because the user explicitly linked the account.

5. **Scope of access.** All outbound OAuth integrations request minimum scopes: read statuses + write statuses. No access to DMs, follows, blocks, or account management.

6. **HTML sanitisation.** RSS and ActivityPub content arrives as HTML. All HTML content is sanitised through a strict allowlist before storage in `external_items.content_html`. The allowlist permits: `p`, `br`, `a` (with `href` and `rel="nofollow"`), `em`, `strong`, `code`, `pre`, `blockquote`, `ul`, `ol`, `li`, `img` (with `src` and `alt`). Everything else is stripped. This happens at ingestion time, not render time — the database never contains unsanitised external HTML.

---

## XVII. What this ADR does NOT cover

For clarity, these are explicitly out of scope:

- **Feed scoring worker implementation.** Specced in FEED-ALGORITHM.md. Should be updated to write to `feed_items.score` (Phase 2+) rather than `feed_scores`. Separate work item.
- **ActivityPub inbox delivery.** Server-side ActivityPub (inbox, HTTP signatures, WebFinger). Evaluated after Phase 4.
- **Nostr NIP-46 (remote signing).** For users with self-custodied keys who want outbound Nostr federation without giving all.haus their private key. Requires bunker protocol support. Deferred.
- **Full-text search of external content.** The existing `pg_trgm` search indexes native content. Extending to `external_items` is straightforward but deferred until the table is populated and search demand is clear.
- **Mobile push notifications for external content.** Per existing project decision, push notifications are deferred to the mobile app.
- **Full sitewide resolver adoption.** The universal resolver (§V.5) ships in Phase 1 and the publication invite flow is migrated immediately. Downstream adoption (DM flows, search pre-pass, DM pricing overrides, ownership transfer) is incremental and not fully specced here — each migration is a small, self-contained change that replaces a narrow input with the shared `POST /api/resolve` endpoint. See §V.5.5 for the adoption table and priority order.
