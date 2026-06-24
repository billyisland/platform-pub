import type Stripe from 'stripe'

// =============================================================================
// isConnectPayable — the single definition of "this writer can receive money".
//
// Used by BOTH the account.updated webhook (routes/webhook.ts) and the KYC
// reconciliation sweep (services/payout.ts::reconcileConnectKyc). Keep it the
// one gate so the two paths cannot silently diverge — divergence is the exact
// bug class this exists to prevent.
//
// We gate on the `transfers` capability being active + payouts enabled, and
// deliberately do NOT require `charges_enabled`. Writers only ever RECEIVE via
// transfers.create (separate charges & transfers — readers are charged on the
// platform account, never on the writer's), so `card_payments`/`charges_enabled`
// is an unused capability here. `card_payments` and `transfers` are separate
// capabilities with separate requirements hashes and can diverge; coupling
// payability to the unused one strands any writer whose card_payments lags
// transfers, and would break outright under a transfers-only onboarding shape.
// =============================================================================
export function isConnectPayable(account: Stripe.Account): boolean {
  return (
    account.capabilities?.transfers === 'active' &&
    Boolean(account.payouts_enabled)
  )
}
