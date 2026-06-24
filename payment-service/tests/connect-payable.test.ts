import { describe, it, expect } from 'vitest'
import type Stripe from 'stripe'
import { isConnectPayable } from '../src/lib/connect-payable.js'

// ---------------------------------------------------------------------------
// isConnectPayable — the single gate that flips stripe_connect_kyc_complete,
// shared by the account.updated webhook and the reconcileConnectKyc sweep.
//
// The regression this pins: a writer only ever RECEIVES via transfers.create
// (separate charges & transfers), so payability must key on the `transfers`
// capability + payouts_enabled and IGNORE `charges_enabled`. The old gate
// (`charges_enabled && payouts_enabled`) silently stranded any writer whose
// `card_payments` capability lagged `transfers` — the two are independent
// capabilities with independent requirements and can diverge.
// ---------------------------------------------------------------------------

/** Minimal Account shaped just enough for the gate; everything else irrelevant. */
function account(over: {
  transfers?: Stripe.Account.Capabilities.Transfers
  payouts_enabled?: boolean
  charges_enabled?: boolean
  capabilities?: Stripe.Account['capabilities']
}): Stripe.Account {
  const { transfers, payouts_enabled = false, charges_enabled = false } = over
  return {
    charges_enabled,
    payouts_enabled,
    capabilities:
      'capabilities' in over
        ? over.capabilities
        : transfers
          ? ({ transfers } as Stripe.Account['capabilities'])
          : ({} as Stripe.Account['capabilities']),
  } as Stripe.Account
}

describe('isConnectPayable', () => {
  it('THE REGRESSION: transfers active + payouts enabled is payable even when charges are DISABLED', () => {
    // card_payments lagging transfers — the exact divergence the old gate dropped.
    expect(
      isConnectPayable(
        account({ transfers: 'active', payouts_enabled: true, charges_enabled: false }),
      ),
    ).toBe(true)
  })

  it('transfers active + payouts enabled + charges enabled is payable', () => {
    expect(
      isConnectPayable(
        account({ transfers: 'active', payouts_enabled: true, charges_enabled: true }),
      ),
    ).toBe(true)
  })

  it('charges enabled is NOT sufficient — transfers inactive blocks payability', () => {
    // The inverse divergence: never pay an account whose transfers capability
    // is not active, regardless of charges_enabled.
    expect(
      isConnectPayable(
        account({ transfers: 'inactive', payouts_enabled: true, charges_enabled: true }),
      ),
    ).toBe(false)
    expect(
      isConnectPayable(
        account({ transfers: 'pending', payouts_enabled: true, charges_enabled: true }),
      ),
    ).toBe(false)
  })

  it('payouts not enabled blocks payability even with transfers active', () => {
    expect(
      isConnectPayable(
        account({ transfers: 'active', payouts_enabled: false, charges_enabled: true }),
      ),
    ).toBe(false)
  })

  it('missing transfers capability is not payable', () => {
    expect(isConnectPayable(account({ payouts_enabled: true }))).toBe(false)
  })

  it('undefined capabilities object does not throw and is not payable', () => {
    expect(
      isConnectPayable(account({ capabilities: undefined, payouts_enabled: true })),
    ).toBe(false)
  })
})
