import { describe, it, expect } from 'vitest'
import {
  computePublicationSplits,
  type ArticleShare,
  type StandingMember,
} from '../src/services/payout.js'

describe('computePublicationSplits', () => {
  const feeBps = 800 // 8% platform fee

  describe('platform fee', () => {
    it('computes platform fee as floor(gross * bps / 10000)', () => {
      const result = computePublicationSplits(1000, feeBps, [], new Map(), [])
      expect(result.platformFeePence).toBe(80) // floor(1000 * 800 / 10000)
    })

    it('floors the fee (no rounding up)', () => {
      const result = computePublicationSplits(1001, feeBps, [], new Map(), [])
      expect(result.platformFeePence).toBe(80) // floor(1001 * 800 / 10000) = floor(80.08)
    })

    it('remaining pool is gross minus platform fee', () => {
      const result = computePublicationSplits(1000, feeBps, [], new Map(), [])
      expect(result.remainingPool).toBe(920)
    })
  })

  describe('subscription leg (§1.3)', () => {
    it('sub net joins the pool AFTER the pooled fee — never run through it', () => {
      const result = computePublicationSplits(1000, feeBps, [], new Map(), [], 500)
      // Fee is computed on gross reads only; the sub leg is already net
      // (logSubscriptionCharge floors the fee per charge).
      expect(result.platformFeePence).toBe(80)
      expect(result.remainingPool).toBe(920 + 500)
    })

    it('a subscription-only pool distributes with zero read gross', () => {
      const members: StandingMember[] = [{ accountId: 'acc-1', revenueShareBps: 5000 }]
      const result = computePublicationSplits(0, feeBps, [], new Map(), members, 400)
      expect(result.platformFeePence).toBe(0)
      expect(result.remainingPool).toBe(400)
      expect(result.splits).toHaveLength(1)
      expect(result.splits[0]).toMatchObject({ accountId: 'acc-1', amountPence: 200 })
    })

    it('standing members split the sub-enlarged pool', () => {
      const members: StandingMember[] = [{ accountId: 'acc-1', revenueShareBps: 5000 }]
      const result = computePublicationSplits(1000, feeBps, [], new Map(), members, 500)
      expect(result.splits[0].amountPence).toBe(710) // floor((920 + 500) * 0.5)
    })

    it('flat fees can draw from the sub leg', () => {
      const shares: ArticleShare[] = [{
        id: 'share-1', articleId: 'art-1', accountId: 'acc-1',
        shareType: 'flat_fee_pence', shareValue: 200, paidOut: false,
      }]
      const result = computePublicationSplits(0, feeBps, shares, new Map(), [], 300)
      expect(result.flatFeesPaidPence).toBe(200)
      expect(result.remainingPool).toBe(100)
    })

    it('omitted sub leg defaults to 0 (unchanged legacy behaviour)', () => {
      const withDefault = computePublicationSplits(1000, feeBps, [], new Map(), [])
      const withZero = computePublicationSplits(1000, feeBps, [], new Map(), [], 0)
      expect(withDefault).toEqual(withZero)
    })
  })

  describe('flat fee shares', () => {
    it('deducts flat fee from pool and creates a split', () => {
      const shares: ArticleShare[] = [{
        id: 'share-1', articleId: 'art-1', accountId: 'acc-1',
        shareType: 'flat_fee_pence', shareValue: 200, paidOut: false,
      }]

      const result = computePublicationSplits(1000, feeBps, shares, new Map(), [])
      expect(result.flatFeesPaidPence).toBe(200)
      expect(result.remainingPool).toBe(720) // 920 - 200
      expect(result.splits).toHaveLength(1)
      expect(result.splits[0]).toMatchObject({
        accountId: 'acc-1', amountPence: 200, shareType: 'flat_fee',
      })
    })

    it('skips flat fee if pool is insufficient', () => {
      const shares: ArticleShare[] = [{
        id: 'share-1', articleId: 'art-1', accountId: 'acc-1',
        shareType: 'flat_fee_pence', shareValue: 10000, paidOut: false,
      }]

      const result = computePublicationSplits(1000, feeBps, shares, new Map(), [])
      expect(result.flatFeesPaidPence).toBe(0)
      expect(result.splits).toHaveLength(0)
    })

    it('skips already-paid flat fees', () => {
      const shares: ArticleShare[] = [{
        id: 'share-1', articleId: 'art-1', accountId: 'acc-1',
        shareType: 'flat_fee_pence', shareValue: 200, paidOut: true,
      }]

      const result = computePublicationSplits(1000, feeBps, shares, new Map(), [])
      expect(result.flatFeesPaidPence).toBe(0)
      expect(result.splits).toHaveLength(0)
    })

    it('tracks which flat fee share IDs were paid', () => {
      const shares: ArticleShare[] = [{
        id: 'share-1', articleId: 'art-1', accountId: 'acc-1',
        shareType: 'flat_fee_pence', shareValue: 100, paidOut: false,
      }]

      const result = computePublicationSplits(1000, feeBps, shares, new Map(), [])
      expect(result.flatFeeShareIds).toEqual(['share-1'])
    })
  })

  describe('article revenue shares', () => {
    it('computes per-article revenue share from article net earnings', () => {
      const shares: ArticleShare[] = [{
        id: 'share-1', articleId: 'art-1', accountId: 'acc-1',
        shareType: 'revenue_bps', shareValue: 5000, paidOut: false, // 50%
      }]
      const earnings = new Map([['art-1', 500]]) // 500p net

      const result = computePublicationSplits(1000, feeBps, shares, earnings, [])
      expect(result.splits[0]).toMatchObject({
        accountId: 'acc-1', amountPence: 250, // floor(500 * 5000 / 10000)
        shareType: 'article_revenue', shareBps: 5000,
      })
    })

    // F10: revenue_bps is a fixed share of the article's revenue — overlapping
    // overrides on one article are clamped so their cumulative bps can't exceed
    // 10000 (which would overdraw the article's net and drive the pool negative).
    it('F10: clamps cumulative revenue_bps per article at 10000', () => {
      const shares: ArticleShare[] = [
        { id: 's1', articleId: 'art-1', accountId: 'acc-a', shareType: 'revenue_bps', shareValue: 7000, paidOut: false },
        { id: 's2', articleId: 'art-1', accountId: 'acc-b', shareType: 'revenue_bps', shareValue: 7000, paidOut: false },
      ]
      const earnings = new Map([['art-1', 1000]])
      const result = computePublicationSplits(10000, feeBps, shares, earnings, [])
      const rev = result.splits.filter(s => s.shareType === 'article_revenue')
      // acc-a: floor(1000 * 7000/10000) = 700; acc-b clamped to the remaining
      // 3000 bps: floor(1000 * 3000/10000) = 300. Sum 1000 == the article net,
      // never more.
      expect(rev.find(s => s.accountId === 'acc-a')!.amountPence).toBe(700)
      expect(rev.find(s => s.accountId === 'acc-b')!.amountPence).toBe(300)
      const revTotal = rev.reduce((sum, s) => sum + s.amountPence, 0)
      expect(revTotal).toBe(1000)
    })

    it('skips articles with no earnings', () => {
      const shares: ArticleShare[] = [{
        id: 'share-1', articleId: 'art-1', accountId: 'acc-1',
        shareType: 'revenue_bps', shareValue: 5000, paidOut: false,
      }]
      const earnings = new Map<string, number>() // no earnings

      const result = computePublicationSplits(1000, feeBps, shares, earnings, [])
      expect(result.splits).toHaveLength(0)
    })
  })

  describe('standing member shares', () => {
    it('distributes remaining pool proportionally by bps', () => {
      const members: StandingMember[] = [
        { accountId: 'acc-a', revenueShareBps: 5000 }, // 50%
        { accountId: 'acc-b', revenueShareBps: 5000 }, // 50%
      ]

      const result = computePublicationSplits(1000, feeBps, [], new Map(), members)
      // Pool = 920, each gets floor(920 * 5000 / 10000) = 460
      const standingSplits = result.splits.filter(s => s.shareType === 'standing')
      expect(standingSplits).toHaveLength(2)
      expect(standingSplits[0].amountPence).toBe(460)
      expect(standingSplits[1].amountPence).toBe(460)
    })

    it('handles unequal bps distribution', () => {
      const members: StandingMember[] = [
        { accountId: 'acc-a', revenueShareBps: 7000 }, // 70%
        { accountId: 'acc-b', revenueShareBps: 3000 }, // 30%
      ]

      const result = computePublicationSplits(10000, feeBps, [], new Map(), members)
      // Pool = 9200
      const standingSplits = result.splits.filter(s => s.shareType === 'standing')
      expect(standingSplits[0].amountPence).toBe(6440) // floor(9200 * 7000 / 10000)
      expect(standingSplits[1].amountPence).toBe(2760) // floor(9200 * 3000 / 10000)
    })

    it('F10: clamps cumulative standing bps at 10000 (over-100% set cannot overdraw)', () => {
      // Σ = 14000 — reachable historically or via racing/partial write paths.
      // The clamp clips whoever comes last: 6000 stands, the second member is
      // clipped to 4000, the third gets nothing. Σ payouts ≤ pool always.
      const members: StandingMember[] = [
        { accountId: 'acc-a', revenueShareBps: 6000 },
        { accountId: 'acc-b', revenueShareBps: 6000 },
        { accountId: 'acc-c', revenueShareBps: 2000 },
      ]

      const result = computePublicationSplits(10000, feeBps, [], new Map(), members)
      // Pool = 9200
      const standingSplits = result.splits.filter(s => s.shareType === 'standing')
      expect(standingSplits).toHaveLength(2)
      expect(standingSplits[0]).toMatchObject({ accountId: 'acc-a', amountPence: 5520, shareBps: 6000 })
      expect(standingSplits[1]).toMatchObject({ accountId: 'acc-b', amountPence: 3680, shareBps: 4000 })
      const total = standingSplits.reduce((s, x) => s + x.amountPence, 0)
      expect(total).toBeLessThanOrEqual(9200)
    })

    it('distributes nothing when remaining pool is 0', () => {
      const shares: ArticleShare[] = [{
        id: 'share-1', articleId: 'art-1', accountId: 'acc-1',
        shareType: 'flat_fee_pence', shareValue: 920, paidOut: false,
      }]
      const members: StandingMember[] = [
        { accountId: 'acc-a', revenueShareBps: 5000 },
      ]

      const result = computePublicationSplits(1000, feeBps, shares, new Map(), members)
      const standingSplits = result.splits.filter(s => s.shareType === 'standing')
      expect(standingSplits).toHaveLength(0)
    })

    it('handles no standing members gracefully', () => {
      const result = computePublicationSplits(1000, feeBps, [], new Map(), [])
      expect(result.splits).toHaveLength(0)
    })

    // F10: fixed share of revenue — a member's bps is a share of the FIXED 10000
    // base, not a normalized weight over the standing total. A partial standing
    // set leaves the platform the unallocated remainder.
    it('F10: a partial standing set leaves the platform a remainder (no renormalisation)', () => {
      const members: StandingMember[] = [
        { accountId: 'acc-a', revenueShareBps: 1000 }, // 10% — the ONLY member
      ]
      const result = computePublicationSplits(1000, feeBps, [], new Map(), members)
      const standingSplits = result.splits.filter(s => s.shareType === 'standing')
      // Pool = 920 → floor(920 * 1000 / 10000) = 92 (NOT the whole 920).
      expect(standingSplits).toHaveLength(1)
      expect(standingSplits[0].amountPence).toBe(92)
    })

    it('F10: a sole 1-bps member gets ~0, not 100% (the renormalisation bug is gone)', () => {
      const members: StandingMember[] = [
        { accountId: 'acc-a', revenueShareBps: 1 },
      ]
      const result = computePublicationSplits(1000, feeBps, [], new Map(), members)
      // floor(920 * 1 / 10000) = 0 → no split emitted (payout <= 0 skipped).
      expect(result.splits.filter(s => s.shareType === 'standing')).toHaveLength(0)
    })
  })

  describe('combined flow', () => {
    it('applies flat fee, then article shares, then standing shares in order', () => {
      const articleShares: ArticleShare[] = [
        {
          id: 'flat-1', articleId: 'art-1', accountId: 'freelancer',
          shareType: 'flat_fee_pence', shareValue: 100, paidOut: false,
        },
        {
          id: 'rev-1', articleId: 'art-2', accountId: 'contributor',
          shareType: 'revenue_bps', shareValue: 2000, paidOut: false, // 20%
        },
      ]
      const earnings = new Map([['art-2', 400]])
      const members: StandingMember[] = [
        { accountId: 'editor', revenueShareBps: 10000 }, // 100% of remainder
      ]

      // Gross: 1000, fee: 80, pool: 920
      // Flat fee: -100, pool: 820
      // Article rev: floor(400 * 2000 / 10000) = 80, pool: 740
      // Standing: floor(740 * 10000 / 10000) = 740
      const result = computePublicationSplits(1000, feeBps, articleShares, earnings, members)

      expect(result.platformFeePence).toBe(80)
      expect(result.flatFeesPaidPence).toBe(100)
      expect(result.splits).toHaveLength(3)
      expect(result.splits[0]).toMatchObject({ accountId: 'freelancer', amountPence: 100, shareType: 'flat_fee' })
      expect(result.splits[1]).toMatchObject({ accountId: 'contributor', amountPence: 80, shareType: 'article_revenue' })
      expect(result.splits[2]).toMatchObject({ accountId: 'editor', amountPence: 740, shareType: 'standing' })
    })

    it('uses floor everywhere — platform absorbs rounding dust', () => {
      const members: StandingMember[] = [
        { accountId: 'acc-a', revenueShareBps: 3333 },
        { accountId: 'acc-b', revenueShareBps: 3333 },
        { accountId: 'acc-c', revenueShareBps: 3334 },
      ]

      const result = computePublicationSplits(1000, feeBps, [], new Map(), members)
      // Pool = 920, total bps = 10000
      // acc-a: floor(920 * 3333 / 10000) = floor(306.636) = 306
      // acc-b: floor(920 * 3333 / 10000) = 306
      // acc-c: floor(920 * 3334 / 10000) = floor(306.728) = 306
      // Total distributed: 918, dust: 2p absorbed by platform
      const total = result.splits.reduce((sum, s) => sum + s.amountPence, 0)
      expect(total).toBe(918)
      expect(total).toBeLessThanOrEqual(920) // Never exceeds pool
    })
  })
})
