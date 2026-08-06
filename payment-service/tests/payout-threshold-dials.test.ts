import { describe, it, expect, beforeEach, vi } from 'vitest'

// =============================================================================
// Each payout cycle binds ITS OWN threshold dial (CONSOLIDATED-TODO §1.14).
//
// WHY THIS FILE EXISTS. `publication_payout_threshold_pence` was seeded by
// migration 038, listed in the admin config UI's Money group, and read by
// NOTHING for the whole of its life: `runPublicationPayoutCycle`'s eligibility
// query bound `config.writerPayoutThresholdPence`. An operator moving the
// publication threshold got a successful save, no error, and no change — the
// "dial with no reader" class CLAUDE.md bans, in its most silent form.
//
// THE TWO DIALS ARE SET TO DIFFERENT VALUES HERE, AND THAT IS THE ENTIRE POINT.
// Both default to 2000. A test that seeded the defaults would pass against the
// bug exactly as it passes against the fix, and would pin nothing — which is
// how the defect survived every green suite since 038. Mutate the bind in
// `runPublicationPayoutCycle` back to `writerPayoutThresholdPence` and the
// publication test goes red on the value.
//
// The writer cycle is asserted alongside as the paired control: the fix must
// not have crossed the wires the other way.
//
// Both cycles are driven for real against a scripted client that answers from
// the SQL it is handed, so what is pinned is the parameter production actually
// binds — not a copy of the query restated in the test.
// =============================================================================

const WRITER_THRESHOLD = 1500
const PUBLICATION_THRESHOLD = 7300

/** Every query the cycles issue, in order. */
const seen: Array<{ sql: string; params: unknown[] }> = []

async function query(sql: string, params: unknown[] = []) {
  seen.push({ sql, params })
  // Answer from the SQL: the eligibility SELECTs return no candidates, so each
  // cycle stops right after the query under test and nothing downstream runs.
  return { rows: [], rowCount: 0 }
}

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query },
  withTransaction: async (fn: (c: unknown) => unknown) => fn({ query }),
  loadConfig: vi.fn(async () => ({
    platformFeeBps: 800,
    payoutMaxSlices: 20,
    writerPayoutThresholdPence: WRITER_THRESHOLD,
    publicationPayoutThresholdPence: PUBLICATION_THRESHOLD,
  })),
}))

vi.mock('@platform-pub/shared/lib/env.js', () => ({
  env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_ALLOCATED_FUNDS: false },
  allocatedFundsEnabled: () => false,
}))
vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('stripe', () => ({ default: class { transfers = { create: vi.fn() } } }))

const { payoutService } = await import('../src/services/payout.js')

/** The one query in the run that selects payout candidates on a threshold. */
function eligibilityQuery(match: RegExp) {
  const hits = seen.filter((q) => match.test(q.sql))
  expect(hits).toHaveLength(1)
  return hits[0]
}

beforeEach(() => {
  seen.length = 0
})

describe('payout cycle threshold dials', () => {
  it('the publication cycle binds publication_payout_threshold_pence', async () => {
    await payoutService.runPublicationPayoutCycle()

    const q = eligibilityQuery(/subs\.sub_net_pence/)
    // Bound as $2 alongside the fee as $1. Assert on the VALUE, not the
    // position: what matters is which dial reached Postgres.
    expect(q.params).toContain(PUBLICATION_THRESHOLD)
    expect(q.params).not.toContain(WRITER_THRESHOLD)
  })

  it('the writer cycle still binds writer_payout_threshold_pence', async () => {
    await payoutService.runPayoutCycle()

    const q = eligibilityQuery(/stripe_connect_kyc_complete/)
    expect(q.params).toContain(WRITER_THRESHOLD)
    expect(q.params).not.toContain(PUBLICATION_THRESHOLD)
  })
})
