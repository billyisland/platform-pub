import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth, optionalAuth } from '../middleware/auth.js'
import { requirePublicationPermission, requirePublicationOwner } from '../middleware/publication-auth.js'
import { generateKeypair, signEvent } from '../lib/key-custody-client.js'
import { publishToRelay } from '../lib/nostr-publisher.js'
import { publishToPublication, approveAndPublishArticle } from '../services/publication-publisher.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Publication Routes
//
// CRUD, member management, and invite acceptance for Publications.
//
// POST   /publications                          — Create
// GET    /publications/:slug                    — Public profile
// PATCH  /publications/:id                      — Update settings
// DELETE /publications/:id                      — Archive (Owner only)
//
// GET    /publications/:id/members              — List members
// POST   /publications/:id/members/invite       — Invite member
// POST   /publications/:id/members/accept       — Accept invite
// PATCH  /publications/:id/members/:memberId    — Update member
// DELETE /publications/:id/members/:memberId    — Remove member
// POST   /publications/:id/transfer-ownership   — Transfer Owner
//
// GET    /publications/invites/:token           — Public invite info
// GET    /my/publications                       — Caller's memberships
// =============================================================================

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/

const CreatePublicationSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'Slug must be 3-50 chars, lowercase alphanumeric/hyphens'),
  name: z.string().min(1).max(100),
  tagline: z.string().max(200).optional(),
  about: z.string().max(10000).optional(),
})

const UpdatePublicationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  tagline: z.string().max(200).nullable().optional(),
  about: z.string().max(10000).nullable().optional(),
  logo_blossom_url: z.string().url().nullable().optional(),
  cover_blossom_url: z.string().url().nullable().optional(),
  subscription_price_pence: z.number().int().min(0).optional(),
  annual_discount_pct: z.number().int().min(0).max(100).optional(),
  default_article_price_pence: z.number().int().min(0).optional(),
})

const InviteMemberSchema = z.object({
  email: z.string().email().optional(),
  accountId: z.string().uuid().optional(),
  role: z.enum(['editor_in_chief', 'editor', 'contributor']).default('contributor'),
  contributorType: z.enum(['permanent', 'one_off']).default('permanent'),
  message: z.string().max(500).optional(),
}).refine(d => d.email || d.accountId, { message: 'email or accountId required' })

const UpdateMemberSchema = z.object({
  role: z.enum(['editor_in_chief', 'editor', 'contributor']).optional(),
  contributorType: z.enum(['permanent', 'one_off']).optional(),
  title: z.string().max(100).nullable().optional(),
  revenueShareBps: z.number().int().min(0).max(10000).nullable().optional(),
  canPublish: z.boolean().optional(),
  canEditOthers: z.boolean().optional(),
  canManageMembers: z.boolean().optional(),
  canManageFinances: z.boolean().optional(),
  canManageSettings: z.boolean().optional(),
})

const TransferOwnershipSchema = z.object({
  newOwnerId: z.string().uuid(),
})

/** Default permissions by role */
const ROLE_DEFAULTS = {
  editor_in_chief: {
    can_publish: true, can_edit_others: true,
    can_manage_members: true, can_manage_finances: true, can_manage_settings: true,
  },
  editor: {
    can_publish: true, can_edit_others: true,
    can_manage_members: false, can_manage_finances: false, can_manage_settings: false,
  },
  contributor: {
    can_publish: false, can_edit_others: false,
    can_manage_members: false, can_manage_finances: false, can_manage_settings: false,
  },
} as const

export async function publicationRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /publications — Create a new publication
  // ---------------------------------------------------------------------------

  app.post('/publications', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = CreatePublicationSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const userId = req.session!.sub!
    const { slug, name, tagline, about } = parsed.data

    // Check slug uniqueness
    const existing = await pool.query('SELECT id FROM publications WHERE slug = $1', [slug])
    if (existing.rows.length > 0) {
      return reply.status(409).send({ error: 'Slug already taken' })
    }

    // Generate custodial Nostr keypair
    const keypair = await generateKeypair()

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO publications (slug, name, tagline, about, nostr_pubkey, nostr_privkey_enc)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [slug, name, tagline || null, about || null, keypair.pubkeyHex, keypair.privkeyEncrypted]
      )
      const publicationId = rows[0].id

      // Creator becomes Owner + EiC with all permissions
      const perms = ROLE_DEFAULTS.editor_in_chief
      await client.query(
        `INSERT INTO publication_members
           (publication_id, account_id, role, is_owner, accepted_at,
            can_publish, can_edit_others, can_manage_members, can_manage_finances, can_manage_settings)
         VALUES ($1, $2, 'editor_in_chief', TRUE, now(), $3, $4, $5, $6, $7)`,
        [publicationId, userId, perms.can_publish, perms.can_edit_others,
         perms.can_manage_members, perms.can_manage_finances, perms.can_manage_settings]
      )

      await client.query('COMMIT')

      logger.info({ publicationId, slug, userId }, 'Publication created')
      return reply.status(201).send({ id: publicationId, slug })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // ---------------------------------------------------------------------------
  // GET /publications/:slug — Public profile
  // ---------------------------------------------------------------------------

  app.get<{ Params: { slug: string } }>('/publications/:slug', async (req, reply) => {
    const { slug } = req.params

    const { rows } = await pool.query(
      `SELECT id, slug, name, tagline, about, logo_blossom_url, cover_blossom_url,
              nostr_pubkey, subscription_price_pence, annual_discount_pct,
              default_article_price_pence, theme_config, status, founded_at
       FROM publications
       WHERE slug = $1 AND status = 'active'`,
      [slug]
    )

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Publication not found' })
    }

    return reply.send(rows[0])
  })

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id — Update settings
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/publications/:id',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_settings')] },
    async (req, reply) => {
      const parsed = UpdatePublicationSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { id } = req.params
      const data = parsed.data

      const setClauses: string[] = []
      const values: any[] = []
      let idx = 1

      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) {
          setClauses.push(`${key} = $${idx}`)
          values.push(value)
          idx++
        }
      }

      if (setClauses.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' })
      }

      setClauses.push(`updated_at = now()`)
      values.push(id)
      await pool.query(
        `UPDATE publications SET ${setClauses.join(', ')} WHERE id = $${idx}`,
        values
      )

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /publications/:id — Archive (Owner only)
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string } }>(
    '/publications/:id',
    { preHandler: [requireAuth, requirePublicationOwner()] },
    async (req, reply) => {
      const { id } = req.params

      await pool.query(
        `UPDATE publications SET status = 'archived' WHERE id = $1`,
        [id]
      )

      logger.info({ publicationId: id }, 'Publication archived')
      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /publications/:id/members — List members
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/publications/:id/members',
    async (req, reply) => {
      const { id } = req.params

      const { rows } = await pool.query(
        `SELECT pm.id, pm.account_id, pm.role, pm.contributor_type, pm.title, pm.is_owner,
                pm.revenue_share_bps, pm.can_publish, pm.can_edit_others,
                pm.can_manage_members, pm.can_manage_finances, pm.can_manage_settings,
                a.username, a.display_name, a.avatar_blossom_url, a.nostr_pubkey
         FROM publication_members pm
         JOIN accounts a ON a.id = pm.account_id
         WHERE pm.publication_id = $1 AND pm.removed_at IS NULL
         ORDER BY pm.is_owner DESC, pm.role ASC, a.display_name ASC`,
        [id]
      )

      return reply.send({ members: rows })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/members/invite — Invite a member
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/publications/:id/members/invite',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_members')] },
    async (req, reply) => {
      const parsed = InviteMemberSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { id } = req.params
      const userId = req.session!.sub!
      const { email, accountId, role, contributorType, message } = parsed.data

      const { rows } = await pool.query<{ id: string; token: string }>(
        `INSERT INTO publication_invites
           (publication_id, invited_by, invited_email, invited_account_id, role, contributor_type, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, token`,
        [id, userId, email || null, accountId || null, role, contributorType, message || null]
      )

      // If inviting an existing user, create a notification
      if (accountId) {
        await pool.query(
          `INSERT INTO notifications (recipient_id, actor_id, type)
           VALUES ($1, $2, 'pub_invite_received')
           ON CONFLICT DO NOTHING`,
          [accountId, userId]
        )
      }

      logger.info({ publicationId: id, inviteId: rows[0].id, role }, 'Publication invite sent')
      return reply.status(201).send({ inviteId: rows[0].id, token: rows[0].token })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/members/accept — Accept an invite
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/publications/:id/members/accept',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { token } = req.body as { token: string }
      if (!token) {
        return reply.status(400).send({ error: 'Token required' })
      }

      const userId = req.session!.sub!

      const { rows: invites } = await pool.query(
        `SELECT * FROM publication_invites
         WHERE token = $1 AND publication_id = $2
           AND accepted_at IS NULL AND declined_at IS NULL
           AND expires_at > now()`,
        [token, req.params.id]
      )

      if (invites.length === 0) {
        return reply.status(404).send({ error: 'Invite not found or expired' })
      }

      const invite = invites[0]

      // Verify the invite is for this user (by email or account ID)
      if (invite.invited_account_id && invite.invited_account_id !== userId) {
        return reply.status(403).send({ error: 'This invite is for another user' })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const perms = ROLE_DEFAULTS[invite.role as keyof typeof ROLE_DEFAULTS]

        await client.query(
          `INSERT INTO publication_members
             (publication_id, account_id, role, contributor_type, accepted_at,
              can_publish, can_edit_others, can_manage_members, can_manage_finances, can_manage_settings)
           VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9)
           ON CONFLICT (publication_id, account_id) DO UPDATE SET
             role = EXCLUDED.role, contributor_type = EXCLUDED.contributor_type,
             removed_at = NULL, accepted_at = now()`,
          [invite.publication_id, userId, invite.role, invite.contributor_type,
           perms.can_publish, perms.can_edit_others, perms.can_manage_members,
           perms.can_manage_finances, perms.can_manage_settings]
        )

        await client.query(
          `UPDATE publication_invites SET accepted_at = now() WHERE id = $1`,
          [invite.id]
        )

        await client.query('COMMIT')

        // Notify members with can_manage_members
        await pool.query(
          `INSERT INTO notifications (recipient_id, actor_id, type)
           SELECT pm.account_id, $1, 'pub_member_joined'
           FROM publication_members pm
           WHERE pm.publication_id = $2 AND pm.can_manage_members = TRUE
             AND pm.removed_at IS NULL AND pm.account_id != $1
           ON CONFLICT DO NOTHING`,
          [userId, invite.publication_id]
        )

        logger.info({ publicationId: invite.publication_id, userId, role: invite.role }, 'Invite accepted')
        return reply.send({ ok: true })
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id/members/:memberId — Update member
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string; memberId: string } }>(
    '/publications/:id/members/:memberId',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_members')] },
    async (req, reply) => {
      const parsed = UpdateMemberSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { id, memberId } = req.params
      const data = parsed.data

      // Cannot modify the Owner
      const { rows: target } = await pool.query(
        `SELECT is_owner FROM publication_members WHERE id = $1 AND publication_id = $2`,
        [memberId, id]
      )
      if (target.length === 0) {
        return reply.status(404).send({ error: 'Member not found' })
      }
      if (target[0].is_owner) {
        return reply.status(403).send({ error: 'Cannot modify the Owner' })
      }

      const setClauses: string[] = []
      const values: any[] = []
      let idx = 1

      const fieldMap: Record<string, string> = {
        role: 'role', contributorType: 'contributor_type', title: 'title',
        revenueShareBps: 'revenue_share_bps', canPublish: 'can_publish',
        canEditOthers: 'can_edit_others', canManageMembers: 'can_manage_members',
        canManageFinances: 'can_manage_finances', canManageSettings: 'can_manage_settings',
      }

      for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
        const val = (data as any)[jsKey]
        if (val !== undefined) {
          setClauses.push(`${dbCol} = $${idx}`)
          values.push(val)
          idx++
        }
      }

      if (setClauses.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' })
      }

      values.push(memberId, id)
      await pool.query(
        `UPDATE publication_members SET ${setClauses.join(', ')}
         WHERE id = $${idx} AND publication_id = $${idx + 1}`,
        values
      )

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /publications/:id/members/:memberId — Remove member
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string; memberId: string } }>(
    '/publications/:id/members/:memberId',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_members')] },
    async (req, reply) => {
      const { id, memberId } = req.params

      // Cannot remove the Owner
      const { rows: target } = await pool.query(
        `SELECT is_owner, account_id FROM publication_members WHERE id = $1 AND publication_id = $2`,
        [memberId, id]
      )
      if (target.length === 0) {
        return reply.status(404).send({ error: 'Member not found' })
      }
      if (target[0].is_owner) {
        return reply.status(403).send({ error: 'Cannot remove the Owner — transfer ownership first' })
      }

      await pool.query(
        `UPDATE publication_members SET removed_at = now() WHERE id = $1`,
        [memberId]
      )

      // Notify members with can_manage_members
      await pool.query(
        `INSERT INTO notifications (recipient_id, actor_id, type)
         SELECT pm.account_id, $1, 'pub_member_left'
         FROM publication_members pm
         WHERE pm.publication_id = $2 AND pm.can_manage_members = TRUE
           AND pm.removed_at IS NULL AND pm.account_id != $1
         ON CONFLICT DO NOTHING`,
        [target[0].account_id, id]
      )

      logger.info({ publicationId: id, memberId }, 'Member removed')
      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/transfer-ownership — Transfer Owner
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/publications/:id/transfer-ownership',
    { preHandler: [requireAuth, requirePublicationOwner()] },
    async (req, reply) => {
      const parsed = TransferOwnershipSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { id } = req.params
      const currentOwnerId = req.session!.sub!
      const { newOwnerId } = parsed.data

      // Verify new owner is an active EiC
      const { rows: newOwner } = await pool.query(
        `SELECT id FROM publication_members
         WHERE publication_id = $1 AND account_id = $2
           AND role = 'editor_in_chief' AND removed_at IS NULL`,
        [id, newOwnerId]
      )
      if (newOwner.length === 0) {
        return reply.status(400).send({ error: 'New owner must be an active Editor-in-Chief' })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Remove owner flag from current owner
        await client.query(
          `UPDATE publication_members SET is_owner = FALSE
           WHERE publication_id = $1 AND account_id = $2`,
          [id, currentOwnerId]
        )

        // Set owner flag on new owner
        await client.query(
          `UPDATE publication_members SET is_owner = TRUE
           WHERE publication_id = $1 AND account_id = $2`,
          [id, newOwnerId]
        )

        await client.query('COMMIT')

        logger.info({ publicationId: id, from: currentOwnerId, to: newOwnerId }, 'Ownership transferred')
        return reply.send({ ok: true })
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    }
  )

  // ---------------------------------------------------------------------------
  // GET /publications/invites/:token — Public invite info
  // ---------------------------------------------------------------------------

  app.get<{ Params: { token: string } }>(
    '/publications/invites/:token',
    async (req, reply) => {
      const { token } = req.params

      const { rows } = await pool.query(
        `SELECT pi.id, pi.role, pi.contributor_type, pi.message, pi.expires_at,
                p.name AS publication_name, p.slug AS publication_slug,
                p.logo_blossom_url AS publication_logo,
                a.display_name AS inviter_name
         FROM publication_invites pi
         JOIN publications p ON p.id = pi.publication_id
         JOIN accounts a ON a.id = pi.invited_by
         WHERE pi.token = $1
           AND pi.accepted_at IS NULL AND pi.declined_at IS NULL
           AND pi.expires_at > now()`,
        [token]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Invite not found or expired' })
      }

      return reply.send(rows[0])
    }
  )

  // ---------------------------------------------------------------------------
  // GET /my/publications — Caller's publication memberships
  // ---------------------------------------------------------------------------

  app.get('/my/publications', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub!

    const { rows } = await pool.query(
      `SELECT p.id, p.slug, p.name, p.logo_blossom_url,
              pm.role, pm.is_owner, pm.can_publish, pm.can_edit_others,
              pm.can_manage_members, pm.can_manage_finances, pm.can_manage_settings
       FROM publication_members pm
       JOIN publications p ON p.id = pm.publication_id
       WHERE pm.account_id = $1 AND pm.removed_at IS NULL AND p.status = 'active'
       ORDER BY p.name ASC`,
      [userId]
    )

    return reply.send({ publications: rows })
  })

  // ===========================================================================
  // CMS Routes — Publication article management
  // ===========================================================================

  const SubmitArticleSchema = z.object({
    title: z.string().min(1).max(500),
    summary: z.string().max(500).optional(),
    content: z.string().min(1),
    fullContent: z.string().min(1),
    accessMode: z.enum(['public', 'paywalled']).default('public'),
    pricePence: z.number().int().min(0).optional(),
    gatePositionPct: z.number().int().min(1).max(99).optional(),
    showOnWriterProfile: z.boolean().default(true),
    existingDTag: z.string().optional(),
  })

  // ---------------------------------------------------------------------------
  // GET /publications/:id/articles — CMS article list
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string; offset?: string } }>(
    '/publications/:id/articles',
    { preHandler: [requireAuth, requirePublicationPermission()] },
    async (req, reply) => {
      const { id } = req.params
      const member = req.publicationMember!
      const status = (req.query as any).status
      const limit = Math.min(parseInt((req.query as any).limit ?? '50', 10), 100)
      const offset = parseInt((req.query as any).offset ?? '0', 10)

      let statusFilter = ''
      const values: any[] = [id]

      // Contributors only see their own articles
      const isContributorOnly = member.role === 'contributor' && !member.can_edit_others
      if (isContributorOnly) {
        values.push(member.account_id)
      }

      if (status) {
        values.push(status)
        statusFilter = `AND a.publication_article_status = $${values.length}`
      }

      const writerFilter = isContributorOnly ? `AND a.writer_id = $2` : ''

      const { rows } = await pool.query(
        `SELECT a.id, a.title, a.slug, a.nostr_d_tag AS d_tag, a.access_mode,
                a.price_pence, a.publication_article_status AS status,
                a.published_at, a.created_at, a.show_on_writer_profile,
                acc.username AS author_username, acc.display_name AS author_display_name
         FROM articles a
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE a.publication_id = $1 AND a.deleted_at IS NULL
           ${writerFilter} ${statusFilter}
         ORDER BY a.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        values
      )

      return reply.send({ articles: rows })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/articles — Submit or publish an article
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/publications/:id/articles',
    { preHandler: [requireAuth, requirePublicationPermission()] },
    async (req, reply) => {
      const parsed = SubmitArticleSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { id } = req.params
      const member = req.publicationMember!
      const userId = req.session!.sub!
      const userPubkey = req.session!.pubkey!

      const result = await publishToPublication({
        publicationId: id,
        authorId: userId,
        authorPubkey: userPubkey,
        canPublish: member.can_publish,
        ...parsed.data,
      })

      return reply.status(201).send(result)
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id/articles/:articleId — Edit article metadata
  // ---------------------------------------------------------------------------

  const EditArticleSchema = z.object({
    title: z.string().min(1).max(500).optional(),
    summary: z.string().max(500).nullable().optional(),
    pricePence: z.number().int().min(0).optional(),
    showOnWriterProfile: z.boolean().optional(),
  })

  app.patch<{ Params: { id: string; articleId: string } }>(
    '/publications/:id/articles/:articleId',
    { preHandler: [requireAuth, requirePublicationPermission('can_edit_others')] },
    async (req, reply) => {
      const parsed = EditArticleSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { id, articleId } = req.params
      const data = parsed.data

      const setClauses: string[] = []
      const values: any[] = []
      let idx = 1

      const fields: Record<string, string> = {
        title: 'title', summary: 'summary',
        pricePence: 'price_pence', showOnWriterProfile: 'show_on_writer_profile',
      }

      for (const [jsKey, dbCol] of Object.entries(fields)) {
        const val = (data as any)[jsKey]
        if (val !== undefined) {
          setClauses.push(`${dbCol} = $${idx}`)
          values.push(val)
          idx++
        }
      }

      if (setClauses.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' })
      }

      values.push(articleId, id)
      await pool.query(
        `UPDATE articles SET ${setClauses.join(', ')}
         WHERE id = $${idx} AND publication_id = $${idx + 1}`,
        values
      )

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /publications/:id/articles/:articleId — Soft-delete article
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string; articleId: string } }>(
    '/publications/:id/articles/:articleId',
    { preHandler: [requireAuth, requirePublicationPermission('can_edit_others')] },
    async (req, reply) => {
      const { id, articleId } = req.params

      const articleResult = await pool.query<{
        nostr_event_id: string
        nostr_d_tag: string
        nostr_pubkey: string
      }>(
        `UPDATE articles SET deleted_at = now(), publication_article_status = 'unpublished'
         WHERE id = $1 AND publication_id = $2
         RETURNING nostr_event_id, nostr_d_tag,
           (SELECT nostr_pubkey FROM publications WHERE id = $2) AS nostr_pubkey`,
        [articleId, id]
      )

      if (articleResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      const article = articleResult.rows[0]

      // Publish kind 5 deletion event to the relay
      try {
        const deletionEvent = await signEvent(id, {
          kind: 5,
          content: '',
          tags: [
            ['e', article.nostr_event_id],
            ['a', `30023:${article.nostr_pubkey}:${article.nostr_d_tag}`],
          ],
          created_at: Math.floor(Date.now() / 1000),
        }, 'publication')
        await publishToRelay(deletionEvent as any)
        logger.info({ articleId, deletionEventId: deletionEvent.id }, 'Kind 5 deletion event published for publication article')
      } catch (err) {
        // Non-fatal: DB is source of truth; feed will still exclude via deleted_at
        logger.error({ err, articleId }, 'Failed to publish kind 5 deletion event for publication article')
      }

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/articles/:articleId/publish — Approve + publish
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string; articleId: string } }>(
    '/publications/:id/articles/:articleId/publish',
    { preHandler: [requireAuth, requirePublicationPermission('can_publish')] },
    async (req, reply) => {
      const { id, articleId } = req.params
      const editorId = req.session!.sub!

      const result = await approveAndPublishArticle(id, articleId, editorId)
      return reply.send(result)
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/articles/:articleId/unpublish — Pull article
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string; articleId: string } }>(
    '/publications/:id/articles/:articleId/unpublish',
    { preHandler: [requireAuth, requirePublicationPermission('can_publish')] },
    async (req, reply) => {
      const { id, articleId } = req.params

      await pool.query(
        `UPDATE articles SET publication_article_status = 'unpublished', published_at = NULL
         WHERE id = $1 AND publication_id = $2`,
        [articleId, id]
      )

      return reply.send({ ok: true })
    }
  )

  // ===========================================================================
  // Reader-facing public routes
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // GET /publications/:slug/public — Full public profile (for homepage)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { slug: string } }>(
    '/publications/:slug/public',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { slug } = req.params

      const { rows } = await pool.query(
        `SELECT p.id, p.slug, p.name, p.tagline, p.about, p.logo_blossom_url, p.cover_blossom_url,
                p.nostr_pubkey, p.subscription_price_pence, p.annual_discount_pct,
                p.default_article_price_pence, p.theme_config, p.status, p.founded_at,
                (SELECT COUNT(*) FROM publication_follows WHERE publication_id = p.id) AS follower_count,
                (SELECT COUNT(*) FROM publication_members WHERE publication_id = p.id AND removed_at IS NULL) AS member_count,
                (SELECT COUNT(*) FROM articles WHERE publication_id = p.id AND published_at IS NOT NULL AND deleted_at IS NULL) AS article_count
         FROM publications p
         WHERE p.slug = $1 AND p.status = 'active'`,
        [slug]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Publication not found' })
      }

      const pub = rows[0]

      // Check if the reader follows this publication
      let isFollowing = false
      let isSubscribed = false
      const readerId = req.session?.sub
      if (readerId) {
        const [followRes, subRes] = await Promise.all([
          pool.query(
            'SELECT 1 FROM publication_follows WHERE follower_id = $1 AND publication_id = $2',
            [readerId, pub.id]
          ),
          pool.query(
            `SELECT 1 FROM subscriptions WHERE reader_id = $1 AND publication_id = $2
               AND status IN ('active', 'cancelled') AND current_period_end > now()`,
            [readerId, pub.id]
          ),
        ])
        isFollowing = followRes.rows.length > 0
        isSubscribed = subRes.rows.length > 0
      }

      return reply.send({ ...pub, isFollowing, isSubscribed })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /publications/by-slug/:slug/articles — Published articles (paginated)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { slug: string }; Querystring: { limit?: string; offset?: string } }>(
    '/publications/by-slug/:slug/articles',
    async (req, reply) => {
      const { slug } = req.params
      const limit = Math.min(parseInt((req.query as any).limit ?? '20', 10), 50)
      const offset = parseInt((req.query as any).offset ?? '0', 10)

      const { rows: pubs } = await pool.query<{ id: string }>(
        `SELECT id FROM publications WHERE slug = $1 AND status = 'active'`,
        [slug]
      )
      if (pubs.length === 0) {
        return reply.status(404).send({ error: 'Publication not found' })
      }

      const { rows } = await pool.query(
        `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, a.title, a.slug, a.summary,
                a.content_free, a.word_count, a.access_mode, a.price_pence,
                a.published_at,
                acc.username AS author_username, acc.display_name AS author_display_name,
                acc.avatar_blossom_url AS author_avatar
         FROM articles a
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE a.publication_id = $1 AND a.published_at IS NOT NULL AND a.deleted_at IS NULL
           AND a.publication_article_status = 'published'
         ORDER BY a.published_at DESC
         LIMIT $2 OFFSET $3`,
        [pubs[0].id, limit, offset]
      )

      return reply.send({ articles: rows })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /publications/:slug/masthead — Public member list with roles/titles
  // ---------------------------------------------------------------------------

  app.get<{ Params: { slug: string } }>(
    '/publications/:slug/masthead',
    async (req, reply) => {
      const { slug } = req.params

      const { rows: pubs } = await pool.query<{ id: string }>(
        `SELECT id FROM publications WHERE slug = $1 AND status = 'active'`,
        [slug]
      )
      if (pubs.length === 0) {
        return reply.status(404).send({ error: 'Publication not found' })
      }

      const { rows } = await pool.query(
        `SELECT pm.role, pm.title, pm.is_owner,
                a.username, a.display_name, a.avatar_blossom_url, a.bio
         FROM publication_members pm
         JOIN accounts a ON a.id = pm.account_id
         WHERE pm.publication_id = $1 AND pm.removed_at IS NULL AND a.status = 'active'
         ORDER BY pm.is_owner DESC, pm.role ASC, a.display_name ASC`,
        [pubs[0].id]
      )

      return reply.send({ members: rows })
    }
  )

  // ===========================================================================
  // Rate Card & Payroll & Earnings Routes (Phase 5 — Revenue)
  // ===========================================================================

  const RateCardSchema = z.object({
    subscriptionPricePence: z.number().int().min(0).max(999999).optional(),
    annualDiscountPct: z.number().int().min(0).max(100).optional(),
    defaultArticlePricePence: z.number().int().min(0).max(999999).optional(),
  })

  const UpdatePayrollSchema = z.object({
    shares: z.array(z.object({
      memberId: z.string().uuid(),
      revenueShareBps: z.number().int().min(0).max(10000),
    })),
  })

  const ArticleShareSchema = z.object({
    accountId: z.string().uuid(),
    shareType: z.enum(['revenue_bps', 'flat_fee_pence']),
    shareValue: z.number().int().min(0),
  })

  // ---------------------------------------------------------------------------
  // GET /publications/:id/rate-card — View pricing
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/publications/:id/rate-card',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const { id } = req.params
      const { rows } = await pool.query<{
        subscription_price_pence: number
        annual_discount_pct: number
        default_article_price_pence: number
      }>(
        `SELECT subscription_price_pence, annual_discount_pct, default_article_price_pence
         FROM publications WHERE id = $1`,
        [id]
      )
      if (rows.length === 0) return reply.status(404).send({ error: 'Publication not found' })
      const r = rows[0]
      return reply.send({
        subscriptionPricePence: r.subscription_price_pence,
        annualDiscountPct: r.annual_discount_pct,
        defaultArticlePricePence: r.default_article_price_pence,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id/rate-card — Update pricing
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/publications/:id/rate-card',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const parsed = RateCardSchema.safeParse(req.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
      const { subscriptionPricePence, annualDiscountPct, defaultArticlePricePence } = parsed.data

      const sets: string[] = []
      const vals: any[] = []
      let idx = 1

      if (subscriptionPricePence !== undefined) { sets.push(`subscription_price_pence = $${idx++}`); vals.push(subscriptionPricePence) }
      if (annualDiscountPct !== undefined) { sets.push(`annual_discount_pct = $${idx++}`); vals.push(annualDiscountPct) }
      if (defaultArticlePricePence !== undefined) { sets.push(`default_article_price_pence = $${idx++}`); vals.push(defaultArticlePricePence) }

      if (sets.length === 0) return reply.status(400).send({ error: 'No fields to update' })

      sets.push(`updated_at = now()`)
      vals.push(req.params.id)

      await pool.query(
        `UPDATE publications SET ${sets.join(', ')} WHERE id = $${idx}`,
        vals
      )

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /publications/:id/payroll — View payroll card
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/publications/:id/payroll',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const { id } = req.params

      // Standing members with their shares
      const { rows: members } = await pool.query(
        `SELECT pm.id AS member_id, pm.account_id, pm.role, pm.contributor_type, pm.title,
                pm.revenue_share_bps, pm.is_owner,
                a.username, a.display_name, a.avatar_blossom_url
         FROM publication_members pm
         JOIN accounts a ON a.id = pm.account_id
         WHERE pm.publication_id = $1 AND pm.removed_at IS NULL
         ORDER BY pm.revenue_share_bps DESC NULLS LAST, a.display_name ASC`,
        [id]
      )

      // Per-article overrides
      const { rows: articleShares } = await pool.query(
        `SELECT pas.id, pas.article_id, pas.account_id, pas.share_type, pas.share_value, pas.paid_out,
                art.title AS article_title, art.slug AS article_slug,
                a.username, a.display_name
         FROM publication_article_shares pas
         JOIN articles art ON art.id = pas.article_id
         JOIN accounts a ON a.id = pas.account_id
         WHERE pas.publication_id = $1
         ORDER BY art.published_at DESC NULLS LAST`,
        [id]
      )

      const totalStandingBps = members.reduce((sum: number, m: any) => sum + (m.revenue_share_bps || 0), 0)

      return reply.send({
        members: members.map((m: any) => ({
          memberId: m.member_id,
          accountId: m.account_id,
          username: m.username,
          displayName: m.display_name,
          avatarBlossomUrl: m.avatar_blossom_url,
          role: m.role,
          contributorType: m.contributor_type,
          title: m.title,
          isOwner: m.is_owner,
          revenueShareBps: m.revenue_share_bps,
        })),
        articleShares: articleShares.map((s: any) => ({
          id: s.id,
          articleId: s.article_id,
          accountId: s.account_id,
          username: s.username,
          displayName: s.display_name,
          articleTitle: s.article_title,
          articleSlug: s.article_slug,
          shareType: s.share_type,
          shareValue: s.share_value,
          paidOut: s.paid_out,
        })),
        totalStandingBps,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id/payroll — Update standing shares
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/publications/:id/payroll',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const parsed = UpdatePayrollSchema.safeParse(req.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
      const { shares } = parsed.data

      // Validate total does not exceed 10,000 bps
      const totalBps = shares.reduce((sum, s) => sum + s.revenueShareBps, 0)
      if (totalBps > 10000) {
        return reply.status(400).send({ error: 'Total standing shares cannot exceed 10,000 bps (100%)' })
      }

      const { id } = req.params

      // Verify all member IDs belong to this publication
      const { rows: validMembers } = await pool.query<{ id: string }>(
        `SELECT id FROM publication_members
         WHERE publication_id = $1 AND removed_at IS NULL`,
        [id]
      )
      const validIds = new Set(validMembers.map(m => m.id))
      for (const s of shares) {
        if (!validIds.has(s.memberId)) {
          return reply.status(400).send({ error: `Member ${s.memberId} not found in this publication` })
        }
      }

      // Update each member's share
      for (const s of shares) {
        await pool.query(
          `UPDATE publication_members SET revenue_share_bps = $1, updated_at = now()
           WHERE id = $2 AND publication_id = $3`,
          [s.revenueShareBps, s.memberId, id]
        )
      }

      return reply.send({ ok: true, totalBps })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id/payroll/article/:articleId — Set per-article override
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string; articleId: string } }>(
    '/publications/:id/payroll/article/:articleId',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const parsed = ArticleShareSchema.safeParse(req.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
      const { accountId, shareType, shareValue } = parsed.data
      const { id, articleId } = req.params

      // Verify article belongs to this publication
      const { rows: articles } = await pool.query(
        `SELECT id FROM articles WHERE id = $1 AND publication_id = $2`,
        [articleId, id]
      )
      if (articles.length === 0) {
        return reply.status(404).send({ error: 'Article not found in this publication' })
      }

      // Upsert the share
      await pool.query(
        `INSERT INTO publication_article_shares (publication_id, article_id, account_id, share_type, share_value)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (article_id, account_id) DO UPDATE SET
           share_type = EXCLUDED.share_type,
           share_value = EXCLUDED.share_value,
           paid_out = FALSE`,
        [id, articleId, accountId, shareType, shareValue]
      )

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /publications/:id/earnings — Revenue dashboard data
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/publications/:id/earnings',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const { id } = req.params

      // Load platform fee from config
      const { rows: feeRows } = await pool.query<{ value: string }>(
        `SELECT value FROM platform_config WHERE key = 'platform_fee_bps'`
      )
      const feeBps = feeRows.length > 0 ? parseInt(feeRows[0].value, 10) : 800

      // Summary totals: gross reads for publication articles, net after platform fee
      const { rows: [summary] } = await pool.query<{
        gross_pence: string
        net_pence: string
        pending_pence: string
        paid_pence: string
        read_count: string
      }>(
        `SELECT
           COALESCE(SUM(r.amount_pence), 0) AS gross_pence,
           COALESCE(SUM(r.amount_pence - FLOOR(r.amount_pence * $2 / 10000)), 0) AS net_pence,
           COALESCE(SUM(CASE WHEN r.state = 'platform_settled'
             THEN r.amount_pence - FLOOR(r.amount_pence * $2 / 10000) ELSE 0 END), 0) AS pending_pence,
           COALESCE(SUM(CASE WHEN r.state = 'writer_paid'
             THEN r.amount_pence - FLOOR(r.amount_pence * $2 / 10000) ELSE 0 END), 0) AS paid_pence,
           COUNT(r.id) AS read_count
         FROM read_events r
         JOIN articles a ON a.id = r.article_id
         WHERE a.publication_id = $1
           AND r.state IN ('platform_settled', 'writer_paid')`,
        [id, feeBps]
      )

      // Per-article breakdown
      const { rows: articles } = await pool.query(
        `SELECT
           a.id AS article_id, a.title, a.slug, a.published_at,
           COUNT(r.id) AS read_count,
           COALESCE(SUM(r.amount_pence - FLOOR(r.amount_pence * $2 / 10000)), 0) AS net_pence
         FROM articles a
         LEFT JOIN read_events r ON r.article_id = a.id AND r.state IN ('platform_settled', 'writer_paid')
         WHERE a.publication_id = $1 AND a.published_at IS NOT NULL AND a.deleted_at IS NULL
         GROUP BY a.id, a.title, a.slug, a.published_at
         ORDER BY net_pence DESC`,
        [id, feeBps]
      )

      // Recent payouts
      const { rows: payouts } = await pool.query(
        `SELECT pp.id, pp.total_pool_pence, pp.platform_fee_pence, pp.flat_fees_paid_pence,
                pp.remaining_pool_pence, pp.status, pp.triggered_at, pp.completed_at,
                json_agg(json_build_object(
                  'accountId', pps.account_id,
                  'username', acc.username,
                  'displayName', acc.display_name,
                  'amountPence', pps.amount_pence,
                  'shareType', pps.share_type,
                  'shareBps', pps.share_bps,
                  'status', pps.status
                ) ORDER BY pps.amount_pence DESC) AS splits
         FROM publication_payouts pp
         LEFT JOIN publication_payout_splits pps ON pps.publication_payout_id = pp.id
         LEFT JOIN accounts acc ON acc.id = pps.account_id
         WHERE pp.publication_id = $1
         GROUP BY pp.id
         ORDER BY pp.triggered_at DESC
         LIMIT 20`,
        [id]
      )

      return reply.send({
        summary: {
          grossPence: parseInt(summary.gross_pence, 10),
          netPence: parseInt(summary.net_pence, 10),
          pendingPence: parseInt(summary.pending_pence, 10),
          paidPence: parseInt(summary.paid_pence, 10),
          readCount: parseInt(summary.read_count, 10),
        },
        articles: articles.map((a: any) => ({
          articleId: a.article_id,
          title: a.title,
          slug: a.slug,
          publishedAt: a.published_at,
          readCount: parseInt(a.read_count, 10),
          netPence: parseInt(a.net_pence, 10),
        })),
        payouts: payouts.map((p: any) => ({
          id: p.id,
          totalPoolPence: p.total_pool_pence,
          platformFeePence: p.platform_fee_pence,
          flatFeesPaidPence: p.flat_fees_paid_pence,
          remainingPoolPence: p.remaining_pool_pence,
          status: p.status,
          triggeredAt: p.triggered_at,
          completedAt: p.completed_at,
          splits: p.splits?.[0]?.accountId ? p.splits : [],
        })),
      })
    }
  )
}
