import 'dotenv/config'
import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { authRoutes } from './routes/auth.js'
import { signingRoutes } from './routes/signing.js'
import { writerRoutes } from './routes/writers.js'
import { articleRoutes } from './routes/articles.js'
import { noteRoutes } from './routes/notes.js'
import { followRoutes } from './routes/follows.js'
import { moderationRoutes } from './routes/moderation.js'
import { rssRoutes } from './routes/rss.js'
import { searchRoutes } from './routes/search.js'
import { googleAuthRoutes } from './routes/google-auth.js'
import { draftRoutes } from './routes/drafts.js'
import { replyRoutes } from './routes/replies.js'
import { mediaRoutes } from './routes/media.js'
import { subscriptionRoutes } from './routes/subscriptions.js'
import { v1_6Routes } from './routes/v1_6.js'
import { receiptRoutes } from './routes/receipts.js'
import { exportRoutes } from './routes/export.js'
import { pool } from '../shared/src/db/client.js'
import logger from '../shared/src/lib/logger.js'

// =============================================================================
// platform.pub — API Gateway
//
// Single ingress point for all client requests. Responsibilities:
//
//   1. Cookie-based session management (JWT in httpOnly cookie)
//   2. Auth routes (signup, login, logout, account info)
//   3. Stripe Connect and card onboarding
//   4. Proxy to internal services (payment-service, key-service)
//      with x-reader-id / x-writer-id / x-reader-pubkey headers injected
//
// The gateway is the ONLY service exposed to the public internet.
// Payment and key services are internal-only.
//
// In production this sits behind a reverse proxy (nginx, Caddy, or
// Cloudflare Tunnel) that handles TLS termination.
// =============================================================================

const app = Fastify({ logger })

async function start() {
  // Plugins
  await app.register(sensible)
  await app.register(cookie, {
    secret: process.env.COOKIE_SECRET ?? process.env.SESSION_SECRET,
  })
  await app.register(cors, {
    origin: process.env.APP_URL ?? 'http://localhost:3000',
    credentials: true,       // allow cookies
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
  await app.register(multipart, {
    limits: {
      fileSize: 12 * 1024 * 1024, // 12 MB (slightly above 10 MB limit to allow overhead)
    },
  })

  // Auth routes
  await app.register(authRoutes, { prefix: '/api/v1' })
  await app.register(googleAuthRoutes, { prefix: '/api/v1' })

  // Signing service (event signing + NIP-44 key unwrapping)
  await app.register(signingRoutes, { prefix: '/api/v1' })

  // Writer profiles (public)
  await app.register(writerRoutes, { prefix: '/api/v1' })

  // Articles (indexing, metadata, vault/key proxies, gate pass orchestration)
  await app.register(articleRoutes, { prefix: '/api/v1' })

  // Notes (short-form content indexing)
  await app.register(noteRoutes, { prefix: '/api/v1' })

  // Drafts (auto-save, load, delete — per ADR §III.3 open question #15)
  await app.register(draftRoutes, { prefix: '/api/v1' })

  // Replies (index, threaded fetch, soft-delete, toggle)
  await app.register(replyRoutes, { prefix: '/api/v1' })

  // Media (Blossom upload proxy, oEmbed proxy)
  await app.register(mediaRoutes, { prefix: '/api/v1' })

  // Follows (follow/unfollow writers, feed filtering)
  await app.register(followRoutes, { prefix: '/api/v1' })

  // Moderation (reports, content removal, account suspension)
  await app.register(moderationRoutes, { prefix: '/api/v1' })

  // Search (articles + writers, trigram-powered)
  await app.register(searchRoutes, { prefix: '/api/v1' })

  // RSS feeds (public, no auth — per ADR §II.6)
  await app.register(rssRoutes)

  // Subscriptions (subscribe, unsubscribe, check, list, pricing)
  await app.register(subscriptionRoutes, { prefix: '/api/v1' })

  // v1.6 additional routes (reading tab)
  await app.register(v1_6Routes, { prefix: '/api/v1' })

  // Receipt portability (portable bearer proofs + platform pubkey for federation)
  await app.register(receiptRoutes, { prefix: '/api/v1' })

  // Author migration export (content keys + receipt whitelist for portability)
  await app.register(exportRoutes, { prefix: '/api/v1' })

  // ---------------------------------------------------------------------------
  // Service proxies
  //
  // The gateway forwards authenticated requests to internal services.
  // These are simple fetch-based proxies — not a full reverse proxy.
  // Auth middleware has already validated the session and injected headers.
  //
  // In production, consider @fastify/http-proxy for better performance.
  // ---------------------------------------------------------------------------

  // Health check
  app.get('/health', async () => {
    await pool.query('SELECT 1')
    return { status: 'ok', service: 'gateway' }
  })

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down gateway')
    await app.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  const port = parseInt(process.env.PORT ?? '3000', 10)
  await app.listen({ port, host: '0.0.0.0' })
  logger.info({ port }, 'Gateway started')
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start gateway')
  process.exit(1)
})
