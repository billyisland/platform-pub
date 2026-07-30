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
const DESTINATION = argv[argv.indexOf('--destination') + 1] ?? ''
if (!DESTINATION.startsWith('acct_')) {
  console.error('usage: npx tsx scripts/segregation-reversal-isolate.ts --destination acct_...')
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
}

const CASES: Case[] = [
  // The canonical shape §3.5 requires — the one probes 7/7b run.
  { name: 'allocated + source_txn + fee + refund_application_fee=true + FULL',
    allocated: true, fee: 32, sourceTransaction: true, refundApplicationFee: true, reversalAmount: null },
  // Is refund_application_fee the trigger?
  { name: 'allocated + source_txn + fee + (no refund_application_fee) + FULL',
    allocated: true, fee: 32, sourceTransaction: true, refundApplicationFee: undefined, reversalAmount: null },
  // Is the application fee itself the trigger?
  { name: 'allocated + source_txn + NO fee + FULL',
    allocated: true, fee: null, sourceTransaction: true, refundApplicationFee: undefined, reversalAmount: null },
  // Is it PARTIAL reversal specifically (probe 7b's shape)?
  { name: 'allocated + source_txn + fee + refund_application_fee=true + PARTIAL',
    allocated: true, fee: 32, sourceTransaction: true, refundApplicationFee: true, reversalAmount: 150 },
  // Is ALLOCATION the trigger? Same call, unallocated charge.
  { name: 'UNALLOCATED + source_txn + fee + refund_application_fee=true + FULL',
    allocated: false, fee: 32, sourceTransaction: true, refundApplicationFee: true, reversalAmount: null },
]

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

    await sleep(4000)

    const reversal = await stripe.transfers.createReversal(transfer.id, {
      ...(c.reversalAmount !== null ? { amount: c.reversalAmount } : {}),
      ...(c.refundApplicationFee !== undefined
        ? { refund_application_fee: c.refundApplicationFee }
        : {}),
    })
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
  const results = []
  for (const c of CASES) {
    process.stdout.write(`${c.name} … `)
    const r = await runCase(stripe, c)
    results.push(r)
    console.log(
      r.result === 'OK'
        ? `OK (amount_reversed=${r.amount_reversed})`
        : `${r.error_type} ${r.error_status} req=${r.error_requestId}`,
    )
  }
  console.log('\n' + '─'.repeat(78))
  console.log(JSON.stringify(results, null, 1))
}

void main()
