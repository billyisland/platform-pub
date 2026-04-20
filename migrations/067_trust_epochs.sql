-- Migration 067: Trust Phase 4 — epoch tracking for aggregation and decay
--
-- trust_epochs: audit log of aggregation runs (full quarterly + Mon/Thu mop-ups).
-- vouches columns: track per-vouch freshness for decay computation.
-- See docs/adr/ALLHAUS-OMNIBUS.md §II.8 for decay tables, §IV.7 Build Phase 4.

CREATE TABLE trust_epochs (
    epoch_id    TEXT PRIMARY KEY,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    type        TEXT NOT NULL CHECK (type IN ('full', 'mopup'))
);

-- Per-vouch freshness tracking for decay
ALTER TABLE vouches ADD COLUMN last_reaffirmed_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE vouches ADD COLUMN epochs_since_reaffirm INTEGER NOT NULL DEFAULT 0;
