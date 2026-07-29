// =============================================================================
// Shared Platform Config Types
//
// These are the tunable parameters stored in platform_config.
// All monetary values in pence (integers, never floats).
// =============================================================================

export interface PlatformConfig {
  freeAllowancePence: number           // default 500  (£5.00)
  tabSettlementThresholdPence: number  // default 800  (£8.00)
  monthlyFallbackMinimumPence: number  // default 200  (£2.00)
  writerPayoutThresholdPence: number   // default 2000 (£20.00)
  platformFeeBps: number               // default 800  (8.00%)
  monthlyFallbackDays: number          // default 30   (days since last read before monthly settlement)
  // Funds segregation (migration 165) — inert while STRIPE_ALLOCATED_FUNDS is
  // off. See shared/src/db/config-defaults.sql for why each is a dial.
  payoutMaxSlices: number              // default 20   (max child transfers per payout)
  allocatedResidualAlertBps: number    // default 2000 (PLACEHOLDER — re-measure before the live flip)
  allocationSyncFreshnessHours: number // default 24   (allocated_pence staleness before re-read)
}
