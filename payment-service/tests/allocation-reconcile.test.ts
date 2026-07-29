import { describe, it, expect } from 'vitest'
import { summariseResidual, isDivergent } from '../src/services/allocation-reconcile.js'

// =============================================================================
// The two decisions the allocation sweeps make, as arithmetic (§3.6 / §3.3d).
//
// The SQL halves — which charges are candidates, what the 30-day window sums —
// are proven against a real Postgres in segregation-assembly-integration.test.ts,
// because they are predicates only Postgres can evaluate. What is here is what
// is decidable without one: the empty-denominator rule and the tolerance.
// =============================================================================

describe('summariseResidual — the §3.3d metric', () => {
  it('reports the share in basis points', () => {
    const m = summariseResidual(10000, 1500, 2000)!
    expect(m.residualBps).toBe(1500)
    expect(m.breached).toBe(false)
  })

  it('breaches ABOVE the threshold, not at it', () => {
    // The dial names the level that is still acceptable, so equality passes.
    // Getting this backwards makes a threshold set from a measured baseline fire
    // on the very distribution it was measured from.
    expect(summariseResidual(10000, 2000, 2000)!.breached).toBe(false)
    expect(summariseResidual(10000, 2001, 2000)!.breached).toBe(true)
  })

  it('returns NULL for an empty window rather than a perfect 0%', () => {
    // No payouts in the window is not "coverage is perfect" — it is no
    // measurement at all. Reporting 0 bps would satisfy the alert forever on a
    // platform whose payout cycle had silently stopped running, which is the
    // failure this refuses to report as health.
    expect(summariseResidual(0, 0, 2000)).toBeNull()
    // And it is the DENOMINATOR that decides, not the numerator: a window with
    // real payouts and no residual at all IS a measurement, and a good one.
    expect(summariseResidual(10000, 0, 2000)).toMatchObject({
      residualBps: 0,
      breached: false,
    })
  })

  it('carries the threshold it judged against, so the log says what it compared', () => {
    const m = summariseResidual(10000, 3000, 500)!
    expect(m).toMatchObject({
      totalPence: 10000,
      residualPence: 3000,
      residualBps: 3000,
      thresholdBps: 500,
      breached: true,
      windowDays: 30,
    })
  })
})

describe('isDivergent — the §3.6 tolerance', () => {
  it('ignores a penny either way, and notices two', () => {
    // Sub-penny timing between our sweep and Stripe's books is not a defect.
    expect(isDivergent(0)).toBe(false)
    expect(isDivergent(1)).toBe(false)
    expect(isDivergent(-1)).toBe(false)
    expect(isDivergent(2)).toBe(true)
  })

  it('is symmetric — under-drawing is as interesting as over-drawing', () => {
    // A model that thinks it has LESS than Stripe does is not "safe and
    // therefore uninteresting": it means a draw was recorded that Stripe never
    // saw, i.e. a transfer we believe happened and did not.
    expect(isDivergent(-500)).toBe(true)
    expect(isDivergent(500)).toBe(true)
  })
})
