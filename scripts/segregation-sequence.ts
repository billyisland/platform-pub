#!/usr/bin/env npx tsx
/**
 * scripts/segregation-sequence.ts
 *
 * Funds segregation §5 — THE SEQUENCE (steps 1-13), run against OUR CODE.
 * Spec: docs/adr/FUNDS-SEGREGATION-INTEGRATION.md §5 "Sequence".
 *
 *   npx tsx scripts/segregation-sequence.ts --fixture      # build the fixture only
 *   npx tsx scripts/segregation-sequence.ts --step 1
 *   npx tsx scripts/segregation-sequence.ts --step 1,2 --keep
 *
 * HOW THIS DIFFERS FROM segregation-probes.ts, AND WHY BOTH EXIST. The probes
 * are step 0: they drive Stripe RAW, deliberately with no §3.3 code, to find out
 * what Stripe does before trusting what we assume it does. This file is the
 * opposite and is the actual gate DEPLOYMENT.md names ("do not flip until the
 * sandbox test plan is green"): it drives the SHIPPED payment-service code with
 * STRIPE_ALLOCATED_FUNDS=1 and asserts the ADR's standing claim — that the
 * ledger, our allocation model and Stripe all agree at every step.
 *
 * So the assertions here are three-sided on purpose. A step that only checked
 * our DB would pass just as well against a service that never called Stripe.
 *
 * WHAT IT NEEDS. A running dev stack whose payment-service holds the SANDBOX
 * key and STRIPE_ALLOCATED_FUNDS=1, `stripe listen --forward-to
 * localhost:3001/webhooks/stripe` for the webhook-driven steps, and a connected
 * account in that sandbox with charges+payouts enabled (--destination, or the
 * first eligible one found).
 *
 * THE FIXTURE IS BUILT THROUGH THE REAL PATHS, NOT INSERTED. Reads are accrued
 * by POSTing real gate passes to the internal /gate-pass route, so the free
 * allowance, the generated chargeable_pence and the accrual ledger entries are
 * all produced by production code. The only direct DB writes are the three
 * things a sandbox cannot mint for itself: which Stripe customer a reader is,
 * which connected account a writer is, and the payout threshold dial. Each is
 * logged. Nothing hand-writes a read_event, a payout, or a ledger row — the bug
 * class this whole exercise exists to catch lives exactly there.
 *
 * SAFETY. Refuses a live key outright: every step moves money. Refuses to run
 * against a DATABASE_URL that is not local, because it mutates account rows.
 */
import 'dotenv/config'
import Stripe from 'stripe'
import { writeFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'
import { ALLOCATED_FUNDS_API_VERSION } from '../shared/src/lib/env.js'

// -----------------------------------------------------------------------------
// Args
// -----------------------------------------------------------------------------

const argv = process.argv.slice(2)
const arg = (name: string): string | null => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

const FIXTURE_ONLY = argv.includes('--fixture')
const STEPS = (arg('--step') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const DESTINATION = arg('--destination')
const OUT = arg('--out') ?? 'segregation-sequence-results.json'
const PAYMENT_URL = process.env.PAYMENT_URL ?? 'http://localhost:3001'

// Two readers so a writer's earnings span TWO settled charges — that is what
// makes the payout multi-child, which is the whole point of step 2. One reader
// would pack onto a single charge and prove nothing about the packer.
const READERS = 2
// £14 of reads per reader per writer: comfortably over the £8 settlement
// threshold, and enough that two readers put one writer over any sane payout
// threshold without needing dozens of gate passes.
const READ_PENCE = 700
const READS_PER_PAIR = 2

// -----------------------------------------------------------------------------
// Result recording — same contract as the probes: a failed check is a finding,
// never a halt. The run always completes and always writes its JSON.
// -----------------------------------------------------------------------------

type Verdict = 'PASS' | 'FAIL' | 'UNKNOWN'

interface Check {
  claim: string
  expected: unknown
  actual: unknown
  verdict: Verdict
}

interface StepResult {
  step: string
  title: string
  status: 'ok' | 'error'
  error?: string
  observations: Record<string, unknown>
  checks: Check[]
}

const results: StepResult[] = []

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
// Clients
// -----------------------------------------------------------------------------

function makeStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY ?? ''
  if (!key || key.startsWith('sk_test_...')) {
    console.error(
      'STRIPE_SECRET_KEY is missing or is the repo placeholder.\n' +
        'This needs the secret key of the segregation SANDBOX — the same one\n' +
        'the running payment-service is using.',
    )
    process.exit(1)
  }
  if (key.startsWith('sk_live_')) {
    console.error('REFUSING: live key. Every step here moves money.')
    process.exit(1)
  }
  return new Stripe(key, { apiVersion: ALLOCATED_FUNDS_API_VERSION as Stripe.LatestApiVersion })
}

function makePool(): Pool {
  const url = process.env.DATABASE_URL ?? ''
  if (!url) {
    console.error('DATABASE_URL is required (the dev database this stack runs on).')
    process.exit(1)
  }
  if (!/@(localhost|127\.0\.0\.1|postgres)[:/]/.test(url)) {
    console.error(
      `REFUSING: DATABASE_URL does not look local (${url.replace(/:[^:@]*@/, ':***@')}).\n` +
        'This script mutates account rows and a platform_config dial.',
    )
    process.exit(1)
  }
  return new Pool({ connectionString: url })
}

const stripe = makeStripe()
const pool = makePool()

const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? ''

async function paymentPost(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${PAYMENT_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Allocation materialises ~1-3s after the PI returns (probe 1, measured). Every
// read-back here polls rather than reading once — a single eager read is
// indistinguishable from the beta being off, which cost a whole session before.
// `allocated_funds.balance` is NOT returned by a bare charges.retrieve — it must
// be EXPANDED, exactly as syncAllocations does. Reading without the expand
// returns a charge with no allocation on it and is indistinguishable from the
// beta being off; that cost an hour here on 2026-07-31, the same false negative
// probe 1 hit from the other direction (reading too early).
async function pollAllocation(
  paymentIntentId: string,
  timeoutMs = 20000,
): Promise<{ pending: number; available: number; waitedMs: number } | null> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const pi = (await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.allocated_funds.balance'],
    })) as any
    const bal = pi.latest_charge?.allocated_funds?.balance
    if (bal && (bal.pending || bal.available)) {
      return {
        pending: bal.pending ?? 0,
        available: bal.available ?? 0,
        waitedMs: Date.now() - started,
      }
    }
    await sleep(1000)
  }
  return null
}

// -----------------------------------------------------------------------------
// Fixture
//
// Everything here is idempotent and tagged, so a re-run reuses rather than
// multiplies. The tag is what the teardown and the reporting select on.
// -----------------------------------------------------------------------------

const FIXTURE_TAG = 'segregation-sequence'

interface Fixture {
  readers: { accountId: string; username: string; tabId: string; customerId: string }[]
  writers: { accountId: string; username: string; connectId: string }[]
  articles: { id: string; writerId: string }[]
  destination: string
}

async function pickDestination(): Promise<string> {
  if (DESTINATION) return DESTINATION
  const list = await stripe.accounts.list({ limit: 20 })
  const usable = list.data.find((a) => a.charges_enabled && a.payouts_enabled)
  if (!usable) {
    console.error(
      'No connected account in this sandbox has charges+payouts enabled.\n' +
        'Onboard one, or pass --destination acct_...',
    )
    process.exit(1)
  }
  return usable.id
}

async function buildFixture(): Promise<Fixture> {
  const destination = await pickDestination()

  // --- Writers: real accounts, given a real connected account -----------------
  // Only ONE sandbox account is onboarded, and accounts.stripe_connect_id is
  // UNIQUE, so exactly one writer can be payable. The second writer is carried
  // deliberately WITHOUT a connect id: the ADR's step 2 wants two writers, and
  // an unpayable one is the honest negative control — the cycle must skip it
  // cleanly rather than fail the batch.
  // A PERSONAL article specifically: a publication article routes its reads to
  // the publication pool and is excluded from the individual writer cycle, so a
  // writer whose only article belongs to a publication would silently never be
  // payable here (the two cycles are exact complements, keyed on
  // read_events.publication_id).
  const writerRows = await pool.query<{ id: string; username: string }>(
    `SELECT a.id, a.username
       FROM accounts a
      WHERE EXISTS (
              SELECT 1 FROM articles ar
               WHERE ar.writer_id = a.id
                 AND ar.deleted_at IS NULL
                 AND ar.publication_id IS NULL)
      ORDER BY a.created_at
      LIMIT 2`,
  )
  if (writerRows.rowCount! < 2) throw new Error('need 2 writer accounts with articles')

  const [w1, w2] = writerRows.rows
  // accounts.stripe_connect_id is UNIQUE, so the id must be released from any
  // prior holder before it can be claimed — otherwise a re-run (or a run that
  // failed after assigning) collides with itself.
  await pool.query(
    `UPDATE accounts
        SET stripe_connect_id = NULL, stripe_connect_kyc_complete = FALSE
      WHERE stripe_connect_id = $1 AND id <> $2`,
    [destination, w1.id],
  )
  await pool.query(
    `UPDATE accounts
        SET stripe_connect_id = $2, stripe_connect_kyc_complete = TRUE
      WHERE id = $1`,
    [w1.id, destination],
  )
  await pool.query(
    `UPDATE accounts
        SET stripe_connect_id = NULL, stripe_connect_kyc_complete = FALSE
      WHERE id = $1`,
    [w2.id],
  )

  // --- Readers: FRESH accounts, each with a real Stripe customer and card -----
  // Minted per run rather than borrowed from the seed set. A reader who has
  // already settled carries state that silently disables this whole step: a
  // negative tab (pre-paid credit, entirely legal) makes every subsequent read
  // land `platform_settled` on the spot, so no threshold is ever crossed and no
  // settlement is ever created. Re-using seeded readers made step 1 report
  // "0 settlements" twice while nothing was wrong with the code under test.
  const readers: Fixture['readers'] = []
  const readerRows: { id: string; username: string }[] = []
  for (let i = 0; i < READERS; i++) {
    const tag = `${FIXTURE_TAG}-${randomUUID().slice(0, 8)}`
    const created = await pool.query<{ id: string; username: string }>(
      `INSERT INTO accounts (nostr_pubkey, username, display_name)
            VALUES ($1, $2, $3)
         RETURNING id, username`,
      [createHash('sha256').update(tag).digest('hex'), tag, `Sequence reader ${i + 1}`],
    )
    readerRows.push(created.rows[0])
  }

  for (const r of readerRows) {
    const customer = await stripe.customers.create({
      email: `${r.username}@sequence.test`,
      metadata: { platform: 'all.haus', fixture: FIXTURE_TAG, account_id: r.id },
    })
    // pm_card_visa is Visa — inside the allocated-funds eligible brand set, so
    // this charge WILL carry allocation. Step 9 deliberately uses an ineligible
    // brand to prove the other arm.
    const pm = await stripe.paymentMethods.attach('pm_card_visa' as string, {
      customer: customer.id,
    })
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: pm.id },
    })

    const tab = await pool.query<{ id: string }>(
      `INSERT INTO reading_tabs (reader_id, balance_pence)
            VALUES ($1, 0)
       ON CONFLICT (reader_id) DO UPDATE SET updated_at = now()
         RETURNING id`,
      [r.id],
    )
    await pool.query(
      `UPDATE accounts
          SET stripe_customer_id = $2, card_action_required_at = NULL
        WHERE id = $1`,
      [r.id, customer.id],
    )
    readers.push({
      accountId: r.id,
      username: r.username,
      tabId: tab.rows[0].id,
      customerId: customer.id,
    })
  }

  // --- Articles to read ------------------------------------------------------
  const articles: Fixture['articles'] = []
  for (const w of [w1, w2]) {
    const a = await pool.query<{ id: string }>(
      `SELECT id FROM articles
        WHERE writer_id = $1 AND deleted_at IS NULL AND publication_id IS NULL
        ORDER BY created_at LIMIT 1`,
      [w.id],
    )
    if (a.rowCount === 0) throw new Error(`writer ${w.username} has no personal article`)
    articles.push({ id: a.rows[0].id, writerId: w.id })
  }

  return {
    readers,
    writers: [
      { accountId: w1.id, username: w1.username, connectId: destination },
      { accountId: w2.id, username: w2.username, connectId: '' },
    ],
    articles,
    destination,
  }
}

// Drive real gate passes. This is what mints the reads, through production code.
async function accrueReads(fx: Fixture): Promise<{ posted: number; states: Record<string, number> }> {
  const states: Record<string, number> = {}
  let posted = 0

  for (const reader of fx.readers) {
    // A gate pass needs the reader's pubkey + its hash; both are real columns.
    const acct = await pool.query<{ nostr_pubkey: string }>(
      `SELECT nostr_pubkey FROM accounts WHERE id = $1`,
      [reader.accountId],
    )
    const pubkey = acct.rows[0].nostr_pubkey
    const pubkeyHash = createHash('sha256').update(pubkey).digest('hex')

    for (const article of fx.articles) {
      for (let i = 0; i < READS_PER_PAIR; i++) {
        const res = await paymentPost('/api/v1/gate-pass', {
          readerId: reader.accountId,
          articleId: article.id,
          writerId: article.writerId,
          amountPence: READ_PENCE,
          readerPubkey: pubkey,
          readerPubkeyHash: pubkeyHash,
          tabId: reader.tabId,
        })
        posted++
        const key = `${res.status}:${res.json?.state ?? res.json?.error ?? 'ok'}`
        states[key] = (states[key] ?? 0) + 1
        // The gate pass fires checkAndSettle in the background; give it room so
        // two passes don't race the same tab into two settlements.
        await sleep(400)
      }
    }
  }
  return { posted, states }
}

// -----------------------------------------------------------------------------
// Step 1 — settlement with allocation on
//
// ADR: "Card setup + settlement with allocation on → expand charge; assert
// allocated_funds.balance.pending == amount; platform balance unchanged; the
// allocation-sync sweep stamps allocated_pence."
//
// The settlement itself is triggered the way production triggers it: a gate pass
// that crosses the threshold fires checkAndSettle. The sync sweep runs thrice
// daily on a cron that will not fire inside a session, so it is invoked directly
// — the same exported function the worker calls, against the same database and
// the same key. Only the process differs.
// -----------------------------------------------------------------------------

async function platformBalancePence(): Promise<number> {
  const b = await stripe.balance.retrieve()
  const gbp = (arr: { amount: number; currency: string }[]) =>
    arr.filter((x) => x.currency === 'gbp').reduce((s, x) => s + x.amount, 0)
  return gbp(b.available as any) + gbp(b.pending as any)
}

async function stepOne(fx: Fixture): Promise<StepResult> {
  const checks: Check[] = []
  const observations: Record<string, unknown> = {}

  const balanceBefore = await platformBalancePence()

  // One gate pass per reader, enough to cross the £8 threshold on a fresh tab.
  const settlements: any[] = []
  for (const reader of fx.readers) {
    const acct = await pool.query<{ nostr_pubkey: string }>(
      `SELECT nostr_pubkey FROM accounts WHERE id = $1`,
      [reader.accountId],
    )
    const pubkey = acct.rows[0].nostr_pubkey
    const before = await pool.query(
      `SELECT count(*)::int n FROM tab_settlements WHERE reader_id = $1`,
      [reader.accountId],
    )

    // Gate passes until the tab crosses the settlement threshold and a NEW
    // settlement row lands. The tab may already have been drained by the
    // fixture's own accrual (a gate pass triggers checkAndSettle in production
    // too), so "post one and expect a settlement" is not a safe assumption —
    // that assumption made this step report 0/2 while the settlements it was
    // looking for had already succeeded.
    let row: any = null
    for (let attempt = 0; attempt < 4 && !row; attempt++) {
      await paymentPost('/api/v1/gate-pass', {
        readerId: reader.accountId,
        articleId: fx.articles[0].id,
        writerId: fx.articles[0].writerId,
        amountPence: READ_PENCE,
        readerPubkey: pubkey,
        readerPubkeyHash: createHash('sha256').update(pubkey).digest('hex'),
        tabId: reader.tabId,
      })

      // checkAndSettle is fired and not awaited by the route, so poll.
      for (let i = 0; i < 10; i++) {
        const n = await pool.query(
          `SELECT count(*)::int n FROM tab_settlements WHERE reader_id = $1`,
          [reader.accountId],
        )
        if (n.rows[0].n > before.rows[0].n) {
          const r = await pool.query(
            `SELECT id, amount_pence, status, failure_reason,
                    stripe_payment_intent_id, allocated_pence
               FROM tab_settlements
              WHERE reader_id = $1
              ORDER BY created_at DESC LIMIT 1`,
            [reader.accountId],
          )
          if (r.rows[0].status !== 'pending') {
            row = r.rows[0]
            break
          }
        }
        await sleep(1000)
      }
    }
    // The fixture's own gate passes may already have crossed the threshold and
    // settled — that IS production behaviour, not a miss. So fall back to this
    // reader's most recent settlement rather than reporting nothing, which is
    // what made this step read 0/2 while two correct settlements sat in the DB.
    if (!row) {
      const latest = await pool.query(
        `SELECT id, amount_pence, status, failure_reason,
                stripe_payment_intent_id, allocated_pence
           FROM tab_settlements
          WHERE reader_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [reader.accountId],
      )
      row = latest.rows[0] ?? null
    }
    settlements.push({ reader: reader.username, ...(row ?? { status: 'none' }) })
  }

  observations.settlements = settlements

  const completed = settlements.filter((s) => s?.status === 'completed')
  check(
    checks,
    'every settlement completed (a card on file charges cleanly)',
    fx.readers.length,
    completed.length,
  )

  // --- the allocation itself, read the way syncAllocations reads it ----------
  const allocations: any[] = []
  for (const s of completed) {
    const alloc = await pollAllocation(s.stripe_payment_intent_id)
    allocations.push({ settlement: s.id, amount: s.amount_pence, alloc })
    check(
      checks,
      `allocated_funds.balance.pending == charge amount (${s.reader})`,
      s.amount_pence,
      alloc?.pending ?? null,
    )
  }
  observations.allocations = allocations

  // --- platform balance must not move: allocation locks the funds -----------
  const balanceAfter = await platformBalancePence()
  observations.platformBalance = { before: balanceBefore, after: balanceAfter }
  check(
    checks,
    'platform GBP balance unchanged — allocated funds never land in it',
    balanceBefore,
    balanceAfter,
  )

  // --- the sweep stamps allocated_pence -------------------------------------
  const { settlementService } = await import(
    '../payment-service/src/services/settlement.js'
  )
  const sync = await settlementService.syncAllocations()
  observations.syncAllocations = sync

  const stamped = await pool.query(
    `SELECT id, amount_pence, allocated_pence
       FROM tab_settlements
      WHERE id = ANY($1::uuid[])`,
    [completed.map((s) => s.id)],
  )
  observations.stamped = stamped.rows
  for (const r of stamped.rows) {
    check(
      checks,
      `allocation-sync stamped allocated_pence == amount (${r.id.slice(0, 8)})`,
      r.amount_pence,
      r.allocated_pence,
    )
  }

  return {
    step: '1',
    title: 'Settlement with allocation on',
    status: 'ok',
    observations,
    checks,
  }
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

async function main() {
  console.log('Funds segregation §5 — the sequence (our code, flag ON)')
  console.log(`  payment-service: ${PAYMENT_URL}`)
  console.log(`  api version:     ${ALLOCATED_FUNDS_API_VERSION}`)

  const health = await fetch(`${PAYMENT_URL}/health`).then((r) => r.json()).catch(() => null)
  if (!health) {
    console.error(`payment-service is not reachable at ${PAYMENT_URL}`)
    process.exit(1)
  }

  const fx = await buildFixture()
  console.log(`\nfixture:`)
  console.log(`  destination: ${fx.destination}`)
  for (const r of fx.readers) console.log(`  reader  ${r.username} -> ${r.customerId}`)
  for (const w of fx.writers)
    console.log(`  writer  ${w.username} -> ${w.connectId || '(no connect id — negative control)'}`)

  const accrued = await accrueReads(fx)
  console.log(`  gate passes: ${accrued.posted} ->`, accrued.states)

  const tabs = await pool.query(
    `SELECT a.username, t.balance_pence
       FROM reading_tabs t JOIN accounts a ON a.id = t.reader_id
      WHERE t.reader_id = ANY($1::uuid[])`,
    [fx.readers.map((r) => r.accountId)],
  )
  console.log(`  tabs:`, tabs.rows)

  if (!FIXTURE_ONLY) {
    if (STEPS.includes('1')) results.push(await stepOne(fx))
  }

  for (const r of results) {
    console.log(`\n── step ${r.step}: ${r.title} [${r.status}]`)
    for (const c of r.checks) {
      const mark = c.verdict === 'PASS' ? '✓' : c.verdict === 'FAIL' ? '✗' : '?'
      console.log(`   ${mark} ${c.claim}`)
      if (c.verdict !== 'PASS') {
        console.log(`      expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`)
      }
    }
  }

  const failed = results.flatMap((r) => r.checks).filter((c) => c.verdict !== 'PASS')
  console.log(
    `\n${results.flatMap((r) => r.checks).length} checks, ${failed.length} not passing`,
  )

  writeFileSync(
    OUT,
    JSON.stringify({ fixture: fx, accrued, tabs: tabs.rows, results }, null, 2),
  )
  console.log(`wrote ${OUT}`)

  await pool.end()
}

main().catch(async (err) => {
  console.error('\nFAILED:', err?.message ?? err)
  try {
    await pool.end()
  } catch {
    /* already closed */
  }
  process.exit(1)
})
