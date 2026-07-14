// =============================================================================
// Payout halt flag (PAYMENTS ADR §1.2 — reconciliation mismatch response).
//
// The scheduled ledger-reconciliation job (services/reconcile-ledger.ts) does
// not merely detect-and-log a mismatch — "detection without a defined response
// is half a control" (§1.2). Its response is ALERT + HALT PAYOUTS: it sets this
// durable flag, and the three payout cycles (writer / publication / tribute)
// refuse to run any outbound transfer while it is set. Charging readers
// (settlement) is deliberately NOT halted — stopping it strands readers and
// moves no money OUT the door; the hazard a divergence guards against is
// irreversible money leaving on books that don't balance.
//
// Durable, not in-process: the divergence outlives a process restart, so the
// flag lives in `platform_config` (key `payouts_halted`, value 'true'; the
// `description` column carries the reason, `updated_at` the halt time). A human
// investigates the divergence, then clears it via POST /payouts/resume.
// =============================================================================

const HALT_KEY = 'payouts_halted'

/** Anything with a pg-style .query — the live pool or a scripted test client. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

/**
 * True iff payouts are currently halted. Read FRESH (not via the cached
 * loadConfig) so a just-set halt takes effect on the very next cycle, and so a
 * resume is honoured immediately — a stale-cached "not halted" would let a
 * cycle pay out after the books were flagged bad.
 */
export async function isPayoutsHalted(db: Queryable): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT value FROM platform_config WHERE key = $1`,
    [HALT_KEY],
  )
  return rows.length > 0 && rows[0].value === 'true'
}

/**
 * Halt payouts, recording the reason. Idempotent AND first-writer-wins: if
 * already halted, the ORIGINAL reason/timestamp are preserved (the first
 * divergence is the one to investigate) via the `WHERE … <> 'true'` guard on
 * the upsert.
 */
export async function haltPayouts(db: Queryable, reason: string): Promise<void> {
  await db.query(
    `INSERT INTO platform_config (key, value, description, updated_at)
     VALUES ($1, 'true', $2, now())
     ON CONFLICT (key) DO UPDATE
       SET value = 'true', description = EXCLUDED.description, updated_at = now()
     WHERE platform_config.value IS DISTINCT FROM 'true'`,
    [HALT_KEY, reason],
  )
}

/** Clear the halt (a human has reconciled the divergence). Absence = not halted. */
export async function resumePayouts(db: Queryable): Promise<void> {
  await db.query(`DELETE FROM platform_config WHERE key = $1`, [HALT_KEY])
}

export interface HaltState {
  halted: boolean
  reason: string | null
  since: string | null
}

/** Report the current halt state (for the internal status route). */
export async function getPayoutHaltState(db: Queryable): Promise<HaltState> {
  const { rows } = await db.query(
    `SELECT value, description, updated_at FROM platform_config WHERE key = $1`,
    [HALT_KEY],
  )
  if (rows.length === 0 || rows[0].value !== 'true') {
    return { halted: false, reason: null, since: null }
  }
  const since = rows[0].updated_at
  return {
    halted: true,
    reason: (rows[0].description as string | null) ?? null,
    since: since instanceof Date ? since.toISOString() : (since as string | null) ?? null,
  }
}
