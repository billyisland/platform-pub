#!/usr/bin/env npx tsx
/**
 * Minimal repro for the transfer-reversal 500 under the allocated-funds preview.
 *
 *   npx tsx scripts/segregation-reversal-isolate.ts --destination acct_...
 *
 * Probes 7 and 7b both die at transfers.createReversal with StripeAPIError 500.
 * The call has four ingredients, and a 500 names none of them. This runs the
 * matrix so the finding is "reversal 500s WHEN <x>" rather than "reversal 500s",
 * which is the difference between a reportable ticket and a shrug.
 *
 * Each case gets its OWN charge and transfer — a reversal mutates state, so
 * reusing one would confound the results.
 */
import 'dotenv/config'
import Stripe from 'stripe'
import { ALLOCATED_FUNDS_API_VERSION } from '../shared/src/lib/env.js'

const argv = process.argv.slice(2)
const arg = (n: string): string | null => {
  const i = argv.indexOf(n)
  return i >= 0 ? (argv[i + 1] ?? null) : null
}
const DESTINATION = arg('--destination') ?? ''
const MODE = arg('--mode') ?? 'ingredients'
const REPS = parseInt(arg('--reps') ?? '2', 10)
if (!DESTINATION.startsWith('acct_')) {
  console.error(
    'usage: npx tsx scripts/segregation-reversal-isolate.ts --destination acct_... [--mode ingredients|delay] [--reps N]',
  )
  process.exit(1)
}

const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!key || key.startsWith('sk_live_')) {
  console.error('Need a SANDBOX STRIPE_SECRET_KEY (never a live key — this moves money).')
  process.exit(1)
}

const AMOUNT = 1000
const CURRENCY = 'gbp'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Case {
  name: string
  allocated: boolean
  fee: number | null
  sourceTransaction: boolean
  refundApplicationFee: boolean | undefined
  reversalAmount: number | null // null = full
  delayMs: number // transfer creation → reversal call
}

const CASES: Case[] = [
  // The canonical shape §3.5 requires — the one probes 7/7b run.
  { name: 'allocated + source_txn + fee + refund_application_fee=true + FULL',
    allocated: true, fee: 32, sourceTransaction: true, refundApplicationFee: true, reversalAmount: null, delayMs: 4000 },
  // Is refund_application_fee the trigger?
  { name: 'allocated + source_txn + fee + (no refund_application_fee) + FULL',
    allocated: true, fee: 32, sourceTransaction: true, refundApplicationFee: undefined, reversalAmount: null, delayMs: 4000 },
  // Is the application fee itself the trigger?
  { name: 'allocated + source_txn + NO fee + FULL',
    allocated: true, fee: null, sourceTransaction: true, refundApplicationFee: undefined, reversalAmount: null, delayMs: 4000 },
  // Is it PARTIAL reversal specifically (probe 7b's shape)?
  { name: 'allocated + source_txn + fee + refund_application_fee=true + PARTIAL',
    allocated: true, fee: 32, sourceTransaction: true, refundApplicationFee: true, reversalAmount: 150, delayMs: 4000 },
  // Is ALLOCATION the trigger? Same call, unallocated charge.
  { name: 'UNALLOCATED + source_txn + fee + refund_application_fee=true + FULL',
    allocated: false, fee: 32, sourceTransaction: true, refundApplicationFee: true, reversalAmount: null, delayMs: 4000 },
]

// -----------------------------------------------------------------------------
// DELAY MODE — hold every ingredient fixed, vary ONLY the wait between creating
// the transfer and reversing it.
//
// WHY. The ingredients matrix above ran entirely inside a window when this was
// failing, so it establishes that the flag CORRELATES with the failure, not that
// it causes it — three later calls carrying the same flag succeeded. Something
// else varies. The failing calls happened to reverse sooner after creating the
// transfer than the passing ones did, which suggests a race: if the fee-refund
// path touches allocation state that is still settling (the same propagation
// measured at ~1-3s for the charge itself), it would 500 when called early and
// succeed when called late, while a reversal WITHOUT the flag never enters that
// path at all.
//
// Six data points and a story is not a finding. This is the test: same shape,
// five delays, repeated. The no-flag controls at the two shortest delays are the
// discriminator — if THEY fail too, the flag is innocent and this is purely
// timing; if they pass while the flag cases fail, it is the interaction.
const DELAYS_MS = [0, 2000, 5000, 15000, 30000]

function delayCases(): Case[] {
  const out: Case[] = []
  for (let rep = 1; rep <= REPS; rep++) {
    for (const d of DELAYS_MS) {
      out.push({
        name: `flag=true  delay=${d}ms  rep=${rep}`,
        allocated: true, fee: 32, sourceTransaction: true,
        refundApplicationFee: true, reversalAmount: null, delayMs: d,
      })
    }
  }
  // Controls: the same call minus the flag, at the delays most likely to fail.
  for (const d of [0, 2000]) {
    out.push({
      name: `CONTROL flag=off delay=${d}ms`,
      allocated: true, fee: 32, sourceTransaction: true,
      refundApplicationFee: undefined, reversalAmount: null, delayMs: d,
    })
  }
  return out
}

async function pollAllocation(stripe: Stripe, piId: string): Promise<number | null> {
  for (const d of [0, 1000, 2000, 4000, 8000]) {
    if (d) await sleep(d)
    const pi = await stripe.paymentIntents.retrieve(piId, {
      expand: ['latest_charge.allocated_funds.balance'],
    })
    const ch = pi.latest_charge as unknown as {
      allocated_funds?: { balance?: { pending?: number; available?: number } }
    } | null
    const b = ch?.allocated_funds?.balance
    if (b) return (b.pending ?? 0) + (b.available ?? 0)
  }
  return null
}

async function runCase(stripe: Stripe, c: Case) {
  const out: Record<string, unknown> = { case: c.name }
  try {
    const pi = await stripe.paymentIntents.create({
      amount: AMOUNT,
      currency: CURRENCY,
      payment_method: 'pm_card_visa',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      ...(c.allocated ? ({ allocated_funds: { enabled: true } } as Record<string, unknown>) : {}),
    } as Stripe.PaymentIntentCreateParams)

    const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge?.id ?? '')
    out.chargeId = chargeId
    out.allocated_pence = c.allocated ? await pollAllocation(stripe, pi.id) : 'n/a'

    const net = 400
    const transfer = await stripe.transfers.create({
      amount: net,
      currency: CURRENCY,
      destination: DESTINATION,
      ...({
        ...(c.sourceTransaction ? { source_transaction: chargeId } : {}),
        ...(c.fee !== null ? { application_fee_amount: c.fee } : {}),
      } as Record<string, unknown>),
    } as Stripe.TransferCreateParams)
    out.transferId = transfer.id

    // Nominal vs ACTUAL: sleep() plus network jitter is not the delay we asked
    // for, and if the answer turns out to sit near a threshold the difference
    // matters. Record what actually elapsed.
    const transferAt = Date.now()
    await sleep(c.delayMs)
    out.delay_nominal_ms = c.delayMs

    const reversal = await stripe.transfers.createReversal(transfer.id, {
      ...(c.reversalAmount !== null ? { amount: c.reversalAmount } : {}),
      ...(c.refundApplicationFee !== undefined
        ? { refund_application_fee: c.refundApplicationFee }
        : {}),
    })
    out.delay_actual_ms = Date.now() - transferAt
    const reloaded = await stripe.transfers.retrieve(transfer.id)
    out.result = 'OK'
    out.reversalId = reversal.id
    out.amount_reversed = reloaded.amount_reversed
  } catch (err) {
    const e = err as Partial<Stripe.errors.StripeError> & { raw?: unknown }
    out.result = 'ERROR'
    out.error_type = e?.type ?? null
    out.error_code = e?.code ?? null
    out.error_status = e?.statusCode ?? null
    out.error_requestId = e?.requestId ?? null
    out.error_message = e instanceof Error ? e.message : String(err)
  }
  return out
}

async function main() {
  const stripe = new Stripe(key, {
    apiVersion: ALLOCATED_FUNDS_API_VERSION as Stripe.LatestApiVersion,
  })
  const cases = MODE === 'delay' ? delayCases() : CASES
  console.log(`mode=${MODE}  cases=${cases.length}${MODE === 'delay' ? `  reps=${REPS}` : ''}\n`)

  const results = []
  for (const c of cases) {
    process.stdout.write(`${c.name} … `)
    const r = await runCase(stripe, c)
    results.push(r)
    console.log(
      r.result === 'OK'
        ? `OK (reversed=${r.amount_reversed}, actual=${r.delay_actual_ms}ms)`
        : `${r.error_type} ${r.error_status} req=${r.error_requestId}`,
    )
  }

  if (MODE === 'delay') {
    // The whole point of the mode: pass/fail BY DELAY, so a threshold (or its
    // absence) is legible without reading the JSON.
    console.log('\n' + '─'.repeat(78))
    console.log('\nflag=true, by nominal delay:')
    for (const d of DELAYS_MS) {
      const rows = results.filter((r) => r.delay_nominal_ms === d && !String(r.case).startsWith('CONTROL'))
      const ok = rows.filter((r) => r.result === 'OK').length
      console.log(`  ${String(d).padStart(6)}ms   ${ok}/${rows.length} passed`)
    }
    const controls = results.filter((r) => String(r.case).startsWith('CONTROL'))
    const cOk = controls.filter((r) => r.result === 'OK').length
    console.log(`\ncontrols (flag off, short delays): ${cOk}/${controls.length} passed`)
    console.log(
      '\nREAD IT LIKE THIS:\n' +
        '  passes rise with delay, controls all pass  → a race in the fee-refund path;\n' +
        '                                               waiting is a real workaround.\n' +
        '  failures spread evenly across delays       → not timing. Flaky, and the\n' +
        '                                               ingredients matrix stands as-is.\n' +
        '  controls fail too                          → the flag is innocent; the whole\n' +
        '                                               reversal path is unwell.\n' +
        '  everything passes                          → it is gone. Say so in the ticket\n' +
        '                                               rather than quietly not sending it.',
    )
  }

  console.log('\n' + '─'.repeat(78))
  console.log(JSON.stringify(results, null, 1))
}

void main()
