import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Draft Routes
//
// POST   /drafts          — Save or update a draft
// GET    /drafts          — List writer's drafts
// GET    /drafts/:id      — Load a single draft
// DELETE /drafts/:id      — Delete a draft
//
// Drafts are stored in the article_drafts table. One draft per d-tag
// (for edits of existing articles) or one auto-created per new article.
// =============================================================================

const SaveDraftSchema = z.object({
  title: z.string().max(500).optional(),
  content: z.string().optional(),
  gatePositionPct: z.number().int().min(0).max(100).optional(),
  pricePence: z.number().int().min(0).optional(),
  dTag: z.string().optional(),   // set when editing an existing published article
})

export async function draftRoutes(app: FastifyInstance) {

  // POST /drafts — upsert a draft
  app.post('/drafts', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = SaveDraftSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const writerId = req.session!.sub!
    const data = parsed.data

    try {
      // If we have a dTag, upsert by (writer_id, nostr_d_tag)
      // Otherwise create a new draft row
      if (data.dTag) {
        const result = await pool.query<{ id: string; auto_saved_at: string }>(
          `INSERT INTO article_drafts (writer_id, nostr_d_tag, title, content_raw, gate_position_pct, price_pence, auto_saved_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (writer_id, nostr_d_tag) WHERE nostr_d_tag IS NOT NULL
           DO UPDATE SET
             title = COALESCE(EXCLUDED.title, article_drafts.title),
             content_raw = COALESCE(EXCLUDED.content_raw, article_drafts.content_raw),
             gate_position_pct = COALESCE(EXCLUDED.gate_position_pct, article_drafts.gate_position_pct),
             price_pence = COALESCE(EXCLUDED.price_pence, article_drafts.price_pence),
             auto_saved_at = now()
           RETURNING id, auto_saved_at`,
          [writerId, data.dTag, data.title ?? null, data.content ?? null, data.gatePositionPct ?? null, data.pricePence ?? null]
        )

        return reply.status(200).send({
          draftId: result.rows[0].id,
          autoSavedAt: result.rows[0].auto_saved_at,
        })
      } else {
        // New draft — check if writer already has a "no dTag" draft, update it
        const existing = await pool.query<{ id: string }>(
          `SELECT id FROM article_drafts
           WHERE writer_id = $1 AND nostr_d_tag IS NULL
           ORDER BY auto_saved_at DESC LIMIT 1`,
          [writerId]
        )

        if (existing.rows.length > 0) {
          const result = await pool.query<{ id: string; auto_saved_at: string }>(
            `UPDATE article_drafts
             SET title = COALESCE($1, title),
                 content_raw = COALESCE($2, content_raw),
                 gate_position_pct = COALESCE($3, gate_position_pct),
                 price_pence = COALESCE($4, price_pence),
                 auto_saved_at = now()
             WHERE id = $5
             RETURNING id, auto_saved_at`,
            [data.title ?? null, data.content ?? null, data.gatePositionPct ?? null, data.pricePence ?? null, existing.rows[0].id]
          )

          return reply.status(200).send({
            draftId: result.rows[0].id,
            autoSavedAt: result.rows[0].auto_saved_at,
          })
        }

        const result = await pool.query<{ id: string; auto_saved_at: string }>(
          `INSERT INTO article_drafts (writer_id, title, content_raw, gate_position_pct, price_pence, auto_saved_at)
           VALUES ($1, $2, $3, $4, $5, now())
           RETURNING id, auto_saved_at`,
          [writerId, data.title ?? null, data.content ?? null, data.gatePositionPct ?? null, data.pricePence ?? null]
        )

        return reply.status(201).send({
          draftId: result.rows[0].id,
          autoSavedAt: result.rows[0].auto_saved_at,
        })
      }
    } catch (err) {
      logger.error({ err, writerId }, 'Draft save failed')
      return reply.status(500).send({ error: 'Draft save failed' })
    }
  })

  // GET /drafts — list writer's drafts
  app.get('/drafts', { preHandler: requireAuth }, async (req, reply) => {
    const writerId = req.session!.sub!

    const { rows } = await pool.query<{
      id: string
      title: string | null
      nostr_d_tag: string | null
      auto_saved_at: string
    }>(
      `SELECT id, title, nostr_d_tag, auto_saved_at
       FROM article_drafts
       WHERE writer_id = $1
       ORDER BY auto_saved_at DESC
       LIMIT 50`,
      [writerId]
    )

    return reply.status(200).send({
      drafts: rows.map(r => ({
        draftId: r.id,
        title: r.title,
        dTag: r.nostr_d_tag,
        autoSavedAt: r.auto_saved_at,
      })),
    })
  })

  // GET /drafts/:id — load a single draft
  app.get<{ Params: { id: string } }>(
    '/drafts/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!

      const { rows } = await pool.query<{
        id: string
        title: string | null
        content_raw: string | null
        nostr_d_tag: string | null
        gate_position_pct: number | null
        price_pence: number | null
        auto_saved_at: string
      }>(
        `SELECT id, title, content_raw, nostr_d_tag, gate_position_pct, price_pence, auto_saved_at
         FROM article_drafts
         WHERE id = $1 AND writer_id = $2`,
        [req.params.id, writerId]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Draft not found' })
      }

      const r = rows[0]
      return reply.status(200).send({
        draftId: r.id,
        title: r.title,
        content: r.content_raw,
        dTag: r.nostr_d_tag,
        gatePositionPct: r.gate_position_pct,
        pricePence: r.price_pence,
        autoSavedAt: r.auto_saved_at,
      })
    }
  )

  // DELETE /drafts/:id
  app.delete<{ Params: { id: string } }>(
    '/drafts/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!

      await pool.query(
        'DELETE FROM article_drafts WHERE id = $1 AND writer_id = $2',
        [req.params.id, writerId]
      )

      return reply.status(200).send({ ok: true })
    }
  )
}
