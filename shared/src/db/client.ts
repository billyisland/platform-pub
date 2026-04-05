import pg from 'pg'
import type { PoolClient } from 'pg'
import type { PlatformConfig } from '../types/config.js'
import logger from '../lib/logger.js'

// =============================================================================
// Shared Database Client
//
// Single connection pool shared across all services in the same process.
// Both payment-service and key-service import { pool, withTransaction, loadConfig }
// from this module.
//
// Connection pooling: 20 connections by default, tunable via env.
// Statement timeout: 10s to prevent runaway queries from holding connections.
// Idle timeout: 30s to reclaim unused connections under low load.
// =============================================================================

const {Pool} = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX ?? '20', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
})

// Fatal pool errors mean the connection is broken — exit so the orchestrator restarts us
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database pool error — exiting')
  process.exit(1)
})

// =============================================================================
// withTransaction
//
// Acquires a client, runs the callback inside BEGIN/COMMIT, and releases.
// ROLLBACK on any error. The caller never touches client lifecycle.
//
// Usage:
//   const result = await withTransaction(async (client) => {
//     await client.query('INSERT INTO ...')
//     return someValue
//   })
// =============================================================================

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// =============================================================================
// loadConfig
//
// Reads platform_config table into a typed PlatformConfig object.
// Cached in-memory after first call — invalidate by calling loadConfig(true).
//
// All monetary values are in pence (integers). Fee is in basis points.
// These match the INSERT statements in schema.sql exactly.
// =============================================================================

let cachedConfig: PlatformConfig | null = null
let cachedConfigAt = 0
const CONFIG_TTL_MS = 30_000

export async function loadConfig(forceRefresh = false): Promise<PlatformConfig> {
  if (cachedConfig && !forceRefresh && Date.now() - cachedConfigAt < CONFIG_TTL_MS) return cachedConfig

  const { rows } = await pool.query<{ key: string; value: string }>(
    'SELECT key, value FROM platform_config'
  )

  const map = new Map(rows.map((r) => [r.key, r.value]))

  const config: PlatformConfig = {
    freeAllowancePence: int(map, 'free_allowance_pence', 500),
    tabSettlementThresholdPence: int(map, 'tab_settlement_threshold_pence', 800),
    monthlyFallbackMinimumPence: int(map, 'monthly_fallback_minimum_pence', 200),
    writerPayoutThresholdPence: int(map, 'writer_payout_threshold_pence', 2000),
    platformFeeBps: int(map, 'platform_fee_bps', 800),
    monthlyFallbackDays: int(map, 'monthly_fallback_days', 30),
  }

  cachedConfig = config
  cachedConfigAt = Date.now()
  return config
}

function int(map: Map<string, string>, key: string, fallback: number): number {
  const val = map.get(key)
  if (val === undefined) return fallback
  const parsed = parseInt(val, 10)
  return isNaN(parsed) ? fallback : parsed
}
