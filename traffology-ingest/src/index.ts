import 'dotenv/config'
import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import rateLimit from '@fastify/rate-limit'
import { beaconRoutes } from './routes/beacon.js'
import { concurrentRoutes } from './routes/concurrent.js'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Traffology Ingest Service
//
// Receives beacon data from the page script, writes reader sessions to
// the traffology schema, and maintains in-memory concurrent reader counters.
//
// Internal only — not exposed to the public internet directly.
// Nginx proxies /ingest/* to this service for beacon reception.
// The gateway queries /concurrent/* for live reader counts.
// =============================================================================

const app = Fastify({ logger, trustProxy: true })

async function start() {
  await app.register(sensible)
  await app.register(rateLimit, { global: false })

  await app.register(beaconRoutes)
  await app.register(concurrentRoutes)

  app.get('/health', async () => {
    await pool.query('SELECT 1')
    return { status: 'ok', service: 'traffology-ingest' }
  })

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down traffology-ingest')
    await app.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  const port = parseInt(process.env.PORT ?? '3005', 10)
  await app.listen({ port, host: '0.0.0.0' })
  logger.info({ port }, 'Traffology ingest service started')
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start traffology-ingest')
  process.exit(1)
})
