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
//
// TWO GRANULARITIES (PAYMENT-PERIMETER-ADR §3.W4, 2026-08-06). The global flag
// above is unchanged and still catches everything. Beside it now sits a
// PER-ACCOUNT halt (`payouts_halted_accounts`, migration 175) for divergences
// the reconciler can honestly ATTRIBUTE to one account. The breadth of the
// global flag — freezing every writer's money over a divergence that may
// implicate one — is the largest surviving HJ ¶7.14.6 principal-like-control
// marker, and narrowing it where attribution is sound is what W4 buys.
//
// The two are not alternatives and the narrow one is not a relaxation: an
// unattributable divergence still freezes everything, and the global reason
// names the class that could not be attributed. See `reconcile-ledger.ts` for
// what "attributable" means and why it is a short list.
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

// =============================================================================
// Per-account halt (W4) — `payouts_halted_accounts`, migration 175.
// =============================================================================

export interface AccountHalt {
  accountId: string
  /** The reconciler check that attributed it. A class, never free text. */
  mismatchClass: string
  reason: string
}

export interface HaltedAccount extends AccountHalt {
  /** FIRST detection (first-writer-wins), so it is a sound escalation input. */
  since: string | null
}

/**
 * Halt the given accounts' payouts, recording why. Batched into ONE statement
 * because the caller has the whole attributed set in hand and halting is a
 * response to a single reconciliation run — a per-row loop would let a failure
 * halfway leave half the diverging accounts paying.
 *
 * FIRST-WRITER-WINS per account (`ON CONFLICT DO NOTHING`), matching the global
 * flag: the first divergence is the one to investigate. This is not merely
 * tidiness — the ledger is append-only, so an orphan re-detects on EVERY run
 * until a human acts, and an upsert would refresh `created_at` each time,
 * making a fortnight-old halt read as new and silently defeating the age
 * escalation.
 *
 * Returns the number of accounts NEWLY halted (0 when every one was already
 * halted), so the caller can alert on a new freeze without re-alerting each run.
 */
export async function haltAccountPayouts(db: Queryable, halts: AccountHalt[]): Promise<number> {
  if (halts.length === 0) return 0
  const { rows } = await db.query(
    `INSERT INTO payouts_halted_accounts (account_id, mismatch_class, reason)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])
     ON CONFLICT (account_id) DO NOTHING
     RETURNING account_id`,
    [halts.map((h) => h.accountId), halts.map((h) => h.mismatchClass), halts.map((h) => h.reason)],
  )
  return rows.length
}

/** Every currently halted account, oldest halt first (the one most overdue). */
export async function listHaltedAccounts(db: Queryable): Promise<HaltedAccount[]> {
  const { rows } = await db.query(
    `SELECT account_id, mismatch_class, reason, created_at
       FROM payouts_halted_accounts
      ORDER BY created_at ASC`,
  )
  return rows.map((r) => ({
    accountId: r.account_id as string,
    mismatchClass: r.mismatch_class as string,
    reason: r.reason as string,
    since:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : ((r.created_at as string | null) ?? null),
  }))
}

/**
 * Clear one account's halt (a human has reconciled that account's divergence).
 * True iff a halt was actually cleared — a resume naming an account that was
 * never halted is a no-op the caller should be able to report honestly rather
 * than confirm as a resume.
 */
export async function resumeAccountPayouts(db: Queryable, accountId: string): Promise<boolean> {
  const { rows } = await db.query(
    `DELETE FROM payouts_halted_accounts WHERE account_id = $1 RETURNING account_id`,
    [accountId],
  )
  return rows.length > 0
}

/**
 * The exclusion predicate every transfer-choosing site shares, as a fragment
 * keyed on whichever column already holds the recipient's account id: the
 * writer/tribute eligibility queries, BOTH resume sweeps (§0q.1 — a sweep
 * without it is a bypass: eligibility stops a halted account's new payouts
 * while a stuck-pending row from a crashed cycle pays anyway), and the
 * publication split gate (as `NOT … AS halted`, since that cycle resolves
 * recipients per split at transfer time).
 *
 * ONE HOME on purpose. The same rule hand-written six times is six chances to
 * key one site on the wrong column — which would fail SILENTLY, in the
 * direction of paying a halted account. `column` is always a code-supplied
 * identifier at the call site; it never carries user input.
 */
export function haltedAccountExclusionSql(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM payouts_halted_accounts hlt WHERE hlt.account_id = ${column})`
}
