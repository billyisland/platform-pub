import type { FastifyRequest, FastifyReply } from 'fastify'
import { pool } from '../../shared/src/db/client.js'

// =============================================================================
// Publication Auth Middleware
//
// Checks that the authenticated user is an active member of the requested
// publication with the required permissions. Attaches the member record to
// req.publicationMember for downstream route handlers.
// =============================================================================

export interface PublicationMember {
  id: string
  publication_id: string
  account_id: string
  role: string
  contributor_type: string
  title: string | null
  is_owner: boolean
  revenue_share_bps: number | null
  can_publish: boolean
  can_edit_others: boolean
  can_manage_members: boolean
  can_manage_finances: boolean
  can_manage_settings: boolean
}

declare module 'fastify' {
  interface FastifyRequest {
    publicationMember?: PublicationMember
  }
}

export function requirePublicationPermission(...requiredPermissions: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.session?.sub
    const publicationId = (req.params as any).publicationId || (req.params as any).id

    if (!userId || !publicationId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { rows } = await pool.query<PublicationMember>(
      `SELECT * FROM publication_members
       WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
      [publicationId, userId]
    )

    if (rows.length === 0) {
      return reply.status(403).send({ error: 'Not a member of this publication' })
    }

    const member = rows[0]

    for (const perm of requiredPermissions) {
      if (!(member as any)[perm]) {
        return reply.status(403).send({
          error: `Missing permission: ${perm}`
        })
      }
    }

    req.publicationMember = member
  }
}

export function requirePublicationOwner() {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.session?.sub
    const publicationId = (req.params as any).publicationId || (req.params as any).id

    if (!userId || !publicationId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { rows } = await pool.query<PublicationMember>(
      `SELECT * FROM publication_members
       WHERE publication_id = $1 AND account_id = $2
         AND is_owner = TRUE AND removed_at IS NULL`,
      [publicationId, userId]
    )

    if (rows.length === 0) {
      return reply.status(403).send({ error: 'Owner access required' })
    }

    req.publicationMember = rows[0]
  }
}
