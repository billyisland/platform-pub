-- =============================================================================
-- config-defaults.sql — the canonical default value of every platform_config
-- tuning dial. Applied by shared/src/db/migrate.ts on EVERY run, after the
-- migration chain, always with ON CONFLICT (key) DO NOTHING.
--
-- WHY THIS FILE EXISTS
--
-- Dials used to be seeded by the migration that introduced them. That silently
-- did not work on a fresh database. schema.sql is the genesis base and is
-- STRUCTURE ONLY (pg_dump, no data) — but it also seeds `_migrations` with every
-- migration filename, so migrate.ts skips those migrations as already-applied
-- and their INSERTs never run. Any dial seeded by a migration older than the
-- current genesis dump was therefore simply absent on every DB booted from
-- schema.sql. Measured on dev 2026-07-20: 31 of 45 dials missing.
--
-- Mostly that was masked, because each consumer carries a code fallback equal to
-- the seeded value — but "masked" is not "harmless": it demotes an operator dial
-- to a code constant (an UPDATE on a missing row changes nothing and reports no
-- error), and it was NOT harmless for `jetstream_healthy`, whose writer is an
-- UPDATE that matched zero rows, so the Jetstream listener could never record
-- itself unhealthy and the atproto polling fallback never engaged.
--
-- THE RULE (CLAUDE.md, tuning-dial section)
--
--   A migration must NOT seed platform_config. New dials go HERE.
--
-- CI-enforced by scripts/check-schema-drift.sh Check 4, which allowlists exactly
-- the 11 historical migrations below (migrations are immutable, so that set is
-- closed forever) and rejects an INSERT INTO platform_config in any other one.
--
-- ON CONFLICT (key) DO NOTHING is load-bearing on every statement: this file is
-- re-applied on every migrate run, so it seeds a missing default and must NEVER
-- overwrite a value an operator has tuned.
--
-- NOT here, deliberately: runtime STATE that happens to live in this table.
-- `payouts_halted` means "halted" by its presence and is DELETEd to resume
-- (payment-service/src/lib/payout-halt.ts) — a seeded default would fight the
-- resume path. Absence is its meaning; only tuning dials belong in this file.
--
-- The blocks below are the historical seeds, verbatim from the migration that
-- introduced each, in chronological order.
-- =============================================================================

-- from 033_admin_account_ids_config.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('admin_account_ids', '', 'Comma-separated account UUIDs with admin access')
ON CONFLICT (key) DO NOTHING;

-- from 035_feed_scores.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('feed_gravity',              '1.5', 'Time-decay exponent for feed scoring (HN-style)'),
  ('feed_weight_reaction',      '1',   'Score weight for reactions'),
  ('feed_weight_reply',         '2',   'Score weight for replies'),
  ('feed_weight_quote_comment', '3',   'Score weight for quote comments'),
  ('feed_weight_gate_pass',     '5',   'Score weight for gate passes (paid reads)')
ON CONFLICT (key) DO NOTHING;

-- from 038_publications.sql  -- ON CONFLICT added here: the original migration had none
INSERT INTO platform_config (key, value, description) VALUES
  ('publication_payout_threshold_pence', '2000', 'Publication payout threshold (£20.00)')
ON CONFLICT (key) DO NOTHING;

-- from 052_universal_feed_external.sql  -- ON CONFLICT added here: the original migration had none
INSERT INTO platform_config (key, value, description) VALUES
  ('feed_ingest_rss_interval_seconds',     '300',  'Default RSS polling interval (5 min)'),
  ('feed_ingest_rss_min_interval_seconds', '60',   'Minimum RSS polling interval'),
  ('feed_ingest_ap_interval_seconds',      '120',  'Default ActivityPub outbox polling interval'),
  ('feed_ingest_max_items_per_fetch',      '50',   'Max items to ingest per poll cycle'),
  ('feed_ingest_error_backoff_factor',     '2',    'Exponential backoff multiplier on fetch errors'),
  ('feed_ingest_max_error_count',          '10',   'Deactivate source after N consecutive errors'),
  ('feed_ingest_daily_cap_default',        '100',  'Default max items/day per source (safety valve)'),
  ('feed_ingest_max_per_host',             '2',    'Max concurrent fetch jobs per hostname'),
  ('feed_ingest_max_concurrent',           '10',   'Global max concurrent fetch jobs'),
  ('outbound_max_retries',                 '3',    'Max retry attempts for outbound cross-posts'),
  ('outbound_retry_delay_seconds',         '30',   'Base delay between outbound retries'),
  ('external_items_retention_days',        '90',   'Days to retain external items before pruning'),
  ('max_subscriptions_per_user',           '200',  'Max external source subscriptions per user')
ON CONFLICT (key) DO NOTHING;

-- from 055_universal_feed_atproto.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('jetstream_healthy',                'true',
    'Set by the Jetstream listener. When false, feed_ingest_poll schedules getAuthorFeed fallback jobs for atproto sources.'),
  ('feed_ingest_atproto_backfill_hours', '24',
    'Lookback window for the one-time atproto backfill job when a new Bluesky source is subscribed to.'),
  ('feed_ingest_atproto_reconnect_max_seconds', '30',
    'Maximum exponential backoff delay (seconds) between Jetstream reconnection attempts.')
ON CONFLICT (key) DO NOTHING;

-- from 056_universal_feed_activitypub.sql
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

-- from 057_universal_feed_outbound.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('outbound_token_refresh_window_pct', '80',
    'Refresh OAuth tokens once elapsed lifetime exceeds this percent of expiry'),
  ('outbound_bluesky_max_graphemes',    '300',
    'Bluesky post graph­eme limit; replies longer are truncated with an all.haus link'),
  ('outbound_mastodon_max_chars',       '500',
    'Default Mastodon status length; replies longer are truncated with an all.haus link')
ON CONFLICT (key) DO NOTHING;

-- from 106_feed_ingest_enqueue_cap.sql
INSERT INTO platform_config (key, value, description)
VALUES (
  'feed_ingest_max_enqueue_per_tick',
  '100',
  'Max sources enqueued per poll tick (decoupled from runner concurrency; = source SELECT LIMIT)'
)
ON CONFLICT (key) DO NOTHING;

-- from 158_resonance_baselines.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('resonance_weight_like',           '1', 'Resonance E weight: external like/reaction/favourite'),
  ('resonance_weight_reply',          '3', 'Resonance E weight: reply (all protocols)'),
  ('resonance_weight_repost',         '2', 'Resonance E weight: external repost/boost'),
  ('resonance_weight_zap',            '4', 'Resonance E weight: nostr zap count (reserved; inert until zap ingestion)'),
  ('resonance_weight_native_up',      '5', 'Resonance E weight: native up-vote (free, capped one per voter/target/direction — see migration header)'),
  ('resonance_weight_native_gate',    '5', 'Resonance E weight: native gate pass (paid read)'),
  ('resonance_weight_native_repost',  '2', 'Resonance E weight: native repost (inert until native repost recording lands)'),
  ('resonance_shrink_k',              '3', 'Baseline shrinkage toward ambient: baseline=(n*median+k*p50)/(n+k)'),
  ('feed_alpha_following',            '0.8', 'D6 proof blend on following surfaces: alpha*resonance + (1-alpha)*ambient percentile'),
  ('feed_alpha_explore',              '0.4', 'D6 proof blend on explore surfaces')
ON CONFLICT (key) DO NOTHING;

-- from 160_resonance_band_thresholds.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('resonance_band1_min', '2.5', 'Resonance gate for band 1 "noticed" (also requires E >= ambient p50)'),
  ('resonance_band2_min', '4',   'Resonance gate for band 2 "resonant" (also requires E >= ambient p50)'),
  ('resonance_band3_min', '6',   'Resonance gate for band 3 "surging" (also requires E >= ambient p90)')
ON CONFLICT (key) DO NOTHING;

-- from 161_feed_proof_floor.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('feed_proof_floor', '0.05', 'D6 read-time blend: floor under proof_term so zero-proof items still order by recency instead of collapsing to a constant (see migration header)')
ON CONFLICT (key) DO NOTHING;
