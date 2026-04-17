import type { FastifyInstance } from 'fastify'
import { pool } from '../../shared/src/db/client.js'
import { optionalAuth } from '../middleware/auth.js'

// =============================================================================
// Trust Routes (Phase 1 — Layer 1 only)
//
// GET /trust/:userId — Layer 1 trust signals for a user
//
// Returns precomputed signals from trust_layer1. Phase 2 will add attestation
// dimension scores and Layer 4 relational data.
// =============================================================================

export async function trustRoutes(app: FastifyInstance) {

  app.get<{ Params: { userId: string } }>(
    '/trust/:userId',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { userId } = req.params

      const { rows } = await pool.query(
        `SELECT account_age_days, paying_reader_count, article_count,
                payment_verified, nip05_verified, pip_status, computed_at
         FROM trust_layer1
         WHERE user_id = $1`,
        [userId]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'No trust data for this user' })
      }

      const row = rows[0]
      return reply.send({
        userId,
        layer1: {
          accountAgeDays: row.account_age_days,
          payingReaderCount: row.paying_reader_count,
          articleCount: row.article_count,
          paymentVerified: row.payment_verified,
          nip05Verified: row.nip05_verified,
          pipStatus: row.pip_status,
          computedAt: row.computed_at,
        },
      })
    }
  )
}
