-- =============================================================================
-- 056: Universal Feed — ActivityPub / Mastodon ingestion config
--
-- Phase 4 of the Universal Feed ADR. Outbox-polling adapter + WebFinger
-- resolution. No schema changes — the pipeline reuses external_sources,
-- external_items and feed_items. This migration:
--   - Seeds tuning parameters specific to activitypub.
--   - Adds a per-instance health/success-rate table so the admin UI and the
--     poll task can see which instances are problematic. ADR §XII.5 calls for
--     this logging from day one; if outbox polling proves unreliable for
--     >30% of subscribed instances, the inbox-delivery future phase is
--     accelerated.
-- =============================================================================

INSERT INTO platform_config (key, value, description) VALUES
  ('feed_ingest_ap_page_limit',           '20',
    'Max outbox pages to paginate per poll (stops early on a known cursor).'),
  ('feed_ingest_ap_items_per_page',       '20',
    'Desired items per outbox page request (instance may ignore).'),
  ('feed_ingest_ap_backfill_hours',       '24',
    'Lookback window for the initial outbox backfill on new subscription.'),
  ('feed_ingest_ap_default_interval',     '300',
    'Default per-source outbox polling interval (seconds).')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- activitypub_instance_health — per-instance success/failure tallies
--
-- Updated on every outbox poll. Exposes `success_rate` so admins can spot
-- instances that need backoff or manual intervention, and informs the
-- ADR's "30% failure → accelerate inbox delivery" threshold.
-- =============================================================================

CREATE TABLE activitypub_instance_health (
  host            TEXT PRIMARY KEY,
  success_count   BIGINT NOT NULL DEFAULT 0,
  failure_count   BIGINT NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ap_instance_health_updated ON activitypub_instance_health(updated_at DESC);
