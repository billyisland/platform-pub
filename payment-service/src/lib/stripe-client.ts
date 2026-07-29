import Stripe from 'stripe'
import {
  allocatedFundsEnabled,
  ALLOCATED_FUNDS_API_VERSION,
} from '@platform-pub/shared/lib/env.js'

// =============================================================================
// Stripe client construction — the one place the allocated-funds preview API
// version is applied, and the one place the preview-only request params are cast.
//
// Spec: docs/adr/FUNDS-SEGREGATION-INTEGRATION.md §3.1, §7 (closed question 2).
//
// WHY A WRAPPER RATHER THAN A stripe-node UPGRADE. The preview beta needs
//   Stripe-Version: 2026-06-24.preview; allocated_funds_preview=v1
// on every request. The SDK is pinned at 2023-10-16 (stripe@^14), whose
// `apiVersion` is a literal union — that string is the ONLY obstacle, and
// runtime is governed by the header regardless of which types the SDK ships.
// A v14→v18 major across four call sites plus webhook event typing is not on
// this critical path, so the version and the two preview-only param shapes are
// cast HERE, once, behind named helpers — never `as any` scattered at call sites.
//
// WHICH CLIENTS TAKE IT. The three that read or write allocation objects
// (PaymentIntents, Transfers, and the events describing both): settlement.ts,
// payout.ts, webhook.ts. `gateway/src/routes/auth.ts` is deliberately EXCLUDED —
// it constructs Connect onboarding objects (accounts, accountLinks) and reader
// card-setup objects (customers, setupIntents), none of which carries allocation
// or gains anything from the preview version, while a *preview* API version can
// move under us on paths whose breakage locks writers out of onboarding or
// readers out of attaching a card at all. The seam is safe across the version
// split because that client only MINTS Customers and PaymentMethods which the
// preview client later references by id — an API version governs request and
// response shapes, never the objects themselves. If a future change makes
// auth.ts touch a charge or a transfer, it joins the other three.
// =============================================================================

const BASE_API_VERSION = '2023-10-16'

/**
 * Construct a Stripe client for a path that reads or writes allocation objects.
 * Flag off ⇒ byte-identical to the previous `new Stripe(key, { apiVersion })`.
 */
export function createAllocationAwareStripe(): Stripe {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: (allocatedFundsEnabled()
      ? ALLOCATED_FUNDS_API_VERSION
      : BASE_API_VERSION) as Stripe.LatestApiVersion,
  })
}

/**
 * The `allocated_funds` param on paymentIntents.create. Preview-only, so absent
 * from the pinned types. Returns an empty object when the flag is off, which is
 * what makes the spread at the call site a no-op rather than a branch.
 *
 * Wire form is `allocated_funds[enabled]=true`.
 */
export function allocatedFundsParam(): Record<string, unknown> {
  if (!allocatedFundsEnabled()) return {}
  return { allocated_funds: { enabled: true } }
}

/**
 * The two params that make a transfer draw on a charge's segregated balance
 * rather than the platform's ordinary one.
 *
 * `source_transaction` is what does the work: allocated funds can ONLY be
 * transferred with it set to the funding charge's id. `application_fee_amount`
 * is optional in Stripe's own docs but effectively required for us — with
 * allocation the FULL charge is locked, so the platform fee we do not claim as
 * an application fee never leaves allocated state at all (it is not taken twice,
 * it is taken zero times). Passing 0 would be a request for no fee, so a
 * zero-fee unit (the tribute carve, an unpairable subscription earning) omits
 * the param and leaves its fee as dust for the Balance-Transfer sweep.
 *
 * Residual children (`funding = 'platform_balance'`) call this with a null
 * charge and get `{}` — an ordinary transfer with the fee implicit, exactly
 * today's behaviour.
 */
export function allocatedTransferParams(
  stripeChargeId: string | null,
  feePence: number,
): Record<string, unknown> {
  if (!allocatedFundsEnabled() || !stripeChargeId) return {}
  return {
    source_transaction: stripeChargeId,
    ...(feePence > 0 ? { application_fee_amount: feePence } : {}),
  }
}

/**
 * The shape the allocation read-back expects off an expanded charge. Preview-only
 * (`expand[]=latest_charge.allocated_funds.balance`), so typed here rather than
 * inferred from the pinned SDK. A charge that carries no allocation — an
 * ineligible card brand, a pre-flip charge — simply has no `allocated_funds`,
 * which the sweep records as 0 rather than as an error.
 */
export interface AllocatedFundsBalance {
  pending?: number
  available?: number
}

export interface ChargeWithAllocatedFunds {
  id?: string
  allocated_funds?: { balance?: AllocatedFundsBalance } | null
}

/**
 * Total pence Stripe reports locked for a charge: pending + available. Both
 * arms count — pending is allocation whose payment method has not settled yet,
 * and a `source_transaction` transfer QUEUES against that settlement rather than
 * failing for insufficient balance, so it is genuinely drawable.
 */
export function readAllocatedBalance(
  charge: ChargeWithAllocatedFunds | null | undefined,
): number {
  const balance = charge?.allocated_funds?.balance
  if (!balance) return 0
  return (balance.pending ?? 0) + (balance.available ?? 0)
}
