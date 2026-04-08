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
