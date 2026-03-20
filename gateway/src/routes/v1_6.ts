import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { pool } from '../../shared/src/db/client.js'

export async function v1_6Routes(app: FastifyInstance) {
  // GET /my/tab
  app.get('/my/tab', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub!
    try {
      const account = await pool.query(
        `SELECT balance_pence, free_allowance_pence FROM accounts WHERE id = $1`,
        [userId]
      )
      const reads = await pool.query(`
        SELECT r.id as "readId", a.title as "articleTitle", a.d_tag as "articleDTag",
               w.display_name as "writerDisplayName", w.username as "writerUsername",
               r.amount_pence as "chargePence", r.read_at as "readAt",
               ts.settled_at as "settledAt",
               r.is_subscription_read as "isSubscriptionRead"
        FROM read_events r
        JOIN articles a ON a.id = r.article_id
        JOIN accounts w ON w.id = r.writer_id
        LEFT JOIN tab_settlements ts ON ts.id = r.tab_settlement_id
        WHERE r.reader_id = $1
        ORDER BY r.read_at DESC
        LIMIT 100
      `, [userId])
      const freeAllowance = account.rows[0]?.free_allowance_pence || 500
      const unsettled = reads.rows.filter((r: any) => !r.settledAt).reduce((sum: number, r: any) => sum + (r.chargePence || 0), 0)
      const remaining = Math.max(0, freeAllowance - unsettled)
      const settled = reads.rows.find((r: any) => r.settledAt)
      return reply.send({
        tabBalancePence: account.rows[0]?.balance_pence || 0,
        freeAllowanceRemainingPence: remaining,
        lastSettledAt: settled?.settledAt || null,
        reads: reads.rows
      })
    } catch (err) {
      req.log.error({ err }, 'Failed to fetch tab')
      return reply.status(500).send({ error: 'Failed to fetch tab data' })
    }
  })
}
