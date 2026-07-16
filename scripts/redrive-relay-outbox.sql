-- scripts/redrive-relay-outbox.sql
--
-- One-time redrive of the relay_outbox queue after the C1 SSRF-pin fix
-- (feed-ingest could not reach ws://strfry:7777 because the pin rejected its
-- private compose address, so every native publish since ~2026-05-16 retried to
-- max_attempts and flipped to status='abandoned').
--
-- Run diagnostic-only first (default), inspect, then re-run with -v apply=true:
--   docker exec -i <postgres> psql -U platformpub -d platformpub -f - < scripts/redrive-relay-outbox.sql
--   docker exec -i <postgres> psql -U platformpub -d platformpub -v apply=true -f - < scripts/redrive-relay-outbox.sql
--   (or: psql "$DATABASE_URL" [-v apply=true] -f scripts/redrive-relay-outbox.sql)
--
-- ─── WHY THIS IS NOT A PLAIN "abandoned -> pending" FLIP ───────────────────────
-- relay_outbox rows store the FULLY-SIGNED event. Account-deletion rows enqueued
-- before the H3 fix have the email address baked into the kind-5 `a` coordinate
-- (`30023:<email>:<d_tag>` instead of `30023:<pubkey>:<d_tag>`); the H3 code fix
-- only corrects NEW enqueues. Redriving those rows would publish the email leak
-- to the relay + any PUBLIC_FANOUT_RELAY_URLS. So PHASE 2 PURGES the poisoned
-- rows (identified by an `@` in an `a`-tag coordinate) BEFORE PHASE 3 redrives
-- the rest. Dropping them is safe: a deletion event that never reached the relay
-- (and whose original 30023 almost certainly never did either, since publishing
-- was broken) has nothing to tombstone.
--
-- ─── CAVEAT: STALE EVENTS CANNOT BE REDRIVEN THROUGH THE RELAY ─────────────────
-- A redriven row re-publishes its ORIGINAL signed event, and a Nostr signature
-- covers `created_at`. strfry refuses events whose created_at is outside its
-- accepted window (observed on prod 2026-07-16: `dockurr/strfry:latest` rejected
-- every 1–5-week-old event with "invalid: created_at too early", even though the
-- repo strfry.conf sets rejectEventsOlderThanSeconds = 0 — the image applies an
-- older-than default regardless). So after a long outage the redrive proves the
-- transport works but the stale rows land in status='failed' and eventually
-- re-abandon; they cannot be freshened without RE-SIGNING (custodial key). To
-- actually get the stuck-but-valid content onto the relay, IMPORT the signed
-- events directly (bypasses the write-policy timestamp check):
--   docker exec -i <postgres> psql -U platformpub -d platformpub -tAc \
--     "SELECT signed_event FROM relay_outbox WHERE status IN ('failed','abandoned')" \
--   | docker exec -i <strfry> /app/strfry --config=/etc/strfry.conf import --show-rejected
--   docker exec -i <postgres> psql -U platformpub -d platformpub -c \
--     "UPDATE relay_outbox SET status='sent', sent_at=now() WHERE status IN ('failed','abandoned')"
-- strfry applies replaceable (d-tag) + kind-5 deletion semantics on import, so a
-- stale article version is correctly dropped if a newer one is already live, and
-- an article_deletion tombstone applies — exclude it with
-- `AND entity_type <> 'article_deletion'` if you don't want to replay a delete.
-- ------------------------------------------------------------------------------

-- Default to a dry run unless the operator passed -v apply=true.
\if :{?apply}
\else
  \set apply false
\endif

\echo '==================================================================='
\echo 'PHASE 1 — diagnostics (read-only)'
\echo '==================================================================='

\echo '-- 1a: queue breakdown by status x entity_type --'
SELECT status, entity_type, count(*)
FROM relay_outbox
GROUP BY status, entity_type
ORDER BY status, entity_type;

\echo '-- 1b: email-poisoned rows (H3) — kind-5 `a` coordinate carrying an email --'
SELECT status, count(*) AS poisoned_rows
FROM relay_outbox
WHERE entity_type = 'article_deletion'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(signed_event -> 'tags') AS tag
    WHERE tag->>0 = 'a' AND tag->>1 LIKE '%@%'
  )
GROUP BY status
ORDER BY status;

\echo '-- 1c: rows that PHASE 3 would redrive (abandoned/failed, excl. poisoned) --'
SELECT entity_type, count(*) AS would_redrive
FROM relay_outbox
WHERE status IN ('abandoned', 'failed')
  AND NOT (
    entity_type = 'article_deletion'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(signed_event -> 'tags') AS tag
      WHERE tag->>0 = 'a' AND tag->>1 LIKE '%@%'
    )
  )
GROUP BY entity_type
ORDER BY entity_type;

\if :apply

\echo '==================================================================='
\echo 'PHASE 2 — PURGE email-poisoned rows (DESTRUCTIVE)'
\echo '==================================================================='

BEGIN;

DELETE FROM relay_outbox
WHERE entity_type = 'article_deletion'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(signed_event -> 'tags') AS tag
    WHERE tag->>0 = 'a' AND tag->>1 LIKE '%@%'
  );

\echo '-- rows purged: --'
-- (row count is reported by the DELETE above; the commit finalises it)
COMMIT;

\echo '==================================================================='
\echo 'PHASE 3 — REDRIVE abandoned/failed rows'
\echo '==================================================================='

BEGIN;

-- Reset to a fresh, immediately-due retry budget. The poisoned rows are gone
-- (PHASE 2), but the predicate re-excludes them defensively in case PHASE 2 was
-- skipped or a new poisoned row slipped in.
UPDATE relay_outbox
SET status = 'pending',
    attempts = 0,
    next_attempt_at = now(),
    last_error = NULL
WHERE status IN ('abandoned', 'failed')
  AND NOT (
    entity_type = 'article_deletion'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(signed_event -> 'tags') AS tag
      WHERE tag->>0 = 'a' AND tag->>1 LIKE '%@%'
    )
  );

\echo '-- rows redriven (reset to pending): --'
COMMIT;

\echo '-- post-redrive queue breakdown --'
SELECT status, entity_type, count(*)
FROM relay_outbox
GROUP BY status, entity_type
ORDER BY status, entity_type;

\else
\echo ''
\echo '*** DRY RUN — no changes made. Re-run with  -v apply=true  to purge + redrive. ***'
\endif
