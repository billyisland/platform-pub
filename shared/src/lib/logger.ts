import pino from 'pino'

// =============================================================================
// Shared Logger
//
// Structured JSON logging via pino. All services use the same format.
// LOG_LEVEL defaults to 'info' in production, overridable via env.
//
// Usage:
//   import logger from '@platform-pub/shared/lib/logger'
//   logger.info({ readerId, amountPence }, 'Gate pass recorded')
// =============================================================================

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
})

export default logger
