#!/usr/bin/env npx tsx
/**
 * scripts/backfill-seed-opening-balances.ts
 *
 * DEV ONLY. Give every seeded reading tab the `opening_balance` ledger entry the
 * seeder never wrote, so `reader_balance_parity` stops failing and the scheduled
 * ledger-reconcile worker stops halting payouts.
 *
 * WHY THIS EXISTS. `scripts/seed.ts` inserts `reading_tabs` with
 * `balance_pence: faker.number.int({ min: 0, max: 800 })` and posts NO ledger
 * entries at all (grep it — the count is zero). Every seeded reader with a
 * non-zero balance therefore violates the standing invariant that
 * `reading_tabs.balance_pence == −SUM(reader ledger)`, which is exactly what
 * `reconcile-ledger`'s first critical check tests. The worker runs at 01:45,
 * 09:45 and 17:45 UTC, finds the divergence, and does precisely what it is
 * supposed to do: HALTS ALL PAYOUTS. On 2026-07-17 09:45 it did, and dev sat
 * halted for a fortnight, silently turning every payout cycle into a no-op —
 * which is how a §5 sequence run came to report "no payout was created" with
 * nothing whatsoever wrong with the payout code.
 *
 * THE DIAGNOSIS IS EVIDENCE, NOT INFERENCE. All 25 discrepancies fell between
 * 23p and 799p — every one inside the seeder's own 0..800 range — and no account
 * that transacted through production code (the harness's own fresh readers) was
 * among them. Seed data, not a defect.
 *
 * WHY `opening_balance` RATHER THAN ZEROING THE TABS. The column is meant to be
 * written only by `applyLedgerDelta`; setting it directly to make the two sides
 * agree breaks the same invariant from the other end, and destroys seeded state
 * other dev work may lean on. `opening_balance` is the trigger type the ledger
 * already defines for a balance that exists without a movement behind it, and
 * `ledger_reader_balance` already counts it. This makes dev match the invariant
 * instead of suppressing the check that enforces it.
 *
 * THIS IS APPEND-ONLY AND CANNOT BE UNDONE. The ledger carries DB guards against
 * UPDATE, DELETE and TRUNCATE by design; corrections are reversing entries. So it
 * dry-runs by default and writes only with --apply.
 *
 *   npx tsx scripts/backfill-seed-opening-balances.ts            # dry run
 *   npx tsx scripts/backfill-seed-opening-balances.ts --apply
 *
 * It does NOT clear `payouts_halted` — that is a separate, deliberate act (the
 * flag's absence means "not halted", so resuming is a DELETE). Re-run the
 * reconcile after this and clear the flag only if it comes back clean.
 */
import 'dotenv/config'
import { pool, withTransaction } from '../shared/src/db/client.js'
import { recordLedger } from '../shared/src/lib/ledger.js'

const APPLY = process.argv.includes('--apply')

interface Row {
  account_id: string
  tab_id: string
  username: string | null
  tab_balance_pence: number
  ledger_balance_pence: string
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? ''
  if (!/@(localhost|127\.0\.0\.1|postgres)[:/]/.test(url)) {
    console.error('REFUSING: DATABASE_URL does not look local. This writes ledger rows.')
    process.exit(1)
  }

  // The SAME predicate reconcile-ledger's `reader_balance_parity` check uses,
  // over the SAME view — not a re-typed approximation of it. An approximation is
  // how this session first mis-attributed three of the accounts: a raw
  // SUM(amount) over ALL entries counts a writer's payout credits against their
  // reader tab, which the view deliberately does not.
  const { rows } = await pool.query<Row>(
    `SELECT rt.reader_id AS account_id,
            rt.id        AS tab_id,
            a.username,
            COALESCE(rt.balance_pence, 0)   AS tab_balance_pence,
            COALESCE(rb.balance_pence, 0)   AS ledger_balance_pence
       FROM reading_tabs rt
       FULL OUTER JOIN ledger_reader_balance rb ON rb.account_id = rt.reader_id
       LEFT JOIN accounts a ON a.id = rt.reader_id
      WHERE COALESCE(rt.balance_pence, 0) <> COALESCE(rb.balance_pence, 0)
        AND rt.reader_id IS NOT NULL
      ORDER BY a.username`,
  )

  if (rows.length === 0) {
    console.log('Nothing to do — reader balance parity already holds.')
    await pool.end()
    return
  }

  // ledger_reader_balance is −SUM(amount), so to move the ledger side from L to
  // the tab's B we post amount = −(B − L). A seeded debit is money the reader
  // OWES, which is negative in the reader-tab sign convention — the same
  // direction `read_accrual` posts.
  const planned = rows.map((r) => {
    const tab = Number(r.tab_balance_pence)
    const ledger = parseInt(r.ledger_balance_pence, 10)
    return { ...r, tab, ledger, amountPence: -(tab - ledger) }
  })

  console.log(`${planned.length} tab(s) to correct:\n`)
  for (const p of planned) {
    console.log(
      `  ${(p.username ?? p.account_id).padEnd(26)} tab=${String(p.tab).padStart(5)}  ` +
        `ledger=${String(p.ledger).padStart(5)}  entry=${String(p.amountPence).padStart(6)}`,
    )
  }
  const total = planned.reduce((s, p) => s + p.amountPence, 0)
  console.log(`\n  Σ entries: ${total}p across ${planned.length} accounts`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to post these entries.')
    await pool.end()
    return
  }

  await withTransaction(async (client) => {
    for (const p of planned) {
      await recordLedger(client, {
        accountId: p.account_id,
        counterpartyId: null,
        amountPence: p.amountPence,
        triggerType: 'opening_balance',
        refTable: 'reading_tabs',
        refId: p.tab_id,
      })
    }
  })

  console.log(`\nPosted ${planned.length} opening_balance entries.`)

  const { rows: after } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM reading_tabs rt
       FULL OUTER JOIN ledger_reader_balance rb ON rb.account_id = rt.reader_id
      WHERE COALESCE(rt.balance_pence, 0) <> COALESCE(rb.balance_pence, 0)`,
  )
  console.log(`Remaining parity violations: ${after[0].n}`)

  await pool.end()
}

main().catch(async (err) => {
  console.error('FAILED:', err?.message ?? err)
  try {
    await pool.end()
  } catch {
    /* already closed */
  }
  process.exit(1)
})
