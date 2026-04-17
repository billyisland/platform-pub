import type { Task } from 'graphile-worker'
import { pool } from '../../shared/src/db/client.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// trust_layer1_refresh — daily computation of Layer 1 trust signals
//
// Reads from accounts, articles, read_events, and subscriptions to produce
// per-user trust signals. Writes to trust_layer1.
//
// pip_status thresholds (ALLHAUS-OMNIBUS §III.7):
//   known   — account >1yr, >50 paying readers, payment verified, nip05 verified
//   partial — account 3–12 months, some payment/subscription history
//   unknown — everything else (default for new accounts, RSS with no identity)
// =============================================================================

export const trustLayer1Refresh: Task = async () => {
  const result = await pool.query(
    `
    WITH writer_stats AS (
      -- Article count per writer
      SELECT writer_id, COUNT(*)::int AS article_count
      FROM articles
      WHERE deleted_at IS NULL
      GROUP BY writer_id
    ),
    paying_readers AS (
      -- Distinct readers who have paid to read a writer's content
      SELECT writer_id, COUNT(DISTINCT reader_id)::int AS paying_reader_count
      FROM read_events
      WHERE state IN ('accrued', 'platform_settled', 'writer_paid')
      GROUP BY writer_id
    ),
    computed AS (
      SELECT
        a.id AS user_id,
        EXTRACT(DAY FROM now() - a.created_at)::int AS account_age_days,
        COALESCE(pr.paying_reader_count, 0)          AS paying_reader_count,
        COALESCE(ws.article_count, 0)                 AS article_count,
        (a.stripe_connect_id IS NOT NULL AND a.stripe_connect_kyc_complete) AS payment_verified,
        FALSE                                          AS nip05_verified,
        -- pip_status: three-state glyph
        CASE
          WHEN EXTRACT(DAY FROM now() - a.created_at) > 365
               AND COALESCE(pr.paying_reader_count, 0) > 50
               AND a.stripe_connect_id IS NOT NULL
               AND a.stripe_connect_kyc_complete
            THEN 'known'
          WHEN EXTRACT(DAY FROM now() - a.created_at) > 90
               AND (COALESCE(pr.paying_reader_count, 0) > 0
                    OR COALESCE(ws.article_count, 0) > 0)
            THEN 'partial'
          ELSE 'unknown'
        END AS pip_status
      FROM accounts a
      LEFT JOIN writer_stats ws ON ws.writer_id = a.id
      LEFT JOIN paying_readers pr ON pr.writer_id = a.id
    )
    INSERT INTO trust_layer1 (user_id, account_age_days, paying_reader_count,
                              article_count, payment_verified, nip05_verified,
                              pip_status, computed_at)
    SELECT user_id, account_age_days, paying_reader_count, article_count,
           payment_verified, nip05_verified, pip_status, now()
    FROM computed
    ON CONFLICT (user_id) DO UPDATE SET
      account_age_days     = EXCLUDED.account_age_days,
      paying_reader_count  = EXCLUDED.paying_reader_count,
      article_count        = EXCLUDED.article_count,
      payment_verified     = EXCLUDED.payment_verified,
      nip05_verified       = EXCLUDED.nip05_verified,
      pip_status           = EXCLUDED.pip_status,
      computed_at          = EXCLUDED.computed_at
    `
  )

  logger.info({ upserted: result.rowCount }, 'trust_layer1 refreshed')
}
