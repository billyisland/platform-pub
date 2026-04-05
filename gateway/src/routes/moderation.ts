import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Moderation Routes
//
// Per ADR §I.5 (Minimum Viable Moderation at Launch):
//   - Report button on all content, feeding a human-reviewed queue
//   - Small set of report categories: illegal content, harassment, spam, other
//   - No automated action — human review only
//   - Platform ability to remove content and suspend accounts
//   - Manual operation by the founder is acceptable at launch
//
// POST   /reports                  — submit a report (any authenticated user)
// GET    /admin/reports            — list reports (founder/admin only)
// PATCH  /admin/reports/:reportId  — resolve a report (remove content / no action)
// POST   /admin/suspend/:accountId — suspend an account
// =============================================================================

// Admin check — reads from platform_config, falls back to env var
let adminIdsCache: string[] | null = null
let adminIdsCacheExpiry = 0

async function getAdminIds(): Promise<string[]> {
  if (adminIdsCache && Date.now() < adminIdsCacheExpiry) return adminIdsCache
  try {
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM platform_config WHERE key = 'admin_account_ids'`
    )
    const dbValue = rows[0]?.value ?? ''
    const ids = dbValue.split(',').filter(Boolean)
    if (ids.length > 0) {
      adminIdsCache = ids
      adminIdsCacheExpiry = Date.now() + 60_000 // cache for 1 minute
      return ids
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read admin_account_ids from platform_config')
  }
  // Fallback to env var
  return (process.env.ADMIN_ACCOUNT_IDS ?? '').split(',').filter(Boolean)
}

async function isAdmin(accountId: string): Promise<boolean> {
  const ids = await getAdminIds()
  return ids.includes(accountId)
}

async function requireAdmin(req: any, reply: any): Promise<void> {
  await requireAuth(req, reply)
  if (reply.sent) return

  if (!(await isAdmin(req.session!.sub!))) {
    return reply.status(403).send({ error: 'Admin access required' })
  }
}

const SubmitReportSchema = z.object({
  targetNostrEventId: z.string().optional(),
  targetAccountId: z.string().uuid().optional(),
  category: z.enum(['illegal_content', 'harassment', 'spam', 'other']),
  notes: z.string().max(2000).optional(),
})

const ResolveReportSchema = z.object({
  action: z.enum(['no_action', 'remove_content', 'suspend_account']),
  reason: z.string().max(1000).optional(),
})

export async function moderationRoutes(app: FastifyInstance) {
  const adminIds = await getAdminIds()
  if (adminIds.length === 0) {
    logger.warn('ADMIN_ACCOUNT_IDS is not set — all admin routes will return 403')
  }


  // ---------------------------------------------------------------------------
  // POST /reports — submit a content report
  //
  // Per ADR: "Any reader can report content using the report button present
  // on every article, note, and comment. Reports are reviewed by a human —
  // there is no automated removal."
  // ---------------------------------------------------------------------------

  app.post('/reports', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = SubmitReportSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const reporterId = req.session!.sub!
    const data = parsed.data

    if (!data.targetNostrEventId && !data.targetAccountId) {
      return reply.status(400).send({ error: 'Must specify targetNostrEventId or targetAccountId' })
    }

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO moderation_reports (
         reporter_id, target_nostr_event_id, target_account_id,
         category, notes, status
       ) VALUES ($1, $2, $3, $4, $5, 'open')
       RETURNING id`,
      [
        reporterId,
        data.targetNostrEventId ?? null,
        data.targetAccountId ?? null,
        data.category,
        data.notes ?? null,
      ]
    )

    logger.info(
      { reportId: rows[0].id, category: data.category, reporterId },
      'Report submitted'
    )

    return reply.status(201).send({ reportId: rows[0].id })
  })

  // ---------------------------------------------------------------------------
  // GET /admin/reports — list reports (admin only)
  //
  // Returns open and under_review reports, newest first.
  // Resolved reports are excluded by default (pass ?all=true to include).
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { all?: string; limit?: string; offset?: string } }>(
    '/admin/reports',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const showAll = req.query.all === 'true'
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 100)
      const offset = parseInt(req.query.offset ?? '0', 10)

      const statusFilter = showAll
        ? ''
        : `AND r.status IN ('open', 'under_review')`

      const { rows } = await pool.query<{
        id: string
        reporter_username: string | null
        target_nostr_event_id: string | null
        target_account_username: string | null
        target_account_id: string | null
        category: string
        notes: string | null
        status: string
        created_at: Date
        reviewed_at: Date | null
      }>(
        `SELECT r.id, reporter.username AS reporter_username,
                r.target_nostr_event_id,
                target_acct.username AS target_account_username,
                r.target_account_id,
                r.category, r.notes, r.status,
                r.created_at, r.reviewed_at
         FROM moderation_reports r
         LEFT JOIN accounts reporter ON reporter.id = r.reporter_id
         LEFT JOIN accounts target_acct ON target_acct.id = r.target_account_id
         WHERE 1=1 ${statusFilter}
         ORDER BY r.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      )

      // Count open reports
      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM moderation_reports WHERE status = 'open'`
      )

      return reply.status(200).send({
        reports: rows.map((r) => ({
          id: r.id,
          reporterUsername: r.reporter_username,
          targetNostrEventId: r.target_nostr_event_id,
          targetAccountUsername: r.target_account_username,
          targetAccountId: r.target_account_id,
          category: r.category,
          notes: r.notes,
          status: r.status,
          createdAt: r.created_at.toISOString(),
          reviewedAt: r.reviewed_at?.toISOString() ?? null,
        })),
        openCount: parseInt(countResult.rows[0].count, 10),
        limit,
        offset,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /admin/reports/:reportId — resolve a report
  //
  // Actions:
  //   no_action        — content stays, report closed
  //   remove_content   — content removed from platform relay + DB index
  //   suspend_account  — account suspended, all content removed
  //
  // Per ADR: "We do not remove content silently. Writers are informed of
  // enforcement actions and the reason for them."
  //
  // Per ADR enforcement rules:
  //   - Content removed from platform relay and surfaces
  //   - Nostr identity (keypair) intact
  //   - Settled earnings paid out on normal schedule
  //   - Accrued-but-unsettled earnings held pending review
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { reportId: string } }>(
    '/admin/reports/:reportId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = ResolveReportSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const adminId = req.session!.sub!
      const { reportId } = req.params
      const { action, reason } = parsed.data

      return withTransaction(async (client) => {
        // Fetch the report
        const reportResult = await client.query<{
          id: string
          target_nostr_event_id: string | null
          target_account_id: string | null
          status: string
        }>(
          'SELECT id, target_nostr_event_id, target_account_id, status FROM moderation_reports WHERE id = $1',
          [reportId]
        )

        if (reportResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Report not found' })
        }

        const report = reportResult.rows[0]

        if (report.status === 'resolved_removed' || report.status === 'resolved_no_action') {
          return reply.status(409).send({ error: 'Report already resolved' })
        }

        let resolvedStatus: string

        switch (action) {
          case 'no_action':
            resolvedStatus = 'resolved_no_action'
            break

          case 'remove_content':
            resolvedStatus = 'resolved_removed'

            // Remove the content from the platform DB index
            if (report.target_nostr_event_id) {
              // Remove article
              await client.query(
                `UPDATE articles SET published_at = NULL, updated_at = now()
                 WHERE nostr_event_id = $1`,
                [report.target_nostr_event_id]
              )
              // Remove note
              await client.query(
                `DELETE FROM notes WHERE nostr_event_id = $1`,
                [report.target_nostr_event_id]
              )

              logger.info(
                { nostrEventId: report.target_nostr_event_id, reportId },
                'Content removed from platform index'
              )
            }
            break

          case 'suspend_account':
            resolvedStatus = 'resolved_removed'

            if (report.target_account_id) {
              // Suspend the account
              await client.query(
                `UPDATE accounts SET status = 'suspended', updated_at = now()
                 WHERE id = $1`,
                [report.target_account_id]
              )

              // Un-publish all their articles (remove from surfaces)
              await client.query(
                `UPDATE articles SET published_at = NULL, updated_at = now()
                 WHERE writer_id = $1`,
                [report.target_account_id]
              )

              // Remove all their notes
              await client.query(
                `DELETE FROM notes WHERE author_id = $1`,
                [report.target_account_id]
              )

              logger.info(
                { accountId: report.target_account_id, reportId },
                'Account suspended — content removed from platform surfaces'
              )
            }
            break
        }

        // Update the report
        await client.query(
          `UPDATE moderation_reports
           SET status = $1, reviewed_by = $2, reviewed_at = now()
           WHERE id = $3`,
          [resolvedStatus!, adminId, reportId]
        )

        return reply.status(200).send({
          reportId,
          status: resolvedStatus!,
          action,
        })
      })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /admin/suspend/:accountId — suspend an account directly
  // (without a report — for cases the founder discovers directly)
  // ---------------------------------------------------------------------------

  app.post<{ Params: { accountId: string } }>(
    '/admin/suspend/:accountId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { accountId } = req.params

      return withTransaction(async (client) => {
        await client.query(
          `UPDATE accounts SET status = 'suspended', updated_at = now() WHERE id = $1`,
          [accountId]
        )
        await client.query(
          `UPDATE articles SET published_at = NULL, updated_at = now() WHERE writer_id = $1`,
          [accountId]
        )
        await client.query(
          `DELETE FROM notes WHERE author_id = $1`,
          [accountId]
        )

        logger.info({ accountId, adminId: req.session!.sub! }, 'Account suspended directly')

        return reply.status(200).send({ ok: true, accountId, status: 'suspended' })
      })
    }
  )
}
