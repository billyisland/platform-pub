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
 * Card brands whose charges the allocated-funds beta will accept — MEASURED,
 * never taken from a documentation list.
 *
 * Established 2026-08-01 against the segregation sandbox by
 * `scripts/segregation-probes.ts --brands --repeat 5`: ten test tokens, each
 * charged three ways (classic API version / preview version alone / preview
 * version plus `allocated_funds[enabled]=true`), with the beta+param cell
 * repeated five times and a Visa positive control in the same window. Fifty
 * samples, no mixed results.
 *
 *   ELIGIBLE 5/5   visa, visa_debit, amex, discover, diners
 *   INELIGIBLE 0/5 mastercard, mastercard_debit, mastercard_prepaid, jcb, unionpay
 *
 * TWO THINGS THAT LIST OVERTURNS, both of which had been asserted in comments
 * here and in `settlement.ts`:
 *
 *   • MASTERCARD IS NOT ELIGIBLE. All three Mastercard variants returned 0/5, so
 *     it is the network and not a quirk of one test card. Roughly a third of UK
 *     card volume therefore cannot be segregated, which is a fact about what
 *     flipping the flag actually buys and a direct input to
 *     `allocated_residual_alert_bps` (§3.3d) — the structural residual floor is
 *     not a small credit-funded rump. Whether this is permanent or merely
 *     not-yet-enabled on the sandbox is a QUESTION FOR STRIPE and a flip gate;
 *     do not treat this constant as settled until they answer.
 *   • DINERS IS eligible, though no brand list names it — because Diners Club
 *     routes over the Discover network. Eligibility follows the NETWORK, not the
 *     `brand` string Stripe reports, which is exactly why this must be measured.
 *
 * DEFAULT-DENY. A brand absent from this set — unknown, unmeasured, or simply
 * null because the payment method could not be read — gets NO allocation. That
 * is the safe direction: the charge succeeds unallocated, `syncAllocations`
 * stamps 0, and its earnings route to the residual (money right, segregation
 * coverage poorer). Wrongly INCLUDING a brand is the unsafe direction, and it is
 * the bug this constant exists to prevent — see `allocatedFundsParam`.
 */
export const ALLOCATION_ELIGIBLE_CARD_BRANDS: ReadonlySet<string> = new Set([
  'visa',
  'amex',
  'discover',
  'diners',
])

/**
 * The `allocated_funds` param on paymentIntents.create. Preview-only, so absent
 * from the pinned types. Returns an empty object when the flag is off, which is
 * what makes the spread at the call site a no-op rather than a branch.
 *
 * Wire form is `allocated_funds[enabled]=true`.
 *
 * IT ALSO RETURNS {} FOR AN INELIGIBLE CARD BRAND, and that is not an
 * optimisation — it is what stops a permanent, silent, per-reader wedge.
 * Measured 2026-08-01: asking for allocation on an ineligible brand does not
 * yield "a charge with no allocated funds", as this file and `settlement.ts`
 * both used to claim. It fails the create outright with a Stripe **500**
 * (`StripeAPIError`, no code, `stripe-should-retry: false`, "An unknown error
 * occurred"). And a 500 is correctly classified AMBIGUOUS by
 * `isTerminalChargeError` — a 500 may mean the PaymentIntent was created, so
 * rolling back would risk a double charge — which means:
 *
 *   the settlement row stays `pending` with no PI id
 *     → `resumePendingSettlements` retries it every reconcile cycle, and 500s again
 *     → `sweepDueSettlements` skips that tab forever (its `NOT EXISTS pending` guard)
 *     → `card_action_required_at` is NEVER set, because ambiguous is deliberately
 *       not the terminal path, so the reader is never prompted to change card
 *     → their reads stay `accrued`, never settle, and the writer never earns.
 *
 * Silent and permanent, from the moment the flag goes live, for any reader on a
 * Mastercard. The ambiguous classification is RIGHT and must not be weakened to
 * paper over this; the fix is to stop asking for something the brand cannot
 * give. Which restores exactly what `settlement.ts`'s own comment always
 * intended: never refuse the reader's card, simply never ASSUME allocation.
 *
 * `brand` is `payment_method_details.card.brand` / `card.brand` — lower-case in
 * Stripe's own responses, but normalised here so a caller reading it from a
 * differently-cased source cannot silently fall through to default-deny.
 */
export function allocatedFundsParam(brand: string | null): Record<string, unknown> {
  if (!allocatedFundsEnabled()) return {}
  if (!brand || !ALLOCATION_ELIGIBLE_CARD_BRANDS.has(brand.trim().toLowerCase())) return {}
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
