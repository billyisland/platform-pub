// =============================================================================
// allocation-packer — the funding decision, as a pure function.
//
// Spec: docs/adr/FUNDS-SEGREGATION-INTEGRATION.md §3.3b.
//
// THE STRUCTURAL IDEA. Under funds segregation, ATTRIBUTION (which reads a
// writer is owed for, and how much) does not change at all — the claim and net
// arithmetic in reserveWriterPayout stay byte-identical, so no money question is
// reopened and every conformance test stays green. What is new is FUNDING:
// deciding which charges' allocated balances pay the already-decided amount.
//
// This module is that decision and nothing else. It lives apart, pure and
// unit-tested, for the same reason `chargeback.ts`'s planner does: it is the
// half of a money path that is all arithmetic, and arithmetic belongs somewhere
// it can be exhaustively tested without a database.
//
// WHY THE POOL, NOT THE PAIRING. A read's own settlement often cannot fund it:
// `confirmSettlement` advances reads by a TIME predicate, not by which reads'
// grosses summed to the charged amount, so `Σ(read net attributed to S) >
// charge(S)` is routine (the reserve clamp; any pre-paid credit). What DOES
// hold is global conservation — in aggregate, across all time, settlement
// charges fund all payable read earnings. So the packer prefers a unit's own
// settlement (it keeps the audit trail legible) and falls back to any charge
// with room. Drawing on another reader's charge is not a compromise: Stripe
// permits any split of a charge across connected accounts, and the guarantee at
// stake is "pooled reader funds can only reach connected accounts" — pool
// drawing keeps a unit UNDER segregation that would otherwise fall to the
// unsegregated residual. If a regulator ever requires per-payer tracing, the
// child rows record exactly which charge funded which unit, so the stricter
// policy is a one-line change to `place`'s step 2.
// =============================================================================

/**
 * The smallest indivisible piece of what we owe: one read's earning, one
 * subscription earning, one tribute accrual. A unit is NEVER split, which is
 * what makes this design introduce no rounding anywhere — every fee here is a
 * fee that already existed.
 */
export interface EarningUnit {
  /** Opaque to the packer; the caller uses it to stamp the claim row. */
  id: string
  /** Which claim table the id belongs to — the caller's release path needs it. */
  source: 'read_events' | 'subscription_events' | 'tribute_accruals'
  /** What the recipient is paid. Always > 0 by the time it reaches the packer. */
  netPence: number
  /**
   * The platform fee that rode this unit, to be claimed as an
   * `application_fee_amount` so it leaves allocated state. Floored, never
   * rounded up, and 0 where it cannot be derived — see `feeDust` below.
   */
  feePence: number
  /**
   * Settlements this unit would rather be funded by, in preference order. One
   * entry for a read (its `tab_settlement_id`); a SET for a publication split,
   * whose net is a bps share of a pool spanning many charges and so has no
   * single natural preference. Empty = no preference, which is correct for a
   * credit-funded subscription earning (no charge exists).
   */
  preferredSettlementIds: string[]
}

/** A charge's remaining drawable allocation, as our model understands it. */
export interface FundingSource {
  settlementId: string
  stripeChargeId: string
  /** allocated_pence − Σ draws, floored at 0 by the caller's SQL. */
  remainingPence: number
}

/** One child transfer: the units placed on a single funding source. */
export interface PackedSlice {
  /** NULL for the residual slice — no charge behind it. */
  settlementId: string | null
  stripeChargeId: string | null
  funding: 'allocated' | 'platform_balance'
  netPence: number
  feePence: number
  units: EarningUnit[]
}

export interface PackResult {
  slices: PackedSlice[]
  /** Units that did not fit within `maxSlices` — the caller must UN-CLAIM these. */
  overflow: EarningUnit[]
}

/**
 * A unit's GROSS is what the charge must actually fund: Stripe debits the
 * application fee from the SAME allocated balance as the transfer, and the two
 * together are what "must not exceed the original payment amount" bounds.
 */
export function unitGross(unit: EarningUnit): number {
  return unit.netPence + unit.feePence
}

// -----------------------------------------------------------------------------
// The tribute carve, apportioned
// -----------------------------------------------------------------------------

/**
 * Spread a writer's ROOT tribute carve across their read units.
 *
 * Today the carve is a single set-level SUM subtracted once from the payout
 * total. Turning it into a naive per-read deduction can drive an individual
 * unit's net BELOW ZERO, and flooring at 0 would make `Σ units > lockedAmount`:
 * the writer overpaid, the carve under-collected, and — because the parent's
 * amount is restated from the placed units — the overpay silently ratified in
 * both Stripe and the ledger.
 *
 * So: take natural per-read attribution where it fits, carry the overflow to the
 * next unit, and never allow a negative. Descending net first, so the largest
 * units absorb the carve and the tail is disturbed as little as possible.
 * Integer pence throughout — nothing rounds.
 *
 * A unit whose net reaches 0 is DROPPED (returned separately): Stripe rejects
 * `amount: 0`, and a slice of pure fee with no net is not a transfer. Its fee is
 * left as dust for the Balance-Transfer sweep.
 *
 * Both assertions the spec requires are the caller's to make against the result
 * (`carveRemaining === 0`, `Σ net === lockedAmountPence`); they are cheap, and
 * they turn this entire class of error into a rolled-back transaction rather
 * than a silent overpay. Inert while TRIBUTES_ENABLED is off — which is exactly
 * why the assertions matter: this is code that will be switched on years from
 * now by someone who was not here.
 */
export function apportionCarve(
  units: EarningUnit[],
  carvePence: number,
): { units: EarningUnit[]; zeroed: EarningUnit[]; carveRemaining: number } {
  if (carvePence <= 0) return { units, zeroed: [], carveRemaining: 0 }

  // Descending net, then by id so the order is deterministic across runs (a
  // resume must produce the same apportionment as the original pass).
  const ordered = [...units].sort(
    (a, b) => b.netPence - a.netPence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  let remaining = carvePence
  const kept: EarningUnit[] = []
  const zeroed: EarningUnit[] = []

  for (const unit of ordered) {
    const take = Math.min(unit.netPence, remaining)
    remaining -= take
    const net = unit.netPence - take
    if (net <= 0) {
      zeroed.push(unit)
    } else {
      kept.push({ ...unit, netPence: net })
    }
  }

  return { units: kept, zeroed, carveRemaining: remaining }
}

// -----------------------------------------------------------------------------
// The pack
// -----------------------------------------------------------------------------

export interface PackOptions {
  /**
   * Ceiling on child transfers for one payout. The cycle is now materially more
   * Stripe calls (O(writers × charges drawn) rather than O(writers)); this bounds
   * the tail rather than paying one writer in a thousand transfers. A
   * platform_config dial, so the caller supplies it.
   */
  maxSlices: number
}

/**
 * Pack whole earning-units onto funding sources.
 *
 * Order: units with a preferred settlement first (so the common case lands on
 * its own charge and the audit trail reads naturally), then gross DESCENDING —
 * a first-fit-decreasing bin pack. FFD is near-optimal in slice count and, more
 * importantly here, DETERMINISTIC: a resume produces the same packing, which is
 * what lets Txn 1 commit the packing once and the execute loop merely replay it.
 *
 * `sources` is not mutated; remainders are tracked locally.
 */
export function packUnits(
  units: EarningUnit[],
  sources: FundingSource[],
  options: PackOptions,
): PackResult {
  const remaining = new Map<string, number>()
  const byId = new Map<string, FundingSource>()
  for (const source of sources) {
    remaining.set(source.settlementId, Math.max(0, source.remainingPence))
    byId.set(source.settlementId, source)
  }

  const ordered = [...units].sort((a, b) => {
    const aPref = a.preferredSettlementIds.length > 0 ? 0 : 1
    const bPref = b.preferredSettlementIds.length > 0 ? 0 : 1
    if (aPref !== bPref) return aPref - bPref
    const byGross = unitGross(b) - unitGross(a)
    if (byGross !== 0) return byGross
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  // Keyed by settlement id, or the sentinel for the single residual slice.
  const RESIDUAL = ' residual'
  const slices = new Map<string, PackedSlice>()

  const sliceCount = () => slices.size

  const openSlice = (key: string, source: FundingSource | null): PackedSlice => {
    const existing = slices.get(key)
    if (existing) return existing
    const slice: PackedSlice = source
      ? {
          settlementId: source.settlementId,
          stripeChargeId: source.stripeChargeId,
          funding: 'allocated',
          netPence: 0,
          feePence: 0,
          units: [],
        }
      : {
          settlementId: null,
          stripeChargeId: null,
          funding: 'platform_balance',
          netPence: 0,
          feePence: 0,
          units: [],
        }
    slices.set(key, slice)
    return slice
  }

  const overflow: EarningUnit[] = []

  // Pick a settlement with room for `gross`. `openOnly` restricts the search to
  // sources that already have a slice, which is what keeps the cap from turning
  // into needless overflow: once the slice budget is spent, a unit that fits an
  // ALREADY-OPEN slice costs no extra transfer and must still be placed.
  const choose = (unit: EarningUnit, gross: number, openOnly: boolean): string | null => {
    const usable = (settlementId: string) =>
      (remaining.get(settlementId) ?? 0) >= gross &&
      (!openOnly || slices.has(settlementId))

    // 1. The unit's own preferred settlement(s), in the caller's order.
    for (const preferred of unit.preferredSettlementIds) {
      if (usable(preferred)) return preferred
    }

    // 2. Any allocated settlement with room — largest remaining first, which
    //    minimises the transfer count. At a TIE, prefer a source whose slice is
    //    already open (a tie broken toward a fresh source would open a second
    //    transfer for no gain), then smallest id so the pack is deterministic.
    let best: string | null = null
    let bestRemaining = -1
    let bestOpen = false
    for (const [settlementId, left] of remaining) {
      if (!usable(settlementId)) continue
      const open = slices.has(settlementId)
      const better =
        best === null ||
        left > bestRemaining ||
        (left === bestRemaining &&
          (open !== bestOpen ? open : settlementId < best))
      if (better) {
        best = settlementId
        bestRemaining = left
        bestOpen = open
      }
    }
    return best
  }

  for (const unit of ordered) {
    const gross = unitGross(unit)

    let chosen = choose(unit, gross, false)
    let key = chosen ?? RESIDUAL

    if (!slices.has(key) && sliceCount() >= options.maxSlices) {
      // The slice budget is spent. Retry against open slices only; a unit that
      // fits one of those costs no extra transfer. Failing that it overflows and
      // the caller UN-CLAIMS it, so it rolls to the next cycle rather than being
      // paid in a thousand transfers.
      chosen = choose(unit, gross, true)
      key = chosen ?? RESIDUAL
      if (!slices.has(key)) {
        overflow.push(unit)
        continue
      }
    }

    const slice = openSlice(key, chosen ? byId.get(chosen)! : null)
    slice.units.push(unit)
    slice.netPence += unit.netPence
    slice.feePence += unit.feePence
    if (chosen !== null) {
      remaining.set(chosen, (remaining.get(chosen) ?? 0) - gross)
    }
  }

  // Deterministic output order: allocated slices by settlement id, residual last
  // (it is the exceptional path and reads better at the end of an audit trail).
  const out = [...slices.values()].sort((a, b) => {
    if (a.funding !== b.funding) return a.funding === 'allocated' ? -1 : 1
    return (a.settlementId ?? '') < (b.settlementId ?? '') ? -1 : 1
  })

  return { slices: out, overflow }
}

/**
 * Prorate a publication payout's ALREADY-WITHHELD pooled fee across its splits,
 * so it routes out of allocated funds into platform balance where it already
 * belonged.
 *
 * The subtlety this closes: a publication split's fee was withheld when the pool
 * was computed, so charging an application fee on top would take it twice — that
 * reasoning is right, and the conclusion "fee = 0" is wrong. Under allocation
 * the FULL charge is locked, so a fee never claimed as an `application_fee_amount`
 * never leaves allocated state at all. It is not taken twice; it is taken ZERO
 * times, and roughly a tenth of all publication revenue would accumulate as
 * locked allocated funds every cycle. That is not dust.
 *
 * The recipient's net is untouched, so no split's payment changes and
 * `computePublicationSplits` is not reopened. FLOOR, so the proration
 * under-claims and the remainder is real dust: taking too little fee leaves dust
 * the Balance-Transfer sweep reclaims, while taking too much over-draws the
 * charge and Stripe rejects the transfer. The two error directions are not
 * symmetric — always err toward dust.
 *
 * The `sub_net_pence` portion of a pool contributes no withheld fee (per-charge
 * fees were floored at charge time), so it dilutes the proration slightly. Safe,
 * in the under-claim direction, and not worth a second denominator.
 */
export function prorateWithheldFee(
  withheldFeePence: number,
  splitAmountPence: number,
  distributedPence: number,
): number {
  if (withheldFeePence <= 0 || distributedPence <= 0) return 0
  if (splitAmountPence <= 0) return 0
  return Math.floor((withheldFeePence * splitAmountPence) / distributedPence)
}
