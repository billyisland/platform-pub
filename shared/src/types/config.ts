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
}
