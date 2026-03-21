// Database
export { pool, withTransaction, loadConfig } from './db/client.js'

// Auth
export { createSession, verifySession, refreshIfNeeded, destroySession } from './auth/session.js'
export type { SessionPayload } from './auth/session.js'
export { getAccountPubkey } from './auth/keypairs.js'
export { signup, getAccount, connectStripeAccount, connectPaymentMethod, SignupSchema } from './auth/accounts.js'
export type { SignupInput, SignupResult, StripeConnectResult, AccountInfo } from './auth/accounts.js'

// Types
export type { PlatformConfig } from './types/config.js'

// Logger
export { default as logger } from './lib/logger.js'
