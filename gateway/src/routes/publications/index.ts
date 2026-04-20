import type { FastifyInstance } from 'fastify'
import { publicationCoreRoutes } from './core.js'
import { publicationMembersRoutes } from './members.js'
import { publicationCmsRoutes } from './cms.js'
import { publicationPublicRoutes } from './public.js'
import { publicationRevenueRoutes } from './revenue.js'

// =============================================================================
// Publication Routes — CRUD, member management, CMS, reader-facing, revenue.
//
// Split across sibling files by concern; composed here. All routes share the
// `/api/v1` prefix applied by the gateway registrar.
// =============================================================================

export async function publicationRoutes(app: FastifyInstance) {
  await publicationCoreRoutes(app)
  await publicationMembersRoutes(app)
  await publicationCmsRoutes(app)
  await publicationPublicRoutes(app)
  await publicationRevenueRoutes(app)
}
