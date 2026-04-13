import 'dotenv/config'
import { requireEnv, requireEnvMinLength } from '../shared/src/lib/env.js'
import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
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
import { subscriptionRoutes, expireAndRenewSubscriptions } from './routes/subscriptions.js'
import { v1_6Routes } from './routes/v1_6.js'
import { receiptRoutes } from './routes/receipts.js'
import { exportRoutes } from './routes/export.js'
import { notificationRoutes } from './routes/notifications.js'
import { voteRoutes } from './routes/votes.js'
import { historyRoutes } from './routes/history.js'
import { giftLinkRoutes } from './routes/gift-links.js'
import { subscriptionOfferRoutes } from './routes/subscription-offers.js'
import { messageRoutes } from './routes/messages.js'
import { feedRoutes } from './routes/feed.js'
import { socialRoutes } from './routes/social.js'
import { publicationRoutes } from './routes/publications.js'
import { driveRoutes, expireOverdueDrives } from './routes/drives.js'
import { traffologyRoutes } from './routes/traffology.js'
import { unsubscribeRoutes } from './routes/unsubscribe.js'
import { refreshFeedScores } from './workers/feed-scorer.js'
import { pool } from '../shared/src/db/client.js'
import logger from '../shared/src/lib/logger.js'

// =============================================================================
// all.haus — API Gateway
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

// Validate required env vars at startup — fail fast
const SESSION_SECRET = requireEnvMinLength('SESSION_SECRET', 32)
const APP_URL = requireEnv('APP_URL')

const app = Fastify({ logger })

async function start() {
  // Plugins
  await app.register(sensible)
  await app.register(cookie, {
    secret: SESSION_SECRET,
  })
  await app.register(cors, {
    origin: APP_URL,
    credentials: true,       // allow cookies
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
  await app.register(multipart, {
    limits: {
      fileSize: 12 * 1024 * 1024, // 12 MB (slightly above 10 MB limit to allow overhead)
    },
  })

  // Rate limiting — per-route limits on sensitive endpoints only.
  // The global blanket limit caused cascading auth failures in dev (Docker
  // containers share a single IP, exhausting the bucket on every SSR fetch).
  // Sensitive routes (signup, login, gate-pass, search, messages) keep their
  // own per-route limits registered inline.
  await app.register(rateLimit, {
    global: false,
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

  // Email unsubscribe (signed token — no auth required)
  await app.register(unsubscribeRoutes, { prefix: '/api/v1' })

  // v1.6 additional routes (reading tab)
  await app.register(v1_6Routes, { prefix: '/api/v1' })

  // Receipt portability (portable bearer proofs + platform pubkey for federation)
  await app.register(receiptRoutes, { prefix: '/api/v1' })

  // Author migration export (content keys + receipt whitelist for portability)
  await app.register(exportRoutes, { prefix: '/api/v1' })

  // Notifications (new followers, new replies)
  await app.register(notificationRoutes, { prefix: '/api/v1' })

  // Votes (upvote/downvote articles, notes, replies)
  await app.register(voteRoutes, { prefix: '/api/v1' })

  // Reading history (list previously-read articles for the current reader)
  await app.register(historyRoutes, { prefix: '/api/v1' })

  // Gift links (capped shareable access tokens for paywalled articles)
  await app.register(giftLinkRoutes, { prefix: '/api/v1' })

  // Subscription offers (discount codes and gifted subscriptions)
  await app.register(subscriptionOfferRoutes, { prefix: '/api/v1' })

  // Direct messages (NIP-17 E2E encrypted conversations)
  await app.register(messageRoutes, { prefix: '/api/v1' })

  // Feed (unified endpoint with reach dial — following, explore)
  await app.register(feedRoutes, { prefix: '/api/v1' })

  // Social (blocks, mutes)
  await app.register(socialRoutes, { prefix: '/api/v1' })

  // Publications (multi-writer publishing groups)
  await app.register(publicationRoutes, { prefix: '/api/v1' })

  // Pledge drives (crowdfunding, commissions)
  await app.register(driveRoutes, { prefix: '/api/v1' })

  // Traffology (writer analytics — concurrent reader counts)
  await app.register(traffologyRoutes, { prefix: '/api/v1' })

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

  // Background workers — run periodically after startup
  // Advisory locks prevent duplicate execution when horizontally scaled
  const WORKER_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
  const FEED_SCORE_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
  const LOCK_SUBSCRIPTIONS = 100001
  const LOCK_DRIVES = 100002
  const LOCK_FEED_SCORES = 100003

  async function withAdvisoryLock(lockId: number, name: string, fn: () => Promise<unknown>) {
    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked', [lockId]
      )
      if (!rows[0].locked) {
        logger.info(`${name}: skipped — another instance holds the lock`)
        return
      }
      try {
        await fn()
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId])
      }
    } finally {
      client.release()
    }
  }

  setInterval(() => {
    withAdvisoryLock(LOCK_SUBSCRIPTIONS, 'Subscription expiry', expireAndRenewSubscriptions).catch(err =>
      logger.error({ err }, 'Subscription expiry worker failed')
    )
    withAdvisoryLock(LOCK_DRIVES, 'Drive expiry', expireOverdueDrives).catch(err =>
      logger.error({ err }, 'Drive expiry worker failed')
    )
  }, WORKER_INTERVAL_MS)

  setInterval(() => {
    withAdvisoryLock(LOCK_FEED_SCORES, 'Feed score refresh', refreshFeedScores).catch(err =>
      logger.error({ err }, 'Feed score worker failed')
    )
  }, FEED_SCORE_INTERVAL_MS)

  // Run once on startup
  withAdvisoryLock(LOCK_SUBSCRIPTIONS, 'Subscription expiry', expireAndRenewSubscriptions).catch(err =>
    logger.error({ err }, 'Subscription expiry worker failed (startup)')
  )
  withAdvisoryLock(LOCK_DRIVES, 'Drive expiry', expireOverdueDrives).catch(err =>
    logger.error({ err }, 'Drive expiry worker failed (startup)')
  )
  withAdvisoryLock(LOCK_FEED_SCORES, 'Feed score refresh', refreshFeedScores).catch(err =>
    logger.error({ err }, 'Feed score worker failed (startup)')
  )
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start gateway')
  process.exit(1)
})
