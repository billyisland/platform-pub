import { describe, it, expect } from 'vitest'
import { voteCostPence } from '../src/lib/voting.js'

describe('voteCostPence', () => {
  describe('upvotes', () => {
    it('1st upvote is free', () => {
      expect(voteCostPence('up', 1)).toBe(0)
    })

    it('2nd upvote costs 10p', () => {
      expect(voteCostPence('up', 2)).toBe(10)
    })

    it('3rd upvote costs 20p', () => {
      expect(voteCostPence('up', 3)).toBe(20)
    })

    it('4th upvote costs 40p', () => {
      expect(voteCostPence('up', 4)).toBe(40)
    })

    it('5th upvote costs 80p', () => {
      expect(voteCostPence('up', 5)).toBe(80)
    })

    it('follows 10 * 2^(n-2) formula for n >= 2', () => {
      for (let n = 2; n <= 10; n++) {
        expect(voteCostPence('up', n)).toBe(Math.round(10 * Math.pow(2, n - 2)))
      }
    })

    it('handles large sequence numbers without overflow', () => {
      const cost = voteCostPence('up', 20)
      expect(cost).toBeGreaterThan(0)
      expect(Number.isFinite(cost)).toBe(true)
    })
  })

  describe('downvotes', () => {
    it('1st downvote costs 10p', () => {
      expect(voteCostPence('down', 1)).toBe(10)
    })

    it('2nd downvote costs 20p', () => {
      expect(voteCostPence('down', 2)).toBe(20)
    })

    it('3rd downvote costs 40p', () => {
      expect(voteCostPence('down', 3)).toBe(40)
    })

    it('follows 10 * 2^(n-1) formula', () => {
      for (let n = 1; n <= 10; n++) {
        expect(voteCostPence('down', n)).toBe(Math.round(10 * Math.pow(2, n - 1)))
      }
    })
  })

  describe('upvote vs downvote pricing', () => {
    it('downvote at sequence n costs the same as upvote at sequence n+1', () => {
      for (let n = 1; n <= 8; n++) {
        expect(voteCostPence('down', n)).toBe(voteCostPence('up', n + 1))
      }
    })
  })
})
