-- scripts/cleanup-orphaned-drafts.sql
--
-- One-time prod cleanup for the duplicate-draft bug fixed 2026-07-08
-- (FIX-PROGRAMME 2026-07-08; migration 149). Before the fix, a new article's
-- draft could be duplicated by a debounced autosave racing an explicit Save;
-- publish/schedule then disposed of ONE twin and left the other — a draft
-- shadowing a now-live article in the writer's dashboard. The code fix stops
-- new duplicates; it does NOT retroactively remove the ones already stranded.
-- This script finds and (opt-in) removes them.
--
-- DRY RUN by default — it only reports. To actually delete the high-confidence
-- set, pass -v apply=true. Either way it runs inside one transaction.
--
--   Dry run (report only, no writes):
--     psql "$DATABASE_URL" -f scripts/cleanup-orphaned-drafts.sql
--     docker exec -i <postgres> psql -U platformpub -d platformpub \
--       -f - < scripts/cleanup-orphaned-drafts.sql
--
--   Apply the deletion (Tier 1 only):
--     psql "$DATABASE_URL" -v apply=true -f scripts/cleanup-orphaned-drafts.sql
--
-- What counts as an orphaned twin (all must hold):
--   * the draft is UNTAGGED (nostr_d_tag IS NULL) — the bug lived only in the
--     new-article path; edits of a published article carry a dTag and are never
--     touched here;
--   * it is NOT scheduled (scheduled_at IS NULL) — a scheduled draft is live
--     work, never swept;
--   * a non-deleted article by the SAME writer has the SAME (non-empty) title.
--
-- Confidence tiers:
--   * TIER 1 (auto-deletable with -v apply=true): the draft's body, once the
--     paywall marker is stripped and whitespace trimmed, is BYTE-IDENTICAL to
--     the live article's content_free and non-empty. That is a near-certain
--     leftover twin (same untagged body, same title, article already published).
--     Note: paywalled articles store only the FREE portion in content_free, so
--     their drafts will NOT be byte-identical and correctly fall to Tier 2.
--   * TIER 2 (report only, NEVER auto-deleted): title matches but the body
--     differs (or the article is paywalled) — could be a legitimately separate
--     draft. Eyeball these and delete by id if they are genuine duplicates.
--   * DRIVE-LINKED (report only, NEVER auto-deleted): the draft is referenced
--     by a pledge_drives row — left alone regardless of tier.
--
-- The marker constant mirrors PAYWALL_GATE_MARKER in the editor / scheduler.

\set ON_ERROR_STOP on

-- Default the gate to false unless the caller passed -v apply=true.
SELECT NOT :{?apply} AS "_need_apply_default" \gset
\if :_need_apply_default
  \set apply false
\endif

BEGIN;

-- Candidate set: every untagged, unscheduled draft that shadows a live
-- same-title article by the same writer, annotated with the match tier and
-- whether a pledge drive references it. One row per draft (a draft matching
-- several same-title articles collapses via the aggregates).
CREATE TEMP TABLE _orphan_candidates ON COMMIT DROP AS
WITH marker AS (SELECT '<!-- paywall-gate -->'::text AS m)
SELECT
  d.id                                   AS draft_id,
  d.writer_id,
  d.title,
  d.auto_saved_at,
  d.created_at                           AS draft_created_at,
  length(btrim(d.content_raw))           AS draft_body_len,
  bool_or(
    d.content_raw IS NOT NULL
    AND length(btrim(replace(d.content_raw, marker.m, ''))) > 0
    AND btrim(replace(d.content_raw, marker.m, '')) = btrim(a.content_free)
  )                                      AS content_exact_match,
  min(a.published_at)                    AS article_published_at,
  count(DISTINCT a.id)                   AS matching_articles,
  min(a.id::text)                        AS sample_article_id,
  EXISTS (SELECT 1 FROM pledge_drives pd WHERE pd.draft_id = d.id) AS drive_linked
FROM article_drafts d
CROSS JOIN marker
JOIN articles a
  ON a.writer_id = d.writer_id
 AND a.deleted_at IS NULL
 AND a.title = d.title
WHERE d.nostr_d_tag IS NULL
  AND d.scheduled_at IS NULL
  AND d.title IS NOT NULL
  AND btrim(d.title) <> ''
GROUP BY d.id, d.writer_id, d.title, d.auto_saved_at, d.created_at, d.content_raw, marker.m;

\echo ''
\echo '==================================================================='
\echo 'Orphaned-draft candidates (untagged, unscheduled, shadowing a live'
\echo 'same-title article by the same writer)'
\echo '==================================================================='

SELECT
  CASE
    WHEN drive_linked          THEN 'DRIVE-LINKED (manual)'
    WHEN content_exact_match   THEN 'TIER 1 (auto)'
    ELSE                            'TIER 2 (manual)'
  END                       AS tier,
  draft_id,
  writer_id,
  left(title, 60)           AS title,
  draft_body_len,
  matching_articles,
  sample_article_id,
  auto_saved_at,
  article_published_at
FROM _orphan_candidates
ORDER BY drive_linked DESC, content_exact_match DESC, writer_id, auto_saved_at;

\echo ''
\echo '-- Summary by tier --'
SELECT
  count(*) FILTER (WHERE content_exact_match AND NOT drive_linked)      AS tier1_auto_deletable,
  count(*) FILTER (WHERE NOT content_exact_match AND NOT drive_linked)  AS tier2_manual_review,
  count(*) FILTER (WHERE drive_linked)                                  AS drive_linked_manual,
  count(*)                                                              AS total_candidates
FROM _orphan_candidates;

-- The set this script is willing to delete automatically.
CREATE TEMP TABLE _to_delete ON COMMIT DROP AS
SELECT draft_id FROM _orphan_candidates
WHERE content_exact_match AND NOT drive_linked;

\if :apply
  \echo ''
  \echo '>>> apply=true — deleting TIER 1 (exact-content, non-drive) drafts...'
  DELETE FROM article_drafts WHERE id IN (SELECT draft_id FROM _to_delete);
  \echo '>>> deleted (row count above). Committing.'
  COMMIT;
  \echo '>>> done.'
\else
  \echo ''
  \echo '>>> DRY RUN (no -v apply=true) — nothing deleted.'
  \echo '>>> Re-run with:  -v apply=true  to remove the TIER 1 set above.'
  \echo '>>> TIER 2 and DRIVE-LINKED rows are never auto-deleted; review by hand.'
  ROLLBACK;
\endif
