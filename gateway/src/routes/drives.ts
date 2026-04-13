import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import { requireAuth, optionalAuth } from '../middleware/auth.js'
import { signEvent } from '../lib/key-custody-client.js'
import { publishToRelay } from '../lib/nostr-publisher.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Pledge Drive Routes
//
// POST   /drives                          — create a pledge drive
// GET    /drives/:id                      — view drive + pledge count/progress
// PUT    /drives/:id                      — update drive (creator only)
// DELETE /drives/:id                      — cancel/delete drive (creator only)
// POST   /drives/:id/pledge               — pledge money
// DELETE /drives/:id/pledge               — withdraw pledge (before publication)
// POST   /drives/:id/accept               — target writer accepts a commission
// POST   /drives/:id/decline              — target writer declines a commission
// POST   /drives/:id/pin                  — pin/unpin on profile
// GET    /drives/by-user/:userId          — list a user's drives (profile view)
// GET    /my/pledges                      — list my active pledges
// =============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const PLEDGE_DRIVE_EVENT_KIND = 30078

const CreateDriveSchema = z.object({
  origin: z.enum(['crowdfund', 'commission']),
  targetWriterId: z.string().regex(UUID_RE).optional(), // required for commissions
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  fundingTargetPence: z.number().int().min(1).optional(),
  suggestedPricePence: z.number().int().min(1).optional(),
  deadline: z.string().datetime().optional(),
  draftId: z.string().regex(UUID_RE).optional(),
  parentNoteEventId: z.string().max(200).optional(),
  parentConversationId: z.string().regex(UUID_RE).optional(),
})

const UpdateDriveSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  fundingTargetPence: z.number().int().min(1).optional(),
  suggestedPricePence: z.number().int().min(1).optional(),
  deadline: z.string().datetime().refine(d => new Date(d) > new Date(), { message: 'Deadline must be in the future' }).optional(),
})

const PledgeSchema = z.object({
  amountPence: z.number().int().min(1),
})

export async function driveRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /drives — create a pledge drive
  // ---------------------------------------------------------------------------

  app.post('/drives', { preHandler: requireAuth }, async (req, reply) => {
    const creatorId = req.session!.sub!
    const parsed = CreateDriveSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const data = parsed.data

    // For crowdfunds, target writer is the creator
    let targetWriterId = creatorId
    if (data.origin === 'commission') {
      if (!data.targetWriterId) {
        return reply.status(400).send({ error: 'targetWriterId is required for commissions' })
      }
      targetWriterId = data.targetWriterId

      // Verify target writer exists and is a writer
      const writer = await pool.query(
        'SELECT id FROM accounts WHERE id = $1 AND is_writer = TRUE',
        [targetWriterId]
      )
      if (writer.rowCount === 0) {
        return reply.status(404).send({ error: 'Target writer not found' })
      }
    }

    const result = await pool.query<{ id: string }>(
      `INSERT INTO pledge_drives (
         creator_id, origin, target_writer_id, title, description,
         funding_target_pence, suggested_price_pence, deadline, draft_id,
         parent_note_event_id, parent_conversation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        creatorId,
        data.origin,
        targetWriterId,
        data.title,
        data.description ?? null,
        data.fundingTargetPence ?? null,
        data.suggestedPricePence ?? null,
        data.deadline ?? null,
        data.draftId ?? null,
        data.parentNoteEventId ?? null,
        data.parentConversationId ?? null,
      ]
    )

    const driveId = result.rows[0].id

    // Publish Nostr event for the drive (async, non-blocking)
    publishDriveEvent(creatorId, driveId, data.title, data.description).catch(err => {
      logger.error({ err, driveId }, 'Failed to publish drive Nostr event')
    })

    // Notify target writer for commissions
    if (data.origin === 'commission') {
      await pool.query(
        `INSERT INTO notifications (recipient_id, actor_id, type)
         VALUES ($1, $2, 'commission_request')`,
        [targetWriterId, creatorId]
      ).catch(err => {
        logger.error({ err, targetWriterId, driveId }, 'Failed to create commission notification')
      })
    }

    logger.info({ driveId, creatorId, origin: data.origin }, 'Pledge drive created')
    return reply.status(201).send({ driveId })
  })

  // ---------------------------------------------------------------------------
  // GET /drives/:id — view drive + pledge count/progress
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/drives/:id',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { rows } = await pool.query<{
        id: string
        creator_id: string
        origin: string
        target_writer_id: string
        title: string
        description: string | null
        funding_target_pence: number | null
        current_total_pence: number
        suggested_price_pence: number | null
        status: string
        article_id: string | null
        nostr_event_id: string | null
        pinned: boolean
        accepted_at: Date | null
        deadline: Date | null
        published_at: Date | null
        fulfilled_at: Date | null
        created_at: Date
        creator_username: string
        creator_display_name: string | null
        writer_username: string
        writer_display_name: string | null
        pledge_count: number
      }>(
        `SELECT d.*,
                c.username AS creator_username, c.display_name AS creator_display_name,
                w.username AS writer_username, w.display_name AS writer_display_name,
                COALESCE(p.cnt, 0)::int AS pledge_count
         FROM pledge_drives d
         JOIN accounts c ON c.id = d.creator_id
         JOIN accounts w ON w.id = d.target_writer_id
         LEFT JOIN (
           SELECT drive_id, COUNT(*) AS cnt FROM pledges WHERE status = 'active' GROUP BY drive_id
         ) p ON p.drive_id = d.id
         WHERE d.id = $1`,
        [req.params.id]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Drive not found' })
      }

      const d = rows[0]
      return reply.status(200).send({
        id: d.id,
        creatorId: d.creator_id,
        origin: d.origin,
        targetWriterId: d.target_writer_id,
        title: d.title,
        description: d.description,
        fundingTargetPence: d.funding_target_pence,
        currentTotalPence: d.current_total_pence,
        suggestedPricePence: d.suggested_price_pence,
        status: d.status,
        articleId: d.article_id,
        nostrEventId: d.nostr_event_id,
        pinned: d.pinned,
        acceptedAt: d.accepted_at?.toISOString() ?? null,
        deadline: d.deadline?.toISOString() ?? null,
        publishedAt: d.published_at?.toISOString() ?? null,
        fulfilledAt: d.fulfilled_at?.toISOString() ?? null,
        createdAt: d.created_at.toISOString(),
        creator: { username: d.creator_username, displayName: d.creator_display_name },
        writer: { username: d.writer_username, displayName: d.writer_display_name },
        pledgeCount: d.pledge_count,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // PUT /drives/:id — update drive (creator only)
  // ---------------------------------------------------------------------------

  app.put<{ Params: { id: string } }>(
    '/drives/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!
      const parsed = UpdateDriveSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const data = parsed.data
      const updates: string[] = []
      const params: any[] = []
      let idx = 1

      if (data.title) { updates.push(`title = $${idx++}`); params.push(data.title) }
      if (data.description !== undefined) { updates.push(`description = $${idx++}`); params.push(data.description) }
      if (data.fundingTargetPence !== undefined) { updates.push(`funding_target_pence = $${idx++}`); params.push(data.fundingTargetPence) }
      if (data.suggestedPricePence !== undefined) { updates.push(`suggested_price_pence = $${idx++}`); params.push(data.suggestedPricePence) }
      if (data.deadline) { updates.push(`deadline = $${idx++}`); params.push(data.deadline) }

      if (updates.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' })
      }

      params.push(req.params.id, userId)
      const result = await pool.query(
        `UPDATE pledge_drives SET ${updates.join(', ')}
         WHERE id = $${idx++} AND creator_id = $${idx} AND status IN ('open', 'funded')
         RETURNING id`,
        params
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Drive not found or not editable' })
      }

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /drives/:id — cancel/delete drive (creator only)
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string } }>(
    '/drives/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!

      await withTransaction(async (client) => {
        const result = await client.query<{ id: string; nostr_event_id: string | null }>(
          `UPDATE pledge_drives
           SET status = 'cancelled', cancelled_at = now(), pinned = FALSE
           WHERE id = $1 AND creator_id = $2 AND status NOT IN ('fulfilled', 'cancelled')
           RETURNING id, nostr_event_id`,
          [req.params.id, userId]
        )

        if (result.rowCount === 0) {
          return reply.status(404).send({ error: 'Drive not found or already terminal' })
        }

        // Void all active pledges — no financial unwind needed
        await client.query(
          `UPDATE pledges SET status = 'void'
           WHERE drive_id = $1 AND status = 'active'`,
          [req.params.id]
        )
      })

      // Publish kind 5 deletion event for the drive (async)
      publishDriveDeletion(userId, req.params.id).catch(err => {
        logger.error({ err, driveId: req.params.id }, 'Failed to publish drive deletion event')
      })

      logger.info({ driveId: req.params.id, userId }, 'Pledge drive cancelled')
      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /drives/:id/pledge — pledge money
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/drives/:id/pledge',
    { preHandler: requireAuth },
    async (req, reply) => {
      const pledgerId = req.session!.sub!
      const parsed = PledgeSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { amountPence } = parsed.data

      // Run pledge in a transaction
      let pledgeError: { message: string; status: number } | null = null
      let newTotal = 0

      await withTransaction(async (client) => {
        // Verify drive exists and is open
        const drive = await client.query<{ id: string; status: string; funding_target_pence: number | null; current_total_pence: number }>(
          `SELECT id, status, funding_target_pence, current_total_pence
           FROM pledge_drives WHERE id = $1 AND status IN ('open', 'funded') FOR UPDATE`,
          [req.params.id]
        )
        if (drive.rows.length === 0) {
          pledgeError = { message: 'Drive not found or not accepting pledges', status: 404 }
          return
        }

        // Insert pledge (one per user per drive)
        try {
          await client.query(
            `INSERT INTO pledges (drive_id, pledger_id, amount_pence)
             VALUES ($1, $2, $3)`,
            [req.params.id, pledgerId, amountPence]
          )
        } catch (err: any) {
          if (err.code === '23505') { // unique violation
            pledgeError = { message: 'Already pledged to this drive', status: 409 }
            return
          }
          throw err
        }

        // Update current total
        newTotal = drive.rows[0].current_total_pence + amountPence
        let newStatus = drive.rows[0].status
        if (drive.rows[0].funding_target_pence && newTotal >= drive.rows[0].funding_target_pence) {
          newStatus = 'funded'
        }

        await client.query(
          `UPDATE pledge_drives SET current_total_pence = $1, status = $2 WHERE id = $3`,
          [newTotal, newStatus, req.params.id]
        )

        // Notify creator if drive just became funded
        if (newStatus === 'funded' && drive.rows[0].status === 'open') {
          const driveInfo = await client.query<{ creator_id: string }>(
            'SELECT creator_id FROM pledge_drives WHERE id = $1',
            [req.params.id]
          )
          await client.query(
            `INSERT INTO notifications (recipient_id, actor_id, type)
             VALUES ($1, $2, 'drive_funded')`,
            [driveInfo.rows[0].creator_id, pledgerId]
          )
        }
      })

      if (pledgeError !== null) {
        const err = pledgeError as { message: string; status: number }
        return reply.status(err.status).send({ error: err.message })
      }

      logger.info({ driveId: req.params.id, pledgerId, amountPence }, 'Pledge created')
      return reply.status(201).send({ ok: true, currentTotalPence: newTotal })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /drives/:id/pledge — withdraw pledge (before publication)
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string } }>(
    '/drives/:id/pledge',
    { preHandler: requireAuth },
    async (req, reply) => {
      const pledgerId = req.session!.sub!

      await withTransaction(async (client) => {
        const pledge = await client.query<{ amount_pence: number }>(
          `DELETE FROM pledges
           WHERE drive_id = $1 AND pledger_id = $2 AND status = 'active'
           RETURNING amount_pence`,
          [req.params.id, pledgerId]
        )

        if (pledge.rowCount === 0) {
          return reply.status(404).send({ error: 'No active pledge found' })
        }

        // Update drive total
        await client.query(
          `UPDATE pledge_drives
           SET current_total_pence = current_total_pence - $1
           WHERE id = $2`,
          [pledge.rows[0].amount_pence, req.params.id]
        )

        // If total dropped below target, revert to open
        await client.query(
          `UPDATE pledge_drives SET status = 'open'
           WHERE id = $1 AND status = 'funded'
             AND funding_target_pence IS NOT NULL
             AND current_total_pence < funding_target_pence`,
          [req.params.id]
        )
      })

      logger.info({ driveId: req.params.id, pledgerId }, 'Pledge withdrawn')
      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /drives/:id/accept — target writer accepts a commission
  // ---------------------------------------------------------------------------

  const AcceptCommissionSchema = z.object({
    acceptanceTerms: z.string().max(5000).optional(),
    backerAccessMode: z.enum(['free', 'paywalled']).optional(),
    deadline: z.string().datetime().optional(),
  })

  app.post<{ Params: { id: string } }>(
    '/drives/:id/accept',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!
      const parsed = AcceptCommissionSchema.safeParse(req.body ?? {})
      const terms = parsed.success ? parsed.data : {}

      const result = await pool.query(
        `UPDATE pledge_drives
         SET accepted_at = now(),
             acceptance_terms = COALESCE($3, acceptance_terms),
             backer_access_mode = COALESCE($4, backer_access_mode),
             deadline = COALESCE($5::timestamptz, deadline)
         WHERE id = $1 AND target_writer_id = $2 AND origin = 'commission'
           AND accepted_at IS NULL AND status IN ('open', 'funded')
         RETURNING id`,
        [
          req.params.id,
          writerId,
          terms.acceptanceTerms ?? null,
          terms.backerAccessMode ?? null,
          terms.deadline ?? null,
        ]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Commission not found or already accepted' })
      }

      logger.info({ driveId: req.params.id, writerId }, 'Commission accepted')
      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /drives/:id/decline — target writer declines a commission
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/drives/:id/decline',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!

      await withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE pledge_drives SET status = 'cancelled', cancelled_at = now(), pinned = FALSE
           WHERE id = $1 AND target_writer_id = $2 AND origin = 'commission'
             AND status IN ('open', 'funded')
           RETURNING id, creator_id`,
          [req.params.id, writerId]
        )

        if (result.rowCount === 0) {
          return reply.status(404).send({ error: 'Commission not found or not declinable' })
        }

        // Void all active pledges
        await client.query(
          `UPDATE pledges SET status = 'void'
           WHERE drive_id = $1 AND status = 'active'`,
          [req.params.id]
        )
      })

      logger.info({ driveId: req.params.id, writerId }, 'Commission declined')
      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /drives/:id/pin — toggle pin on profile
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/drives/:id/pin',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!

      const result = await pool.query(
        `UPDATE pledge_drives SET pinned = NOT pinned
         WHERE id = $1 AND creator_id = $2 AND status NOT IN ('expired', 'cancelled')
         RETURNING id, pinned`,
        [req.params.id, userId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Drive not found' })
      }

      return reply.status(200).send({ pinned: result.rows[0].pinned })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /drives/by-user/:userId — list a user's drives (profile view)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { userId: string } }>(
    '/drives/by-user/:userId',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { rows } = await pool.query<{
        id: string
        origin: string
        title: string
        description: string | null
        funding_target_pence: number | null
        current_total_pence: number
        status: string
        pinned: boolean
        deadline: Date | null
        created_at: Date
        pledge_count: number
      }>(
        `SELECT d.id, d.origin, d.title, d.description,
                d.funding_target_pence, d.current_total_pence,
                d.status, d.pinned, d.deadline, d.created_at,
                COALESCE(p.cnt, 0)::int AS pledge_count
         FROM pledge_drives d
         LEFT JOIN (
           SELECT drive_id, COUNT(*) AS cnt FROM pledges WHERE status != 'void' GROUP BY drive_id
         ) p ON p.drive_id = d.id
         WHERE d.creator_id = $1 AND d.origin = 'crowdfund' AND d.status != 'cancelled'
         ORDER BY d.pinned DESC, d.created_at DESC
         LIMIT 50`,
        [req.params.userId]
      )

      return reply.status(200).send({
        drives: rows.map(d => ({
          id: d.id,
          origin: d.origin,
          title: d.title,
          description: d.description,
          fundingTargetPence: d.funding_target_pence,
          currentTotalPence: d.current_total_pence,
          status: d.status,
          pinned: d.pinned,
          deadline: d.deadline?.toISOString() ?? null,
          createdAt: d.created_at.toISOString(),
          pledgeCount: d.pledge_count,
        })),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /my/commissions — incoming commissions for the current writer
  // ---------------------------------------------------------------------------

  app.get('/my/commissions', { preHandler: requireAuth }, async (req, reply) => {
    const writerId = req.session!.sub!

    const { rows } = await pool.query<{
      id: string
      title: string
      description: string | null
      funding_target_pence: number | null
      current_total_pence: number
      status: string
      accepted_at: Date | null
      deadline: Date | null
      created_at: Date
      pledge_count: number
      creator_username: string
      creator_display_name: string | null
    }>(
      `SELECT d.id, d.title, d.description,
              d.funding_target_pence, d.current_total_pence,
              d.status, d.accepted_at, d.deadline, d.created_at,
              COALESCE(p.cnt, 0)::int AS pledge_count,
              c.username AS creator_username, c.display_name AS creator_display_name
       FROM pledge_drives d
       JOIN accounts c ON c.id = d.creator_id
       LEFT JOIN (
         SELECT drive_id, COUNT(*) AS cnt FROM pledges WHERE status != 'void' GROUP BY drive_id
       ) p ON p.drive_id = d.id
       WHERE d.target_writer_id = $1 AND d.origin = 'commission'
       ORDER BY d.created_at DESC
       LIMIT 50`,
      [writerId]
    )

    return reply.status(200).send({
      commissions: rows.map(d => ({
        id: d.id,
        origin: 'commission' as const,
        title: d.title,
        description: d.description,
        fundingTargetPence: d.funding_target_pence,
        currentTotalPence: d.current_total_pence,
        status: d.status,
        acceptedAt: d.accepted_at?.toISOString() ?? null,
        deadline: d.deadline?.toISOString() ?? null,
        createdAt: d.created_at.toISOString(),
        pledgeCount: d.pledge_count,
        commissioner: { username: d.creator_username, displayName: d.creator_display_name },
      })),
    })
  })

  // ---------------------------------------------------------------------------
  // GET /my/pledges — list my active pledges
  // ---------------------------------------------------------------------------

  app.get('/my/pledges', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub!

    const { rows } = await pool.query<{
      id: string
      drive_id: string
      amount_pence: number
      status: string
      created_at: Date
      drive_title: string
      drive_status: string
      writer_username: string
      writer_display_name: string | null
    }>(
      `SELECT p.id, p.drive_id, p.amount_pence, p.status, p.created_at,
              d.title AS drive_title, d.status AS drive_status,
              a.username AS writer_username, a.display_name AS writer_display_name
       FROM pledges p
       JOIN pledge_drives d ON d.id = p.drive_id
       JOIN accounts a ON a.id = d.target_writer_id
       WHERE p.pledger_id = $1
       ORDER BY p.created_at DESC
       LIMIT 100`,
      [userId]
    )

    return reply.status(200).send({
      pledges: rows.map(r => ({
        id: r.id,
        driveId: r.drive_id,
        amountPence: r.amount_pence,
        status: r.status,
        createdAt: r.created_at.toISOString(),
        driveTitle: r.drive_title,
        driveStatus: r.drive_status,
        writer: { username: r.writer_username, displayName: r.writer_display_name },
      })),
    })
  })
}

// =============================================================================
// Publication trigger — called from article indexing route
//
// Checks if a newly published article is linked to a pledge drive via draft_id.
// If found, marks the drive as 'published' and queues async fulfilment.
// =============================================================================

export async function checkAndTriggerDriveFulfilment(
  writerId: string,
  articleId: string,
  draftId: string | null
): Promise<void> {
  if (!draftId) return

  const driveId = await withTransaction(async (client) => {
    const driveRow = await client.query<{ id: string }>(
      `SELECT id FROM pledge_drives
       WHERE target_writer_id = $1 AND draft_id = $2 AND status IN ('open', 'funded')
       FOR UPDATE`,
      [writerId, draftId]
    )

    if (driveRow.rows.length === 0) return null

    const id = driveRow.rows[0].id

    await client.query(
      `UPDATE pledge_drives SET article_id = $1, status = 'published',
       published_at = now() WHERE id = $2`,
      [articleId, id]
    )

    return id
  })

  if (!driveId) return

  // Queue async fulfilment (runs outside the publish request path)
  fulfillDrive(driveId).catch(err => {
    logger.error({ err, driveId }, 'Drive fulfilment failed')
  })
}

// =============================================================================
// Async fulfilment job — processes pledges in batches
// =============================================================================

async function fulfillDrive(driveId: string): Promise<void> {
  const driveRow = await pool.query<{
    article_id: string
    target_writer_id: string
  }>(
    'SELECT article_id, target_writer_id FROM pledge_drives WHERE id = $1',
    [driveId]
  )

  if (driveRow.rows.length === 0) return
  const drive = driveRow.rows[0]

  // Process pledges in batches of 50
  const pledgesResult = await pool.query<{
    id: string
    pledger_id: string
    amount_pence: number
  }>(
    `SELECT id, pledger_id, amount_pence FROM pledges
     WHERE drive_id = $1 AND status = 'active'
     ORDER BY created_at`,
    [driveId]
  )

  const pledges = pledgesResult.rows
  const batchSize = 50

  for (let i = 0; i < pledges.length; i += batchSize) {
    const batch = pledges.slice(i, i + batchSize)

    await withTransaction(async (client) => {
      for (const pledge of batch) {
        // 1. Create read_event (enters existing settlement pipeline)
        const readEvent = await client.query<{ id: string }>(
          `INSERT INTO read_events
             (reader_id, article_id, writer_id, amount_pence, state)
           VALUES ($1, $2, $3, $4, 'accrued')
           RETURNING id`,
          [pledge.pledger_id, drive.article_id, drive.target_writer_id, pledge.amount_pence]
        )

        // 2. Create article_unlocks — checkArticleAccess() grants access
        await client.query(
          `INSERT INTO article_unlocks (reader_id, article_id, unlocked_via)
           VALUES ($1, $2, 'pledge')
           ON CONFLICT (reader_id, article_id) DO NOTHING`,
          [pledge.pledger_id, drive.article_id]
        )

        // 3. Update reading_tabs balance (charge becomes real)
        await client.query(
          `UPDATE reading_tabs
           SET balance_pence = balance_pence + $1, last_read_at = now()
           WHERE reader_id = $2`,
          [pledge.amount_pence, pledge.pledger_id]
        )

        // 4. Mark pledge as fulfilled
        await client.query(
          `UPDATE pledges SET status = 'fulfilled', read_event_id = $1,
           fulfilled_at = now() WHERE id = $2`,
          [readEvent.rows[0].id, pledge.id]
        )
      }
    })
  }

  // Mark drive as fulfilled, auto-unpin
  await pool.query(
    `UPDATE pledge_drives SET status = 'fulfilled', fulfilled_at = now(),
     pinned = FALSE WHERE id = $1`,
    [driveId]
  )

  // Send notifications to all pledgers (async, non-blocking)
  const pledgerIds = pledges.map(p => p.pledger_id)
  for (const pledgerId of pledgerIds) {
    await pool.query(
      `INSERT INTO notifications (recipient_id, type)
       VALUES ($1, 'pledge_fulfilled')`,
      [pledgerId]
    ).catch(err => {
      logger.error({ err, pledgerId, driveId }, 'Failed to notify pledger')
    })
  }

  logger.info({ driveId, pledgeCount: pledges.length }, 'Pledge drive fulfilled')
}

// =============================================================================
// Deadline expiry — call this from a cron job
// =============================================================================

export async function expireOverdueDrives(): Promise<number> {
  const result = await withTransaction(async (client) => {
    const expired = await client.query<{ id: string }>(
      `UPDATE pledge_drives
       SET status = 'expired', pinned = FALSE
       WHERE status IN ('open', 'funded')
         AND deadline IS NOT NULL
         AND deadline < now()
       RETURNING id`
    )

    if (expired.rows.length > 0) {
      const expiredIds = expired.rows.map(r => r.id)
      await client.query(
        `UPDATE pledges SET status = 'void'
         WHERE drive_id = ANY($1) AND status = 'active'`,
        [expiredIds]
      )
    }

    return expired.rowCount ?? 0
  })

  if (result > 0) {
    logger.info({ count: result }, 'Expired overdue pledge drives')
  }

  return result
}

// =============================================================================
// Nostr event helpers
// =============================================================================

async function publishDriveEvent(
  creatorId: string,
  driveId: string,
  title: string,
  description?: string | null
): Promise<void> {
  try {
    const event = await signEvent(creatorId, {
      kind: PLEDGE_DRIVE_EVENT_KIND,
      content: description ?? '',
      tags: [
        ['d', driveId],
        ['title', title],
      ],
      created_at: Math.floor(Date.now() / 1000),
    })

    await publishToRelay(event as any)

    await pool.query(
      'UPDATE pledge_drives SET nostr_event_id = $1 WHERE id = $2',
      [event.id, driveId]
    )

    logger.debug({ driveId, eventId: event.id }, 'Drive Nostr event published')
  } catch (err) {
    logger.error({ err, driveId }, 'Failed to publish drive Nostr event')
  }
}

async function publishDriveDeletion(creatorId: string, driveId: string): Promise<void> {
  try {
    const drive = await pool.query<{ nostr_event_id: string | null }>(
      'SELECT nostr_event_id FROM pledge_drives WHERE id = $1',
      [driveId]
    )

    if (!drive.rows[0]?.nostr_event_id) return

    const event = await signEvent(creatorId, {
      kind: 5,
      content: '',
      tags: [['e', drive.rows[0].nostr_event_id]],
      created_at: Math.floor(Date.now() / 1000),
    })

    await publishToRelay(event as any)
    logger.debug({ driveId, deletionEventId: event.id }, 'Drive deletion event published')
  } catch (err) {
    logger.error({ err, driveId }, 'Failed to publish drive deletion event')
  }
}
