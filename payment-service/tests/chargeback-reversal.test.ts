import { describe, it, expect } from 'vitest'
import { computeChargebackReversal, type ReversalAccrual } from '../src/services/chargeback.js'
import { perReadNetPence } from '@platform-pub/shared/lib/per-read-net.js'

// ---------------------------------------------------------------------------
// F3 chargeback reversal — conservation of the pure planner (repo idiom: the
// SQL just feeds this; the math is proven here, not against a DB).
//
// The spine: for a charged-back read where every accrual has resolved
// (all 'paid'/'returned'), the writer + tribute reversal entries sum to exactly
// −read_net. Money never paid out (held/swept-voided, unpaid reads) is PREVENTED,
// not reversed, so it is correctly absent from the sum.
// ---------------------------------------------------------------------------

const FEE = 800 // 8%

/** Sum the PAID-side reversal entries (what actually left the platform). */
function writerSideSum(entries: { trigger: string; amountPence: number }[]): number {
  return entries
    .filter((e) => e.trigger === 'writer_payout_reversal' || e.trigger === 'tribute_payout_reversal')
    .reduce((s, e) => s + e.amountPence, 0)
}

/** Sum the EARNED-side reversal entries (item 3 final phase — backs out
 *  ledger_writer_earned). For the author this nets to −(read_net − paid_root
 *  carve) = −(author's retained earned); inspirer tribute income is not on the
 *  earned side, so it is correctly absent. */
function earnedSideSum(entries: { trigger: string; amountPence: number }[]): number {
  return entries
    .filter((e) => e.trigger === 'writer_accrual_reversal' || e.trigger === 'tribute_carve_reversal')
    .reduce((s, e) => s + e.amountPence, 0)
}

const baseAccrual = (over: Partial<ReversalAccrual>): ReversalAccrual => ({
  id: 'a', readEventId: 'R', tributeId: 'T', parentTributeId: null,
  amountPence: 0, state: 'paid', resolvedAccountId: 'I', authorAccountId: 'W',
  parentResolvedAccountId: null, parentAuthorAccountId: null,
  sweptReturnKind: null, claimed: false, ...over,
})

describe('computeChargebackReversal', () => {
  it('platform-wide (no tributes): a writer_paid read reverses the full read net', () => {
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals: [], platformFeeBps: FEE,
    })
    const net = perReadNetPence(1000, FEE) // 920
    expect(writerSideSum(plan.ledgerEntries)).toBe(-net)
    // reader entry restores the full settled charge
    expect(plan.ledgerEntries.find((e) => e.trigger === 'tab_settlement_reversal')!.amountPence).toBe(-1000)
    expect(plan.tabRestorePence).toBe(1000)
    expect(plan.chargeBackReadIds).toEqual(['R'])
    expect(plan.voidAccrualIds).toEqual([])
  })

  it('platform_settled (unpaid) read: charged back, no writer reversal', () => {
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 500,
      reads: [{ id: 'R', amountPence: 500, state: 'platform_settled', writerId: 'W' }],
      votes: [], accruals: [], platformFeeBps: FEE,
    })
    expect(writerSideSum(plan.ledgerEntries)).toBe(0)
    expect(plan.chargeBackReadIds).toEqual(['R'])
  })

  it('upvote charge (writer_paid) reverses against its recipient', () => {
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [],
      votes: [{ id: 'V', amountPence: 100, state: 'writer_paid', recipientId: 'REC' }],
      accruals: [], platformFeeBps: FEE,
    })
    expect(plan.chargeBackVoteIds).toEqual(['V'])
    const recEntry = plan.ledgerEntries.find((e) => e.accountId === 'REC')!
    expect(recEntry.trigger).toBe('writer_payout_reversal')
    expect(recEntry.amountPence).toBe(-perReadNetPence(100, FEE))
  })

  it('fully-resolved tribute chain: writer + tribute reversals sum to −read_net', () => {
    // read 1000 → net 920. Root T1 (→I1) accrued 300 gross; child T2 (→I2) 100.
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'paid', resolvedAccountId: 'I1', authorAccountId: 'W' }),
      baseAccrual({ id: 'a2', tributeId: 'T2', parentTributeId: 'T1', amountPence: 100, state: 'paid', resolvedAccountId: 'I2', authorAccountId: 'I1', parentResolvedAccountId: 'I1', parentAuthorAccountId: 'W' }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals, platformFeeBps: FEE,
    })
    const net = perReadNetPence(1000, FEE)
    expect(writerSideSum(plan.ledgerEntries)).toBe(-net)
    // author keeps net − roots = 920 − 300 = 620
    expect(plan.ledgerEntries.find((e) => e.accountId === 'W' && e.trigger === 'writer_payout_reversal')!.amountPence).toBe(-620)
    // root inspirer I1: 300 − child 100 = 200
    expect(plan.ledgerEntries.find((e) => e.accountId === 'I1')!.amountPence).toBe(-200)
    // child inspirer I2: 100 − 0 = 100
    expect(plan.ledgerEntries.find((e) => e.accountId === 'I2')!.amountPence).toBe(-100)
    expect(plan.voidAccrualIds).toEqual([])
  })

  it('held root accrual: voided, NOT reversed (platform keeps the held float)', () => {
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'held', resolvedAccountId: 'I1', authorAccountId: 'W' }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals, platformFeeBps: FEE,
    })
    // author reversed only for what it received: net − carved root = 920 − 300 = 620
    expect(writerSideSum(plan.ledgerEntries)).toBe(-620)
    expect(plan.voidAccrualIds).toEqual(['a1'])
  })

  it('claimed (mid-payout) released accrual is reversed as paid, not skipped — conservation holds', () => {
    // The accrual is in-flight to 'paid' via a reserved tribute payout (claimed,
    // sweptReturnKind null). Reversing it as paid is what closes the money hole:
    // the in-flight transfer pays the inspirer clawed-back money, so a reversal
    // must exist. Not voided (it WILL be paid).
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'released', resolvedAccountId: 'I1', authorAccountId: 'W', claimed: true }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals, platformFeeBps: FEE,
    })
    const net = perReadNetPence(1000, FEE)
    expect(plan.voidAccrualIds).toEqual([])
    // I1 reversed for the claimed accrual it is being paid (300 − no children).
    expect(plan.ledgerEntries.find((e) => e.accountId === 'I1')!.amountPence).toBe(-300)
    // conservation still nets to −read_net (author 620 + I1 300).
    expect(writerSideSum(plan.ledgerEntries)).toBe(-net)
  })

  it('UNclaimed released accrual is still voided (not reversed)', () => {
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'released', resolvedAccountId: 'I1', authorAccountId: 'W', claimed: false }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals, platformFeeBps: FEE,
    })
    expect(plan.voidAccrualIds).toEqual(['a1'])
    // Only the author's carve-reduced net is reversed (the held float is kept).
    expect(writerSideSum(plan.ledgerEntries)).toBe(-620)
  })

  it('claimed swept-return (kind writer) is reversed against the author as a returned share', () => {
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'swept', sweptReturnKind: 'writer', resolvedAccountId: 'I1', authorAccountId: 'W', claimed: true }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals, platformFeeBps: FEE,
    })
    const net = perReadNetPence(1000, FEE)
    expect(plan.voidAccrualIds).toEqual([])
    // Same outcome as a fully-returned root (kind writer): author reversed base + return.
    expect(plan.ledgerEntries.find((e) => e.accountId === 'W' && e.trigger === 'writer_payout_reversal')!.amountPence).toBe(-net)
  })

  it('claimed swept-return (kind tribute) is reversed against the parent inspirer', () => {
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'paid', resolvedAccountId: 'I1', authorAccountId: 'W' }),
      baseAccrual({ id: 'a2', tributeId: 'T2', parentTributeId: 'T1', amountPence: 100, state: 'swept', sweptReturnKind: 'tribute', resolvedAccountId: 'I2', authorAccountId: 'I1', parentResolvedAccountId: 'I1', parentAuthorAccountId: 'W', claimed: true }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals, platformFeeBps: FEE,
    })
    const net = perReadNetPence(1000, FEE)
    expect(plan.voidAccrualIds).toEqual([])
    // I1 received own paid net (300−100=200) + the in-flight returned child (100) = 300.
    expect(plan.ledgerEntries.find((e) => e.accountId === 'I1')!.amountPence).toBe(-300)
    expect(writerSideSum(plan.ledgerEntries)).toBe(-net)
  })

  it('swept-then-returned root (kind writer): author reversed for base + return = −read_net', () => {
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'returned', sweptReturnKind: 'writer', resolvedAccountId: 'I1', authorAccountId: 'W' }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals, platformFeeBps: FEE,
    })
    const net = perReadNetPence(1000, FEE)
    expect(writerSideSum(plan.ledgerEntries)).toBe(-net)
    // single merged writer entry for W: base 620 + returned 300 = 920
    expect(plan.ledgerEntries.find((e) => e.accountId === 'W' && e.trigger === 'writer_payout_reversal')!.amountPence).toBe(-net)
  })

  it('returned child (kind tribute): reversed against the parent inspirer', () => {
    // Parent T1 paid (→I1), child T2 swept-then-returned up to I1.
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'paid', resolvedAccountId: 'I1', authorAccountId: 'W' }),
      baseAccrual({ id: 'a2', tributeId: 'T2', parentTributeId: 'T1', amountPence: 100, state: 'returned', sweptReturnKind: 'tribute', resolvedAccountId: 'I2', authorAccountId: 'I1', parentResolvedAccountId: 'I1', parentAuthorAccountId: 'W' }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals, platformFeeBps: FEE,
    })
    const net = perReadNetPence(1000, FEE)
    // I1 received: own paid net (300−100=200) + returned child (100) = 300 → reversed −300
    expect(plan.ledgerEntries.find((e) => e.accountId === 'I1')!.amountPence).toBe(-300)
    // conservation: author 620 + I1 300 = 920
    expect(writerSideSum(plan.ledgerEntries)).toBe(-net)
  })
})

// ---------------------------------------------------------------------------
// Earned-side reversals (item 3 final phase). DISJOINT from the paid side: the
// writer_accrual posted at settlement is reversed regardless of payout state,
// and a paid ROOT carve's tribute_carve author debit is reversed too. The
// author's earned backs out to −(read_net − paid_root_carve).
// ---------------------------------------------------------------------------
describe('computeChargebackReversal — earned side', () => {
  it('platform_settled (UNPAID) read still reverses its writer_accrual', () => {
    // The paid side does nothing (never transferred), but the accrual was posted
    // at settlement — so the earned side MUST back it out. This is the behaviour
    // the paid-side planner does not have (it skips unpaid reads).
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 500,
      reads: [{ id: 'R', amountPence: 500, state: 'platform_settled', writerId: 'W' }],
      votes: [], accruals: [], platformFeeBps: FEE,
    })
    expect(writerSideSum(plan.ledgerEntries)).toBe(0)
    expect(earnedSideSum(plan.ledgerEntries)).toBe(-perReadNetPence(500, FEE))
    const e = plan.ledgerEntries.find((x) => x.trigger === 'writer_accrual_reversal')!
    expect(e.accountId).toBe('W')
    expect(e.counterpartyId).toBe('reader')
  })

  it('fully-resolved chain: earned side nets to the author retained (−620), not −read_net', () => {
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'paid', resolvedAccountId: 'I1', authorAccountId: 'W' }),
      baseAccrual({ id: 'a2', tributeId: 'T2', parentTributeId: 'T1', amountPence: 100, state: 'paid', resolvedAccountId: 'I2', authorAccountId: 'I1', parentResolvedAccountId: 'I1', parentAuthorAccountId: 'W' }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals, platformFeeBps: FEE,
    })
    // writer_accrual_reversal −920 + tribute_carve_reversal +300 (root only) = −620.
    expect(earnedSideSum(plan.ledgerEntries)).toBe(-620)
    expect(plan.ledgerEntries.find((e) => e.trigger === 'writer_accrual_reversal')!.amountPence).toBe(-920)
    const carve = plan.ledgerEntries.find((e) => e.trigger === 'tribute_carve_reversal')!
    expect(carve.amountPence).toBe(300) // positive: restores the author's debit
    expect(carve.accountId).toBe('W')
    expect(carve.counterpartyId).toBe('I1')
    // child carve (T2) is NOT reversed on the earned side — only one carve entry.
    expect(plan.ledgerEntries.filter((e) => e.trigger === 'tribute_carve_reversal')).toHaveLength(1)
  })

  it('held root carve: accrual reversed in full, NO carve reversal (carve never paid)', () => {
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'held', resolvedAccountId: 'I1', authorAccountId: 'W' }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals, platformFeeBps: FEE,
    })
    // The held carve never entered the ledger (guard #7), so no carve reversal;
    // the full read_net accrual still backs out.
    expect(earnedSideSum(plan.ledgerEntries)).toBe(-perReadNetPence(1000, FEE))
    expect(plan.ledgerEntries.filter((e) => e.trigger === 'tribute_carve_reversal')).toHaveLength(0)
  })

  // F2/F5 safety gate: a publication read earns no personal writer_accrual and
  // is paid to split recipients, not the author — so it must be charged back on
  // the reader side only, with NO author-keyed writer reversal (else the
  // chargeback mis-attributes to the author). Full split-recipient reversal is
  // deferred F5; the platform absorbs the un-reversed split for now.
  it('publication read: charged back but no author-side reversal (F2/F5 gate)', () => {
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W', isPublication: true }],
      votes: [], accruals: [], platformFeeBps: FEE,
    })
    // The read flips to charged_back...
    expect(plan.chargeBackReadIds).toEqual(['R'])
    // ...the reader's debt is restored...
    expect(plan.tabRestorePence).toBe(1000)
    expect(plan.ledgerEntries.filter((e) => e.trigger === 'tab_settlement_reversal')).toHaveLength(1)
    // ...but NO author-keyed writer/earned reversal fires.
    expect(writerSideSum(plan.ledgerEntries)).toBe(0)
    expect(earnedSideSum(plan.ledgerEntries)).toBe(0)
    expect(plan.ledgerEntries.filter((e) => e.trigger === 'writer_payout_reversal')).toHaveLength(0)
    expect(plan.ledgerEntries.filter((e) => e.trigger === 'writer_accrual_reversal')).toHaveLength(0)
  })

  // Control: the SAME read as an individual-writer read DOES reverse to the author.
  it('individual read: reverses to the author (control for the publication gate)', () => {
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      votes: [], accruals: [], platformFeeBps: FEE,
    })
    expect(writerSideSum(plan.ledgerEntries)).toBe(-perReadNetPence(1000, FEE))
    expect(earnedSideSum(plan.ledgerEntries)).toBe(-perReadNetPence(1000, FEE))
  })
})
