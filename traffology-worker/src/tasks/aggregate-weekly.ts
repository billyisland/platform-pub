import { type Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'

// =============================================================================
// aggregate_weekly
//
// Runs Monday at 01:00 UTC. Materialises:
//   - traffology.topic_performance (per-topic aggregates per writer)
//
// Topics come from the tags array on traffology.pieces.
// =============================================================================

export const aggregateWeekly: Task = async (_payload, helpers) => {
  const start = Date.now()

  await pool.query(`
    INSERT INTO traffology.topic_performance (
      writer_id, topic, piece_count, mean_readers,
      mean_reading_time, mean_search_readers, updated_at
    )
    SELECT
      p.writer_id,
      unnest(p.tags) AS topic,
      COUNT(DISTINCT p.id)::int AS piece_count,
      COALESCE(AVG(ps.total_readers)::real, 0.0) AS mean_readers,
      COALESCE(AVG(ps.avg_reading_time_seconds)::real, 0.0) AS mean_reading_time,
      -- Search readers: sessions from search sources
      COALESCE(AVG(
        (SELECT COUNT(*)::real FROM traffology.sessions s
         JOIN traffology.sources src ON src.id = s.resolved_source_id
         WHERE s.piece_id = p.id AND src.source_type = 'search')
      ), 0.0) AS mean_search_readers,
      now() AS updated_at
    FROM traffology.pieces p
    JOIN traffology.piece_stats ps ON ps.piece_id = p.id
    WHERE array_length(p.tags, 1) > 0
      AND p.published_at IS NOT NULL
    GROUP BY p.writer_id, unnest(p.tags)
    ON CONFLICT (writer_id, topic) DO UPDATE SET
      piece_count = EXCLUDED.piece_count,
      mean_readers = EXCLUDED.mean_readers,
      mean_reading_time = EXCLUDED.mean_reading_time,
      mean_search_readers = EXCLUDED.mean_search_readers,
      updated_at = EXCLUDED.updated_at
  `)

  helpers.logger.info(`aggregate_weekly completed in ${Date.now() - start}ms`)
}
