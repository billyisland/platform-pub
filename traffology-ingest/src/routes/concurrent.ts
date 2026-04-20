import type { FastifyInstance } from 'fastify'
import { getCount, getCountsByPieceIds } from '../lib/concurrent-tracker.js'
import { pool } from '@platform-pub/shared/db/client.js'

// =============================================================================
// Concurrent reader endpoints — internal only (called by gateway)
//
// GET /concurrent/:pieceId — live reader count for a single piece
// GET /concurrent/writer/:writerId — live counts for all pieces by a writer
// =============================================================================

export async function concurrentRoutes(app: FastifyInstance) {
  app.get<{ Params: { pieceId: string } }>(
    '/concurrent/:pieceId',
    async (req) => {
      const { pieceId } = req.params
      return { pieceId, count: getCount(pieceId) }
    },
  )

  app.get<{ Params: { writerId: string } }>(
    '/concurrent/writer/:writerId',
    async (req) => {
      const { writerId } = req.params

      // Find all piece IDs for this writer
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM traffology.pieces WHERE writer_id = $1',
        [writerId],
      )

      const pieceIds = rows.map(r => r.id)
      const counts = getCountsByPieceIds(pieceIds)
      const total = Object.values(counts).reduce((a, b) => a + b, 0)

      return { writerId, total, pieces: counts }
    },
  )
}
