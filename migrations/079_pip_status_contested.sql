-- =============================================================================
-- 079: trust_layer1.pip_status gains 'contested' — workspace experiment slice 17
--
-- Slice 12 introduced the pip panel; slice 15 added three-question polls; slice
-- 17 composes both into a four-state pip. The fourth state — `contested` — is
-- a real negative signal (≥3 humanity-no responses with ≤0.3 yes-share, or the
-- same on good_faith). The CHECK constraint added in migration 065 only
-- allowed three states; this migration extends it.
--
-- Composition logic lives in feed-ingest/src/lib/trust-pip.ts (a pure
-- function). The daily trust_layer1_refresh cron now reads trust_polls
-- aggregates and writes the composed status into trust_layer1.pip_status —
-- gateway and frontend code paths reading the column don't change.
-- =============================================================================

ALTER TABLE trust_layer1
  DROP CONSTRAINT IF EXISTS trust_layer1_pip_status_check;

ALTER TABLE trust_layer1
  ADD CONSTRAINT trust_layer1_pip_status_check
    CHECK (pip_status IN ('known', 'partial', 'unknown', 'contested'));
