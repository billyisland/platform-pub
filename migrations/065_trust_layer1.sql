-- Migration 065: Trust Layer 1 — precomputed trust signals
--
-- Stores per-user Layer 1 signals computed by a daily feed-ingest cron job.
-- pip_status is the three-state trust pip: 'known', 'partial', 'unknown'.
-- See docs/adr/ALLHAUS-OMNIBUS.md §III.7 for pip thresholds, §IV.3 for schema.

CREATE TABLE trust_layer1 (
    user_id              UUID PRIMARY KEY REFERENCES accounts(id),
    account_age_days     INTEGER NOT NULL DEFAULT 0,
    paying_reader_count  INTEGER NOT NULL DEFAULT 0,
    article_count        INTEGER NOT NULL DEFAULT 0,
    payment_verified     BOOLEAN NOT NULL DEFAULT FALSE,
    nip05_verified       BOOLEAN NOT NULL DEFAULT FALSE,
    pip_status           TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (pip_status IN ('known', 'partial', 'unknown')),
    computed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed every existing account so the feed JOIN never misses
INSERT INTO trust_layer1 (user_id)
SELECT id FROM accounts;
