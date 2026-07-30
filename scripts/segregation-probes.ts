#!/usr/bin/env npx tsx
/**
 * scripts/segregation-probes.ts
 *
 * Funds segregation §5 STEP 0 — the sandbox probes, run against Stripe directly.
 * Spec: docs/adr/FUNDS-SEGREGATION-INTEGRATION.md §5 step 0, §3.5, §7.5.
 *
 *   npx tsx scripts/segregation-probes.ts --probe 1,4,6,7,7b
 *   npx tsx scripts/segregation-probes.ts --probe 7b --destination acct_123
 *   npx tsx scripts/segregation-probes.ts --countries          # §7.5, read-only
 *
 * WHY THIS DRIVES STRIPE AND NOT OUR CODE. §5 step 0 is explicit: run these
 * "against the sandbox with no §3.3 code at all". The point is to observe what
 * Stripe actually does BEFORE trusting what our packer, our webhook handlers and
 * our allocation model assume it does. So this file imports exactly one thing
 * from the repo — the preview API version string, which must not drift — and
 * otherwise talks to the API raw and PRINTS WHAT COMES BACK. Where the ADR
 * states an expectation it is recorded as a check with a verdict, but a failed
 * check never stops the run: an unexpected shape is the finding, not an error.
 *
 * WHAT IT ANSWERS. Four of these retire uncertainty the build had to assume:
 *
 *   1   allocation lands, and `allocated_funds.balance` has the shape
 *       readAllocatedBalance() destructures (pending + available).
 *   4   a full refund pre-transfer empties the allocation and the charge stops
 *       being drawable — the state recordRefundDraw() models.
 *   6   a refund POST-transfer draws platform balance, not allocation.
 *   7   a reversal returns funds to allocated state (the `reversal` draw kind).
 *   7b  THE ONE REV 2 NEVER THOUGHT TO ASK, and the reason to run this at all:
 *       reverse ONE child of a multi-child set and see which webhook arrives and
 *       what it can be keyed on. §3.5's whole re-keying design — and
 *       `payout_transfers.reversed_pence`, a column §10.2 admits the spec does
 *       not name — rests on the answer being "the Transfer object, carrying its
 *       own id and a CUMULATIVE amount_reversed". If it is not, that column and
 *       the handlers above it are wrong. Fifteen minutes, per the ADR.
 *
 * SETUP. A Stripe SANDBOX with the allocated-funds beta enabled, and ITS secret
 * key in STRIPE_SECRET_KEY. Not classic test mode — allocation exists only in a
 * segregation-enabled Sandbox. No webhook tunnel is needed: 7b reads the event
 * off `events.list` rather than waiting for a delivery, which also lets it dump
 * the whole payload for inspection.
 *
 * SAFETY. Refuses an `sk_live_` key for every probe that moves money, and
 * refuses the repo's placeholder key. `--countries` is read-only (accounts.list)
 * and is the one mode that WANTS the live key, since §7.5 asks about the real
 * connected accounts — it is allowed there, behind a banner.
 *
 * NOT IN STEP 0. Probes 2, 3, 5, 8-13 exercise our code and belong to the full
 * §5 run after the flag is on in staging. This file deliberately stops at the
 * five that need no §3.3 code.
 */
import 'dotenv/config'
import Stripe from 'stripe'
import { writeFileSync } from 'node:fs'
import { ALLOCATED_FUNDS_API_VERSION } from '../shared/src/lib/env.js'

// -----------------------------------------------------------------------------
// Args
// -----------------------------------------------------------------------------

const argv = process.argv.slice(2)
const arg = (name: string): string | null => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? null) : null
}
const COUNTRIES_ONLY = argv.includes('--countries')
const PROBES = (arg('--probe') ?? '1,4,6,7,7b').split(',').map((s) => s.trim())
const DESTINATION = arg('--destination')
const OUT = arg('--out') ?? `segregation-probe-results.json`

// £10.00 per probe charge — large enough that two child transfers and their fees
// fit inside one charge (7b), small enough to be obviously a test.
const AMOUNT = 1000
const CURRENCY = 'gbp'

// -----------------------------------------------------------------------------
// Result recording — observations are the deliverable, checks are commentary
// -----------------------------------------------------------------------------

type Verdict = 'PASS' | 'FAIL' | 'UNKNOWN'

interface Check {
  claim: string
  expected: unknown
  actual: unknown
  verdict: Verdict
}

interface ProbeResult {
  probe: string
  title: string
  status: 'ok' | 'error'
  error?: string
  observations: Record<string, unknown>
  checks: Check[]
}

const results: ProbeResult[] = []

function check(
  checks: Check[],
  claim: string,
  expected: unknown,
  actual: unknown,
  verdict?: Verdict,
): void {
  checks.push({
    claim,
    expected,
    actual,
    verdict: verdict ?? (JSON.stringify(expected) === JSON.stringify(actual) ? 'PASS' : 'FAIL'),
  })
}

// -----------------------------------------------------------------------------
// Stripe client — the preview version, from the ONE place it is defined
// -----------------------------------------------------------------------------

function makeStripe(readOnly: boolean): Stripe {
  const key = process.env.STRIPE_SECRET_KEY ?? ''

  if (!key || key.startsWith('sk_test_...')) {
    console.error(
      'STRIPE_SECRET_KEY is missing or is the repo placeholder.\n' +
        'These probes need the secret key of a Stripe SANDBOX with the\n' +
        'allocated-funds beta enabled — not classic test mode, where\n' +
        'allocated_funds does not exist.',
    )
    process.exit(1)
  }

  if (key.startsWith('sk_live_')) {
    if (!readOnly) {
      console.error(
        'REFUSING: STRIPE_SECRET_KEY is a LIVE key.\n' +
          'These probes create charges, refunds, transfers and reversals.\n' +
          'Run them against a sandbox key. (--countries is read-only and is\n' +
          'the one mode that accepts a live key.)',
      )
      process.exit(1)
    }
    console.warn('⚠  LIVE key in use. --countries is read-only (accounts.list only).\n')
  }

  return new Stripe(key, {
    // The header is what governs runtime; the SDK's literal union is the only
    // obstacle, which is why stripe-client.ts casts rather than upgrading.
    apiVersion: ALLOCATED_FUNDS_API_VERSION as Stripe.LatestApiVersion,
  })
}

// -----------------------------------------------------------------------------
// Helpers — deliberately raw. Nothing here interprets Stripe's shape for us.
// -----------------------------------------------------------------------------

/** Create and confirm a PI carrying allocation, and return its charge id. */
async function allocatedCharge(
  stripe: Stripe,
  label: string,
): Promise<{ paymentIntentId: string; chargeId: string; raw: unknown }> {
  const pi = await stripe.paymentIntents.create({
    amount: AMOUNT,
    currency: CURRENCY,
    payment_method: 'pm_card_visa',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    // Mirrors settlement.ts: transfer_group + allocated_funds[enabled]=true.
    transfer_group: `probe-${label}`,
    ...({ allocated_funds: { enabled: true } } as Record<string, unknown>),
  } as Stripe.PaymentIntentCreateParams)

  const chargeId =
    typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge?.id ?? '')

  if (!chargeId) throw new Error(`PI ${pi.id} produced no charge (status ${pi.status})`)
  return { paymentIntentId: pi.id, chargeId, raw: { id: pi.id, status: pi.status } }
}

/**
 * Read the allocation back the way syncAllocations does — PI retrieve with
 * `expand[]=latest_charge.allocated_funds.balance`. Returns the RAW object, not
 * a total: the whole point of probe 1 is to see the shape before trusting it.
 */
async function readAllocationRaw(stripe: Stripe, paymentIntentId: string): Promise<unknown> {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge.allocated_funds.balance'],
  })
  const charge = pi.latest_charge as unknown as Record<string, unknown> | null
  return charge && typeof charge === 'object'
    ? ((charge as { allocated_funds?: unknown }).allocated_funds ?? null)
    : null
}

/** pending + available, the sum stripe-client.ts::readAllocatedBalance takes. */
function allocatedTotal(allocated: unknown): number | null {
  const bal = (allocated as { balance?: { pending?: number; available?: number } } | null)?.balance
  if (!bal) return null
  return (bal.pending ?? 0) + (bal.available ?? 0)
}

async function platformBalancePence(stripe: Stripe): Promise<number> {
  const bal = await stripe.balance.retrieve()
  const gbp = bal.available.find((b) => b.currency === CURRENCY)
  return gbp?.amount ?? 0
}

/**
 * A destination connected account. Prefer --destination: an account the sandbox
 * has already onboarded behaves like production. The auto-created fallback is a
 * convenience and may need dashboard completion before transfers succeed — if a
 * probe fails with a capability error, that is what it means.
 */
async function resolveDestination(stripe: Stripe): Promise<string> {
  if (DESTINATION) return DESTINATION

  const existing = await stripe.accounts.list({ limit: 100 })
  const usable = existing.data.find((a) => a.capabilities?.transfers === 'active')
  if (usable) {
    console.log(`  using existing connected account ${usable.id} (transfers active)`)
    return usable.id
  }

  console.log('  no transfer-capable connected account found — creating one')
  const created = await stripe.accounts.create({
    type: 'express',
    country: 'GB',
    capabilities: { transfers: { requested: true } },
  })
  console.log(
    `  created ${created.id} — it may need onboarding before transfers succeed.\n` +
      `  If probes 6/7/7b fail on capabilities, onboard it or pass --destination.`,
  )
  return created.id
}

const money = (p: number) => `£${(p / 100).toFixed(2)}`

// -----------------------------------------------------------------------------
// PROBE 1 — allocation lands, and has the shape our code destructures
// -----------------------------------------------------------------------------

async function probe1(stripe: Stripe): Promise<ProbeResult> {
  const checks: Check[] = []
  const before = await platformBalancePence(stripe)

  const { paymentIntentId, chargeId } = await allocatedCharge(stripe, '1')
  const allocated = await readAllocationRaw(stripe, paymentIntentId)
  const total = allocatedTotal(allocated)
  const after = await platformBalancePence(stripe)

  check(checks, 'allocated_funds is present on the charge', true, allocated !== null)
  check(checks, 'allocated_funds.balance.pending == charge amount', AMOUNT, total)
  check(
    checks,
    'platform available balance unchanged by an allocated charge',
    before,
    after,
    before === after ? 'PASS' : 'FAIL',
  )

  return {
    probe: '1',
    title: 'Settlement with allocation on',
    status: 'ok',
    observations: {
      paymentIntentId,
      chargeId,
      amount_pence: AMOUNT,
      // The raw object IS the deliverable: if `balance` is nested differently,
      // or carries a third bucket, readAllocatedBalance() is wrong.
      allocated_funds_RAW: allocated,
      allocated_total_pence: total,
      platform_balance_before_pence: before,
      platform_balance_after_pence: after,
    },
    checks,
  }
}

// -----------------------------------------------------------------------------
// PROBE 4 — full refund pre-transfer drains the allocation
// -----------------------------------------------------------------------------

async function probe4(stripe: Stripe, destination: string): Promise<ProbeResult> {
  const checks: Check[] = []
  const { paymentIntentId, chargeId } = await allocatedCharge(stripe, '4')
  const beforeAllocated = allocatedTotal(await readAllocationRaw(stripe, paymentIntentId))

  const refund = await stripe.refunds.create({ charge: chargeId })
  const afterRaw = await readAllocationRaw(stripe, paymentIntentId)
  const afterAllocated = allocatedTotal(afterRaw)

  check(checks, 'allocation before refund', AMOUNT, beforeAllocated)
  check(checks, 'allocation after full refund', 0, afterAllocated)

  // The charge must stop being drawable. Attempting the transfer is the only
  // honest way to establish that — and the ERROR SHAPE matters: it is what
  // isTerminalTransferError() must classify as terminal, or the payout resume
  // sweep retries a transfer that can never succeed.
  let transferError: Record<string, unknown> | null = null
  let transferSucceeded = false
  try {
    await stripe.transfers.create({
      amount: 100,
      currency: CURRENCY,
      destination,
      ...({ source_transaction: chargeId } as Record<string, unknown>),
    } as Stripe.TransferCreateParams)
    transferSucceeded = true
  } catch (err) {
    const e = err as Stripe.errors.StripeError
    transferError = { type: e.type, code: e.code, message: e.message, statusCode: e.statusCode }
  }

  check(
    checks,
    'a refunded charge is no longer drawable',
    'transfer rejected',
    transferSucceeded ? 'transfer SUCCEEDED' : 'transfer rejected',
  )
  check(
    checks,
    'the rejection is a StripeInvalidRequestError (what isTerminalTransferError treats as terminal)',
    'StripeInvalidRequestError',
    transferError?.type ?? null,
  )

  return {
    probe: '4',
    title: 'Full refund pre-transfer',
    status: 'ok',
    observations: {
      chargeId,
      refundId: refund.id,
      refund_amount_pence: refund.amount,
      allocation_before_pence: beforeAllocated,
      allocation_after_pence: afterAllocated,
      allocated_funds_after_RAW: afterRaw,
      transfer_attempt_error: transferError,
      transfer_unexpectedly_succeeded: transferSucceeded,
    },
    checks,
  }
}

// -----------------------------------------------------------------------------
// PROBE 6 — refund POST-transfer draws platform balance
// -----------------------------------------------------------------------------

async function probe6(stripe: Stripe, destination: string): Promise<ProbeResult> {
  const checks: Check[] = []
  const { paymentIntentId, chargeId } = await allocatedCharge(stripe, '6')

  const net = 400
  const fee = 32
  const transfer = await stripe.transfers.create({
    amount: net,
    currency: CURRENCY,
    destination,
    ...({ source_transaction: chargeId, application_fee_amount: fee } as Record<string, unknown>),
  } as Stripe.TransferCreateParams)

  const afterTransfer = allocatedTotal(await readAllocationRaw(stripe, paymentIntentId))
  const balBefore = await platformBalancePence(stripe)

  const refund = await stripe.refunds.create({ charge: chargeId })

  const afterRefundRaw = await readAllocationRaw(stripe, paymentIntentId)
  const afterRefund = allocatedTotal(afterRefundRaw)
  const balAfter = await platformBalancePence(stripe)

  check(
    checks,
    'transfer + fee leave the allocation (gross = net + fee)',
    AMOUNT - (net + fee),
    afterTransfer,
  )
  check(
    checks,
    'the full refund exceeds what is left allocated, so part comes from platform balance',
    true,
    balAfter < balBefore,
    balAfter < balBefore ? 'PASS' : 'UNKNOWN',
  )

  return {
    probe: '6',
    title: 'Refund post-transfer',
    status: 'ok',
    observations: {
      chargeId,
      transferId: transfer.id,
      transfer_net_pence: net,
      transfer_fee_pence: fee,
      allocation_after_transfer_pence: afterTransfer,
      refundId: refund.id,
      refund_amount_pence: refund.amount,
      allocation_after_refund_pence: afterRefund,
      allocated_funds_after_refund_RAW: afterRefundRaw,
      platform_balance_before_refund_pence: balBefore,
      platform_balance_after_refund_pence: balAfter,
      platform_balance_delta_pence: balAfter - balBefore,
    },
    checks,
  }
}

// -----------------------------------------------------------------------------
// PROBE 7 — a reversal returns funds to ALLOCATED state, not platform balance
// -----------------------------------------------------------------------------

async function probe7(stripe: Stripe, destination: string): Promise<ProbeResult> {
  const checks: Check[] = []
  const { paymentIntentId, chargeId } = await allocatedCharge(stripe, '7')

  const net = 400
  const fee = 32
  const transfer = await stripe.transfers.create({
    amount: net,
    currency: CURRENCY,
    destination,
    ...({ source_transaction: chargeId, application_fee_amount: fee } as Record<string, unknown>),
  } as Stripe.TransferCreateParams)

  const afterTransfer = allocatedTotal(await readAllocationRaw(stripe, paymentIntentId))

  const reversal = await stripe.transfers.createReversal(transfer.id, {
    refund_application_fee: true,
  })

  const afterRaw = await readAllocationRaw(stripe, paymentIntentId)
  const afterReversal = allocatedTotal(afterRaw)
  const reloaded = await stripe.transfers.retrieve(transfer.id)

  check(checks, 'allocation after transfer', AMOUNT - (net + fee), afterTransfer)
  check(
    checks,
    'reversal returns the gross to ALLOCATED state (this is what the `reversal` draw kind models)',
    AMOUNT,
    afterReversal,
  )
  check(checks, 'transfer.amount_reversed is CUMULATIVE', net, reloaded.amount_reversed)

  return {
    probe: '7',
    title: 'Transfer reversal (refund_application_fee=true)',
    status: 'ok',
    observations: {
      chargeId,
      transferId: transfer.id,
      reversalId: reversal.id,
      allocation_after_transfer_pence: afterTransfer,
      allocation_after_reversal_pence: afterReversal,
      allocated_funds_after_reversal_RAW: afterRaw,
      transfer_amount_reversed: reloaded.amount_reversed,
      transfer_reversed_flag: reloaded.reversed,
    },
    checks,
  }
}

// -----------------------------------------------------------------------------
// PROBE 7b — reverse ONE child of a multi-child set. The headline probe.
// -----------------------------------------------------------------------------

async function probe7b(stripe: Stripe, destination: string): Promise<ProbeResult> {
  const checks: Check[] = []
  const since = Math.floor(Date.now() / 1000) - 5
  const { paymentIntentId, chargeId } = await allocatedCharge(stripe, '7b')

  // Two children on ONE charge to ONE destination — the shape a writer payout
  // takes when their earnings span a single settlement but the packer opens
  // more than one slice, and the shape that makes the webhook ambiguous IF the
  // event carries only the charge or only the destination.
  const a = { net: 400, fee: 32 }
  const b = { net: 300, fee: 24 }

  const childA = await stripe.transfers.create({
    amount: a.net,
    currency: CURRENCY,
    destination,
    ...({ source_transaction: chargeId, application_fee_amount: a.fee } as Record<string, unknown>),
  } as Stripe.TransferCreateParams)

  const childB = await stripe.transfers.create({
    amount: b.net,
    currency: CURRENCY,
    destination,
    ...({ source_transaction: chargeId, application_fee_amount: b.fee } as Record<string, unknown>),
  } as Stripe.TransferCreateParams)

  const allocatedBoth = allocatedTotal(await readAllocationRaw(stripe, paymentIntentId))

  // Reverse child A only, and PARTIALLY — a partial is what forces the
  // cumulative question, and prorateCarveReversal()'s whole design rests on
  // amount_reversed being cumulative rather than per-reversal.
  const partial = 150
  const reversal = await stripe.transfers.createReversal(childA.id, {
    amount: partial,
    refund_application_fee: true,
  })

  const reloadedA = await stripe.transfers.retrieve(childA.id)
  const reloadedB = await stripe.transfers.retrieve(childB.id)
  const allocatedAfter = allocatedTotal(await readAllocationRaw(stripe, paymentIntentId))

  // The event, read rather than awaited. `events.list` gives the same payload a
  // webhook delivery would, without a tunnel — and lets us dump it whole.
  await new Promise((r) => setTimeout(r, 3000))
  const events = await stripe.events.list({
    type: 'transfer.reversed',
    created: { gte: since },
    limit: 10,
  })
  const event = events.data[0] ?? null
  const eventObject = (event?.data?.object ?? null) as Record<string, unknown> | null

  check(checks, 'the sibling child B is untouched by A′s reversal', 0, reloadedB.amount_reversed)
  check(checks, 'child A amount_reversed is the partial amount', partial, reloadedA.amount_reversed)
  check(
    checks,
    'a transfer.reversed event arrived',
    true,
    event !== null,
    event ? 'PASS' : 'UNKNOWN',
  )
  // THE question. §3.5 keys the handler on payout_transfers.stripe_transfer_id,
  // so the event's object must carry the CHILD transfer's id.
  check(
    checks,
    "the event object carries the CHILD transfer's own id (what stripe_transfer_id resolves on)",
    childA.id,
    eventObject?.id ?? null,
  )
  check(
    checks,
    'the event object carries a CUMULATIVE amount_reversed (what reversed_pence stages against)',
    partial,
    eventObject?.amount_reversed ?? null,
  )

  return {
    probe: '7b',
    title: 'Reversal of ONE child among several — the re-keying question',
    status: 'ok',
    observations: {
      chargeId,
      childA: { id: childA.id, net: a.net, fee: a.fee },
      childB: { id: childB.id, net: b.net, fee: b.fee },
      allocation_after_both_transfers_pence: allocatedBoth,
      reversalId: reversal.id,
      reversal_amount_pence: partial,
      childA_amount_reversed: reloadedA.amount_reversed,
      childB_amount_reversed: reloadedB.amount_reversed,
      allocation_after_partial_reversal_pence: allocatedAfter,
      event_id: event?.id ?? null,
      event_type: event?.type ?? null,
      // The full payload. Read this by hand — it is the actual deliverable of
      // step 0, and the thing §3.5 was designed against without ever seeing.
      event_data_object_RAW: eventObject,
      events_seen: events.data.map((e) => ({ id: e.id, type: e.type })),
    },
    checks,
  }
}

// -----------------------------------------------------------------------------
// §7.5 — connected-account countries (read-only; pairs with QUERY C of the SQL)
// -----------------------------------------------------------------------------

async function countries(stripe: Stripe): Promise<void> {
  const byCountry = new Map<string, string[]>()
  let count = 0

  for await (const account of stripe.accounts.list({ limit: 100 })) {
    count++
    const c = account.country ?? 'unknown'
    byCountry.set(c, [...(byCountry.get(c) ?? []), account.id])
  }

  console.log(`\n§7.5 — connected accounts by country (${count} total)\n`)
  for (const [country, ids] of [...byCountry].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${country.padEnd(8)} ${String(ids.length).padStart(4)}   ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ' …' : ''}`)
  }

  const nonGb = [...byCountry.keys()].filter((c) => c !== 'GB')
  console.log(
    nonGb.length === 0
      ? '\n✓ All GB. Record that as the §7.5 standing assumption and move on.\n'
      : `\n⚠ NON-GB PRESENT (${nonGb.join(', ')}). §7.5 is LIVE: probe in the sandbox\n` +
          '  whether a GB platform′s allocated funds transfer cross-border, BEFORE the flip.\n',
  )
}

// -----------------------------------------------------------------------------
// Runner
// -----------------------------------------------------------------------------

async function main() {
  const stripe = makeStripe(COUNTRIES_ONLY)

  if (COUNTRIES_ONLY) {
    await countries(stripe)
    return
  }

  console.log(`Funds segregation §5 step 0 — probes ${PROBES.join(', ')}`)
  console.log(`API version: ${ALLOCATED_FUNDS_API_VERSION}\n`)

  const needsDestination = PROBES.some((p) => ['4', '6', '7', '7b'].includes(p))
  const destination = needsDestination ? await resolveDestination(stripe) : ''
  if (destination) console.log(`destination: ${destination}\n`)

  const runners: Record<string, () => Promise<ProbeResult>> = {
    '1': () => probe1(stripe),
    '4': () => probe4(stripe, destination),
    '6': () => probe6(stripe, destination),
    '7': () => probe7(stripe, destination),
    '7b': () => probe7b(stripe, destination),
  }

  for (const p of PROBES) {
    const run = runners[p]
    if (!run) {
      console.log(`  ? unknown probe "${p}" — step 0 covers 1, 4, 6, 7, 7b`)
      continue
    }
    process.stdout.write(`probe ${p} … `)
    try {
      const result = await run()
      results.push(result)
      const failed = result.checks.filter((c) => c.verdict === 'FAIL').length
      const unknown = result.checks.filter((c) => c.verdict === 'UNKNOWN').length
      console.log(
        failed === 0 && unknown === 0
          ? `ok (${result.checks.length} checks passed)`
          : `${failed} FAILED, ${unknown} unknown, of ${result.checks.length}`,
      )
    } catch (err) {
      // A probe that throws is a finding too — record and continue, so one
      // capability error does not cost the whole run.
      const message = err instanceof Error ? err.message : String(err)
      results.push({
        probe: p,
        title: 'threw',
        status: 'error',
        error: message,
        observations: {},
        checks: [],
      })
      console.log(`ERROR — ${message}`)
    }
  }

  console.log('\n' + '─'.repeat(78))
  for (const r of results) {
    console.log(`\nPROBE ${r.probe} — ${r.title}${r.status === 'error' ? '  [ERROR]' : ''}`)
    if (r.error) console.log(`  ${r.error}`)
    for (const c of r.checks) {
      const mark = c.verdict === 'PASS' ? '✓' : c.verdict === 'FAIL' ? '✗' : '?'
      console.log(`  ${mark} ${c.claim}`)
      if (c.verdict !== 'PASS') {
        console.log(`      expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`)
      }
    }
  }

  writeFileSync(OUT, JSON.stringify({ apiVersion: ALLOCATED_FUNDS_API_VERSION, results }, null, 2))
  console.log(`\n${'─'.repeat(78)}`)
  console.log(`Raw observations → ${OUT}`)
  console.log(
    'Read probe 7b′s event_data_object_RAW by hand before trusting §3.5′s re-keying,\n' +
      'and probe 1′s allocated_funds_RAW before trusting readAllocatedBalance().',
  )

  const anyFail = results.some(
    (r) => r.status === 'error' || r.checks.some((c) => c.verdict === 'FAIL'),
  )
  process.exit(anyFail ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
