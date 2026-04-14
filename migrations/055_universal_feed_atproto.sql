-- =============================================================================
-- 055: Universal Feed — Bluesky / AT Protocol ingestion config
--
-- Phase 3 of the Universal Feed ADR. Jetstream listener + atproto ingestion
-- adapter config. No schema changes — the pipeline reuses external_sources,
-- external_items and feed_items from earlier phases. This migration only
-- seeds tuning parameters and the health flag the poll fallback checks.
-- =============================================================================

INSERT INTO platform_config (key, value, description) VALUES
  ('jetstream_healthy',                'true',
    'Set by the Jetstream listener. When false, feed_ingest_poll schedules getAuthorFeed fallback jobs for atproto sources.'),
  ('feed_ingest_atproto_backfill_hours', '24',
    'Lookback window for the one-time atproto backfill job when a new Bluesky source is subscribed to.'),
  ('feed_ingest_atproto_reconnect_max_seconds', '30',
    'Maximum exponential backoff delay (seconds) between Jetstream reconnection attempts.')
ON CONFLICT (key) DO NOTHING;
