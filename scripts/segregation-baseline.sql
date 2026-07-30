-- =============================================================================
-- scripts/segregation-baseline.sql
--
-- Funds segregation §5 step 0 — the PRODUCTION baseline readings.
-- Spec: docs/adr/FUNDS-SEGREGATION-INTEGRATION.md §3.3d, §5 step 0, §7.2, §7.5.
--
-- These produce the two numbers the design consumed as placeholders:
--
--   Query A  → allocated_residual_alert_bps   (ships at 2000, an explicit
--                                              placeholder that WILL fire)
--   Query B  → payout_max_slices              (ships at 20, a guess)
--   Query C  → the connected-account id list for the §7.5 country check
--
-- STRICTLY READ-ONLY. No INSERT/UPDATE/DELETE anywhere in this file; safe to run
-- against live production during business hours. Every query is independently
-- runnable — paste one, or run the file whole.
--
--   ssh <prod> 'docker exec -i <pg-container> psql -U platformpub -d platformpub' \
--     < scripts/segregation-baseline.sql
--
-- WHY THIS IS NOT OPTIONAL. §3.3d: "a threshold chosen without that baseline
-- fires on day one and gets muted, which is worse than not having the alert."
-- The dials are `platform_config` rows, so acting on these numbers is an UPDATE,
-- not a deploy — but it must be an UPDATE informed by these, and set BEFORE the
-- STRIPE_ALLOCATED_FUNDS flip.
-- =============================================================================


-- =============================================================================
-- QUERY 0 — WHICH CLASSIFIER CAN QUERY A TRUST? Run this FIRST.
-- =============================================================================
--
-- READ THIS BEFORE READING QUERY A'S OUTPUT. Query A must separate a
-- credit-funded `subscription_earning` (no charge behind it — the residual's
-- structural floor) from a charge-funded one. There are two ways to tell, and
-- which one is valid depends on whether migration 165 has run here yet.
--
--   EXACT       `tab_settlement_id IS NULL`
--               confirmSettlement stamps settled_at and tab_settlement_id in one
--               UPDATE (settlement.ts:653); the charge-time credit branch inserts
--               settled_at with no settlement (subscriptions/shared.ts:93). So a
--               NULL settlement on a settled earning means credit-funded.
--               *** Valid ONLY for rows created after migration 165 ran. ***
--               Migration 165 added the column with NO BACKFILL, deliberately
--               ("stamped going forward" — 165_funds_segregation.sql:172). Every
--               pre-165 row therefore has tab_settlement_id NULL whatever funded
--               it, and the exact classifier reads them ALL as credit-funded.
--
--   HEURISTIC   `settled_at < created_at + interval '1 minute'`
--               The charge-time branch stamps settled_at in the same transaction
--               that inserts the row; confirmSettlement stamps it when a later
--               settlement lands. Works on pre-165 rows. It is a heuristic: a
--               settlement confirming within 60s of a subscription charge would
--               be misread as credit-funded (rare, and it errs toward a LARGER
--               residual, i.e. a safer dial).
--
-- If migration 165 has not been deployed here, the exact classifier reports a
-- ~100% residual and the dial derived from it is meaningless. Query A reports
-- BOTH figures side by side for exactly this reason: if they disagree wildly,
-- the window is dominated by pre-165 rows and the heuristic is the one to use.

SELECT
  (SELECT applied_at FROM _migrations
    WHERE filename LIKE '165%')                         AS migration_165_applied_at,
  (SELECT count(*) FROM subscription_events
    WHERE event_type = 'subscription_earning'
      AND created_at >= now() - interval '30 days')     AS earnings_in_window,
  (SELECT count(*) FROM subscription_events
    WHERE event_type = 'subscription_earning'
      AND created_at >= now() - interval '30 days'
      AND created_at < COALESCE(
            (SELECT applied_at FROM _migrations WHERE filename LIKE '165%'),
            'infinity'::timestamptz))                   AS earnings_predating_165,
  CASE
    WHEN (SELECT applied_at FROM _migrations WHERE filename LIKE '165%') IS NULL
      THEN 'MIGRATION 165 NOT APPLIED HERE — use the HEURISTIC row of Query A'
    WHEN (SELECT count(*) FROM subscription_events
           WHERE event_type = 'subscription_earning'
             AND created_at >= now() - interval '30 days'
             AND created_at < (SELECT applied_at FROM _migrations
                                WHERE filename LIKE '165%')) > 0
      THEN 'WINDOW SPANS THE MIGRATION — prefer the HEURISTIC row of Query A'
    ELSE 'Window is entirely post-165 — the EXACT row of Query A is authoritative'
  END                                                   AS which_classifier;


-- =============================================================================
-- QUERY A — §3.3d RESIDUAL BASELINE  →  allocated_residual_alert_bps
-- =============================================================================
--
-- The residual is payout value funded from PLATFORM BALANCE rather than from a
-- charge's allocated funds. §1.4 gives it a structural floor: money that never
-- had a charge behind it cannot be segregated, and lands there by construction.
-- Two sources, both per §3.3d:
--
--   1. `subscription_credit` ledger entries — the spend→subscription credit-back.
--      NOTE: dark since 2026-07-16 (SUBSCRIPTION_CONVERT_ENABLED), so this SHOULD
--      read 0 on a trailing-30-day window. A non-zero figure means that flag is
--      live and the dial must be revisited when it moves. Sign convention
--      (ledger.ts): subscription_credit is +credit, so this sums positive. It is
--      deliberately NOT wrapped in ABS() — a negative total is a finding, and
--      hiding it would be the point of failure.
--
--   2. Credit-funded `subscription_earning` — an earning already payable at
--      charge time because pre-paid credit covered the charge (the collection
--      gate, migration 146). No charge exists, so the packer has nothing to
--      prefer and the unit becomes a platform_balance child.
--
-- Over: total payout value in the same window.
--
-- CAVEAT the ADR states and this query cannot fix: the flag is dark, so this
-- measures the residual's floor under CURRENT funding behaviour. Post-flip there
-- is also a TRANSITION spike (§6.3) as pre-flip charges — which the sweep stamps
-- allocated_pence = 0 and the packer never draws on — drain out of the payable
-- set. Set the dial above the floor with headroom, and expect the spike; do not
-- read it as a defect.

WITH win AS (
  SELECT (now() - interval '30 days')::timestamptz AS t0
),
credit_back AS (
  SELECT COALESCE(SUM(le.amount_pence), 0)::bigint AS pence
    FROM ledger_entries le, win
   WHERE le.trigger_type = 'subscription_credit'
     AND le.created_at >= win.t0
),
earnings AS (
  SELECT
    COALESCE(SUM(se.amount_pence) FILTER (
      WHERE se.settled_at IS NOT NULL AND se.tab_settlement_id IS NULL
    ), 0)::bigint AS exact_pence,
    COALESCE(SUM(se.amount_pence) FILTER (
      WHERE se.settled_at IS NOT NULL
        AND se.settled_at < se.created_at + interval '1 minute'
    ), 0)::bigint AS heuristic_pence
    FROM subscription_events se, win
   WHERE se.event_type = 'subscription_earning'
     AND se.created_at >= win.t0
),
payouts AS (
  SELECT
    -- §3.3d names writer payouts as the denominator. All three cycles now fund
    -- through the packer, so the all-cycles figure is the one the live metric
    -- will actually divide by (allocation-reconcile.ts) — both are reported.
    (SELECT COALESCE(SUM(wp.amount_pence), 0)::bigint
       FROM writer_payouts wp, win
      WHERE wp.status = 'completed' AND wp.completed_at >= win.t0) AS writer_pence,
    -- publication_payout_splits carries no completed_at (unlike the other two),
    -- so the window keys on created_at. Slightly wider than the writer arm; the
    -- difference is one payout cycle's lag and does not move the bps materially.
    (SELECT COALESCE(SUM(pps.amount_pence), 0)::bigint
       FROM publication_payout_splits pps, win
      WHERE pps.status = 'completed' AND pps.created_at >= win.t0) AS pub_pence,
    (SELECT COALESCE(SUM(tp.amount_pence), 0)::bigint
       FROM tribute_payouts tp, win
      WHERE tp.status = 'completed' AND tp.completed_at >= win.t0) AS tribute_pence
),
totals AS (
  SELECT
    credit_back.pence                                   AS credit_back_pence,
    earnings.exact_pence,
    earnings.heuristic_pence,
    payouts.writer_pence,
    payouts.writer_pence + payouts.pub_pence + payouts.tribute_pence AS all_pence
  FROM credit_back, earnings, payouts
)
SELECT classifier, numerator_pence, denominator_pence, residual_bps,
       CASE
         WHEN denominator_pence = 0 THEN 'NO PAYOUTS IN WINDOW — no measurement. Widen the window; do NOT read 0 as perfect coverage.'
         ELSE 'Suggested dial ≈ ' || (((residual_bps * 3) / 2) + 500)::text ||
              ' bps (measured × 1.5 + 500 headroom) — sanity-check, do not paste blind.'
       END AS note
FROM (
  SELECT 'EXACT (post-165 rows only)'::text AS classifier,
         (credit_back_pence + exact_pence)  AS numerator_pence,
         writer_pence                       AS denominator_pence,
         CASE WHEN writer_pence = 0 THEN 0
              ELSE round((credit_back_pence + exact_pence) * 10000.0 / writer_pence)::bigint
         END                                AS residual_bps,
         1 AS ord
    FROM totals
  UNION ALL
  SELECT 'HEURISTIC (valid pre-165)',
         (credit_back_pence + heuristic_pence),
         writer_pence,
         CASE WHEN writer_pence = 0 THEN 0
              ELSE round((credit_back_pence + heuristic_pence) * 10000.0 / writer_pence)::bigint
         END,
         2
    FROM totals
  UNION ALL
  SELECT 'HEURISTIC over ALL cycles',
         (credit_back_pence + heuristic_pence),
         all_pence,
         CASE WHEN all_pence = 0 THEN 0
              ELSE round((credit_back_pence + heuristic_pence) * 10000.0 / all_pence)::bigint
         END,
         3
    FROM totals
) x
ORDER BY ord;

-- Components, so a surprising bps above is attributable rather than mysterious.
SELECT
  (SELECT COALESCE(SUM(amount_pence), 0) FROM ledger_entries
    WHERE trigger_type = 'subscription_credit'
      AND created_at >= now() - interval '30 days')      AS credit_back_pence,
  (SELECT count(*) FROM ledger_entries
    WHERE trigger_type = 'subscription_credit'
      AND created_at >= now() - interval '30 days')      AS credit_back_rows,
  (SELECT COALESCE(SUM(amount_pence), 0) FROM subscription_events
    WHERE event_type = 'subscription_earning'
      AND created_at >= now() - interval '30 days'
      AND settled_at IS NOT NULL
      AND settled_at < created_at + interval '1 minute') AS credit_funded_earning_pence,
  (SELECT COALESCE(SUM(amount_pence), 0) FROM writer_payouts
    WHERE status = 'completed'
      AND completed_at >= now() - interval '30 days')    AS writer_payouts_pence;


-- =============================================================================
-- QUERY B — §7.2 SLICE DISTRIBUTION  →  payout_max_slices
-- =============================================================================
--
-- Under segregation one payout becomes N child transfers, one per funding charge
-- drawn on. `payout_max_slices` caps N; units past the cap are un-claimed inside
-- the reserve transaction and roll to the next cycle. Too low and writers are
-- paid in dribs across cycles (and §10.3's carve × slice-cap over-carve becomes
-- REACHABLE); too high and one payout can fan out into an unbounded number of
-- Stripe calls.
--
-- The unit of measure is what §7.2 names: per writer with an unpaid balance, how
-- many DISTINCT settlements does that balance span. Eligibility is copied
-- exactly from reserveWriterPayout (payout.ts:730-738) — including
-- `publication_id IS NULL`, since publication reads are claimed by the pool and
-- never by the writer cycle (the complements invariant). Getting that filter
-- wrong inflates the count with reads this cycle will never see.
--
-- THIS IS AN UPPER BOUND, which is the right side to be on for a cap. The packer
-- prefers a unit's own settlement but will co-locate units onto a shared charge
-- when one has room (allocation-packer.ts::choose), and ALL residual units
-- collapse into a SINGLE platform_balance slice (the RESIDUAL sentinel). So the
-- realised slice count is ≤ this. It cannot be measured exactly pre-flip:
-- remaining allocation per charge is unknown until charges carry allocation.

WITH threshold AS (
  SELECT COALESCE(
    (SELECT value::bigint FROM platform_config WHERE key = 'writer_payout_threshold_pence'),
    2000
  ) AS pence
),
units AS (
  -- One row per payable unit, carrying the settlement that would fund it.
  SELECT re.writer_id, re.tab_settlement_id, re.chargeable_pence AS gross_pence
    FROM read_events re
   WHERE re.state = 'platform_settled'
     AND re.writer_payout_id IS NULL
     AND re.publication_id IS NULL
  UNION ALL
  SELECT se.writer_id, se.tab_settlement_id, se.amount_pence
    FROM subscription_events se
   WHERE se.event_type = 'subscription_earning'
     AND se.publication_id IS NULL
     AND se.writer_payout_id IS NULL
     AND se.settled_at IS NOT NULL
     AND se.writer_id IS NOT NULL
),
per_writer AS (
  SELECT writer_id,
         SUM(gross_pence)                                        AS balance_pence,
         count(DISTINCT tab_settlement_id)                       AS allocated_slices,
         count(*) FILTER (WHERE tab_settlement_id IS NULL)       AS residual_units,
         -- The residual collapses to ONE slice however many units land in it.
         count(DISTINCT tab_settlement_id)
           + LEAST(1, count(*) FILTER (WHERE tab_settlement_id IS NULL)) AS slices_upper_bound
    FROM units
   GROUP BY writer_id
),
payable AS (
  SELECT p.* FROM per_writer p, threshold t WHERE p.balance_pence >= t.pence
)
SELECT
  (SELECT count(*) FROM per_writer)                                AS writers_with_balance,
  (SELECT count(*) FROM payable)                                   AS writers_over_threshold,
  (SELECT COALESCE(max(slices_upper_bound), 0) FROM payable)       AS max_slices,
  (SELECT COALESCE(round(avg(slices_upper_bound), 2), 0) FROM payable) AS mean_slices,
  (SELECT COALESCE(percentile_disc(0.50) WITHIN GROUP (ORDER BY slices_upper_bound), 0) FROM payable) AS p50,
  (SELECT COALESCE(percentile_disc(0.90) WITHIN GROUP (ORDER BY slices_upper_bound), 0) FROM payable) AS p90,
  (SELECT COALESCE(percentile_disc(0.99) WITHIN GROUP (ORDER BY slices_upper_bound), 0) FROM payable) AS p99,
  -- Set the dial ABOVE the tail, not at it: a writer past the cap has units
  -- un-claimed and re-carved next cycle (§10.3), so the cap should bite rarely.
  CASE
    WHEN (SELECT count(*) FROM payable) = 0
      THEN 'NO WRITERS OVER THRESHOLD — no measurement. The shipped guess of 20 stands; re-run when payouts are flowing.'
    ELSE 'Suggested payout_max_slices ≈ '
         || GREATEST(
              10,
              (SELECT percentile_disc(0.99) WITHIN GROUP (ORDER BY slices_upper_bound) FROM payable) * 2
            )::text
         || ' (p99 × 2, floor 10). Confirm against max_slices before setting.'
  END AS note;

-- The full distribution, for eyeballing the tail's shape rather than its
-- percentiles. A long thin tail and a fat one want different dials.
WITH units AS (
  SELECT re.writer_id, re.tab_settlement_id, re.chargeable_pence AS gross_pence
    FROM read_events re
   WHERE re.state = 'platform_settled'
     AND re.writer_payout_id IS NULL
     AND re.publication_id IS NULL
  UNION ALL
  SELECT se.writer_id, se.tab_settlement_id, se.amount_pence
    FROM subscription_events se
   WHERE se.event_type = 'subscription_earning'
     AND se.publication_id IS NULL
     AND se.writer_payout_id IS NULL
     AND se.settled_at IS NOT NULL
     AND se.writer_id IS NOT NULL
)
SELECT slices_upper_bound, count(*) AS writers
  FROM (
    SELECT writer_id,
           count(DISTINCT tab_settlement_id)
             + LEAST(1, count(*) FILTER (WHERE tab_settlement_id IS NULL)) AS slices_upper_bound
      FROM units GROUP BY writer_id
  ) d
 GROUP BY slices_upper_bound
 ORDER BY slices_upper_bound;


-- =============================================================================
-- QUERY C — §7.5 CONNECTED-ACCOUNT ENUMERATION
-- =============================================================================
--
-- §5 step 0: "Enumerate the countries of all live connected accounts. All GB →
-- record that as the §7.5 standing assumption. Any non-GB → §7.5 is live: probe
-- in the sandbox whether a GB platform's allocated funds transfer cross-border,
-- before the flip."
--
-- Country is Stripe-side, not ours, so this produces the ID LIST to resolve.
-- Feed the output to:  npx tsx scripts/segregation-probes.ts --countries
-- (which calls accounts.retrieve per id and groups by country), or paste into
-- the dashboard. TWO homes for a connect id — accounts and publications — and
-- missing the second would under-count the platform's real payout surface.

SELECT 'account' AS holder_kind, a.id AS holder_id, a.username AS holder_label,
       a.stripe_connect_id, a.stripe_connect_kyc_complete AS kyc_complete
  FROM accounts a
 WHERE a.stripe_connect_id IS NOT NULL
UNION ALL
SELECT 'publication', p.id, p.slug, p.stripe_connect_id, p.stripe_connect_kyc_complete
  FROM publications p
 WHERE p.stripe_connect_id IS NOT NULL
 ORDER BY holder_kind, holder_label;

SELECT count(*) FILTER (WHERE kyc_complete)     AS payable_accounts,
       count(*) FILTER (WHERE NOT kyc_complete) AS onboarding_incomplete,
       count(*)                                 AS total_connect_ids
  FROM (
    SELECT stripe_connect_kyc_complete AS kyc_complete FROM accounts
     WHERE stripe_connect_id IS NOT NULL
    UNION ALL
    SELECT stripe_connect_kyc_complete FROM publications
     WHERE stripe_connect_id IS NOT NULL
  ) z;
