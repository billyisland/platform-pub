-- FOLLOW-GRAPH-IMPORT-ADR §11.2 — follow-graph import job + binding tables.
--
-- follow_imports: one row per import run. `identities` holds the resolved
-- remote graph (with display metadata) captured once at POST time, and
-- `cursor` the next unprocessed index — together they make the gateway sweep
-- restartable without re-reading the remote graph (§6.2 amendment). Counters
-- are progress UI; per-source failures never fail the run.
--
-- feed_import_bindings: the origin binding a "Sync now" (Phase 2) re-reads.
-- Written from Phase 1 so pre-Phase-2 imports are sync-capable retroactively.
--
-- feed_import_exclusions: local removals from a bound feed, recorded by
-- removeSource AND the move handler (§6.3) so re-sync never resurrects a
-- source the user deliberately removed here. Deleting the feed cascades all
-- three tables' rows (follow_imports intentionally loses its run history with
-- the feed — the run row is that feed's progress/summary surface).

CREATE TABLE follow_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    protocol external_protocol NOT NULL,
    origin_identity text NOT NULL,
    feed_id uuid NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'done', 'failed')),
    total integer NOT NULL DEFAULT 0,
    imported integer NOT NULL DEFAULT 0,
    skipped integer NOT NULL DEFAULT 0,
    failed integer NOT NULL DEFAULT 0,
    identities jsonb NOT NULL DEFAULT '[]'::jsonb,
    cursor integer NOT NULL DEFAULT 0,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

-- The sweep claims the oldest unfinished run; the partial index keeps that
-- scan cheap once done/failed history accumulates.
CREATE INDEX idx_follow_imports_unfinished
    ON follow_imports (created_at)
    WHERE status IN ('pending', 'running');

CREATE INDEX idx_follow_imports_account
    ON follow_imports (account_id, created_at DESC);

CREATE TABLE feed_import_bindings (
    feed_id uuid PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
    protocol external_protocol NOT NULL,
    origin_identity text NOT NULL,
    last_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feed_import_exclusions (
    feed_id uuid NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    protocol external_protocol NOT NULL,
    identity text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (feed_id, protocol, identity)
);
