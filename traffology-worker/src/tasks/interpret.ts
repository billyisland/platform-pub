import { type Task } from 'graphile-worker'
import { type PoolClient } from 'pg'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// interpret task
//
// Runs after each aggregation cycle. Reads aggregated data, applies trigger
// conditions from ADR Section 5.2, and writes traffology.observations records.
//
// Phase 1 observation types:
//   ARRIVAL_CURRENT / ARRIVAL_NONE  — live reader counts
//   FIRST_DAY_SUMMARY              — end of first calendar day
//   SOURCE_NEW                     — new source detected
//   SOURCE_BREAKDOWN               — first-day source split
//   ANOMALY_HIGH / ANOMALY_LOW     — first-day readers vs baseline
//   MILESTONE_READERS              — 100, 500, 1k, 5k, 10k thresholds
// =============================================================================

const MILESTONE_THRESHOLDS = [100, 500, 1000, 5000, 10000]

export const interpret: Task = async (_payload, helpers) => {
  const start = Date.now()

  await withTransaction(async (client: PoolClient) => {
    await detectFirstDaySummaries(client)
    await detectAnomalies(client)
    await detectNewSources(client)
    await detectSourceBreakdowns(client)
    await detectMilestones(client)
  })

  helpers.logger.info(`interpret completed in ${Date.now() - start}ms`)
}

// =============================================================================
// FIRST_DAY_SUMMARY — end of piece's first calendar day
// =============================================================================

async function detectFirstDaySummaries(client: PoolClient) {
  // Find pieces published yesterday that don't already have a FIRST_DAY_SUMMARY
  const { rows: pieces } = await client.query<{
    piece_id: string
    writer_id: string
    title: string
    first_day_readers: number
    top_source_name: string | null
    top_source_pct: number | null
    mean_first_day_readers: number | null
  }>(`
    SELECT
      ps.piece_id,
      p.writer_id,
      p.title,
      ps.first_day_readers,
      src.display_name AS top_source_name,
      ps.top_source_pct,
      wb.mean_first_day_readers
    FROM traffology.piece_stats ps
    JOIN traffology.pieces p ON p.id = ps.piece_id
    LEFT JOIN traffology.sources src ON src.id = ps.top_source_id
    LEFT JOIN traffology.writer_baselines wb ON wb.writer_id = p.writer_id
    WHERE p.published_at >= CURRENT_DATE - INTERVAL '2 days'
      AND p.published_at < CURRENT_DATE
      AND NOT EXISTS (
        SELECT 1 FROM traffology.observations o
        WHERE o.piece_id = ps.piece_id
          AND o.observation_type = 'FIRST_DAY_SUMMARY'
      )
  `)

  for (const piece of pieces) {
    const mean = piece.mean_first_day_readers ?? 0
    let comparison: string | null = null
    if (mean > 0) {
      const ratio = piece.first_day_readers / mean
      if (ratio > 1.25) comparison = 'higher'
      else if (ratio < 0.75) comparison = 'lower'
    }

    await insertObservation(client, {
      writerId: piece.writer_id,
      pieceId: piece.piece_id,
      type: 'FIRST_DAY_SUMMARY',
      priority: 1,
      values: {
        title: piece.title,
        readers: piece.first_day_readers,
        comparison,
        topSource: piece.top_source_name,
        topSourcePct: piece.top_source_pct
          ? Math.round(piece.top_source_pct * 100)
          : null,
        baseline: mean > 0 ? Math.round(mean) : null,
      },
    })
  }
}

// =============================================================================
// ANOMALY_HIGH / ANOMALY_LOW — first-day readers vs baseline
// =============================================================================

async function detectAnomalies(client: PoolClient) {
  const { rows: pieces } = await client.query<{
    piece_id: string
    writer_id: string
    title: string
    first_day_readers: number
    mean_first_day_readers: number
  }>(`
    SELECT
      ps.piece_id,
      p.writer_id,
      p.title,
      ps.first_day_readers,
      wb.mean_first_day_readers
    FROM traffology.piece_stats ps
    JOIN traffology.pieces p ON p.id = ps.piece_id
    JOIN traffology.writer_baselines wb ON wb.writer_id = p.writer_id
    WHERE p.published_at >= CURRENT_DATE - INTERVAL '2 days'
      AND p.published_at < CURRENT_DATE
      AND wb.mean_first_day_readers > 0
      AND NOT EXISTS (
        SELECT 1 FROM traffology.observations o
        WHERE o.piece_id = ps.piece_id
          AND o.observation_type IN ('ANOMALY_HIGH', 'ANOMALY_LOW')
      )
  `)

  for (const piece of pieces) {
    const ratio = piece.first_day_readers / piece.mean_first_day_readers
    let type: string | null = null
    if (ratio > 2.0) type = 'ANOMALY_HIGH'
    else if (ratio < 0.5) type = 'ANOMALY_LOW'
    if (!type) continue

    await insertObservation(client, {
      writerId: piece.writer_id,
      pieceId: piece.piece_id,
      type,
      priority: 1,
      values: {
        title: piece.title,
        readers: piece.first_day_readers,
        baseline: Math.round(piece.mean_first_day_readers),
      },
    })
  }
}

// =============================================================================
// SOURCE_NEW — new source detected for a writer
// =============================================================================

async function detectNewSources(client: PoolClient) {
  // Sources created in the last 2 hours that don't already have an observation
  const { rows: sources } = await client.query<{
    source_id: string
    writer_id: string
    display_name: string
    source_type: string
    piece_id: string
    title: string
    reader_count: number
    first_reader_at: string
  }>(`
    SELECT
      src.id AS source_id,
      src.writer_id,
      src.display_name,
      src.source_type,
      ss.piece_id,
      p.title,
      ss.reader_count,
      ss.first_reader_at
    FROM traffology.sources src
    JOIN traffology.source_stats ss ON ss.source_id = src.id
    JOIN traffology.pieces p ON p.id = ss.piece_id
    WHERE src.is_new_for_writer = TRUE
      AND src.created_at >= now() - INTERVAL '2 hours'
      AND NOT EXISTS (
        SELECT 1 FROM traffology.observations o
        WHERE o.writer_id = src.writer_id
          AND o.observation_type = 'SOURCE_NEW'
          AND (o.values->>'sourceId')::text = src.id::text
      )
    ORDER BY ss.reader_count DESC
  `)

  // Deduplicate: one observation per source (pick the piece with the most readers)
  const seen = new Set<string>()
  for (const src of sources) {
    if (seen.has(src.source_id)) continue
    seen.add(src.source_id)

    await insertObservation(client, {
      writerId: src.writer_id,
      pieceId: src.piece_id,
      type: 'SOURCE_NEW',
      priority: 2,
      values: {
        sourceId: src.source_id,
        sourceName: src.display_name,
        sourceType: src.source_type,
        title: src.title,
        readers: src.reader_count,
      },
    })
  }
}

// =============================================================================
// SOURCE_BREAKDOWN — first-day source split
// =============================================================================

async function detectSourceBreakdowns(client: PoolClient) {
  const { rows: pieces } = await client.query<{
    piece_id: string
    writer_id: string
    title: string
    first_day_readers: number
  }>(`
    SELECT ps.piece_id, p.writer_id, p.title, ps.first_day_readers
    FROM traffology.piece_stats ps
    JOIN traffology.pieces p ON p.id = ps.piece_id
    WHERE p.published_at >= CURRENT_DATE - INTERVAL '2 days'
      AND p.published_at < CURRENT_DATE
      AND ps.first_day_readers > 0
      AND NOT EXISTS (
        SELECT 1 FROM traffology.observations o
        WHERE o.piece_id = ps.piece_id
          AND o.observation_type = 'SOURCE_BREAKDOWN'
      )
  `)

  for (const piece of pieces) {
    // Get top sources for first-day sessions
    const { rows: sources } = await client.query<{
      display_name: string
      reader_count: number
    }>(`
      SELECT
        COALESCE(src.display_name, 'Direct') AS display_name,
        COUNT(*)::int AS reader_count
      FROM traffology.sessions s
      JOIN traffology.pieces p ON p.id = s.piece_id
      LEFT JOIN traffology.sources src ON src.id = s.resolved_source_id
      WHERE s.piece_id = $1
        AND s.started_at < (p.published_at + INTERVAL '1 day')
      GROUP BY COALESCE(src.display_name, 'Direct')
      ORDER BY reader_count DESC
      LIMIT 5
    `, [piece.piece_id])

    const breakdown = sources.map(s => ({
      name: s.display_name,
      pct: Math.round((s.reader_count / piece.first_day_readers) * 100),
    }))

    // If more than 4 named sources, collapse the rest into "other sources"
    if (breakdown.length > 4) {
      const top4 = breakdown.slice(0, 4)
      const otherPct = 100 - top4.reduce((sum, s) => sum + s.pct, 0)
      top4.push({ name: 'other sources', pct: Math.max(otherPct, 0) })
      breakdown.length = 0
      breakdown.push(...top4)
    }

    await insertObservation(client, {
      writerId: piece.writer_id,
      pieceId: piece.piece_id,
      type: 'SOURCE_BREAKDOWN',
      priority: 4,
      values: {
        title: piece.title,
        breakdown,
      },
    })
  }
}

// =============================================================================
// MILESTONE_READERS — reader count thresholds
// =============================================================================

async function detectMilestones(client: PoolClient) {
  for (const threshold of MILESTONE_THRESHOLDS) {
    const { rows: pieces } = await client.query<{
      piece_id: string
      writer_id: string
      title: string
      total_readers: number
      rank_this_year: number | null
      rank_all_time: number | null
    }>(`
      SELECT
        ps.piece_id,
        p.writer_id,
        p.title,
        ps.total_readers,
        ps.rank_this_year,
        ps.rank_all_time
      FROM traffology.piece_stats ps
      JOIN traffology.pieces p ON p.id = ps.piece_id
      WHERE ps.total_readers >= $1
        AND NOT EXISTS (
          SELECT 1 FROM traffology.observations o
          WHERE o.piece_id = ps.piece_id
            AND o.observation_type = 'MILESTONE_READERS'
            AND (o.values->>'threshold')::int = $1
        )
    `, [threshold])

    for (const piece of pieces) {
      let rankClause: string | null = null
      if (piece.rank_this_year && piece.rank_this_year <= 3) {
        rankClause = `your ${ordinal(piece.rank_this_year)} most-read piece this year`
      } else if (piece.rank_all_time && piece.rank_all_time <= 3) {
        rankClause = `your ${ordinal(piece.rank_all_time)} most-read piece of all time`
      }

      await insertObservation(client, {
        writerId: piece.writer_id,
        pieceId: piece.piece_id,
        type: 'MILESTONE_READERS',
        priority: 3,
        values: {
          title: piece.title,
          threshold,
          totalReaders: piece.total_readers,
          rankClause,
        },
      })
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

interface ObservationInput {
  writerId: string
  pieceId: string | null
  type: string
  priority: number
  values: Record<string, unknown>
}

async function insertObservation(client: PoolClient, obs: ObservationInput) {
  await client.query(
    `INSERT INTO traffology.observations
       (writer_id, piece_id, observation_type, priority, values)
     VALUES ($1, $2, $3, $4, $5)`,
    [obs.writerId, obs.pieceId, obs.type, obs.priority, JSON.stringify(obs.values)]
  )
  logger.info(
    { type: obs.type, pieceId: obs.pieceId, writerId: obs.writerId },
    'Observation created'
  )
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
