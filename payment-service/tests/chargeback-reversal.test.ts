import { describe, it, expect } from 'vitest'
import { computeChargebackReversal, type ReversalAccrual } from '../src/services/chargeback.js'
import { perReadNetPence } from '@platform-pub/shared/lib/per-read-net.js'

// ---------------------------------------------------------------------------
// F3 chargeback reversal — conservation of the pure planner (repo idiom: the
// SQL just feeds this; the math is proven here, not against a DB).
//
// The spine: for a charged-back read where every accrual has resolved (all
// 'paid'), the writer + tribute reversal entries sum to exactly −read_net. Money
// never paid out (released-voided accruals, unpaid reads) is PREVENTED, not
// reversed, so it is correctly absent from the sum.
//
// Dial A (consent-gated accrual): an accrual is only ever 'released' → 'paid'
// (+ 'voided' here). The held/swept/returned states and the swept-return-to-
// parent reversal are gone — a live tribute never un-consents.
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
  claimed: false, ...over,
})

describe('computeChargebackReversal', () => {
  it('platform-wide (no tributes): a writer_paid read reverses the full read net', () => {
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      accruals: [], platformFeeBps: FEE,
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
      accruals: [], platformFeeBps: FEE,
    })
    expect(writerSideSum(plan.ledgerEntries)).toBe(0)
    expect(plan.chargeBackReadIds).toEqual(['R'])
  })

  it('fully-resolved tribute chain: writer + tribute reversals sum to −read_net', () => {
    // read 1000 → net 920. Root T1 (→I1) accrued 300 gross; child T2 (→I2) 100.
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'paid', resolvedAccountId: 'I1', authorAccountId: 'W' }),
      baseAccrual({ id: 'a2', tributeId: 'T2', parentTributeId: 'T1', amountPence: 100, state: 'paid', resolvedAccountId: 'I2', authorAccountId: 'I1' }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      accruals, platformFeeBps: FEE,
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

  it('claimed (mid-payout) released accrual is reversed as paid, not skipped — conservation holds', () => {
    // The accrual is in-flight to 'paid' via a reserved tribute payout (claimed).
    // Reversing it as paid is what closes the money hole: the in-flight transfer
    // pays the inspirer clawed-back money, so a reversal must exist. Not voided
    // (it WILL be paid).
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'released', resolvedAccountId: 'I1', authorAccountId: 'W', claimed: true }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      accruals, platformFeeBps: FEE,
    })
    const net = perReadNetPence(1000, FEE)
    expect(plan.voidAccrualIds).toEqual([])
    // I1 reversed for the claimed accrual it is being paid (300 − no children).
    expect(plan.ledgerEntries.find((e) => e.accountId === 'I1')!.amountPence).toBe(-300)
    // conservation still nets to −read_net (author 620 + I1 300).
    expect(writerSideSum(plan.ledgerEntries)).toBe(-net)
  })

  it('UNclaimed released accrual is voided (not reversed) — platform keeps the float', () => {
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'released', resolvedAccountId: 'I1', authorAccountId: 'W', claimed: false }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      accruals, platformFeeBps: FEE,
    })
    expect(plan.voidAccrualIds).toEqual(['a1'])
    // Only the author's carve-reduced net is reversed (the reserved float is kept).
    expect(writerSideSum(plan.ledgerEntries)).toBe(-620)
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
      accruals: [], platformFeeBps: FEE,
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
      baseAccrual({ id: 'a2', tributeId: 'T2', parentTributeId: 'T1', amountPence: 100, state: 'paid', resolvedAccountId: 'I2', authorAccountId: 'I1' }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      accruals, platformFeeBps: FEE,
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

  it('unclaimed released carve: accrual reversed in full, NO carve reversal (carve never paid)', () => {
    const accruals: ReversalAccrual[] = [
      baseAccrual({ id: 'a1', tributeId: 'T1', parentTributeId: null, amountPence: 300, state: 'released', resolvedAccountId: 'I1', authorAccountId: 'W', claimed: false }),
    ]
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      accruals, platformFeeBps: FEE,
    })
    // The released (unpaid) carve never entered the ledger (guard #7), so no carve
    // reversal; the full read_net accrual still backs out.
    expect(earnedSideSum(plan.ledgerEntries)).toBe(-perReadNetPence(1000, FEE))
    expect(plan.ledgerEntries.filter((e) => e.trigger === 'tribute_carve_reversal')).toHaveLength(0)
  })

  // F5: a publication read whose pool was NOT paid out (no PAID splits passed
  // in — e.g. KYC-incomplete recipients, or not yet finalised) is charged back
  // on the reader side only, with NO author-keyed reversal (pub reads pay the
  // pool, not the author) and no earned-side entry (they post no writer_accrual).
  it('publication read, pool unpaid: charged back, no writer/earned reversal', () => {
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W', isPublication: true }],
      accruals: [], platformFeeBps: FEE,
    })
    expect(plan.chargeBackReadIds).toEqual(['R'])
    expect(plan.tabRestorePence).toBe(1000)
    expect(plan.ledgerEntries.filter((e) => e.trigger === 'tab_settlement_reversal')).toHaveLength(1)
    // NO author-keyed writer/earned reversal fires.
    expect(writerSideSum(plan.ledgerEntries)).toBe(0)
    expect(earnedSideSum(plan.ledgerEntries)).toBe(0)
    expect(plan.ledgerEntries.filter((e) => e.trigger === 'writer_payout_reversal')).toHaveLength(0)
    expect(plan.ledgerEntries.filter((e) => e.trigger === 'writer_accrual_reversal')).toHaveLength(0)
  })

  // F5: a publication read whose pool WAS paid out reverses each PAID split
  // recipient by their receipt × (read gross ÷ payout pool) — to the recipients,
  // never the author, and never on the earned side.
  it('publication read, pool paid: reverses split recipients proportionally, not the author', () => {
    // This read (gross 1000) is one of a 4000-gross payout pool. Two members were
    // paid 1800 (M1) and 900 (M2). This read funded 1000/4000 = 1/4 of each.
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{
        id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W', isPublication: true,
        publicationPoolPence: 4000,
        publicationSplits: [
          { accountId: 'M1', amountPence: 1800 },
          { accountId: 'M2', amountPence: 900 },
        ],
      }],
      accruals: [], platformFeeBps: FEE,
    })
    expect(plan.chargeBackReadIds).toEqual(['R'])
    // Recipients reversed by their prorated receipt: floor(1800·1000/4000)=450,
    // floor(900·1000/4000)=225.
    expect(plan.ledgerEntries.find((e) => e.accountId === 'M1')!.amountPence).toBe(-450)
    expect(plan.ledgerEntries.find((e) => e.accountId === 'M1')!.trigger).toBe('writer_payout_reversal')
    expect(plan.ledgerEntries.find((e) => e.accountId === 'M2')!.amountPence).toBe(-225)
    // The author W is NEVER reversed, and no earned-side entry fires for pub reads.
    expect(plan.ledgerEntries.find((e) => e.accountId === 'W')).toBeUndefined()
    expect(earnedSideSum(plan.ledgerEntries)).toBe(0)
    expect(writerSideSum(plan.ledgerEntries)).toBe(-675)
  })

  // Control: the SAME read as an individual-writer read DOES reverse to the author.
  it('individual read: reverses to the author (control for the publication gate)', () => {
    const plan = computeChargebackReversal({
      readerId: 'reader', settlementAmountPence: 1000,
      reads: [{ id: 'R', amountPence: 1000, state: 'writer_paid', writerId: 'W' }],
      accruals: [], platformFeeBps: FEE,
    })
    expect(writerSideSum(plan.ledgerEntries)).toBe(-perReadNetPence(1000, FEE))
    expect(earnedSideSum(plan.ledgerEntries)).toBe(-perReadNetPence(1000, FEE))
  })
})
