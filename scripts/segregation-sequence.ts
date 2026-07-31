#!/usr/bin/env npx tsx
/**
 * scripts/segregation-sequence.ts
 *
 * Funds segregation §5 — THE SEQUENCE (steps 1-13), run against OUR CODE.
 * Spec: docs/adr/FUNDS-SEGREGATION-INTEGRATION.md §5 "Sequence".
 *
 *   npx tsx scripts/segregation-sequence.ts --fixture      # build the fixture only
 *   npx tsx scripts/segregation-sequence.ts --step 1
 *   npx tsx scripts/segregation-sequence.ts --step 2,3,10
 *   npx tsx scripts/segregation-sequence.ts --step 11 --destination acct_A,acct_B
 *
 * IMPLEMENTED: 1 (settlement + allocation), 2 (multi-child writer payout),
 * 3 (forced over-transfer + failure handling), 10 (crash-resume), 11 (publication
 * cycle). Step 13 is the flag-off suite, run separately. 4-9 and 12 are not here;
 * 12 is additionally blocked on the Dial-A tribute rework, so driving it today
 * would book a pass against a model already scheduled for replacement.
 *
 * STEP ORDER MATTERS AND `main` ENFORCES IT. Steps 2, 3 and 10 each consume the
 * writer's claimable earnings, so each one accrues its own (`ensureClaimable`)
 * rather than inheriting a position the previous step just paid out. Step 11 runs
 * LAST unconditionally: it re-homes the sandbox's connect ids onto the
 * publication's members and `accounts.stripe_connect_id` is UNIQUE, so a writer
 * step after it would find its writer un-onboarded.
 *
 * ACCRUING "ITS OWN" MEANS ROTATING THE READERS, and that took a second attempt
 * to get right (2026-07-31). The accrual space is `readers × articles` and a
 * repeat (reader, article) pair mints no read event, so once step 2 has paid out
 * everything the current readers can earn, no number of extra gate passes gives
 * step 3 anything to reserve — and more articles would not help either, since
 * step 2 read them all. `ensureClaimable` therefore mints a FRESH reader set when
 * a round adds nothing (`rotateReaders`). Before that, a multi-step invocation
 * ran step 2 correctly and then reported a threshold shortfall on every step
 * after it, which looks precisely like a broken payout cycle.
 *
 * THE FLAG MUST BE SET IN THIS PROCESS, not merely in the container. Steps 2, 3,
 * 10 and 11 import payoutService and run the cycle here, so they read this
 * shell's `STRIPE_ALLOCATED_FUNDS`. Each refuses rather than reporting a wall of
 * zeroes against a service that took the aggregate path.
 *
 * WHERE A STEP DRIVES A PRIVATE METHOD, THAT IS DELIBERATE. Steps 3, 10 and 11
 * need the state BETWEEN Txn 1 and the Stripe call — a committed pack with
 * nothing yet transferred — which no public entry point exposes because in
 * production only a crash produces it. They call production's own
 * `reserveWriterPayout` / `reservePublicationPayout` rather than hand-writing a
 * payout row: the fabrication is confined to one column of one already-committed
 * child, and everything under test is still reached through production's paths.
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
import { ALLOCATED_FUNDS_API_VERSION, allocatedFundsEnabled } from '../shared/src/lib/env.js'
import { perReadNetPence } from '../shared/src/lib/per-read-net.js'

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
/**
 * Reads per (reader, article) pair — ONE, and it cannot usefully be more.
 *
 * A reader who has already paid for an article is not charged again, so a second
 * gate pass on the same pair returns the existing access and mints no
 * `read_events` row. That is correct product behaviour and it silently bounds
 * this whole harness: the accrual space is `readers × articles`, full stop.
 * Setting this to 2 (as it was until 2026-07-31) posted twice the gate passes for
 * exactly the same earnings, and made `ensureClaimable`'s retry loop inert — 24
 * gate passes across three rounds produced 4 read events and the writer stalled
 * at 1288p against a 2000p threshold, looking for all the world like a broken
 * payout. Grow the ARTICLE count, never this.
 */
const READS_PER_PAIR = 1
/**
 * Articles per writer to read. The threshold is the constraint: at £7 a read and
 * an 8% fee, one writer needs `ceil(2000 / 644) = 4` reads to clear £20, and
 * `readers × articles` must therefore be at least that. Five gives headroom and
 * still leaves the seeded writers' article sets intact.
 */
const ARTICLES_PER_WRITER = 5
/**
 * Per-read price for PUBLICATION reads, higher than `READ_PENCE` on purpose.
 *
 * The writer cycle can reach its threshold by breadth — five articles per writer
 * — but the seeded publication has exactly ONE article, so the pool's accrual
 * space is `readers × 1` and no number of rounds can widen it. Depth is the only
 * dial left: two reads at £15 net £27.60 against the £20 threshold, across the
 * two charges step 11 needs. If a publication with more articles ever exists,
 * prefer widening over this.
 */
const PUB_READ_PENCE = 1500

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
  /** The CURRENT reader set. Rotated per step by `rotateReaders`. */
  readers: { accountId: string; username: string; tabId: string; customerId: string }[]
  /**
   * Every reader this run has minted, current and retired. Funding sources and
   * allocation stamping must span all of them — see `rotateReaders`.
   */
  allReaderIds: string[]
  writers: { accountId: string; username: string; connectId: string }[]
  articles: { id: string; writerId: string }[]
  /** The writer cycle's destination — always `destinations[0]`. */
  destination: string
  /**
   * Every payable connected account this sandbox offers, in discovery order.
   *
   * Steps 1-10 need exactly one. Step 11 needs TWO, and that is a real sandbox
   * prerequisite rather than a harness limitation: a publication payout with one
   * payable member has one split, and a single split that fails takes its parent
   * down with it (correctly — `failedOutright`). The "a failed split completes
   * its parent rather than zombifying it" claim only has meaning when there is a
   * sibling split left to pay, so it needs a second onboarded account.
   */
  destinations: string[]
}

async function pickDestinations(): Promise<string[]> {
  if (DESTINATION) return DESTINATION.split(',').map((s) => s.trim()).filter(Boolean)
  const list = await stripe.accounts.list({ limit: 20 })
  const usable = list.data.filter((a) => a.charges_enabled && a.payouts_enabled)
  if (usable.length === 0) {
    console.error(
      'No connected account in this sandbox has charges+payouts enabled.\n' +
        'Onboard one, or pass --destination acct_... (comma-separated for step 11).',
    )
    process.exit(1)
  }
  return usable.map((a) => a.id)
}

/**
 * Mint N fresh reader accounts, each with a real Stripe customer and card.
 *
 * FRESH, NEVER BORROWED FROM THE SEED SET. A reader who has already settled
 * carries state that silently disables everything downstream: a negative tab
 * (pre-paid credit, entirely legal) makes every subsequent read land
 * `platform_settled` on the spot, so no threshold is crossed and no settlement is
 * ever created. Re-using seeded readers made step 1 report "0 settlements" twice
 * while nothing was wrong with the code under test.
 *
 * CALLED PER STEP, NOT ONCE PER RUN — that is what makes `--step 2,3,10` work.
 * The accrual space is `readers × articles` and a repeat pair mints nothing
 * (READS_PER_PAIR), so once step 2 has paid out everything this reader set can
 * generate, step 3 has no earnings left to reserve. Minting a new set is the only
 * way to refill it; more articles would not help, since step 2 already reads them
 * all. Until 2026-07-31 the fixture minted once per run, and a multi-step
 * invocation reported a threshold shortfall on every step after the first.
 */
async function mintReaders(count: number): Promise<Fixture['readers']> {
  const readers: Fixture['readers'] = []

  for (let i = 0; i < count; i++) {
    const tag = `${FIXTURE_TAG}-${randomUUID().slice(0, 8)}`
    const created = await pool.query<{ id: string; username: string }>(
      `INSERT INTO accounts (nostr_pubkey, username, display_name)
            VALUES ($1, $2, $3)
         RETURNING id, username`,
      [createHash('sha256').update(tag).digest('hex'), tag, `Sequence reader ${i + 1}`],
    )
    const r = created.rows[0]

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
    // The settlement PI passes `payment_method` explicitly (2026-07-31 P0: a PI
    // does NOT inherit invoice_settings.default_payment_method), but this field
    // is what `resolveDefaultPaymentMethod` reads, so it must still be set.
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

  return readers
}

/**
 * Swap in a fresh reader set, remembering the old ones.
 *
 * `allReaderIds` accumulates rather than replaces, because the OLD readers'
 * charges are still funding sources — a payout reserved after the swap draws on
 * whichever charges have allocation left, including theirs. Stamping and the
 * settlement census must therefore span every reader the run has ever minted,
 * not just the current set; scoping them to `fx.readers` would leave earlier
 * charges unstamped, un-drawable, and silently routed to the residual.
 */
async function rotateReaders(fx: Fixture): Promise<string[]> {
  const fresh = await mintReaders(READERS)
  fx.readers = fresh
  const ids = fresh.map((r) => r.accountId)
  fx.allReaderIds.push(...ids)
  return ids
}

async function buildFixture(): Promise<Fixture> {
  const destinations = await pickDestinations()
  const destination = destinations[0]

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

  const readers = await mintReaders(READERS)

  // --- Articles to read ------------------------------------------------------
  // Several per writer, not one. A repeat read of the same article mints no new
  // read_event (see READS_PER_PAIR), so the article count is the ONLY dial that
  // moves a writer's earnings — one article per writer caps this fixture at two
  // reads per writer, permanently under the payout threshold.
  const articles: Fixture['articles'] = []
  for (const w of [w1, w2]) {
    const a = await pool.query<{ id: string }>(
      `SELECT id FROM articles
        WHERE writer_id = $1 AND deleted_at IS NULL AND publication_id IS NULL
        ORDER BY created_at LIMIT $2`,
      [w.id, ARTICLES_PER_WRITER],
    )
    if (a.rowCount === 0) throw new Error(`writer ${w.username} has no personal article`)
    for (const row of a.rows) articles.push({ id: row.id, writerId: w.id })
  }

  return {
    readers,
    allReaderIds: readers.map((r) => r.accountId),
    writers: [
      { accountId: w1.id, username: w1.username, connectId: destination },
      { accountId: w2.id, username: w2.username, connectId: '' },
    ],
    articles,
    destination,
    destinations,
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
// Shared step machinery
//
// Steps 2, 3 and 10 each need the same starting position: one writer holding
// unclaimed `platform_settled` earnings spanning at least two settled charges.
// They cannot inherit it from each other — step 2 pays those earnings out and
// leaves them `writer_paid` — so each step must be able to CREATE that position
// or `--step 2,3,10` would report two spurious failures after one real pass.
// -----------------------------------------------------------------------------

interface Claimable {
  reads: number
  netPence: number
  thresholdPence: number
  feeBps: number
  maxSlices: number
  settlements: number
}

/** What this writer could be paid right now, by production's own arithmetic. */
async function claimableFor(writerId: string): Promise<Claimable> {
  const { loadConfig } = await import('../shared/src/db/client.js')
  const config = await loadConfig(true)
  const { rows } = await pool.query<{ chargeable_pence: number; tab_settlement_id: string | null }>(
    `SELECT chargeable_pence, tab_settlement_id
       FROM read_events
      WHERE writer_id = $1 AND publication_id IS NULL
        AND state = 'platform_settled' AND writer_payout_id IS NULL`,
    [writerId],
  )
  // Per-row floor then sum — production's rounding rule (the platform absorbs
  // the dust), never sum-then-floor, which would collapse N sub-penny fees into
  // one and report a net the cycle will never agree with.
  return {
    reads: rows.length,
    netPence: rows.reduce((s, r) => s + perReadNetPence(r.chargeable_pence, config.platformFeeBps), 0),
    thresholdPence: config.writerPayoutThresholdPence,
    feeBps: config.platformFeeBps,
    maxSlices: config.payoutMaxSlices,
    settlements: new Set(rows.map((r) => r.tab_settlement_id).filter(Boolean)).size,
  }
}

/**
 * Accrue and settle until the writer is payable across >=2 charges, or give up
 * and say so.
 *
 * The wait is for the WEBHOOK, and that is the trap this function exists to make
 * loud. A gate pass charges the card and the settlement reaches `completed` on
 * the create response — but the reads only advance to `platform_settled` in
 * `confirmSettlement`, on `payment_intent.succeeded`. With no `stripe listen`
 * forwarding, everything looks healthy and the payout cycle simply finds nothing
 * eligible, which reads exactly like a broken payout. So: poll, bound it, and
 * return what was actually reached rather than assuming.
 */
async function ensureClaimable(
  fx: Fixture,
  writerId: string,
  rounds = 3,
): Promise<{
  before: Claimable
  after: Claimable
  roundsRun: number
  rotations: string[][]
  accrued: unknown[]
  stamping: { attempts: number; unstamped: number }
}> {
  const before = await claimableFor(writerId)
  const accrued: unknown[] = []
  const rotations: string[][] = []
  let current = before
  let roundsRun = 0

  const enough = (c: Claimable) => c.netPence >= c.thresholdPence && c.settlements >= 2

  while (!enough(current) && roundsRun < rounds) {
    const before = current.reads
    accrued.push(await accrueReads(fx))
    roundsRun++

    // Wait for the webhook to advance the reads. 30s is four orders of magnitude
    // over a local `stripe listen` round trip; a timeout here means the forwarder
    // is not running, not that Stripe is slow.
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      current = await claimableFor(writerId)
      if (enough(current)) break
      await sleep(2000)
    }
    current = await claimableFor(writerId)

    // A round that added no reads will never add any with THIS reader set: the
    // accrual space is `readers × articles` and a repeat pair mints nothing
    // (READS_PER_PAIR). Rotate rather than spin — spinning burns Stripe-backed
    // gate passes to no effect and then reports a threshold shortfall that reads
    // exactly like a payout defect. This is what lets step 3 follow step 2 in one
    // invocation, after step 2 has paid out everything the first set could earn.
    if (current.reads === before) {
      rotations.push(await rotateReaders(fx))
    }
  }

  const stamping = await syncUntilStamped(fx.allReaderIds)

  return { before, after: await claimableFor(writerId), roundsRun, rotations, accrued, stamping }
}

/**
 * Sync allocations until every completed charge is stamped, or say it isn't.
 *
 * ONE SYNC IS NOT ENOUGH, and the failure it produces is thoroughly convincing.
 * `lockFundingSources` requires `allocated_pence IS NOT NULL` — an unstamped
 * charge is "not known to be drawable" and is skipped in silence, which is the
 * correct conservative behaviour. But a settlement that lands *after* the sync
 * stays unstamped, its earnings fall through to the RESIDUAL slice, and that
 * child draws on the platform's ordinary balance instead of segregated funds. In
 * a sandbox whose platform balance is overdrawn it is then rejected
 * `balance_insufficient`, and step 2 reports "every child completed: false"
 * against a payout in which nothing was wrong at all.
 *
 * Compounded by the ~1-3s materialisation lag (probe 1): allocation is not
 * visible the instant the PI returns, so even a well-timed sync can miss the
 * newest charge. Hence loop, with room for the lag, and report the residue
 * rather than assuming success.
 */
async function syncUntilStamped(
  readerIds: string[],
  attempts = 6,
): Promise<{ attempts: number; unstamped: number }> {
  const { settlementService } = await import('../payment-service/src/services/settlement.js')
  for (let i = 1; i <= attempts; i++) {
    await settlementService.syncAllocations()
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tab_settlements
        WHERE reader_id = ANY($1::uuid[])
          AND status = 'completed'
          AND stripe_charge_id IS NOT NULL
          AND allocated_pence IS NULL`,
      [readerIds],
    )
    if (rows[0].n === 0) return { attempts: i, unstamped: 0 }
    await sleep(2500)
  }
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tab_settlements
      WHERE reader_id = ANY($1::uuid[]) AND status = 'completed'
        AND stripe_charge_id IS NOT NULL AND allocated_pence IS NULL`,
    [readerIds],
  )
  return { attempts, unstamped: rows[0].n }
}

/** The writer's most recent payout parent, with its children. */
async function readPayout(payoutId: string): Promise<{ parent: any; children: any[] }> {
  const { rows: parents } = await pool.query(
    `SELECT id, writer_id, amount_pence, status, stripe_transfer_id, failed_reason, completed_at
       FROM writer_payouts WHERE id = $1`,
    [payoutId],
  )
  const { rows: children } = await pool.query(
    `SELECT id, settlement_id, stripe_charge_id, funding, net_pence, fee_pence,
            status, stripe_transfer_id, failure_reason
       FROM payout_transfers
      WHERE parent_table = 'writer_payouts' AND parent_id = $1
      ORDER BY id`,
    [payoutId],
  )
  return { parent: parents[0] ?? null, children }
}

/**
 * Ledger entries posted against a payout parent, in order.
 *
 * `amount_pence` is COERCED, and that is not tidying. It is a `bigint`, which
 * node-postgres returns as a STRING to avoid silently truncating past 2^53 — so
 * `sum + e.amount_pence` concatenates ("0" + "1288" + "644" …) and a multiset
 * comparison tests 644 against "644". Both failed on the first green run of step
 * 2 while every underlying figure was correct. The dangerous direction is the
 * other one: a string sum never equals a number, so such a check can only ever
 * fail — but a check that cannot pass is as useless as one that cannot fail, and
 * the next person would have read the noise as a real ledger divergence.
 */
async function ledgerFor(payoutId: string): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT id, account_id, counterparty_id, amount_pence, trigger_type, ref_table, ref_id
       FROM ledger_entries
      WHERE ref_table = 'writer_payouts' AND ref_id = $1
      ORDER BY created_at`,
    [payoutId],
  )
  return rows.map((r: any) => ({ ...r, amount_pence: Number(r.amount_pence) }))
}

/**
 * The flag must be ON IN THIS PROCESS. The harness imports payoutService and
 * runs the cycle in its own process, not in the container — so it reads its OWN
 * env. With the flag off, `completeWriterPayout` takes the aggregate path, mints
 * no children at all, and every child-level check reports 0 against an expected
 * 2: a step that looks comprehensively broken when nothing is broken except the
 * shell it was launched from.
 */
function flagGuard(step: string, title: string, checks: Check[]): StepResult | null {
  if (allocatedFundsEnabled()) return null
  check(
    checks,
    'STRIPE_ALLOCATED_FUNDS=1 in THIS process (the harness runs the cycle itself)',
    '1',
    process.env.STRIPE_ALLOCATED_FUNDS ?? '(unset)',
    'UNKNOWN',
  )
  return {
    step,
    title,
    status: 'error',
    error:
      'STRIPE_ALLOCATED_FUNDS is not 1 in this process. The container having it is not enough — ' +
      'the harness imports payoutService and runs the cycle here.',
    observations: {},
    checks,
  }
}

// -----------------------------------------------------------------------------
// Step 2 — the multi-child writer payout
//
// ADR: "Accrue reads for >=2 writers across >=2 settlements; cross the threshold
// -> the payout cycle emits one transfer per drawn charge with correct
// source_transaction and application_fee_amount; app fees appear in platform
// balance; each child posts ITS OWN ledger entry at its own completion, refs
// pointing at the parent; the parent completes once with amount_pence ==
// SUM(completed children); then run the ledger-reconcile cycle and assert it
// stays green — ledger_orphans must tolerate N entries per parent (§3.6)."
//
// THIS IS THE ONE NOTHING IN THE REPO CAN REACH. `executePendingChildren`'s
// Stripe half — the terminal/ambiguous split, the row-stable `xfer-<childId>`
// key, the ledger emit gated on the pending->completed flip's rowCount — drives
// the module-level `pool` and is unreachable from a rolled-back transaction, so
// the 28 DB-backed assembly tests stop at the packing and the rest is pinned
// only by mock batteries. A mock answers the call; it does not enforce Stripe's
// rules. Every rule this step checks is one only Stripe knows.
//
// THE ASSERTIONS ARE THREE-SIDED, and that is the point. Our DB says N children
// completed; Stripe says N transfers exist with those amounts, sources and fees;
// the ledger says N entries sum to the parent. A step that checked only the
// first would pass just as well against a service that never called Stripe.
//
// WHY TWO READERS MAKE IT MULTI-CHILD. Settlement is per reader tab, so two
// readers produce two charges. One writer read by both therefore has earnings
// spanning two settlements, and `packUnits` keys its slices by settlement id —
// one slice per funding charge — so the payout packs into two children. A single
// reader would pack onto one charge and prove nothing about the child lifecycle
// that the aggregate path does not already prove.
// -----------------------------------------------------------------------------

/**
 * Poll the platform balance until it reaches `expected`, or time out.
 *
 * The fee is what we are watching for, and Stripe does not necessarily reflect
 * it the instant `transfers.create` returns — the same lag probe 1 measured on
 * the allocation side (~1-3s). A single eager read would report "the fee never
 * arrived" for a fee that arrives a second later, which is the false negative
 * that has now bitten this exercise twice in two different ways. So poll, and
 * report what it actually reached rather than the last sample.
 */
async function pollPlatformBalance(
  expected: number,
  timeoutMs = 25000,
): Promise<{ pence: number; waitedMs: number; reached: boolean }> {
  const started = Date.now()
  let last = await platformBalancePence()
  while (Date.now() - started < timeoutMs) {
    if (last === expected) return { pence: last, waitedMs: Date.now() - started, reached: true }
    await sleep(1000)
    last = await platformBalancePence()
  }
  return { pence: last, waitedMs: Date.now() - started, reached: last === expected }
}

async function stepTwo(fx: Fixture): Promise<StepResult> {
  const checks: Check[] = []
  const observations: Record<string, unknown> = {}

  const payable = fx.writers[0] // the one with a connect id
  const control = fx.writers[1] // the negative control: no connect id

  const blocked = flagGuard('2', 'Multi-child writer payout', checks)
  if (blocked) return blocked

  const { payoutService } = await import('../payment-service/src/services/payout.js')
  const { reconcileLedger } = await import(
    '../payment-service/src/services/reconcile-ledger.js'
  )

  // --- Preconditions, established rather than assumed -----------------------
  // Accrues and settles until the writer is payable across >=2 charges, and
  // stamps the allocations. Standing alone matters: step 2 may follow step 1 in
  // one invocation, or run cold against a database whose earlier reads are all
  // `writer_paid` already.
  const prep = await ensureClaimable(fx, payable.accountId)
  observations.ensureClaimable = prep

  // Surfaced as its own check because an unstamped charge does not fail loudly:
  // it is skipped as un-drawable, its earnings fall to the residual slice, and
  // the resulting platform-balance transfer is what fails — three steps away
  // from the cause. Naming it here turns a puzzling child failure into a
  // one-line diagnosis.
  check(
    checks,
    'every completed charge is allocation-stamped before the cycle — an unstamped one is skipped as ' +
      'un-drawable and routes its earnings to the residual',
    0,
    prep.stamping.unstamped,
  )

  const { rows: settlements } = await pool.query(
    `SELECT ts.id, ts.reader_id, ts.status, ts.amount_pence, ts.allocated_pence,
            ts.stripe_charge_id,
            GREATEST(0, COALESCE(ts.allocated_pence, 0) - COALESCE((
              SELECT SUM(d.gross_pence) FROM allocated_draws d WHERE d.settlement_id = ts.id
            ), 0))::int AS remaining_pence
       FROM tab_settlements ts
      WHERE ts.reader_id = ANY($1::uuid[])
      ORDER BY ts.created_at`,
    // ALL readers, not just the current set: a retired reader's charge still has
    // allocation on it and is still a legitimate funding source for this payout.
    [fx.allReaderIds],
  )
  observations.settlements = settlements

  const drawable = settlements.filter(
    (s: any) => s.status === 'completed' && s.stripe_charge_id && s.allocated_pence !== null,
  )
  check(
    checks,
    'at least 2 drawable settlements exist (two readers, two charges — what makes the payout multi-child)',
    true,
    drawable.length >= 2,
  )

  // The reads must be `platform_settled` before the cycle can claim them, and
  // that state is stamped by `confirmSettlement` on the payment_intent.succeeded
  // WEBHOOK. Without `stripe listen` running, the charge succeeds, the settlement
  // completes, and the reads simply never advance — the cycle then finds nothing
  // eligible and reports a clean zero. That is indistinguishable from a payout
  // bug unless the state census is on the record, so put it on the record.
  const { rows: readCensus } = await pool.query(
    `SELECT state, count(*)::int AS n, COALESCE(SUM(chargeable_pence), 0)::int AS chargeable
       FROM read_events
      WHERE writer_id = $1 AND publication_id IS NULL
      GROUP BY state ORDER BY state`,
    [payable.accountId],
  )
  observations.readCensus = readCensus

  const claimable = await claimableFor(payable.accountId)
  observations.eligibility = { writer: payable.username, ...claimable }
  check(
    checks,
    `writer is over the payout threshold (${claimable.netPence}p vs ${claimable.thresholdPence}p) — ` +
      'a shortfall here means the fixture under-accrued or the webhook never advanced the reads',
    true,
    claimable.netPence >= claimable.thresholdPence,
  )
  check(
    checks,
    'the claimable reads span >=2 settlements — what makes the pack multi-child',
    true,
    claimable.settlements >= 2,
  )

  // --- Reconcile BEFORE, so a pre-existing dev-DB violation is not our finding
  const reconcileBefore = await reconcileLedger(pool)
  observations.reconcileBefore = reconcileBefore

  const balanceBefore = await platformBalancePence()

  // --- Run the real cycle ----------------------------------------------------
  const cycle = await payoutService.runPayoutCycle()
  observations.cycle = cycle

  // --- The parent ------------------------------------------------------------
  const { rows: parents } = await pool.query(
    `SELECT id, writer_id, amount_pence, status, stripe_transfer_id, failed_reason,
            completed_at
       FROM writer_payouts
      WHERE writer_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [payable.accountId],
  )
  const parent: any = parents[0] ?? null
  observations.parent = parent

  // The negative control. Writer 2 carries no connect id, so the eligibility
  // query must not select it — the cycle skips it cleanly rather than failing
  // the batch. An unpayable writer that fails the whole cycle is a real bug
  // shape, and one aggregate-path testing has no way to produce.
  const { rows: controlPayouts } = await pool.query(
    `SELECT count(*)::int AS n FROM writer_payouts WHERE writer_id = $1`,
    [control.accountId],
  )
  observations.controlPayouts = controlPayouts[0].n
  check(
    checks,
    `the un-onboarded writer (${control.username}) is skipped, not failed — no payout row at all`,
    0,
    controlPayouts[0].n,
  )

  if (!parent) {
    check(checks, 'a writer payout was created', true, false)
    return {
      step: '2',
      title: 'Multi-child writer payout',
      status: 'ok',
      observations,
      checks,
    }
  }

  // --- The children ----------------------------------------------------------
  const { rows: children } = await pool.query(
    `SELECT id, settlement_id, stripe_charge_id, funding, net_pence, fee_pence,
            status, stripe_transfer_id, failure_reason
       FROM payout_transfers
      WHERE parent_table = 'writer_payouts' AND parent_id = $1
      ORDER BY id`,
    [parent.id],
  )
  observations.children = children

  check(
    checks,
    'the payout is MULTI-CHILD — one transfer per drawn charge, not one aggregate transfer',
    true,
    children.length >= 2,
  )
  check(
    checks,
    'the parent carries NO aggregate stripe_transfer_id (the segregated path never creates one)',
    null,
    parent.stripe_transfer_id,
  )

  const completedChildren = children.filter((c: any) => c.status === 'completed')
  const failedChildren = children.filter((c: any) => c.status !== 'completed')

  // ALLOCATED children completing is the claim this step exists to test, and it
  // is unconditional. A RESIDUAL child is a different animal: it draws on the
  // platform's ordinary balance rather than segregated funds (§3.3d), so in a
  // sandbox whose balance is thin it fails `balance_insufficient` — an
  // environment fact that says nothing about the payout code, and which
  // otherwise reads as "the payout is broken". Separate the two rather than
  // weakening either: an allocated failure still FAILS, a residual funding
  // failure reports UNKNOWN and names the top-up.
  const allocatedFailures = failedChildren.filter((c: any) => c.funding === 'allocated')
  const residualFunding = failedChildren.filter(
    (c: any) => c.funding === 'platform_balance' && c.failure_reason === 'balance_insufficient',
  )
  check(checks, 'every ALLOCATED child completed', 0, allocatedFailures.length)
  if (residualFunding.length > 0) {
    check(
      checks,
      `${residualFunding.length} residual child/children failed balance_insufficient — the SANDBOX platform ` +
        'balance is too thin to fund a non-allocated transfer, not a payout defect. Top it up with a ' +
        'pm_card_bypassPending PaymentIntent and re-run.',
      null,
      null,
      'UNKNOWN',
    )
  } else {
    check(checks, 'every child completed, residual included', children.length, completedChildren.length)
  }

  // At most one child per funding charge, plus at most one residual. `packUnits`
  // keys its slices by settlement id, so two children on one charge would mean
  // the pack itself had drifted — a shape that costs an extra Stripe call per
  // payout and over-draws nothing, so nothing else would ever notice it.
  const allocatedChildren = children.filter((c: any) => c.funding === 'allocated')
  const residualChildren = children.filter((c: any) => c.funding === 'platform_balance')
  const distinctCharges = new Set(allocatedChildren.map((c: any) => c.settlement_id))
  check(
    checks,
    'at most one allocated child per funding charge',
    allocatedChildren.length,
    distinctCharges.size,
  )
  check(checks, 'at most one residual child', true, residualChildren.length <= 1)

  // --- Stripe's own account of the same transfers ----------------------------
  const transfers: any[] = []
  for (const child of completedChildren as any[]) {
    if (!child.stripe_transfer_id) {
      check(
        checks,
        `child ${child.id.slice(0, 8)} completed WITH a stripe_transfer_id`,
        true,
        false,
      )
      continue
    }
    let t: any = null
    try {
      t = await stripe.transfers.retrieve(child.stripe_transfer_id)
    } catch (err: any) {
      transfers.push({ child: child.id, error: err?.message ?? String(err) })
      check(
        checks,
        `Stripe knows transfer ${child.stripe_transfer_id} (child ${child.id.slice(0, 8)})`,
        true,
        false,
      )
      continue
    }
    const sourceTransaction =
      typeof t.source_transaction === 'string' ? t.source_transaction : t.source_transaction?.id ?? null
    const destination = typeof t.destination === 'string' ? t.destination : t.destination?.id ?? null
    // `application_fee_amount` on a Transfer is preview-surface: if the pinned
    // SDK's response shape does not carry it, an absent field is NOT evidence
    // that no fee was charged. Report UNKNOWN and let the platform-balance delta
    // below — which is the ADR's actual claim about fees — carry that weight.
    const feeField = (t as any).application_fee_amount
    transfers.push({
      child: child.id,
      id: t.id,
      amount: t.amount,
      currency: t.currency,
      destination,
      source_transaction: sourceTransaction,
      application_fee_amount: feeField ?? null,
      reversed: t.reversed,
    })

    check(checks, `transfer amount == child net (${child.id.slice(0, 8)})`, child.net_pence, t.amount)
    check(checks, `transfer destination == the writer's connect account (${child.id.slice(0, 8)})`, fx.destination, destination)

    // The two fundings have OPPOSITE contracts and asserting the allocated one on
    // a residual child is a false failure. `allocatedTransferParams` returns {}
    // for a residual: no `source_transaction` (there is no charge behind it) and
    // no `application_fee_amount`, because with no allocation the fee is IMPLICIT
    // — the platform keeps it by simply not transferring it. Passing a fee of 0
    // would be a request for no fee, which is why the param is omitted rather
    // than zeroed. Stripe also rejects `application_fee_amount` outright on a
    // transfer whose source is not an allocated charge (probe 6), so the two are
    // inseparable in both directions.
    if (child.funding === 'allocated') {
      check(
        checks,
        `source_transaction == the child's funding charge (${child.id.slice(0, 8)})`,
        child.stripe_charge_id,
        sourceTransaction,
      )
      check(
        checks,
        `application_fee_amount == child fee (${child.id.slice(0, 8)})`,
        child.fee_pence,
        feeField ?? null,
        feeField === undefined ? 'UNKNOWN' : undefined,
      )
    } else {
      check(
        checks,
        `residual child carries NO source_transaction (${child.id.slice(0, 8)})`,
        null,
        sourceTransaction,
      )
      check(
        checks,
        `residual child carries NO application_fee_amount — the fee is implicit (${child.id.slice(0, 8)})`,
        null,
        feeField ?? null,
      )
    }
  }
  observations.transfers = transfers

  // --- What the platform balance does, in BOTH directions --------------------
  // Step 1 established that allocated funds never enter the platform balance, so
  // an allocated child moves it only by its application fee — the one point at
  // which the fee becomes ours. A RESIDUAL child moves it the other way and by
  // far more: its whole net is PAID OUT of the ordinary balance, and it claims no
  // fee at all. So the expected delta is a difference, not a sum, and it is
  // routinely NEGATIVE. Summing every child's fee (as this did until 2026-07-31)
  // is only right for an all-allocated payout, and reports a false failure the
  // moment one unit falls to the residual.
  const allocatedFeePence = completedChildren
    .filter((c: any) => c.funding === 'allocated')
    .reduce((s: number, c: any) => s + c.fee_pence, 0)
  const residualNetPence = completedChildren
    .filter((c: any) => c.funding === 'platform_balance')
    .reduce((s: number, c: any) => s + c.net_pence, 0)
  const expectedDelta = allocatedFeePence - residualNetPence

  const balanceAfter = await pollPlatformBalance(balanceBefore + expectedDelta)
  observations.platformBalance = {
    before: balanceBefore,
    after: balanceAfter.pence,
    delta: balanceAfter.pence - balanceBefore,
    allocatedFeePence,
    residualNetPence,
    expectedDelta,
    waitedMs: balanceAfter.waitedMs,
  }
  check(
    checks,
    'platform balance moved by exactly (Σ allocated fees − Σ residual nets)',
    expectedDelta,
    balanceAfter.pence - balanceBefore,
  )

  // --- allocated_draws: one per allocated child, at GROSS --------------------
  // Gross, not net: Stripe debits the fee from the same allocated balance, and
  // the two together are what the charge must fund. A draw recorded at net is
  // the over-draw bug, and it would only surface on the LAST payout to touch
  // that charge, months later.
  const { rows: draws } = await pool.query(
    `SELECT d.id, d.settlement_id, d.kind, d.ref_id, d.gross_pence
       FROM allocated_draws d
      WHERE d.ref_table = 'payout_transfers'
        AND d.ref_id = ANY($1::uuid[])
      ORDER BY d.created_at`,
    [children.map((c: any) => c.id)],
  )
  observations.draws = draws
  check(
    checks,
    'one allocated_draws row per allocated child',
    allocatedChildren.length,
    draws.filter((d: any) => d.kind === 'transfer').length,
  )
  for (const child of allocatedChildren as any[]) {
    const draw: any = draws.find((d: any) => d.ref_id === child.id)
    check(
      checks,
      `draw is GROSS = net + fee (${child.id.slice(0, 8)})`,
      child.net_pence + child.fee_pence,
      draw?.gross_pence ?? null,
    )
  }

  // --- The ledger: one entry per child, at the child's own net, ref = PARENT --
  const entries = await ledgerFor(parent.id)
  observations.ledgerEntries = entries
  check(
    checks,
    'one ledger entry per COMPLETED child (not one per parent, and not one per attempted child)',
    completedChildren.length,
    entries.length,
  )
  const sortNums = (xs: number[]) => [...xs].sort((a, b) => a - b)
  check(
    checks,
    'the entry amounts are exactly the completed children nets',
    sortNums(completedChildren.map((c: any) => c.net_pence)),
    sortNums(entries.map((e: any) => e.amount_pence)),
  )
  check(
    checks,
    'every entry credits the writer against a NULL counterparty (platform is never an account_id)',
    true,
    entries.every((e: any) => e.account_id === payable.accountId && e.counterparty_id === null),
  )
  check(
    checks,
    'every entry refs the PARENT writer_payouts row, never the child',
    true,
    entries.every((e: any) => e.ref_table === 'writer_payouts' && e.ref_id === parent.id),
  )

  // --- The parent's restated amount -----------------------------------------
  const completedNet = completedChildren.reduce((s: number, c: any) => s + c.net_pence, 0)
  check(checks, 'the parent completed', 'completed', parent.status)
  check(
    checks,
    'parent amount_pence == SUM(completed children net)',
    completedNet,
    parent.amount_pence,
  )
  check(
    checks,
    'ledger sum == parent amount (the parity that makes N-entries-per-parent safe)',
    parent.amount_pence,
    entries.reduce((s: number, e: any) => s + e.amount_pence, 0),
  )

  // --- The claim rows advanced, per child -----------------------------------
  const { rows: advanced } = await pool.query(
    `SELECT state, count(*)::int AS n
       FROM read_events
      WHERE writer_payout_id = $1
      GROUP BY state ORDER BY state`,
    [parent.id],
  )
  observations.claimStates = advanced
  check(
    checks,
    'every read claimed by this payout advanced to writer_paid',
    true,
    advanced.length > 0 && advanced.every((r: any) => r.state === 'writer_paid'),
  )

  // --- Reconcile AFTER -------------------------------------------------------
  // The claim under test is §3.6's: `ledger_orphans` must TOLERATE N entries per
  // parent. It is a whole-DB check, so the honest form is the paired one — a
  // violation the dev DB already carried is not this step's finding. Compare the
  // sets, and report both.
  const reconcileAfter = await reconcileLedger(pool)
  observations.reconcileAfter = reconcileAfter
  const before = new Set(reconcileBefore.violations.map((v: any) => `${v.check}:${v.count}`))
  const newViolations = reconcileAfter.violations.filter(
    (v: any) => !before.has(`${v.check}:${v.count}`),
  )
  observations.newViolations = newViolations
  check(
    checks,
    'ledger-reconcile gains no violation from N entries per parent (§3.6 ledger_orphans tolerates them)',
    [],
    newViolations.map((v: any) => `${v.check}(${v.count})`),
  )

  return {
    step: '2',
    title: 'Multi-child writer payout',
    status: 'ok',
    observations,
    checks,
  }
}

// -----------------------------------------------------------------------------
// Step 3 — forced over-transfer, and the failure handling underneath it
//
// ADR: "bypass the packer (or hand-edit an allocated_draws row) to emit a slice
// exceeding the charge's remaining allocation -> Stripe rejects; the worker marks
// that child failed, DELETEs its draw row, releases exactly its units
// (payout_transfer_id + parent stamp nulled on those rows and no others);
// siblings complete; the parent completes with the restated, smaller amount and a
// failed_reason; the ledger sums to the restated amount; the next cycle re-packs
// the released units onto a different source. This tests failure HANDLING: with
// the packer in place the ordinary path can no longer produce this (§3.3e)."
//
// SO THE FABRICATION IS THE POINT, and it must be honest about which half it
// fabricates. `insertChildren` writes the child and its `allocated_draws` row in
// the same transaction that read the remainder under lock, which is what makes
// over-transfer structurally impossible rather than merely tested against. The
// only way to reach the handling code is therefore to corrupt state AFTER the
// pack has committed — so this step drives the REAL reserve (production's own
// private `reserveWriterPayout`, not a hand-written payout row), then inflates
// one committed child's `net_pence` past its charge, then drives the REAL
// execute. Everything under test — the terminal classification, the draw delete,
// the unit release, the parent restatement — is production code reached through
// production's own entry points.
//
// THE DRAW ROW IS DELIBERATELY LEFT STALE at the original gross. That is what
// makes STRIPE the thing that rejects, rather than our own budget arithmetic
// noticing first. §3.3e's claim is about Stripe's enforcement; a step that
// tripped our packer instead would be testing the guard we already know holds.
//
// WHAT MAKES IT A REAL TEST RATHER THAN A DEMONSTRATION: the sibling. A handler
// that failed the whole parent, released every unit, or deleted every draw would
// pass a single-child version of this step and be catastrophically wrong. The
// sibling's rows are read BEFORE the fabrication and asserted untouched after.
// -----------------------------------------------------------------------------

async function stepThree(fx: Fixture): Promise<StepResult> {
  const checks: Check[] = []
  const observations: Record<string, unknown> = {}

  const blocked = flagGuard('3', 'Forced over-transfer', checks)
  if (blocked) return blocked

  const payable = fx.writers[0]
  const { payoutService } = await import('../payment-service/src/services/payout.js')
  const svc = payoutService as any

  observations.ensureClaimable = await ensureClaimable(fx, payable.accountId)
  const claimable = await claimableFor(payable.accountId)
  observations.eligibility = claimable
  check(
    checks,
    'the writer is payable across >=2 charges (a sibling is what this step turns on)',
    true,
    claimable.netPence >= claimable.thresholdPence && claimable.settlements >= 2,
  )
  if (claimable.settlements < 2 || claimable.netPence < claimable.thresholdPence) {
    return { step: '3', title: 'Forced over-transfer', status: 'ok', observations, checks }
  }

  // --- Txn 1, for real ------------------------------------------------------
  // production's own reserve: parent + children + draws + unit stamps, committed,
  // with nothing yet sent to Stripe. This is exactly the state a crash between
  // Txn 1 and the transfer leaves behind, which is why step 10 starts here too.
  let reserved: { payoutId: string; amountPence: number } | null = null
  try {
    reserved = await svc.reserveWriterPayout(payable.accountId, fx.destination, claimable.netPence)
  } catch (err: any) {
    observations.reserveError = err?.message ?? String(err)
  }
  observations.reserved = reserved
  if (!reserved) {
    check(checks, 'the reserve committed a payout', true, false)
    return { step: '3', title: 'Forced over-transfer', status: 'ok', observations, checks }
  }

  const packed = await readPayout(reserved.payoutId)
  observations.packed = packed
  check(checks, 'the pack produced >=2 children', true, packed.children.length >= 2)
  if (packed.children.length < 2) {
    return { step: '3', title: 'Forced over-transfer', status: 'ok', observations, checks }
  }

  // --- The fabrication: one child inflated past its charge ------------------
  const doomed: any = packed.children.find((c: any) => c.funding === 'allocated') ?? packed.children[0]
  const siblings = packed.children.filter((c: any) => c.id !== doomed.id)

  // Read the claim rows on BOTH sides before the edit, so "releases exactly its
  // units and no others" is checked against a recorded fact rather than a guess.
  const { rows: doomedReadsBefore } = await pool.query<{ id: string }>(
    `SELECT id FROM read_events WHERE payout_transfer_id = $1 ORDER BY id`,
    [doomed.id],
  )
  const { rows: siblingReadsBefore } = await pool.query<{ id: string }>(
    `SELECT id FROM read_events WHERE payout_transfer_id = ANY($1::uuid[]) ORDER BY id`,
    [siblings.map((c: any) => c.id)],
  )
  observations.unitsBefore = {
    doomed: doomedReadsBefore.length,
    siblings: siblingReadsBefore.length,
  }

  // Comfortably past the whole charge, not merely past its remainder: Stripe's
  // bound is the source amount, and a marginal overshoot could be absorbed by
  // rounding somewhere and turn a deterministic rejection into a flake.
  const { rows: chargeRows } = await pool.query<{ amount_pence: number }>(
    `SELECT amount_pence FROM tab_settlements WHERE id = $1`,
    [doomed.settlement_id],
  )
  const inflated = (chargeRows[0]?.amount_pence ?? 0) + 5000
  await pool.query(`UPDATE payout_transfers SET net_pence = $1 WHERE id = $2`, [inflated, doomed.id])
  observations.fabrication = {
    child: doomed.id,
    settlement: doomed.settlement_id,
    chargePence: chargeRows[0]?.amount_pence ?? null,
    originalNet: doomed.net_pence,
    inflatedNet: inflated,
    note: 'allocated_draws left at the original gross on purpose — Stripe must be the thing that rejects',
  }

  // --- Execute, for real ----------------------------------------------------
  // `executePendingChildren` re-throws on an AMBIGUOUS error (the transfer may
  // exist, so the child must stay pending for the resume sweep). That would be a
  // finding rather than a harness bug — probe 4 saw this exact rejection come
  // back as a StripeInvalidRequestError, i.e. terminal — so catch it and record
  // it rather than losing the step.
  try {
    await svc.completeWriterPayout(
      reserved.payoutId,
      payable.accountId,
      fx.destination,
      reserved.amountPence,
    )
    observations.executeThrew = false
  } catch (err: any) {
    observations.executeThrew = { message: err?.message ?? String(err), type: err?.type ?? null }
    check(
      checks,
      'the over-transfer classified TERMINAL, not ambiguous (an ambiguous re-throw leaves the child pending forever)',
      false,
      true,
    )
  }

  const after = await readPayout(reserved.payoutId)
  observations.after = after

  const doomedAfter: any = after.children.find((c: any) => c.id === doomed.id)
  const siblingsAfter = after.children.filter((c: any) => c.id !== doomed.id)

  check(checks, 'the over-transferring child is failed', 'failed', doomedAfter?.status ?? null)
  check(
    checks,
    'the failed child records a failure_reason (nothing else will ever resolve this row — no transfer.failed is coming)',
    true,
    Boolean(doomedAfter?.failure_reason),
  )
  check(checks, 'the failed child has no stripe_transfer_id', null, doomedAfter?.stripe_transfer_id ?? null)
  check(
    checks,
    'every sibling completed — one failed child does not fail the batch',
    siblings.length,
    siblingsAfter.filter((c: any) => c.status === 'completed').length,
  )

  // --- The draw row: deleted for the failed child, intact for the siblings ---
  const { rows: drawsAfter } = await pool.query<{ ref_id: string; gross_pence: number }>(
    `SELECT ref_id, gross_pence FROM allocated_draws
      WHERE ref_table = 'payout_transfers' AND ref_id = ANY($1::uuid[]) AND kind = 'transfer'`,
    [after.children.map((c: any) => c.id)],
  )
  observations.drawsAfter = drawsAfter
  check(
    checks,
    "the failed child's allocated_draws row is DELETED — its allocation returns to the budget",
    true,
    !drawsAfter.some((d) => d.ref_id === doomed.id),
  )
  check(
    checks,
    "every sibling's draw row survives (a blanket delete would silently free allocation still in use)",
    siblings.filter((c: any) => c.funding === 'allocated').length,
    drawsAfter.filter((d) => d.ref_id !== doomed.id).length,
  )

  // --- Unit release: exactly its own rows, and no others ---------------------
  const { rows: doomedReadsAfter } = await pool.query<{
    id: string
    state: string
    writer_payout_id: string | null
    payout_transfer_id: string | null
  }>(
    `SELECT id, state, writer_payout_id, payout_transfer_id
       FROM read_events WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [doomedReadsBefore.map((r) => r.id)],
  )
  const { rows: siblingReadsAfter } = await pool.query<{
    id: string
    state: string
    writer_payout_id: string | null
    payout_transfer_id: string | null
  }>(
    `SELECT id, state, writer_payout_id, payout_transfer_id
       FROM read_events WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [siblingReadsBefore.map((r) => r.id)],
  )
  observations.unitsAfter = { doomed: doomedReadsAfter, siblings: siblingReadsAfter }

  check(
    checks,
    "the failed child's reads are released — back to platform_settled with both pointers nulled",
    true,
    doomedReadsAfter.length > 0 &&
      doomedReadsAfter.every(
        (r) =>
          r.state === 'platform_settled' &&
          r.writer_payout_id === null &&
          r.payout_transfer_id === null,
      ),
  )
  check(
    checks,
    "the siblings' reads are untouched by the failure — still claimed, and advanced to writer_paid",
    true,
    siblingReadsAfter.length > 0 &&
      siblingReadsAfter.every(
        (r) => r.state === 'writer_paid' && r.payout_transfer_id !== null,
      ),
  )

  // --- The parent, restated --------------------------------------------------
  const completedNet = siblingsAfter
    .filter((c: any) => c.status === 'completed')
    .reduce((s: number, c: any) => s + c.net_pence, 0)
  check(checks, 'the parent completed rather than zombifying on the failed child', 'completed', after.parent?.status ?? null)
  check(
    checks,
    'the parent amount is RESTATED to the smaller Σ(completed children), not the originally reserved figure',
    completedNet,
    after.parent?.amount_pence ?? null,
  )
  check(
    checks,
    'the parent records a failed_reason naming the failed count',
    true,
    Boolean(after.parent?.failed_reason),
  )

  // --- The ledger sums to the restated amount --------------------------------
  const entries = await ledgerFor(reserved.payoutId)
  observations.ledgerEntries = entries
  check(
    checks,
    'one ledger entry per COMPLETED child — the failed child posts none',
    siblingsAfter.filter((c: any) => c.status === 'completed').length,
    entries.length,
  )
  check(
    checks,
    'ledger sum == the restated parent amount (parity survives a partial failure)',
    after.parent?.amount_pence ?? null,
    entries.reduce((s: number, e: any) => s + e.amount_pence, 0),
  )

  // --- The released units are re-packable ------------------------------------
  // The ADR asks for "the next cycle re-packs the released units onto a different
  // source". Whether a NEXT CYCLE actually picks them up depends on the released
  // net clearing the payout threshold on its own, which it usually will not — so
  // report that honestly rather than failing a correct system for being under a
  // dial. What the release itself guarantees is re-packABILITY, asserted above.
  const releasedClaimable = await claimableFor(payable.accountId)
  observations.releasedClaimable = releasedClaimable
  if (releasedClaimable.netPence >= releasedClaimable.thresholdPence) {
    const second = await payoutService.runPayoutCycle()
    observations.secondCycle = second
    const { rows: nextParents } = await pool.query<{ id: string }>(
      `SELECT id FROM writer_payouts WHERE writer_id = $1 AND id <> $2
        ORDER BY created_at DESC LIMIT 1`,
      [payable.accountId, reserved.payoutId],
    )
    const next = nextParents[0] ? await readPayout(nextParents[0].id) : { parent: null, children: [] }
    observations.repack = next
    check(
      checks,
      'the released units are re-packed under a FRESH parent (never back onto the failed child)',
      true,
      next.children.length > 0 && next.children.every((c: any) => c.id !== doomed.id),
    )
  } else {
    check(
      checks,
      `released net ${releasedClaimable.netPence}p is under the ${releasedClaimable.thresholdPence}p threshold, ` +
        'so no next cycle claims it — re-packability is asserted by the release check above',
      null,
      null,
      'UNKNOWN',
    )
  }

  return { step: '3', title: 'Forced over-transfer', status: 'ok', observations, checks }
}

// -----------------------------------------------------------------------------
// Step 10 — crash-resume
//
// ADR: "kill the worker mid-child-sequence; restart; assert idempotent
// completion, no double transfer, no re-pack, and that a child completed before
// the crash posts exactly one ledger entry."
//
// THE CRASH IS REAL, NOT SIMULATED. `reserveWriterPayout` commits Txn 1 — parent
// `pending`, children `pending`, draws written, units stamped — and returns
// before anything reaches Stripe. Stopping there IS the crash state, produced by
// production code rather than reconstructed by hand. `resumePendingWriterPayouts`
// is then the restart, and it is the real sweep.
//
// WHAT THIS STEP DELIBERATELY DOES NOT DO, AND WHY THAT IS THE APPEND-ONLY GUARD
// WORKING. The other crash position — one child completed, the next still
// pending — cannot be reconstructed by hand, because a faithful reconstruction
// would have to DELETE the completed child's ledger entry (in a real crash it was
// never posted, since it rides the same transaction as the flip). The ledger is
// append-only at the database level, so that DELETE is refused. Reconstructing it
// WITHOUT the delete would be unfaithful in the one direction that matters: the
// resumed flip would post a second entry for the same child and the step would
// report a double-credit that no crash can actually produce. So rather than
// fabricate a state that misrepresents the system, this step pins the mechanism
// that makes the mid-sequence case safe — `executePendingChildren` selects
// `status = 'pending'` only, so a completed child is never revisited (arm 2), and
// the row-stable idempotency key dedupes a transfer that did go through (arm 3).
// A future step 10b with a fault-injection seam in the service could reach the
// real interleaving; hand-editing cannot, and saying so is better than a green
// tick over a fiction.
// -----------------------------------------------------------------------------

async function stepTen(fx: Fixture): Promise<StepResult> {
  const checks: Check[] = []
  const observations: Record<string, unknown> = {}

  const blocked = flagGuard('10', 'Crash-resume', checks)
  if (blocked) return blocked

  const payable = fx.writers[0]
  const { payoutService } = await import('../payment-service/src/services/payout.js')
  const svc = payoutService as any

  observations.ensureClaimable = await ensureClaimable(fx, payable.accountId)
  const claimable = await claimableFor(payable.accountId)
  observations.eligibility = claimable
  check(
    checks,
    'the writer is payable across >=2 charges',
    true,
    claimable.netPence >= claimable.thresholdPence && claimable.settlements >= 2,
  )
  if (claimable.settlements < 2 || claimable.netPence < claimable.thresholdPence) {
    return { step: '10', title: 'Crash-resume', status: 'ok', observations, checks }
  }

  // --- Arm 1: crash after Txn 1, then resume --------------------------------
  let reserved: { payoutId: string; amountPence: number } | null = null
  try {
    reserved = await svc.reserveWriterPayout(payable.accountId, fx.destination, claimable.netPence)
  } catch (err: any) {
    observations.reserveError = err?.message ?? String(err)
  }
  observations.reserved = reserved
  if (!reserved) {
    check(checks, 'the reserve committed a payout', true, false)
    return { step: '10', title: 'Crash-resume', status: 'ok', observations, checks }
  }

  const atCrash = await readPayout(reserved.payoutId)
  observations.atCrash = atCrash
  check(checks, 'the crash state is a pending parent', 'pending', atCrash.parent?.status ?? null)
  check(
    checks,
    'with pending children already packed and committed (the pack happens in Txn 1, so a resume must never re-pack)',
    true,
    atCrash.children.length >= 2 && atCrash.children.every((c: any) => c.status === 'pending'),
  )
  check(
    checks,
    'and no ledger entry yet — the entry rides the flip, so a crash before the transfer leaves the books silent',
    0,
    (await ledgerFor(reserved.payoutId)).length,
  )

  // The restart.
  await payoutService.resumePendingWriterPayouts()
  const afterResume = await readPayout(reserved.payoutId)
  const entriesAfterResume = await ledgerFor(reserved.payoutId)
  observations.afterResume = { ...afterResume, entries: entriesAfterResume }

  check(checks, 'the resume completed the parent', 'completed', afterResume.parent?.status ?? null)
  check(
    checks,
    'no re-pack — the same children, the same ids, the same funding charges Txn 1 committed',
    atCrash.children.map((c: any) => `${c.id}:${c.settlement_id}`),
    afterResume.children.map((c: any) => `${c.id}:${c.settlement_id}`),
  )
  check(
    checks,
    'one ledger entry per completed child',
    afterResume.children.filter((c: any) => c.status === 'completed').length,
    entriesAfterResume.length,
  )

  // --- Arm 2: resume AGAIN — the double-delivery control --------------------
  // This is the arm that would catch a resume keyed on anything looser than
  // `status = 'pending'`. Without it the first arm proves only that a resume
  // works once, which is not the property crash-resume is about.
  await payoutService.resumePendingWriterPayouts()
  const afterSecond = await readPayout(reserved.payoutId)
  const entriesAfterSecond = await ledgerFor(reserved.payoutId)
  // Count what STRIPE holds for THIS payout, by metadata — not the raw list
  // length. A list-length delta would be polluted by any other step's transfers
  // and would silently cap out at the page size once the sandbox accumulates a
  // hundred of them, which is a check that quietly stops being able to fail.
  const listed = await stripe.transfers.list({ destination: fx.destination, limit: 100 })
  const mine = listed.data.filter((t) => t.metadata?.payout_id === reserved!.payoutId)
  observations.afterSecondResume = {
    parent: afterSecond.parent,
    children: afterSecond.children.length,
    entries: entriesAfterSecond.length,
    stripeTransfersForThisPayout: mine.map((t) => t.id),
    listPageSize: listed.data.length,
  }

  check(
    checks,
    'a second resume posts NO further ledger entry',
    entriesAfterResume.length,
    entriesAfterSecond.length,
  )
  check(
    checks,
    'a second resume mints no further child',
    afterResume.children.length,
    afterSecond.children.length,
  )
  check(
    checks,
    'a second resume does not restate the parent',
    afterResume.parent?.amount_pence ?? null,
    afterSecond.parent?.amount_pence ?? null,
  )
  check(
    checks,
    'Stripe holds exactly one transfer per completed child — no double-pay across two resumes',
    afterResume.children.filter((c: any) => c.status === 'completed').length,
    mine.length,
  )
  check(
    checks,
    'and they are exactly the transfer ids our children recorded',
    afterResume.children
      .filter((c: any) => c.status === 'completed')
      .map((c: any) => c.stripe_transfer_id)
      .sort(),
    mine.map((t) => t.id).sort(),
  )
  check(
    checks,
    "each completed child still carries the transfer id it completed with",
    afterResume.children.map((c: any) => c.stripe_transfer_id),
    afterSecond.children.map((c: any) => c.stripe_transfer_id),
  )

  // --- Arm 3: the idempotency key itself, asked of Stripe directly ----------
  // The property the whole resume design rests on: `xfer-<childId>` is ROW-STABLE,
  // so replaying it returns the SAME transfer rather than creating a second. Asked
  // of Stripe with no DB fabrication at all, because a DB-level reconstruction of
  // the mid-sequence crash is exactly what the append-only ledger refuses (see the
  // header). The mismatched-params arm is the 2026-07-15 publication-split lesson:
  // a key reused with different params is an `idempotency_error`, which the
  // classifier calls AMBIGUOUS and re-throws — the shape that wedges a payout
  // forever, and the reason the key must be per-row rather than composed.
  const sample: any = afterSecond.children.find((c: any) => c.status === 'completed')
  if (sample) {
    const { allocatedTransferParams } = await import('../payment-service/src/lib/stripe-client.js')
    try {
      const replay = await stripe.transfers.create(
        {
          amount: sample.net_pence,
          currency: 'gbp',
          destination: fx.destination,
          ...(allocatedTransferParams(sample.stripe_charge_id, sample.fee_pence) as any),
          metadata: {
            platform: 'all.haus',
            writer_id: payable.accountId,
            payout_id: reserved.payoutId,
            payout_transfer_id: sample.id,
            funding: sample.funding,
          },
        } as Stripe.TransferCreateParams,
        { idempotencyKey: `xfer-${sample.id}` },
      )
      observations.idempotentReplay = { requested: sample.stripe_transfer_id, returned: replay.id }
      check(
        checks,
        'replaying xfer-<childId> returns the SAME transfer — the key is what makes an ambiguous retry safe',
        sample.stripe_transfer_id,
        replay.id,
      )
    } catch (err: any) {
      observations.idempotentReplay = { error: err?.message ?? String(err), type: err?.type ?? null }
      check(
        checks,
        'replaying xfer-<childId> returns the SAME transfer',
        sample.stripe_transfer_id,
        `threw: ${err?.message ?? err}`,
      )
    }

    try {
      await stripe.transfers.create(
        {
          amount: sample.net_pence + 1,
          currency: 'gbp',
          destination: fx.destination,
          ...(allocatedTransferParams(sample.stripe_charge_id, sample.fee_pence) as any),
        } as Stripe.TransferCreateParams,
        { idempotencyKey: `xfer-${sample.id}` },
      )
      check(
        checks,
        'the same key with DIFFERENT params is rejected (a colliding key must not silently pay the wrong amount)',
        'idempotency_error',
        'accepted',
      )
    } catch (err: any) {
      observations.idempotencyMismatch = { type: err?.type ?? null, code: err?.code ?? null }
      check(
        checks,
        'the same key with DIFFERENT params is rejected as an idempotency_error',
        true,
        String(err?.type ?? '').includes('Idempotency') || String(err?.code ?? '') === 'idempotency_key_in_use',
      )
    }
  }

  return { step: '10', title: 'Crash-resume', status: 'ok', observations, checks }
}

// -----------------------------------------------------------------------------
// Step 11 — the publication cycle end to end
//
// ADR: "a payout whose pool spans >=2 charges -> per-split children draw from the
// preference set; SUM(child.fee_pence) <= platform_fee_pence and the difference
// is dust, not a tenth of the pool (§3.4); a deliberately failed split completes
// its parent rather than zombifying it (§3.3c)."
//
// RUN THIS LAST, OR ON ITS OWN. It re-homes the sandbox's connect ids onto the
// publication's members, and `accounts.stripe_connect_id` is UNIQUE — so a step
// 2/3/10 running AFTER it would find its writer un-onboarded. `main` orders the
// steps accordingly; an invocation that passes them out of order is the caller's
// to get right.
//
// THE SECOND DESTINATION IS A PREREQUISITE, NOT A NICETY. See `Fixture.destinations`.
// With one, arms 1 and 2 still run in full and arm 3 reports UNKNOWN naming what
// it needs — which is the honest verdict, and better than a green tick over a
// single-split payout that cannot exhibit the property at all.
//
// WHY THE SPLIT IS THE PARENT. A publication payout is a two-level tree: the
// payout owns splits, and each SPLIT owns the transfer children. That is why the
// ledger's ref_table here is `publication_payout_splits` and not the payout —
// `ledger_publication_distribution` hard-filters on exactly that, so a child
// entry re-pointed at the payout (or at the child) would silently empty the view
// while every total still balanced.
// -----------------------------------------------------------------------------

interface PubFixture {
  publicationId: string
  articleId: string
  writerId: string
  members: { accountId: string; username: string; bps: number; connectId: string }[]
}

/**
 * Give the publication two revenue-sharing, payable members.
 *
 * Three logged direct writes, each of the same class the fixture header already
 * sanctions — things a sandbox cannot mint for itself: which connected account a
 * member is, and what share they hold. The publication, its article and its
 * membership are NOT fabricated; if the database has no publication with an
 * article, the step says so rather than inventing one, because a hand-built
 * publication would skip the nostr keypair the real creation path mints and
 * would be a different object wearing the same table.
 */
async function buildPubFixture(fx: Fixture): Promise<PubFixture | null> {
  const { rows: pubs } = await pool.query<{ id: string; article_id: string; writer_id: string }>(
    `SELECT p.id, a.id AS article_id, a.writer_id
       FROM publications p
       JOIN articles a ON a.publication_id = p.id AND a.deleted_at IS NULL
      ORDER BY p.created_at, a.created_at
      LIMIT 1`,
  )
  if (pubs.length === 0) return null

  const { id: publicationId, article_id: articleId, writer_id: writerId } = pubs[0]

  const wanted = Math.min(2, fx.destinations.length)
  const { rows: memberRows } = await pool.query<{ account_id: string; username: string }>(
    `SELECT pm.account_id, a.username
       FROM publication_members pm
       JOIN accounts a ON a.id = pm.account_id
      WHERE pm.publication_id = $1 AND pm.removed_at IS NULL AND pm.accepted_at IS NOT NULL
      ORDER BY pm.created_at, pm.id
      LIMIT $2`,
    [publicationId, wanted],
  )
  if (memberRows.length === 0) return null

  // 4000/3000 bps: Σ < 10000 on purpose, so the platform's retained remainder is
  // exercised too. Equal shares would hide a renormalisation bug — the old
  // `× bps / totalStandingBps` paid a sole 1-bps member the entire pool, and
  // shares summing to 10000 make that bug invisible.
  const bpsFor = [4000, 3000]
  const members: PubFixture['members'] = []

  for (let i = 0; i < memberRows.length; i++) {
    const m = memberRows[i]
    const connectId = fx.destinations[i]
    // Release the id from any prior holder first: the column is UNIQUE, so a
    // re-run (or the writer fixture's own assignment) would otherwise collide
    // with itself.
    await pool.query(
      `UPDATE accounts SET stripe_connect_id = NULL, stripe_connect_kyc_complete = FALSE
        WHERE stripe_connect_id = $1 AND id <> $2`,
      [connectId, m.account_id],
    )
    await pool.query(
      `UPDATE accounts SET stripe_connect_id = $2, stripe_connect_kyc_complete = TRUE
        WHERE id = $1`,
      [m.account_id, connectId],
    )
    await pool.query(
      `UPDATE publication_members SET revenue_share_bps = $3
        WHERE publication_id = $1 AND account_id = $2`,
      [publicationId, m.account_id, bpsFor[i]],
    )
    members.push({ accountId: m.account_id, username: m.username, bps: bpsFor[i], connectId })
  }

  return { publicationId, articleId, writerId, members }
}

/** What the publication could be paid right now, by production's own arithmetic. */
async function pubClaimable(publicationId: string) {
  const { loadConfig } = await import('../shared/src/db/client.js')
  const config = await loadConfig(true)
  const { rows } = await pool.query<{ chargeable_pence: number; tab_settlement_id: string | null }>(
    `SELECT chargeable_pence, tab_settlement_id
       FROM read_events
      WHERE publication_id = $1 AND state = 'platform_settled' AND writer_payout_id IS NULL`,
    [publicationId],
  )
  // Sum-then-floor on the pooled gross — the publication cycle's rounding rule,
  // deliberately NOT the writer cycle's per-row floor. Using the wrong one here
  // would make the harness disagree with the code it is checking by a few pence
  // and send someone hunting a bug that is only in this file.
  const gross = rows.reduce((s, r) => s + r.chargeable_pence, 0)
  const net = gross - Math.floor((gross * config.platformFeeBps) / 10000)
  return {
    reads: rows.length,
    grossPence: gross,
    netPence: net,
    thresholdPence: config.writerPayoutThresholdPence,
    feeBps: config.platformFeeBps,
    settlements: new Set(rows.map((r) => r.tab_settlement_id).filter(Boolean)).size,
    settlementIds: [...new Set(rows.map((r) => r.tab_settlement_id).filter(Boolean))] as string[],
  }
}

/** Accrue publication reads until the pool clears the threshold across >=2 charges. */
async function ensurePubClaimable(fx: Fixture, pub: PubFixture, rounds = 3) {
  let current = await pubClaimable(pub.publicationId)
  const enough = (c: typeof current) => c.netPence >= c.thresholdPence && c.settlements >= 2
  let roundsRun = 0

  while (!enough(current) && roundsRun < rounds) {
    const before = current.reads
    for (const reader of fx.readers) {
      const acct = await pool.query<{ nostr_pubkey: string }>(
        `SELECT nostr_pubkey FROM accounts WHERE id = $1`,
        [reader.accountId],
      )
      const pubkey = acct.rows[0].nostr_pubkey
      for (let i = 0; i < READS_PER_PAIR; i++) {
        // publicationId is what routes the read to the POOL rather than to the
        // writer's own cycle. The two cycles are exact complements keyed on this
        // denormalised column, so omitting it here would silently test the wrong
        // cycle while every number still looked plausible.
        await paymentPost('/api/v1/gate-pass', {
          readerId: reader.accountId,
          articleId: pub.articleId,
          writerId: pub.writerId,
          publicationId: pub.publicationId,
          amountPence: PUB_READ_PENCE,
          readerPubkey: pubkey,
          readerPubkeyHash: createHash('sha256').update(pubkey).digest('hex'),
          tabId: reader.tabId,
        })
        await sleep(400)
      }
    }
    roundsRun++

    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      current = await pubClaimable(pub.publicationId)
      if (enough(current)) break
      await sleep(2000)
    }
    current = await pubClaimable(pub.publicationId)

    // Same rotation as ensureClaimable, and it matters MORE here: the publication
    // has ONE article, so the pool's accrual space is `readers × 1` and a second
    // round with the same readers adds literally nothing. Step 11's second arm
    // needs a whole second payable pool after the first has been paid out, which
    // is only reachable by rotating.
    if (current.reads === before) {
      await rotateReaders(fx)
    }
  }

  const stamping = await syncUntilStamped(fx.allReaderIds)
  return { roundsRun, stamping, claimable: await pubClaimable(pub.publicationId) }
}

async function stepEleven(fx: Fixture): Promise<StepResult> {
  const checks: Check[] = []
  const observations: Record<string, unknown> = {}

  const blocked = flagGuard('11', 'Publication cycle', checks)
  if (blocked) return blocked

  const { payoutService } = await import('../payment-service/src/services/payout.js')
  const svc = payoutService as any

  const pub = await buildPubFixture(fx)
  observations.pubFixture = pub
  if (!pub) {
    check(
      checks,
      'the database holds a publication with an article and >=1 accepted member',
      true,
      false,
      'UNKNOWN',
    )
    return { step: '11', title: 'Publication cycle', status: 'ok', observations, checks }
  }

  observations.destinations = fx.destinations
  const twoPayable = pub.members.length >= 2

  observations.ensurePubClaimable = await ensurePubClaimable(fx, pub)
  const claimable = await pubClaimable(pub.publicationId)
  observations.claimable = claimable
  check(
    checks,
    'the pool spans >=2 charges — the precondition the whole step is about',
    true,
    claimable.settlements >= 2,
  )
  check(
    checks,
    `the pool clears the threshold (${claimable.netPence}p vs ${claimable.thresholdPence}p)`,
    true,
    claimable.netPence >= claimable.thresholdPence,
  )
  if (claimable.settlements < 2 || claimable.netPence < claimable.thresholdPence) {
    return { step: '11', title: 'Publication cycle', status: 'ok', observations, checks }
  }

  const poolSettlements = new Set(claimable.settlementIds)

  // --- Arm 1: the ordinary cycle --------------------------------------------
  const cycle = await payoutService.runPublicationPayoutCycle()
  observations.cycle = cycle

  const { rows: payouts } = await pool.query(
    `SELECT id, publication_id, total_pool_pence, platform_fee_pence, sub_net_pence,
            flat_fees_paid_pence, remaining_pool_pence, status, completed_at
       FROM publication_payouts WHERE publication_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [pub.publicationId],
  )
  const payout: any = payouts[0] ?? null
  observations.payout = payout
  if (!payout) {
    check(checks, 'a publication payout was created', true, false)
    return { step: '11', title: 'Publication cycle', status: 'ok', observations, checks }
  }

  const { rows: splits } = await pool.query(
    `SELECT id, account_id, share_bps, amount_pence, share_type, status,
            stripe_transfer_id, attempt, replaced_by_split_id
       FROM publication_payout_splits WHERE publication_payout_id = $1 ORDER BY id`,
    [payout.id],
  )
  observations.splits = splits
  check(checks, 'one split per revenue-sharing member', pub.members.length, splits.length)
  check(
    checks,
    'every split completed',
    splits.length,
    splits.filter((s: any) => s.status === 'completed').length,
  )
  check(
    checks,
    'the parent completed rather than sitting pending',
    'completed',
    payout.status,
  )
  check(
    checks,
    'no split carries an aggregate transfer id — under segregation the transfers hang off the CHILDREN',
    true,
    splits.every((s: any) => s.stripe_transfer_id === null),
  )

  // --- Children: one per split, drawn from the preference set ---------------
  const { rows: pubChildren } = await pool.query(
    `SELECT id, parent_id, settlement_id, stripe_charge_id, funding, net_pence,
            fee_pence, status, stripe_transfer_id
       FROM payout_transfers
      WHERE parent_table = 'publication_payout_splits' AND parent_id = ANY($1::uuid[])
      ORDER BY parent_id, id`,
    [splits.map((s: any) => s.id)],
  )
  observations.children = pubChildren
  check(
    checks,
    'every split owns at least one child',
    splits.length,
    new Set(pubChildren.map((c: any) => c.parent_id)).size,
  )
  // A split is ONE indivisible unit (a bps share of a pool spanning many
  // charges), so it packs onto exactly one source — never split across two.
  check(
    checks,
    'each split packs to exactly ONE child (a split is indivisible — §3.4)',
    splits.length,
    pubChildren.length,
  )
  check(
    checks,
    "every allocated child draws from the POOL'S charges, never some unrelated one",
    true,
    pubChildren
      .filter((c: any) => c.funding === 'allocated')
      .every((c: any) => poolSettlements.has(c.settlement_id)),
  )

  // --- §3.4's fee-dust claim -------------------------------------------------
  // The withheld pooled fee is prorated across splits and FLOORED per split, so
  // Σ(child fee) is at most the pooled fee and the shortfall is rounding dust.
  // The test that matters is the SIZE of the shortfall: an over-claim would be
  // rejected by Stripe (the transfer would exceed its source), but an
  // under-claim is silent, and a formula error that under-claimed by a tenth of
  // the pool would leave that tenth locked in allocated state forever with
  // nothing reporting it.
  const childFees = pubChildren.reduce((s: number, c: any) => s + c.fee_pence, 0)
  const dust = payout.platform_fee_pence - childFees
  observations.feeDust = {
    platformFeePence: payout.platform_fee_pence,
    childFeeSum: childFees,
    dustPence: dust,
    dustFractionOfPool: payout.total_pool_pence > 0 ? dust / payout.total_pool_pence : null,
    splitCount: splits.length,
  }
  check(checks, 'Σ(child fee) <= platform_fee_pence — never an over-claim', true, childFees <= payout.platform_fee_pence)
  check(
    checks,
    'the shortfall is DUST — under one penny per split, not a fraction of the pool',
    true,
    dust >= 0 && dust <= splits.length,
  )

  // --- The ledger, at the SPLIT grain ---------------------------------------
  const { rows: pubEntries } = await pool.query(
    `SELECT id, account_id, amount_pence, trigger_type, ref_table, ref_id
       FROM ledger_entries
      WHERE ref_table = 'publication_payout_splits' AND ref_id = ANY($1::uuid[])
      ORDER BY created_at`,
    [splits.map((s: any) => s.id)],
  )
  // bigint -> string from node-postgres; coerce before any sum or comparison
  // (same trap as ledgerFor).
  for (const e of pubEntries as any[]) e.amount_pence = Number(e.amount_pence)
  observations.ledgerEntries = pubEntries
  check(
    checks,
    'one ledger entry per completed child',
    pubChildren.filter((c: any) => c.status === 'completed').length,
    pubEntries.length,
  )
  check(
    checks,
    "every entry refs its own SPLIT — ledger_publication_distribution filters on exactly this ref_table, " +
      'so pointing it at the payout or the child would silently empty the view',
    true,
    pubEntries.every((e: any) => splits.some((s: any) => s.id === e.ref_id)),
  )
  check(
    checks,
    'ledger sum == Σ(completed split amounts)',
    splits
      .filter((s: any) => s.status === 'completed')
      .reduce((s: number, sp: any) => s + sp.amount_pence, 0),
    pubEntries.reduce((s: number, e: any) => s + e.amount_pence, 0),
  )

  // --- Arm 2: a deliberately failed split must not zombify its parent -------
  if (!twoPayable) {
    check(
      checks,
      'a deliberately failed split completes its parent — NOT RUN: needs a second onboarded ' +
        'sandbox account, else the payout has one split and a single failure correctly fails ' +
        'the parent outright (pass --destination acct_A,acct_B)',
      null,
      null,
      'UNKNOWN',
    )
    return { step: '11', title: 'Publication cycle', status: 'ok', observations, checks }
  }

  const second = await ensurePubClaimable(fx, pub)
  observations.secondPoolPrep = second
  if (second.claimable.netPence < second.claimable.thresholdPence || second.claimable.settlements < 2) {
    check(
      checks,
      'a second payable pool could be accrued for the failed-split arm',
      true,
      false,
      'UNKNOWN',
    )
    return { step: '11', title: 'Publication cycle', status: 'ok', observations, checks }
  }

  const { loadConfig } = await import('../shared/src/db/client.js')
  const config = await loadConfig(true)
  const reserved2 = await svc.reservePublicationPayout(
    pub.publicationId,
    config.platformFeeBps,
    config.payoutMaxSlices,
  )
  observations.secondReserve = reserved2
  if (!reserved2) {
    check(checks, 'the second reserve committed a payout', true, false)
    return { step: '11', title: 'Publication cycle', status: 'ok', observations, checks }
  }

  const { rows: splits2 } = await pool.query(
    `SELECT id, account_id, amount_pence, status FROM publication_payout_splits
      WHERE publication_payout_id = $1 ORDER BY id`,
    [reserved2.payoutId],
  )
  const { rows: children2 } = await pool.query(
    `SELECT id, parent_id, settlement_id, net_pence, fee_pence
       FROM payout_transfers
      WHERE parent_table = 'publication_payout_splits' AND parent_id = ANY($1::uuid[])
      ORDER BY parent_id, id`,
    [splits2.map((s: any) => s.id)],
  )
  observations.secondPacked = { splits: splits2, children: children2 }
  if (splits2.length < 2 || children2.length < 2) {
    check(checks, 'the second payout packed >=2 splits with children', true, false)
    return { step: '11', title: 'Publication cycle', status: 'ok', observations, checks }
  }

  // Same fabrication as step 3, one level down: inflate ONE split's child past
  // its funding charge so Stripe deterministically rejects it. The draw row is
  // again left at the original gross on purpose — Stripe must be the thing that
  // refuses, not our own budget noticing first.
  const doomedChild: any = children2[0]
  const doomedSplit = doomedChild.parent_id
  const { rows: chargeRows } = await pool.query<{ amount_pence: number }>(
    `SELECT amount_pence FROM tab_settlements WHERE id = $1`,
    [doomedChild.settlement_id],
  )
  const inflated = (chargeRows[0]?.amount_pence ?? 0) + 5000
  await pool.query(`UPDATE payout_transfers SET net_pence = $1 WHERE id = $2`, [inflated, doomedChild.id])
  observations.secondFabrication = {
    split: doomedSplit,
    child: doomedChild.id,
    originalNet: doomedChild.net_pence,
    inflatedNet: inflated,
  }

  try {
    await svc.processPublicationSplits(reserved2.payoutId)
    await svc.finalisePublicationPayout(reserved2.payoutId, pub.publicationId)
    observations.secondExecuteThrew = false
  } catch (err: any) {
    observations.secondExecuteThrew = { message: err?.message ?? String(err), type: err?.type ?? null }
  }

  const { rows: payout2 } = await pool.query(
    `SELECT id, status, completed_at FROM publication_payouts WHERE id = $1`,
    [reserved2.payoutId],
  )
  const { rows: splitsAfter } = await pool.query(
    `SELECT id, account_id, amount_pence, status FROM publication_payout_splits
      WHERE publication_payout_id = $1 ORDER BY id`,
    [reserved2.payoutId],
  )
  const { rows: childrenAfter } = await pool.query(
    `SELECT id, parent_id, status, failure_reason, net_pence FROM payout_transfers
      WHERE parent_table = 'publication_payout_splits' AND parent_id = ANY($1::uuid[])
      ORDER BY parent_id, id`,
    [splits2.map((s: any) => s.id)],
  )
  observations.secondAfter = { payout: payout2[0] ?? null, splits: splitsAfter, children: childrenAfter }

  const doomedAfter: any = childrenAfter.find((c: any) => c.id === doomedChild.id)
  check(checks, 'the over-transferring split child failed', 'failed', doomedAfter?.status ?? null)
  check(
    checks,
    'the sibling split still completed — one bad split does not stop the others',
    true,
    splitsAfter.some((s: any) => s.id !== doomedSplit && s.status === 'completed'),
  )
  // The rule is "no split PENDING", never "every split completed" — the latter
  // freezes a parent forever on one failed split, because the resume sweep
  // retries only `pending` ones. That is the zombie this arm exists to catch.
  check(
    checks,
    'the parent COMPLETED on "no split pending" — a failed split must not zombify it (§3.3c)',
    'completed',
    payout2[0]?.status ?? null,
  )
  check(
    checks,
    'no split is left pending',
    0,
    splitsAfter.filter((s: any) => s.status === 'pending').length,
  )

  return { step: '11', title: 'Publication cycle', status: 'ok', observations, checks }
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
    if (STEPS.includes('2')) results.push(await stepTwo(fx))
    if (STEPS.includes('3')) results.push(await stepThree(fx))
    if (STEPS.includes('10')) results.push(await stepTen(fx))
    // 11 LAST, always: it re-homes the sandbox connect ids onto the
    // publication's members, and the column is UNIQUE — a writer-cycle step
    // running after it would find its writer un-onboarded.
    if (STEPS.includes('11')) results.push(await stepEleven(fx))
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
