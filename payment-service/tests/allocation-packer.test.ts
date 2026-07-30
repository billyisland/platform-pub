import { describe, it, expect } from 'vitest'
import {
  packUnits,
  apportionCarve,
  prorateWithheldFee,
  prorateCarveReversal,
  unitGross,
  type EarningUnit,
  type FundingSource,
} from '../src/lib/allocation-packer.js'

// =============================================================================
// The funding decision, tested where it lives — no database, no Stripe.
//
// These are the properties the design leans on (FUNDS-SEGREGATION-INTEGRATION
// §3.3b/§3.3e), stated as tests rather than as prose:
//
//   • no slice ever exceeds its charge's remaining allocation (over-transfer is
//     structurally impossible, not merely tested against)
//   • every unit is either placed or reported as overflow — never silently lost
//   • no unit is ever split, so no rounding is introduced anywhere
//   • the pack is deterministic, so a resume replays rather than re-decides
// =============================================================================

let seq = 0
function unit(
  netPence: number,
  feePence = 0,
  preferredSettlementIds: string[] = [],
  id = `u${String(++seq).padStart(3, '0')}`,
): EarningUnit {
  return { id, source: 'read_events', netPence, feePence, preferredSettlementIds }
}

function source(settlementId: string, remainingPence: number): FundingSource {
  return { settlementId, stripeChargeId: `ch_${settlementId}`, remainingPence }
}

const CAP = { maxSlices: 20 }

/** Every invariant that must hold of any pack, whatever the inputs. */
function assertPackSound(
  result: ReturnType<typeof packUnits>,
  units: EarningUnit[],
  sources: FundingSource[],
) {
  // 1. Nothing exceeds its source's remaining allocation.
  const remaining = new Map(sources.map((s) => [s.settlementId, s.remainingPence]))
  for (const slice of result.slices) {
    if (slice.funding !== 'allocated') continue
    const gross = slice.netPence + slice.feePence
    expect(gross).toBeLessThanOrEqual(remaining.get(slice.settlementId!)!)
  }

  // 2. Every unit is accounted for exactly once — placed, overflowed, or set
  //    aside as zero-net.
  const placed = result.slices.flatMap((s) => s.units.map((u) => u.id))
  const seen = [
    ...placed,
    ...result.overflow.map((u) => u.id),
    ...result.zeroNet.map((u) => u.id),
  ].sort()
  expect(seen).toEqual(units.map((u) => u.id).sort())
  expect(new Set(seen).size).toBe(seen.length)

  // 3. Slice totals are exactly the sum of their units — no unit split, no
  //    rounding introduced — and every slice is INSERTABLE: the child table's
  //    `payout_transfers_net_positive` CHECK forbids net <= 0, so a slice that
  //    sums to nothing must never be emitted (it would abort the whole reserve,
  //    deterministically, every cycle).
  for (const slice of result.slices) {
    expect(slice.netPence).toBe(slice.units.reduce((s, u) => s + u.netPence, 0))
    expect(slice.feePence).toBe(slice.units.reduce((s, u) => s + u.feePence, 0))
    expect(slice.netPence).toBeGreaterThan(0)
  }

  // 4. An allocated slice always names its charge; a residual one never does.
  for (const slice of result.slices) {
    if (slice.funding === 'allocated') {
      expect(slice.settlementId).toBeTruthy()
      expect(slice.stripeChargeId).toBeTruthy()
    } else {
      expect(slice.settlementId).toBeNull()
      expect(slice.stripeChargeId).toBeNull()
    }
  }
}

describe('packUnits — the ordinary path', () => {
  it('places a unit on its own preferred settlement when it fits', () => {
    const units = [unit(100, 8, ['s1'])]
    const sources = [source('s1', 500), source('s2', 5000)]
    const result = packUnits(units, sources, CAP)

    expect(result.slices).toHaveLength(1)
    expect(result.slices[0].settlementId).toBe('s1')
    expect(result.slices[0].funding).toBe('allocated')
    assertPackSound(result, units, sources)
  })

  it('funds a unit against the CHARGE gross — net + fee, not net alone', () => {
    // The charge must cover both: Stripe debits the application fee from the
    // same allocated balance as the transfer. 100 fits; 100 + 8 does not.
    const units = [unit(100, 8, ['s1'])]
    const sources = [source('s1', 105)]
    const result = packUnits(units, sources, CAP)

    expect(unitGross(units[0])).toBe(108)
    expect(result.slices[0].funding).toBe('platform_balance')
    assertPackSound(result, units, sources)
  })

  it('collapses several units onto one charge — one transfer, not one per unit', () => {
    const units = [unit(100, 0, ['s1']), unit(200, 0, ['s1']), unit(50, 0, ['s1'])]
    const sources = [source('s1', 1000)]
    const result = packUnits(units, sources, CAP)

    expect(result.slices).toHaveLength(1)
    expect(result.slices[0].netPence).toBe(350)
    expect(result.slices[0].units).toHaveLength(3)
    assertPackSound(result, units, sources)
  })

  it('falls back to the POOL when a unit outgrows its own settlement', () => {
    // §1.1: `Σ(read net attributed to S) > charge(S)` is routine, not exotic —
    // the reserve clamp and any pre-paid credit both produce it. The money is
    // there in aggregate; it is just not behind the charge the read is stamped
    // with. Pool-drawing keeps the unit UNDER segregation.
    const units = [unit(900, 0, ['s1'])]
    const sources = [source('s1', 100), source('s2', 5000)]
    const result = packUnits(units, sources, CAP)

    expect(result.slices).toHaveLength(1)
    expect(result.slices[0].settlementId).toBe('s2')
    expect(result.slices[0].funding).toBe('allocated')
    assertPackSound(result, units, sources)
  })

  it('prefers the largest remaining source, minimising the transfer count', () => {
    const units = [unit(300), unit(300), unit(300)]
    const sources = [source('sA', 400), source('sB', 1000)]
    const result = packUnits(units, sources, CAP)

    // All three fit in sB; a smallest-first policy would have opened both.
    expect(result.slices).toHaveLength(1)
    expect(result.slices[0].settlementId).toBe('sB')
    assertPackSound(result, units, sources)
  })
})

describe('packUnits — the residual path (§3.3d)', () => {
  it('routes a unit with no fundable charge to platform_balance', () => {
    // A credit-funded subscription earning: no settlement exists at all.
    const units = [unit(500, 0, [])]
    const sources: FundingSource[] = []
    const result = packUnits(units, sources, CAP)

    expect(result.slices).toHaveLength(1)
    expect(result.slices[0].funding).toBe('platform_balance')
    expect(result.slices[0].settlementId).toBeNull()
    assertPackSound(result, units, sources)
  })

  it('opens exactly ONE residual slice however many units fall to it', () => {
    const units = [unit(100), unit(200), unit(300)]
    const result = packUnits(units, [], CAP)

    expect(result.slices).toHaveLength(1)
    expect(result.slices[0].netPence).toBe(600)
  })

  it('treats a charge with zero known allocation as simply not drawable', () => {
    // The ineligible-card-brand case, the not-yet-settled case and the pre-flip
    // case all arrive here identically: allocated_pence syncs to 0, so the
    // packer routes around with no error anywhere.
    const units = [unit(100, 0, ['s1'])]
    const sources = [source('s1', 0)]
    const result = packUnits(units, sources, CAP)

    expect(result.slices[0].funding).toBe('platform_balance')
    assertPackSound(result, units, sources)
  })
})

describe('packUnits — zero-net units never become a slice (the wedge)', () => {
  // Zero-net units are real: a fully-gifted read has chargeable_pence = 0
  // (migration 164), and a 1p-chargeable read floors to net 0 under
  // perReadNetPence. Both settle, both get claimed. Before the zeroNet bucket,
  // such a unit could open its own slice — a netPence: 0 child that violates
  // payout_transfers_net_positive and, because packing is deterministic,
  // aborts the SAME writer's reserve every cycle.

  it('sets a fully-gifted read (net 0, fee 0) aside instead of opening a zero slice', () => {
    const units = [unit(0, 0, ['s1'], 'gifted'), unit(500, 40, ['s1'], 'real')]
    const sources = [source('s1', 1000)]
    const result = packUnits(units, sources, CAP)

    expect(result.zeroNet.map((u) => u.id)).toEqual(['gifted'])
    expect(result.slices).toHaveLength(1)
    expect(result.slices[0].netPence).toBe(500)
    assertPackSound(result, units, sources)
  })

  it('sets a fee-floored read (net 0, fee 1) aside, leaving its fee as dust', () => {
    // chargeable_pence = 1 at 10% fee: net = floor(1 × 9000 / 10000) = 0.
    const units = [unit(0, 1, ['s1'], 'floored'), unit(500, 40, ['s1'], 'real')]
    const sources = [source('s1', 1000)]
    const result = packUnits(units, sources, CAP)

    expect(result.zeroNet.map((u) => u.id)).toEqual(['floored'])
    // The dust fee is NOT claimed by any slice — under-claiming is the safe
    // direction; the Balance-Transfer sweep reclaims it.
    expect(result.slices.reduce((s, sl) => s + sl.feePence, 0)).toBe(40)
    assertPackSound(result, units, sources)
  })

  it('a zero-net unit alone produces NO slices at all', () => {
    const units = [unit(0, 0, ['s1'], 'only')]
    const sources = [source('s1', 1000)]
    const result = packUnits(units, sources, CAP)

    expect(result.slices).toHaveLength(0)
    expect(result.zeroNet).toHaveLength(1)
    assertPackSound(result, units, sources)
  })

  it('a preferred settlement ABSENT from the sources map cannot be chosen', () => {
    // The usable() hole this pins: gross 0 satisfied `(remaining.get(id) ?? 0)
    // >= gross` for a settlement that was never locked, and openSlice was then
    // handed byId.get(chosen)! = undefined — a mislabeled slice keyed under a
    // settlement id. Presence is now required before the remainder compares.
    const units = [unit(0, 0, ['s-never-locked'], 'zero')]
    const result = packUnits(units, [], CAP)

    expect(result.slices).toHaveLength(0)
    expect(result.zeroNet.map((u) => u.id)).toEqual(['zero'])
    assertPackSound(result, units, [])
  })
})

describe('packUnits — over-transfer is structurally impossible (§3.3e)', () => {
  it('never over-draws a charge across many competing units', () => {
    const units = Array.from({ length: 40 }, (_, i) => unit(37 + i, 3, ['s1']))
    const sources = [source('s1', 500), source('s2', 500), source('s3', 500)]
    const result = packUnits(units, sources, { maxSlices: 20 })

    assertPackSound(result, units, sources)

    // The overspill has nowhere allocated left to go, so it is residual —
    // never an over-draw.
    const allocatedGross = result.slices
      .filter((s) => s.funding === 'allocated')
      .reduce((t, s) => t + s.netPence + s.feePence, 0)
    expect(allocatedGross).toBeLessThanOrEqual(1500)
  })

  it('is deterministic — the same inputs pack the same way, so a resume replays', () => {
    const units = [
      unit(100, 8, ['s2'], 'ua'),
      unit(100, 8, ['s1'], 'ub'),
      unit(250, 20, [], 'uc'),
      unit(60, 4, ['s1'], 'ud'),
    ]
    const sources = [source('s1', 400), source('s2', 400)]

    const a = packUnits(units, sources, CAP)
    const b = packUnits([...units].reverse(), sources, CAP)

    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('packUnits — the slice cap (§3.3c overflow)', () => {
  it('overflows units past the cap instead of paying in a thousand transfers', () => {
    const units = Array.from({ length: 6 }, (_, i) => unit(100, 0, [`s${i}`]))
    const sources = Array.from({ length: 6 }, (_, i) => source(`s${i}`, 100))
    const result = packUnits(units, sources, { maxSlices: 2 })

    expect(result.slices).toHaveLength(2)
    expect(result.overflow).toHaveLength(4)
    assertPackSound(result, units, sources)
  })

  it('still places a unit that fits an ALREADY-OPEN slice at the cap', () => {
    // Reaching the cap must not turn into needless overflow: an extra unit on an
    // open slice costs no extra transfer.
    const units = [
      unit(100, 0, ['s1'], 'big1'),
      unit(100, 0, ['s2'], 'big2'),
      unit(10, 0, ['s3'], 'small'),
    ]
    const sources = [source('s1', 1000), source('s2', 1000), source('s3', 1000)]
    const result = packUnits(units, sources, { maxSlices: 2 })

    expect(result.overflow).toHaveLength(0)
    expect(result.slices).toHaveLength(2)
    assertPackSound(result, units, sources)
  })
})

describe('apportionCarve — the carve can never produce a negative unit (§3.3b)', () => {
  it('deducts naturally when every unit is large enough', () => {
    const units = [unit(100, 0, [], 'a'), unit(100, 0, [], 'b')]
    const { units: out, zeroed, carveRemaining } = apportionCarve(units, 60)

    expect(carveRemaining).toBe(0)
    expect(zeroed).toHaveLength(0)
    expect(out.reduce((s, u) => s + u.netPence, 0)).toBe(140)
  })

  it('carries the overflow to the next unit rather than flooring at zero', () => {
    // The bug this closes: a per-read deduction driving one unit below zero, then
    // flooring it, makes Σ(units) > lockedAmount — the writer overpaid, the carve
    // under-collected, and the overpay ratified in both Stripe and the ledger.
    const units = [unit(30, 0, [], 'small'), unit(200, 0, [], 'large')]
    const { units: out, zeroed, carveRemaining } = apportionCarve(units, 220)

    expect(carveRemaining).toBe(0)
    // Total net is exactly 230 − 220 = 10, never more.
    const total = out.reduce((s, u) => s + u.netPence, 0)
    expect(total).toBe(10)
    for (const u of out) expect(u.netPence).toBeGreaterThan(0)
    expect(zeroed.map((u) => u.id)).toEqual(['large'])
  })

  it('drops a unit whose net reaches zero — Stripe rejects amount: 0', () => {
    const units = [unit(50, 4, [], 'x')]
    const { units: out, zeroed } = apportionCarve(units, 50)

    expect(out).toHaveLength(0)
    expect(zeroed).toHaveLength(1)
  })

  it('reports an unsatisfiable carve rather than swallowing it', () => {
    // The caller asserts carveRemaining === 0 and rolls Txn 1 back otherwise:
    // the entire error class becomes a rolled-back transaction, not a silent
    // overpay.
    const units = [unit(10, 0, [], 'x')]
    const { carveRemaining } = apportionCarve(units, 999)

    expect(carveRemaining).toBe(989)
  })

  it('is a no-op when tributes are dark (carve 0)', () => {
    const units = [unit(100, 8, ['s1'])]
    const result = apportionCarve(units, 0)

    expect(result.units).toBe(units)
    expect(result.carveRemaining).toBe(0)
  })
})

describe('prorateWithheldFee — routes the pooled fee out of allocated state (§3.4)', () => {
  it('splits the withheld fee in proportion to each split', () => {
    // 100p withheld across a 1000p distribution: a 400p split carries 40p.
    expect(prorateWithheldFee(100, 400, 1000)).toBe(40)
    expect(prorateWithheldFee(100, 600, 1000)).toBe(60)
  })

  it('FLOORS, so the proration under-claims and the remainder is dust', () => {
    // Taking too little fee leaves dust the Balance-Transfer sweep reclaims;
    // taking too much over-draws the charge and Stripe rejects the transfer. The
    // two directions are not symmetric — always err toward dust.
    const withheld = 100
    const splits = [333, 333, 334]
    const fees = splits.map((s) => prorateWithheldFee(withheld, s, 1000))

    expect(fees).toEqual([33, 33, 33])
    expect(fees.reduce((a, b) => a + b, 0)).toBeLessThan(withheld)
  })

  it('claims nothing when there is nothing withheld or nothing distributed', () => {
    expect(prorateWithheldFee(0, 400, 1000)).toBe(0)
    expect(prorateWithheldFee(100, 400, 0)).toBe(0)
    expect(prorateWithheldFee(100, 0, 1000)).toBe(0)
  })
})

describe('prorateCarveReversal — the author carve re-credited per child (§3.4)', () => {
  it('re-credits in proportion to the child\'s cumulative reversal', () => {
    // A 1000p child carrying a 400p carve, reversed in full: the author gets the
    // whole carve back, because the whole transfer went back.
    expect(prorateCarveReversal(400, 1000, 0, 1000)).toBe(400)
    // Half reversed ⇒ half the carve.
    expect(prorateCarveReversal(400, 1000, 0, 500)).toBe(200)
    // And it FLOORS: 400 × 333 ÷ 1000 = 133.2, so the author gets 133 back and
    // the odd 0.2p stays where it is. Under-claiming is the safe direction —
    // handing the author back more carve than left them would manufacture
    // earnings out of a reversal.
    expect(prorateCarveReversal(400, 1000, 0, 333)).toBe(133)
  })

  it('posts the INCREMENT of a staged partial, never the cumulative figure again', () => {
    // Stripe reports amount_reversed cumulatively, so a second partial arrives as
    // a larger absolute number. Posting `owed(after)` each time would re-credit
    // the first stage twice; the delta is the only honest figure.
    const first = prorateCarveReversal(400, 1000, 0, 300)
    const second = prorateCarveReversal(400, 1000, 300, 700)
    expect(first).toBe(120)
    expect(second).toBe(160)
    expect(first + second).toBe(prorateCarveReversal(400, 1000, 0, 700))
  })

  it('is a no-op for a redelivery, which is the whole idempotency claim', () => {
    expect(prorateCarveReversal(400, 1000, 700, 700)).toBe(0)
  })

  it('cannot go negative when a chargeback shrinks the carve between partials', () => {
    // Both terms use the SAME carve figure, so the difference is monotone in
    // `reversed` and a shrunk carve simply makes the next increment smaller —
    // it can never demand money back. (The parent-grain legacy path differences
    // against ledger entries posted under the OLD carve, where a negative IS
    // reachable and its `> 0` test is load-bearing.) 400 → 100 mid-stage:
    expect(prorateCarveReversal(400, 1000, 0, 700)).toBe(280)
    expect(prorateCarveReversal(100, 1000, 700, 800)).toBe(10)
    // A carve voided away entirely stops re-crediting rather than reversing.
    expect(prorateCarveReversal(0, 1000, 700, 800)).toBe(0)
  })

  it('never re-credits more than the carve, however the reversal is reported', () => {
    // `reversed` is capped at the child's net upstream, but a defensive over-large
    // figure must still not manufacture money.
    expect(prorateCarveReversal(400, 1000, 0, 5000)).toBe(400)
    expect(prorateCarveReversal(400, 0, 0, 1000)).toBe(0)
  })
})
