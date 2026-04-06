import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import { requirePublicationPermission, requirePublicationOwner } from '../middleware/publication-auth.js'
import { generateKeypair } from '../lib/key-custody-client.js'
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
}
