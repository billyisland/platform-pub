import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { pool } from '../../shared/src/db/client.js'

export async function v1_6Routes(app: FastifyInstance) {
  // GET /my/tab
  app.get('/my/tab', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub!
    try {
      const account = await pool.query(
        `SELECT a.free_allowance_remaining_pence,
                COALESCE(rt.balance_pence, 0) AS balance_pence
         FROM accounts a
         LEFT JOIN reading_tabs rt ON rt.reader_id = a.id
         WHERE a.id = $1`,
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
      const settled = reads.rows.find((r: any) => r.settledAt)
      return reply.send({
        tabBalancePence: account.rows[0]?.balance_pence ?? 0,
        freeAllowanceRemainingPence: account.rows[0]?.free_allowance_remaining_pence ?? 0,
        lastSettledAt: settled?.settledAt || null,
        reads: reads.rows
      })
    } catch (err) {
      req.log.error({ err }, 'Failed to fetch tab')
      return reply.status(500).send({ error: 'Failed to fetch tab data' })
    }
  })
}
