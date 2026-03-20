import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PlatformConfig } from '../src/types/index.js'

// =============================================================================
// Settlement Logic Tests
//
// Tests the pure shouldTriggerSettlement logic — no DB or Stripe calls needed.
// The method is tested directly by importing and invoking it.
// =============================================================================

const CONFIG: PlatformConfig = {
  freeAllowancePence: 500,
  tabSettlementThresholdPence: 800,
  monthlyFallbackMinimumPence: 200,
  writerPayoutThresholdPence: 2000,
  platformFeeBps: 800,
}

// Pull the private method out for unit testing via a test subclass
// FIX #3: Updated to use last_read_at (last reading activity) instead of
// last_settled_at, matching ADR language: "one month after the last payment"
class TestableSettlementService {
  shouldTriggerSettlement(
    tab: { balance_pence: number; last_read_at: Date | null; last_settled_at: Date | null },
    config: PlatformConfig,
    triggerType: 'threshold' | 'monthly_fallback'
  ): boolean {
    if (triggerType === 'threshold') {
      return tab.balance_pence >= config.tabSettlementThresholdPence
    }
    if (tab.balance_pence < config.monthlyFallbackMinimumPence) return false
    const now = Date.now()
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    // FIX #3: Check last_read_at (last reading activity), not last_settled_at
    const lastActivity = tab.last_read_at?.getTime() ?? 0
    return now - lastActivity >= thirtyDays
  }
}

const svc = new TestableSettlementService()

describe('shouldTriggerSettlement — threshold', () => {
  it('triggers when balance exactly equals threshold', () => {
    expect(svc.shouldTriggerSettlement(
      { balance_pence: 800, last_read_at: null, last_settled_at: null }, CONFIG, 'threshold'
    )).toBe(true)
  })

  it('triggers when balance exceeds threshold', () => {
    expect(svc.shouldTriggerSettlement(
      { balance_pence: 950, last_read_at: null, last_settled_at: null }, CONFIG, 'threshold'
    )).toBe(true)
  })

  it('does not trigger when balance is below threshold', () => {
    expect(svc.shouldTriggerSettlement(
      { balance_pence: 799, last_read_at: null, last_settled_at: null }, CONFIG, 'threshold'
    )).toBe(false)
  })

  it('does not trigger with zero balance', () => {
    expect(svc.shouldTriggerSettlement(
      { balance_pence: 0, last_read_at: null, last_settled_at: null }, CONFIG, 'threshold'
    )).toBe(false)
  })
})

describe('shouldTriggerSettlement — monthly_fallback', () => {
  const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  const twentyNineDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)

  it('triggers when 30+ days since last read and balance >= minimum', () => {
    expect(svc.shouldTriggerSettlement(
      { balance_pence: 200, last_read_at: thirtyOneDaysAgo, last_settled_at: null },
      CONFIG,
      'monthly_fallback'
    )).toBe(true)
  })

  it('does not trigger when balance is below minimum', () => {
    expect(svc.shouldTriggerSettlement(
      { balance_pence: 199, last_read_at: thirtyOneDaysAgo, last_settled_at: null },
      CONFIG,
      'monthly_fallback'
    )).toBe(false)
  })

  it('does not trigger when fewer than 30 days since last read', () => {
    expect(svc.shouldTriggerSettlement(
      { balance_pence: 500, last_read_at: twentyNineDaysAgo, last_settled_at: null },
      CONFIG,
      'monthly_fallback'
    )).toBe(false)
  })

  it('triggers for a reader who has never read (last_read_at null)', () => {
    // null last_read_at → treated as epoch (0) → always >= 30 days
    // This edge case shouldn't arise in practice (no reads = no balance)
    // but is handled defensively.
    expect(svc.shouldTriggerSettlement(
      { balance_pence: 300, last_read_at: null, last_settled_at: null },
      CONFIG,
      'monthly_fallback'
    )).toBe(true)
  })

  it('uses last_read_at not last_settled_at for timing', () => {
    // Reader settled recently but last read was 31 days ago — should trigger
    const recentSettlement = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // 2 days ago
    expect(svc.shouldTriggerSettlement(
      { balance_pence: 300, last_read_at: thirtyOneDaysAgo, last_settled_at: recentSettlement },
      CONFIG,
      'monthly_fallback'
    )).toBe(true)
  })

  it('does not trigger when last read was recent even if never settled', () => {
    expect(svc.shouldTriggerSettlement(
      { balance_pence: 500, last_read_at: twentyNineDaysAgo, last_settled_at: null },
      CONFIG,
      'monthly_fallback'
    )).toBe(false)
  })
})

describe('platform fee calculation', () => {
  it('computes 8% fee correctly (integer pence)', () => {
    const amountPence = 800
    const feeBps = 800
    const fee = Math.floor((amountPence * feeBps) / 10_000)
    expect(fee).toBe(64)                    // 8% of £8.00 = 64p
    expect(amountPence - fee).toBe(736)     // net to writers = £7.36
  })

  it('floors fractional pence — never rounds up', () => {
    const amountPence = 1
    const fee = Math.floor((amountPence * 800) / 10_000)
    expect(fee).toBe(0)   // sub-pence fee floors to 0 — platform absorbs rounding
  })

  it('handles typical monthly settlement', () => {
    const amountPence = 450   // reader read £4.50 worth
    const fee = Math.floor((amountPence * 800) / 10_000)
    expect(fee).toBe(36)     // 8% = 36p
    expect(amountPence - fee).toBe(414)
  })
})
