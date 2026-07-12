-- FOLLOW-GRAPH-IMPORT-ADR §11.5 — Phase 2 "Sync now".
--
-- A sync is a follow_imports run of kind='sync' against an import-bound feed:
-- POST /follow-imports/sync re-reads the remote graph, diffs (remote graph −
-- exclusions) against current same-protocol membership, and persists the plan
-- as a status='preview' row — adds in `identities`, removals in `removals` —
-- which the user confirms into 'pending' (or cancels; abandoned previews are
-- GC'd by the sweep after a day). The engine applies removals BEFORE adds,
-- each side cursored, so a mid-run restart resumes deterministically (the
-- §6.2 discipline extended to the removal half).

ALTER TABLE follow_imports
    ADD COLUMN kind text NOT NULL DEFAULT 'import'
        CHECK (kind IN ('import', 'sync')),
    ADD COLUMN removals jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN removal_cursor integer NOT NULL DEFAULT 0,
    ADD COLUMN removed integer NOT NULL DEFAULT 0;

-- 'preview' — a sync plan awaiting user confirmation. Never claimed by the
-- sweep (whose claim still selects pending/running only).
ALTER TABLE follow_imports DROP CONSTRAINT follow_imports_status_check;
ALTER TABLE follow_imports ADD CONSTRAINT follow_imports_status_check
    CHECK (status IN ('pending', 'running', 'done', 'failed', 'preview'));

-- Recreate the unfinished partial index to cover previews too, so both the
-- sweep's claim scan (pending/running) and its stale-preview GC stay cheap.
DROP INDEX idx_follow_imports_unfinished;
CREATE INDEX idx_follow_imports_unfinished
    ON follow_imports (created_at)
    WHERE status IN ('pending', 'running', 'preview');
