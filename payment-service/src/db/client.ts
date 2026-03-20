// Re-export from the shared database client
// This shim lets the payment service import from './db/client.js' or '../db/client.js'
// without changing every import path to the shared module location.

export { pool, withTransaction, loadConfig } from '../../shared/src/db/client.js'
