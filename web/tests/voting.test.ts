import { describe, it, expect } from 'vitest'
import { voteCostPence, formatPence } from '../src/lib/voting'

// The client-side voteCostPence must produce identical results to shared/src/lib/voting.ts
describe('voteCostPence', () => {
  it('1st upvote is free', () => {
    expect(voteCostPence('up', 1)).toBe(0)
  })

  it('follows the exponential upvote formula', () => {
    expect(voteCostPence('up', 2)).toBe(10)
    expect(voteCostPence('up', 3)).toBe(20)
    expect(voteCostPence('up', 4)).toBe(40)
    expect(voteCostPence('up', 5)).toBe(80)
  })

  it('follows the exponential downvote formula', () => {
    expect(voteCostPence('down', 1)).toBe(10)
    expect(voteCostPence('down', 2)).toBe(20)
    expect(voteCostPence('down', 3)).toBe(40)
  })

  it('downvote n equals upvote n+1', () => {
    for (let n = 1; n <= 8; n++) {
      expect(voteCostPence('down', n)).toBe(voteCostPence('up', n + 1))
    }
  })
})

describe('formatPence', () => {
  it('formats zero as Free', () => {
    expect(formatPence(0)).toBe('Free')
  })

  it('formats sub-pound amounts with p suffix', () => {
    expect(formatPence(10)).toBe('10p')
    expect(formatPence(50)).toBe('50p')
    expect(formatPence(99)).toBe('99p')
  })

  it('formats exact pound amounts without decimals', () => {
    expect(formatPence(100)).toBe('£1')
    expect(formatPence(500)).toBe('£5')
    expect(formatPence(1000)).toBe('£10')
  })

  it('formats pounds with pence', () => {
    expect(formatPence(150)).toBe('£1.50')
    expect(formatPence(1099)).toBe('£10.99')
    expect(formatPence(250)).toBe('£2.50')
  })
})
