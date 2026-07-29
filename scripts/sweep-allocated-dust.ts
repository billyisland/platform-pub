#!/usr/bin/env npx tsx
/**
 * scripts/sweep-allocated-dust.ts
 *
 * Funds segregation §3.3f — reclaim small amounts stranded in allocated state.
 *
 *   npx tsx scripts/sweep-allocated-dust.ts                 # report only (default)
 *   npx tsx scripts/sweep-allocated-dust.ts --apply         # issue Balance Transfers
 *   npx tsx scripts/sweep-allocated-dust.ts --max-pence 250 # widen what counts as dust
 *
 * AN OPS SCRIPT, NOT A JOB, AND DELIBERATELY SO. §3.3f asks for this to be run
 * by a person: a Balance Transfer moves real money out of a segregated balance,
 * and the whole point of segregation is that such moves are deliberate. It is
 * dry-run by default and prints exactly what it would do.
 *
 * WHAT DUST IS. Floored fee prorations, unpairable subscription fees and
 * carve-zeroed units leave a few pence locked against a charge that nothing will
 * ever draw again. Individually trivial; in aggregate a slowly growing balance
 * nobody can explain.
 *
 * WHAT DUST IS NOT — read this before widening --max-pence. If this script is
 * finding POUNDS rather than pence, something upstream is wrong and sweeping it
 * hides the symptom. The known case is §3.4's fee proration: without it the
 * publication cycle strands roughly the whole pooled platform fee every cycle,
 * which is not dust and is not an ops-script-shaped problem. Check
 * `prorateWithheldFee` is live before reaching for a bigger threshold.
 *
 * SAFETY. A charge is only swept when every unit drawn on it is finished — no
 * child transfer still `pending` — so a sweep can never take an allocation a
 * queued transfer is about to need. It records nothing in the ledger, by
 * design: §3.3f is explicit that the packer introduces no rounding, so there is
 * no residue to post; the money moves between two balances the platform already
 * owns. It does record an `allocated_draws` row, because that IS the drawing
 * budget and a swept charge must stop offering what it no longer holds.
 */
import 'dotenv/config'
import Stripe from 'stripe'
import { pool } from '../shared/src/db/client.js'

const APPLY = process.argv.includes('--apply')
const MAX_PENCE = (() => {
  const i = process.argv.indexOf('--max-pence')
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : 100
})()

interface DustRow {
  id: string
  stripe_charge_id: string
  remaining_pence: string
  pending_children: string
}

const DUST_SQL = `
  SELECT ts.id,
         ts.stripe_charge_id,
         GREATEST(0, ts.allocated_pence - COALESCE((
           SELECT SUM(d.gross_pence) FROM allocated_draws d
            WHERE d.settlement_id = ts.id
         ), 0)) AS remaining_pence,
         (SELECT count(*) FROM payout_transfers pt
           WHERE pt.settlement_id = ts.id AND pt.status = 'pending') AS pending_children
    FROM tab_settlements ts
   WHERE ts.status = 'completed'
     AND ts.stripe_charge_id IS NOT NULL
     AND ts.allocated_pence IS NOT NULL
   ORDER BY ts.settled_at ASC`

async function main() {
  const key = process.env.STRIPE_SECRET_KEY
  if (APPLY && (!key || key.startsWith('sk_test_...'))) {
    console.error('--apply needs a real STRIPE_SECRET_KEY')
    process.exit(1)
  }

  const { rows } = await pool.query<DustRow>(DUST_SQL)

  const candidates = rows
    .map((r) => ({
      ...r,
      remaining: parseInt(r.remaining_pence, 10),
      pending: parseInt(r.pending_children, 10),
    }))
    // > 0 because a fully-drawn charge has nothing to sweep, and <= MAX because
    // anything larger is a question, not dust (see the header).
    .filter((r) => r.remaining > 0 && r.remaining <= MAX_PENCE && r.pending === 0)

  const held = rows
    .map((r) => ({ ...r, remaining: parseInt(r.remaining_pence, 10) }))
    .filter((r) => r.remaining > MAX_PENCE)

  const total = candidates.reduce((s, r) => s + r.remaining, 0)

  console.log(`Dust threshold:      ${MAX_PENCE}p`)
  console.log(`Charges with dust:   ${candidates.length}`)
  console.log(`Total reclaimable:   ${total}p`)
  console.log(
    `Above the threshold: ${held.length} charge(s), ${held.reduce((s, r) => s + r.remaining, 0)}p ` +
      `— NOT swept. If this is large, read the header before widening --max-pence.`,
  )
  console.log('')

  for (const c of candidates) {
    console.log(`  ${c.stripe_charge_id}  ${String(c.remaining).padStart(5)}p  (settlement ${c.id})`)
  }

  if (!APPLY) {
    console.log('\nDry run — nothing moved. Re-run with --apply to sweep.')
    await pool.end()
    return
  }

  const stripe = new Stripe(key!, {
    apiVersion: (process.env.ALLOCATED_FUNDS_API_VERSION ??
      undefined) as unknown as Stripe.LatestApiVersion,
  })

  let swept = 0
  for (const c of candidates) {
    try {
      // Row-stable idempotency key, the same discipline every money-moving
      // create in this repo uses: a re-run after a lost response must land on
      // the transfer that already happened, not mint a second one. Keyed on the
      // settlement AND the amount, so a later, larger dust figure on the same
      // charge is a genuinely new sweep rather than a silent dedupe of the old.
      await (stripe as unknown as {
        balanceTransfers: {
          create(
            p: Record<string, unknown>,
            o: { idempotencyKey: string },
          ): Promise<{ id: string }>
        }
      }).balanceTransfers.create(
        {
          amount: c.remaining,
          currency: 'gbp',
          source_balance: { type: 'allocated_funds', allocated_funds: { source_transaction: c.stripe_charge_id } },
        },
        { idempotencyKey: `dust-${c.id}-${c.remaining}` },
      )

      // The budget must learn: a swept charge holds nothing more, and the packer
      // must stop offering it. `kind = 'transfer'` because that is what it is —
      // value leaving the allocation — and one row per (ref, kind) keeps the
      // unique honest.
      await pool.query(
        `INSERT INTO allocated_draws (settlement_id, kind, ref_table, ref_id, gross_pence)
         VALUES ($1, 'transfer', 'tab_settlements', $1, $2)
         ON CONFLICT (ref_table, ref_id, kind)
         DO UPDATE SET gross_pence = allocated_draws.gross_pence + EXCLUDED.gross_pence`,
        [c.id, c.remaining],
      )
      swept++
      console.log(`  swept ${c.remaining}p from ${c.stripe_charge_id}`)
    } catch (err) {
      // Keep going: one charge Stripe refuses is not a reason to leave the rest
      // stranded, and nothing here is transactional across charges.
      console.error(`  FAILED ${c.stripe_charge_id}:`, (err as Error).message)
    }
  }

  console.log(`\nSwept ${swept}/${candidates.length} charges.`)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
