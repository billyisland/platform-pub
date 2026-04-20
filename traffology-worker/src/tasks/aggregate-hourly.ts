import { type Task } from 'graphile-worker'
import { type PoolClient } from 'pg'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'

// =============================================================================
// aggregate_hourly
//
// Runs every hour at :05. Materialises from traffology.sessions into:
//   - traffology.piece_stats  (per-piece summary)
//   - traffology.source_stats (per-source-per-piece summary)
//   - traffology.half_day_buckets (traffic volume per source per 12h period)
//
// Also queues resolve_source for any sessions with NULL resolved_source_id.
// =============================================================================

export const aggregateHourly: Task = async (_payload, helpers) => {
  const start = Date.now()

  // First, resolve any unresolved sources
  await helpers.addJob('resolve_source', {}, { jobKey: 'resolve_source_batch' })

  await withTransaction(async (client: PoolClient) => {
    // =========================================================================
    // piece_stats — full recompute per piece with any session activity
    // =========================================================================
    await client.query(`
      INSERT INTO traffology.piece_stats (
        piece_id, total_readers, readers_today, first_day_readers,
        unique_countries, avg_reading_time_seconds, avg_scroll_depth,
        top_source_id, top_source_pct,
        free_conversions, paid_conversions, last_reader_at, updated_at
      )
      SELECT
        s.piece_id,
        COUNT(*)::int AS total_readers,
        COUNT(*) FILTER (
          WHERE s.started_at >= CURRENT_DATE
        )::int AS readers_today,
        COUNT(*) FILTER (
          WHERE s.started_at < (p.published_at + INTERVAL '1 day')
            AND p.published_at IS NOT NULL
        )::int AS first_day_readers,
        COUNT(DISTINCT s.country) FILTER (WHERE s.country IS NOT NULL)::int AS unique_countries,
        COALESCE(AVG(s.reading_time_seconds)::int, 0) AS avg_reading_time_seconds,
        COALESCE(AVG(s.scroll_depth)::real, 0.0) AS avg_scroll_depth,
        -- top_source: subquery for the source with the most sessions
        (
          SELECT resolved_source_id
          FROM traffology.sessions sub
          WHERE sub.piece_id = s.piece_id AND sub.resolved_source_id IS NOT NULL
          GROUP BY resolved_source_id
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ) AS top_source_id,
        -- top_source_pct
        CASE WHEN COUNT(*) > 0 THEN (
          SELECT COUNT(*)::real / NULLIF(
            (SELECT COUNT(*) FROM traffology.sessions sub2 WHERE sub2.piece_id = s.piece_id), 0
          )
          FROM traffology.sessions sub
          WHERE sub.piece_id = s.piece_id AND sub.resolved_source_id = (
            SELECT resolved_source_id
            FROM traffology.sessions sub3
            WHERE sub3.piece_id = s.piece_id AND sub3.resolved_source_id IS NOT NULL
            GROUP BY resolved_source_id
            ORDER BY COUNT(*) DESC
            LIMIT 1
          )
        ) ELSE 0.0 END AS top_source_pct,
        COUNT(*) FILTER (WHERE s.subscriber_status = 'free')::int AS free_conversions,
        COUNT(*) FILTER (WHERE s.subscriber_status = 'paying')::int AS paid_conversions,
        MAX(s.started_at) AS last_reader_at,
        now() AS updated_at
      FROM traffology.sessions s
      JOIN traffology.pieces p ON p.id = s.piece_id
      GROUP BY s.piece_id, p.published_at
      ON CONFLICT (piece_id) DO UPDATE SET
        total_readers = EXCLUDED.total_readers,
        readers_today = EXCLUDED.readers_today,
        first_day_readers = EXCLUDED.first_day_readers,
        unique_countries = EXCLUDED.unique_countries,
        avg_reading_time_seconds = EXCLUDED.avg_reading_time_seconds,
        avg_scroll_depth = EXCLUDED.avg_scroll_depth,
        top_source_id = EXCLUDED.top_source_id,
        top_source_pct = EXCLUDED.top_source_pct,
        free_conversions = EXCLUDED.free_conversions,
        paid_conversions = EXCLUDED.paid_conversions,
        last_reader_at = EXCLUDED.last_reader_at,
        updated_at = EXCLUDED.updated_at
    `)

    // =========================================================================
    // source_stats — per source per piece
    // =========================================================================
    await client.query(`
      INSERT INTO traffology.source_stats (
        piece_id, source_id, reader_count, pct_of_total,
        first_reader_at, last_reader_at,
        avg_reading_time_seconds, avg_scroll_depth, bounce_rate, updated_at
      )
      SELECT
        s.piece_id,
        s.resolved_source_id AS source_id,
        COUNT(*)::int AS reader_count,
        COUNT(*)::real / NULLIF(piece_total.total, 0) AS pct_of_total,
        MIN(s.started_at) AS first_reader_at,
        MAX(s.started_at) AS last_reader_at,
        COALESCE(AVG(s.reading_time_seconds)::int, 0) AS avg_reading_time_seconds,
        COALESCE(AVG(s.scroll_depth)::real, 0.0) AS avg_scroll_depth,
        COALESCE(
          AVG(CASE WHEN s.is_bounce THEN 1.0 ELSE 0.0 END)::real, 0.0
        ) AS bounce_rate,
        now() AS updated_at
      FROM traffology.sessions s
      JOIN LATERAL (
        SELECT COUNT(*)::real AS total
        FROM traffology.sessions t
        WHERE t.piece_id = s.piece_id
      ) piece_total ON true
      WHERE s.resolved_source_id IS NOT NULL
      GROUP BY s.piece_id, s.resolved_source_id, piece_total.total
      ON CONFLICT (piece_id, source_id) DO UPDATE SET
        reader_count = EXCLUDED.reader_count,
        pct_of_total = EXCLUDED.pct_of_total,
        first_reader_at = EXCLUDED.first_reader_at,
        last_reader_at = EXCLUDED.last_reader_at,
        avg_reading_time_seconds = EXCLUDED.avg_reading_time_seconds,
        avg_scroll_depth = EXCLUDED.avg_scroll_depth,
        bounce_rate = EXCLUDED.bounce_rate,
        updated_at = EXCLUDED.updated_at
    `)

    // =========================================================================
    // half_day_buckets — 12-hour buckets per source per piece
    //
    // Buckets start at 06:00 (day) and 18:00 (night) UTC.
    // These directly power the op-art provenance bars in the UI.
    // =========================================================================
    await client.query(`
      INSERT INTO traffology.half_day_buckets (
        piece_id, source_id, bucket_start, is_day, reader_count
      )
      SELECT
        s.piece_id,
        s.resolved_source_id AS source_id,
        -- Align to 06:00 or 18:00 UTC
        CASE
          WHEN EXTRACT(HOUR FROM s.started_at) >= 6
            AND EXTRACT(HOUR FROM s.started_at) < 18
          THEN date_trunc('day', s.started_at) + INTERVAL '6 hours'
          WHEN EXTRACT(HOUR FROM s.started_at) >= 18
          THEN date_trunc('day', s.started_at) + INTERVAL '18 hours'
          ELSE date_trunc('day', s.started_at) - INTERVAL '6 hours'
        END AS bucket_start,
        EXTRACT(HOUR FROM s.started_at) >= 6
          AND EXTRACT(HOUR FROM s.started_at) < 18 AS is_day,
        COUNT(*)::int AS reader_count
      FROM traffology.sessions s
      WHERE s.resolved_source_id IS NOT NULL
      GROUP BY
        s.piece_id,
        s.resolved_source_id,
        CASE
          WHEN EXTRACT(HOUR FROM s.started_at) >= 6
            AND EXTRACT(HOUR FROM s.started_at) < 18
          THEN date_trunc('day', s.started_at) + INTERVAL '6 hours'
          WHEN EXTRACT(HOUR FROM s.started_at) >= 18
          THEN date_trunc('day', s.started_at) + INTERVAL '18 hours'
          ELSE date_trunc('day', s.started_at) - INTERVAL '6 hours'
        END,
        EXTRACT(HOUR FROM s.started_at) >= 6
          AND EXTRACT(HOUR FROM s.started_at) < 18
      ON CONFLICT (piece_id, source_id, bucket_start) DO UPDATE SET
        reader_count = EXCLUDED.reader_count
    `)
  })

  // =========================================================================
  // Ranking pass — compute rank_this_year and rank_all_time
  // Done outside the main transaction as a lighter update
  // =========================================================================
  await pool.query(`
    WITH ranked AS (
      SELECT
        ps.piece_id,
        ROW_NUMBER() OVER (
          PARTITION BY p.writer_id
          ORDER BY ps.total_readers DESC
        )::int AS rank_all_time,
        ROW_NUMBER() OVER (
          PARTITION BY p.writer_id
          ORDER BY ps.total_readers DESC
        ) FILTER (
          WHERE p.published_at >= date_trunc('year', CURRENT_DATE)
        ) AS rank_this_year_raw
      FROM traffology.piece_stats ps
      JOIN traffology.pieces p ON p.id = ps.piece_id
    )
    UPDATE traffology.piece_stats ps SET
      rank_all_time = r.rank_all_time,
      rank_this_year = r.rank_this_year_raw::int
    FROM ranked r
    WHERE ps.piece_id = r.piece_id
  `)

  helpers.logger.info(`aggregate_hourly completed in ${Date.now() - start}ms`)
}
