import { type Task } from 'graphile-worker'
import { type PoolClient } from 'pg'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'

// =============================================================================
// aggregate_daily
//
// Runs daily at 00:15 UTC. Materialises rolling baselines:
//   - traffology.writer_baselines   (per-writer means and subscriber counts)
//   - traffology.publication_baselines (per-publication means)
// =============================================================================

export const aggregateDaily: Task = async (_payload, helpers) => {
  const start = Date.now()

  await withTransaction(async (client: PoolClient) => {
    // =========================================================================
    // writer_baselines — rolling means from piece_stats
    // =========================================================================
    await client.query(`
      INSERT INTO traffology.writer_baselines (
        writer_id, mean_first_day_readers, stddev_first_day_readers,
        mean_reading_time, mean_open_rate, mean_piece_lifespan_days,
        total_free_subscribers, total_paying_subscribers,
        monthly_revenue, updated_at
      )
      SELECT
        p.writer_id,
        COALESCE(AVG(ps.first_day_readers)::real, 0.0) AS mean_first_day_readers,
        COALESCE(STDDEV_POP(ps.first_day_readers)::real, 0.0) AS stddev_first_day_readers,
        COALESCE(AVG(ps.avg_reading_time_seconds)::real, 0.0) AS mean_reading_time,
        COALESCE(AVG(ps.open_rate)::real, 0.0) AS mean_open_rate,
        -- Lifespan: days between publish and last reader
        COALESCE(AVG(
          EXTRACT(EPOCH FROM (ps.last_reader_at - p.published_at)) / 86400.0
        )::real, 0.0) AS mean_piece_lifespan_days,
        -- Subscriber counts: free = price_pence = 0, paid = price_pence > 0
        COALESCE((
          SELECT COUNT(*)::int FROM public.subscriptions sub
          WHERE sub.writer_id = p.writer_id
            AND sub.status = 'active'
            AND sub.price_pence = 0
        ), 0) AS total_free_subscribers,
        COALESCE((
          SELECT COUNT(*)::int FROM public.subscriptions sub
          WHERE sub.writer_id = p.writer_id
            AND sub.status = 'active'
            AND sub.price_pence > 0
        ), 0) AS total_paying_subscribers,
        -- Monthly revenue from writer payouts
        COALESCE((
          SELECT SUM(amount_pence)::numeric / 100.0
          FROM public.writer_payouts wp
          WHERE wp.writer_id = p.writer_id
            AND wp.triggered_at >= date_trunc('month', CURRENT_DATE)
            AND wp.status = 'completed'
        ), 0.00) AS monthly_revenue,
        now() AS updated_at
      FROM traffology.pieces p
      JOIN traffology.piece_stats ps ON ps.piece_id = p.id
      WHERE p.published_at IS NOT NULL
      GROUP BY p.writer_id
      ON CONFLICT (writer_id) DO UPDATE SET
        mean_first_day_readers = EXCLUDED.mean_first_day_readers,
        stddev_first_day_readers = EXCLUDED.stddev_first_day_readers,
        mean_reading_time = EXCLUDED.mean_reading_time,
        mean_open_rate = EXCLUDED.mean_open_rate,
        mean_piece_lifespan_days = EXCLUDED.mean_piece_lifespan_days,
        total_free_subscribers = EXCLUDED.total_free_subscribers,
        total_paying_subscribers = EXCLUDED.total_paying_subscribers,
        monthly_revenue = EXCLUDED.monthly_revenue,
        updated_at = EXCLUDED.updated_at
    `)

    // =========================================================================
    // publication_baselines — same pattern, grouped by publication
    // =========================================================================
    await client.query(`
      INSERT INTO traffology.publication_baselines (
        publication_id, mean_first_day_readers, stddev_first_day_readers,
        mean_reading_time, mean_open_rate,
        writer_count, total_readers_this_month, updated_at
      )
      SELECT
        p.publication_id,
        COALESCE(AVG(ps.first_day_readers)::real, 0.0) AS mean_first_day_readers,
        COALESCE(STDDEV_POP(ps.first_day_readers)::real, 0.0) AS stddev_first_day_readers,
        COALESCE(AVG(ps.avg_reading_time_seconds)::real, 0.0) AS mean_reading_time,
        COALESCE(AVG(ps.open_rate)::real, 0.0) AS mean_open_rate,
        COUNT(DISTINCT p.writer_id)::int AS writer_count,
        COALESCE(SUM(ps.readers_today)::int, 0) AS total_readers_this_month,
        now() AS updated_at
      FROM traffology.pieces p
      JOIN traffology.piece_stats ps ON ps.piece_id = p.id
      WHERE p.publication_id IS NOT NULL
        AND p.published_at IS NOT NULL
      GROUP BY p.publication_id
      ON CONFLICT (publication_id) DO UPDATE SET
        mean_first_day_readers = EXCLUDED.mean_first_day_readers,
        stddev_first_day_readers = EXCLUDED.stddev_first_day_readers,
        mean_reading_time = EXCLUDED.mean_reading_time,
        mean_open_rate = EXCLUDED.mean_open_rate,
        writer_count = EXCLUDED.writer_count,
        total_readers_this_month = EXCLUDED.total_readers_this_month,
        updated_at = EXCLUDED.updated_at
    `)
  })

  helpers.logger.info(`aggregate_daily completed in ${Date.now() - start}ms`)
}
