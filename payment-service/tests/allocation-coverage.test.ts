import { describe, it, expect } from 'vitest'
import { summariseCoverage } from '../src/services/allocation-coverage.js'

// =============================================================================
// PAYMENT-PERIMETER-ADR W2 — the charge-side coverage metric, as arithmetic.
//
// The half that is decidable without a database: the empty-denominator rule and
// the share itself. The half that is NOT — the NULL-versus-0 tri-state split
// that decides which settlements are even in the denominator — is proven
// against a real Postgres in allocation-coverage-integration.test.ts, because a
// mocked `pool.query` would answer that split from a fixture I chose rather
// than from the predicate as shipped.
// =============================================================================

const totals = (o: Partial<Parameters<typeof summariseCoverage>[0]>) => ({
  measuredCount: 0,
  measuredPence: 0,
  allocatedPence: 0,
  unallocatedCount: 0,
  unallocatedPence: 0,
  ...o,
})

describe('summariseCoverage — the W2 metric', () => {
  it('reports the share in basis points', () => {
    const m = summariseCoverage(
      totals({ measuredCount: 4, measuredPence: 10000, allocatedPence: 7500 }),
    )!
    expect(m.coverageBps).toBe(7500)
    expect(m.windowDays).toBe(30)
  })

  it('returns NULL for an unmeasured window rather than a fake 0%', () => {
    // THE RULE THIS METRIC EXISTS TO OBEY. `syncAllocations` no-ops while
    // STRIPE_ALLOCATED_FUNDS is off, so pre-flip every row is unmeasured and the
    // denominator is empty. A 0% there asserts that none of the platform's
    // reader money is segregated — the most alarming thing the panel can say,
    // said every day the flag ships dark. The caller renders null in words.
    expect(summariseCoverage(totals({}))).toBeNull()
  })

  it('is the DENOMINATOR that decides, never the numerator', () => {
    // A window with real measured settlements and no allocation across any of
    // them IS a measurement, and a bad one that must be shown. Collapsing it to
    // null would hide the exact state W2 was written to surface.
    const m = summariseCoverage(
      totals({
        measuredCount: 3,
        measuredPence: 6000,
        allocatedPence: 0,
        unallocatedCount: 3,
        unallocatedPence: 6000,
      }),
    )!
    expect(m.coverageBps).toBe(0)
    expect(m.unallocatedCount).toBe(3)
  })

  it('carries the counts it judged, so the panel can show the sample', () => {
    const m = summariseCoverage(
      totals({
        measuredCount: 10,
        measuredPence: 20000,
        allocatedPence: 18000,
        unallocatedCount: 1,
        unallocatedPence: 2000,
      }),
    )!
    expect(m).toMatchObject({
      measuredCount: 10,
      measuredPence: 20000,
      allocatedPence: 18000,
      coverageBps: 9000,
      unallocatedCount: 1,
      unallocatedPence: 2000,
    })
  })

  it('reports full coverage as exactly 10000 bps, not 9999', () => {
    // The panel warns below 100%, so an off-by-one in the rounding would paint
    // a fully segregated month crimson forever.
    const m = summariseCoverage(
      totals({ measuredCount: 3, measuredPence: 3333, allocatedPence: 3333 }),
    )!
    expect(m.coverageBps).toBe(10000)
  })
})
