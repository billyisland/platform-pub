-- Traffology schema — writer-facing analytics for all.haus
-- Creates all tables from docs/adr/TRAFFOLOGY-MASTER-ADR-2.md Section 4.
-- Phase 2/3 tables (nostr_events, public_mentions, observations, aggregated
-- tables) are created empty now so the schema is complete from day one.

CREATE SCHEMA IF NOT EXISTS traffology;

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Pieces: thin table linking to public.articles with Traffology-specific fields
CREATE TABLE traffology.pieces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id      UUID NOT NULL UNIQUE REFERENCES public.articles(id) ON DELETE CASCADE,
  writer_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  publication_id  UUID REFERENCES public.publications(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  external_url    TEXT NOT NULL,
  word_count      INTEGER,
  nostr_event_id  TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_traf_pieces_writer ON traffology.pieces (writer_id);
CREATE INDEX idx_traf_pieces_publication ON traffology.pieces (publication_id)
  WHERE publication_id IS NOT NULL;
CREATE INDEX idx_traf_pieces_nostr ON traffology.pieces (nostr_event_id)
  WHERE nostr_event_id IS NOT NULL;

-- Sessions: append-only record of each reader visit to a piece
CREATE TABLE traffology.sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_id              UUID NOT NULL REFERENCES traffology.pieces(id) ON DELETE CASCADE,
  session_token         TEXT NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_beacon_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  referrer_url          TEXT,
  referrer_domain       TEXT,
  resolved_source_id    UUID,
  utm_source            TEXT,
  utm_medium            TEXT,
  utm_campaign          TEXT,
  country               TEXT,
  city                  TEXT,
  device_type           TEXT NOT NULL DEFAULT 'desktop'
                        CHECK (device_type IN ('desktop', 'mobile', 'tablet')),
  browser_family        TEXT,
  subscriber_status     TEXT NOT NULL DEFAULT 'anonymous'
                        CHECK (subscriber_status IN ('anonymous', 'free', 'paying')),
  scroll_depth          REAL NOT NULL DEFAULT 0.0,
  reading_time_seconds  INTEGER NOT NULL DEFAULT 0,
  is_bounce             BOOLEAN NOT NULL DEFAULT TRUE,
  ip_hash               TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_traf_sessions_dedup ON traffology.sessions (session_token, piece_id);
CREATE INDEX idx_traf_sessions_piece ON traffology.sessions (piece_id, started_at DESC);
CREATE INDEX idx_traf_sessions_started ON traffology.sessions (started_at DESC);
CREATE INDEX idx_traf_sessions_piece_last_beacon ON traffology.sessions (piece_id, last_beacon_at DESC);

-- Sources: resolved origin of traffic
CREATE TABLE traffology.sources (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  writer_id         UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  source_type       TEXT NOT NULL
                    CHECK (source_type IN ('mailing-list', 'search', 'link', 'nostr', 'direct', 'platform-internal')),
  domain            TEXT,
  display_name      TEXT NOT NULL,
  nostr_npub        TEXT,
  allhaus_writer_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_new_for_writer BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_traf_sources_writer ON traffology.sources (writer_id);
CREATE INDEX idx_traf_sources_domain ON traffology.sources (writer_id, domain)
  WHERE domain IS NOT NULL;

-- FK from sessions to sources (deferred because sources table created after sessions)
ALTER TABLE traffology.sessions
  ADD CONSTRAINT fk_sessions_source
  FOREIGN KEY (resolved_source_id) REFERENCES traffology.sources(id) ON DELETE SET NULL;

-- ============================================================================
-- EVENT STORE (Phase 2+ — created empty now)
-- ============================================================================

CREATE TABLE traffology.nostr_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              TEXT NOT NULL UNIQUE,
  piece_id              UUID NOT NULL REFERENCES traffology.pieces(id) ON DELETE CASCADE,
  event_kind            INTEGER NOT NULL,
  author_npub           TEXT NOT NULL,
  author_display_name   TEXT,
  parent_event_id       TEXT,
  relay                 TEXT NOT NULL,
  event_created_at      TIMESTAMPTZ NOT NULL,
  attributed_sessions   INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_traf_nostr_events_piece ON traffology.nostr_events (piece_id);

CREATE TABLE traffology.public_mentions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_id                UUID NOT NULL REFERENCES traffology.pieces(id) ON DELETE CASCADE,
  platform                TEXT NOT NULL
                          CHECK (platform IN ('bluesky', 'mastodon', 'reddit', 'hackernews', 'twitter', 'other')),
  post_url                TEXT NOT NULL,
  author_handle           TEXT NOT NULL,
  author_display_name     TEXT,
  post_text               TEXT,
  posted_at               TIMESTAMPTZ NOT NULL,
  engagement_count        INTEGER NOT NULL DEFAULT 0,
  comment_count           INTEGER,
  attributed_sessions     INTEGER NOT NULL DEFAULT 0,
  attribution_confidence  TEXT NOT NULL DEFAULT 'found'
                          CHECK (attribution_confidence IN ('direct', 'inferred', 'found')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_traf_mentions_piece ON traffology.public_mentions (piece_id);

-- ============================================================================
-- AGGREGATED TABLES (Phase 1 step 2 — created empty now)
-- ============================================================================

CREATE TABLE traffology.piece_stats (
  piece_id                  UUID PRIMARY KEY REFERENCES traffology.pieces(id) ON DELETE CASCADE,
  total_readers             INTEGER NOT NULL DEFAULT 0,
  readers_today             INTEGER NOT NULL DEFAULT 0,
  first_day_readers         INTEGER NOT NULL DEFAULT 0,
  unique_countries          INTEGER NOT NULL DEFAULT 0,
  avg_reading_time_seconds  INTEGER NOT NULL DEFAULT 0,
  avg_scroll_depth          REAL NOT NULL DEFAULT 0.0,
  open_rate                 REAL,
  rank_this_year            INTEGER,
  rank_all_time             INTEGER,
  top_source_id             UUID REFERENCES traffology.sources(id) ON DELETE SET NULL,
  top_source_pct            REAL,
  free_conversions          INTEGER NOT NULL DEFAULT 0,
  paid_conversions          INTEGER NOT NULL DEFAULT 0,
  last_reader_at            TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE traffology.source_stats (
  piece_id                  UUID NOT NULL REFERENCES traffology.pieces(id) ON DELETE CASCADE,
  source_id                 UUID NOT NULL REFERENCES traffology.sources(id) ON DELETE CASCADE,
  reader_count              INTEGER NOT NULL DEFAULT 0,
  pct_of_total              REAL NOT NULL DEFAULT 0.0,
  first_reader_at           TIMESTAMPTZ,
  last_reader_at            TIMESTAMPTZ,
  avg_reading_time_seconds  INTEGER NOT NULL DEFAULT 0,
  avg_scroll_depth          REAL NOT NULL DEFAULT 0.0,
  bounce_rate               REAL NOT NULL DEFAULT 0.0,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (piece_id, source_id)
);

CREATE TABLE traffology.half_day_buckets (
  piece_id      UUID NOT NULL REFERENCES traffology.pieces(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES traffology.sources(id) ON DELETE CASCADE,
  bucket_start  TIMESTAMPTZ NOT NULL,
  is_day        BOOLEAN NOT NULL,
  reader_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (piece_id, source_id, bucket_start)
);

CREATE TABLE traffology.writer_baselines (
  writer_id                   UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  mean_first_day_readers      REAL NOT NULL DEFAULT 0.0,
  stddev_first_day_readers    REAL NOT NULL DEFAULT 0.0,
  mean_reading_time           REAL NOT NULL DEFAULT 0.0,
  mean_open_rate              REAL NOT NULL DEFAULT 0.0,
  mean_piece_lifespan_days    REAL NOT NULL DEFAULT 0.0,
  total_free_subscribers      INTEGER NOT NULL DEFAULT 0,
  total_paying_subscribers    INTEGER NOT NULL DEFAULT 0,
  monthly_revenue             NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE traffology.publication_baselines (
  publication_id              UUID PRIMARY KEY REFERENCES public.publications(id) ON DELETE CASCADE,
  mean_first_day_readers      REAL NOT NULL DEFAULT 0.0,
  stddev_first_day_readers    REAL NOT NULL DEFAULT 0.0,
  mean_reading_time           REAL NOT NULL DEFAULT 0.0,
  mean_open_rate              REAL NOT NULL DEFAULT 0.0,
  writer_count                INTEGER NOT NULL DEFAULT 0,
  total_readers_this_month    INTEGER NOT NULL DEFAULT 0,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE traffology.topic_performance (
  writer_id           UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  topic               TEXT NOT NULL,
  piece_count         INTEGER NOT NULL DEFAULT 0,
  mean_readers        REAL NOT NULL DEFAULT 0.0,
  mean_reading_time   REAL NOT NULL DEFAULT 0.0,
  mean_search_readers REAL NOT NULL DEFAULT 0.0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (writer_id, topic)
);

-- ============================================================================
-- OBSERVATION STORE (Phase 1 step 3 — created empty now)
-- ============================================================================

CREATE TABLE traffology.observations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  writer_id         UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  piece_id          UUID REFERENCES traffology.pieces(id) ON DELETE CASCADE,
  observation_type  TEXT NOT NULL,
  priority          INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
  values            JSONB NOT NULL DEFAULT '{}',
  suppressed        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_traf_observations_writer ON traffology.observations (writer_id, created_at DESC);
CREATE INDEX idx_traf_observations_piece ON traffology.observations (piece_id, created_at DESC)
  WHERE piece_id IS NOT NULL;
CREATE INDEX idx_traf_observations_type ON traffology.observations (observation_type, created_at DESC);
