import 'dotenv/config'
import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import { paymentRoutes } from './routes/payment.js'
import { webhookRoutes } from './routes/webhook.js'
import { startPayoutWorker } from './workers/payout.js'
import { pool } from './db/client.js'
import logger from './lib/logger.js'

// =============================================================================
// platform.pub — Payment Service
// =============================================================================

const app = Fastify({ logger })

async function start() {
  // Plugins
  await app.register(sensible)

  // Routes
  await app.register(paymentRoutes, { prefix: '/api/v1' })
  await app.register(webhookRoutes)

  // Health check
  app.get('/health', async () => {
    await pool.query('SELECT 1')
    return { status: 'ok', service: 'payment-service' }
  })

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down')
    await app.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  const port = parseInt(process.env.PORT ?? '3001', 10)
  await app.listen({ port, host: '0.0.0.0' })

  // Start background workers after HTTP server is ready
  startPayoutWorker()

  logger.info({ port }, 'Payment service started')
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start payment service')
  process.exit(1)
})
