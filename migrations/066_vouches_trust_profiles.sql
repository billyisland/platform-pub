-- Migration 066: Trust Phase 2 — vouches + trust_profiles
--
-- vouches: per-attestor/subject/dimension endorsements with public/aggregate visibility.
-- trust_profiles: precomputed dimension scores (populated by Phase 4 epoch aggregation cron).
-- See docs/adr/ALLHAUS-OMNIBUS.md §IV.3 for schema spec.

CREATE TABLE vouches (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attestor_id   UUID NOT NULL REFERENCES accounts(id),
    subject_id    UUID NOT NULL REFERENCES accounts(id),
    dimension     TEXT NOT NULL CHECK (dimension IN ('humanity', 'encounter', 'identity', 'integrity')),
    value         TEXT NOT NULL CHECK (value IN ('affirm', 'contest')),
    visibility    TEXT NOT NULL CHECK (visibility IN ('public', 'aggregate')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    withdrawn_at  TIMESTAMPTZ,
    UNIQUE (attestor_id, subject_id, dimension),
    CHECK (attestor_id != subject_id),
    -- contests can only be aggregate (no public negative endorsements)
    CHECK (value != 'contest' OR visibility = 'aggregate')
);

CREATE INDEX idx_vouches_subject ON vouches(subject_id) WHERE withdrawn_at IS NULL;
CREATE INDEX idx_vouches_attestor ON vouches(attestor_id) WHERE withdrawn_at IS NULL;
CREATE INDEX idx_vouches_public ON vouches(subject_id, dimension)
    WHERE visibility = 'public' AND withdrawn_at IS NULL;

CREATE TABLE trust_profiles (
    user_id           UUID NOT NULL REFERENCES accounts(id),
    dimension         TEXT NOT NULL CHECK (dimension IN ('humanity', 'encounter', 'identity', 'integrity')),
    score             NUMERIC NOT NULL DEFAULT 0,
    attestation_count INTEGER NOT NULL DEFAULT 0,
    epoch             TEXT NOT NULL DEFAULT 'pre-epoch',
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, dimension)
);
