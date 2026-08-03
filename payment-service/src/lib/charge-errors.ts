// =============================================================================
// isTerminalChargeError — does this error from paymentIntents.create mean the
// charge will not succeed without the reader acting (decline / SCA / unusable
// payment method), as opposed to a transient infra failure we should retry?
//
//   • StripeCardError           — card_declined / authentication_required /
//                                 expired_card / insufficient_funds … TERMINAL.
//   • StripeInvalidRequestError — for the fixed settlement call shape (off-session
//                                 confirm on the customer's default PM) the only
//                                 causes are an unusable/detached payment method
//                                 or a customer with no default PM. TERMINAL —
//                                 leaving it pending would freeze the tab forever.
//
// Everything else (StripeConnectionError / StripeAPIError / StripeRateLimitError
// / StripeIdempotencyError / StripeAuthenticationError) is transient or a code
// bug — the caller re-throws so resumePendingSettlements retries with the stable
// idempotency key. The charge may yet succeed, so it must NOT be marked failed.
//
// Lives in its own Stripe-free module so it is unit-testable without the service
// constructing a Stripe client at import (mirrors connect-payable.ts). Keyed on
// the SDK-set `err.type` string rather than instanceof so it is robust across
// re-thrown / serialised error shapes.
// =============================================================================
export function isTerminalChargeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const type = (err as { type?: string }).type;
  return type === "StripeCardError" || type === "StripeInvalidRequestError";
}

// =============================================================================
// isTerminalTransferError — does this error from transfers.create mean the
// transfer was DEFINITIVELY not created and never will be for this request
// (e.g. the destination's `transfers` capability was revoked, an invalid
// destination, insufficient platform balance)?
//
// NARROWER than the charge variant on purpose, because the failure mode here is
// DOUBLE-PAY, not double-charge: only StripeInvalidRequestError qualifies — a
// deterministic 400 that Stripe rejects at validation, before creating any
// transfer object. It is then safe to mark the payout failed and release its
// claimed earnings, because the next cycle re-pays under a NEW payout id (a new
// idempotency key → a genuinely new transfer, no dedupe of a phantom one).
//
// StripeCardError does not occur on transfers. EVERYTHING ELSE
// (StripeConnectionError / StripeAPIError / StripeRateLimitError /
// StripeIdempotencyError) is AMBIGUOUS — the transfer may have been created
// before the response was lost — so the caller MUST re-throw and let
// resumePending*Payouts retry with the STABLE idempotency key (which dedupes a
// transfer that did go through). Rolling back on an ambiguous error would send
// the money twice.
// =============================================================================
export function isTerminalTransferError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { type?: string }).type === "StripeInvalidRequestError";
}

// =============================================================================
// isIdempotencyConflict — Stripe recorded a previous request under this key
// with DIFFERENT parameters ("Keys for idempotent requests can only be used
// with the same parameters they were first used with").
//
// Still classified AMBIGUOUS by the two terminal classifiers above — correctly,
// because the first request may have created the resource. But it is the one
// ambiguous error a retry can NEVER clear: the settlement flow rebuilds its
// create payload per attempt (the default card is re-resolved live, and the
// allocation param depends on its brand), so once the payload drifts — a deploy
// changing the create shape, a card swap, a brand-eligibility flip — the
// row-stable key returns this error on every retry forever, the row stays
// 'pending', and the in-flight guard freezes the TAB with it (2026-08-03 audit
// §0o.1; three dev settlements measured wedged this way).
//
// It is also uniquely RESOLVABLE ambiguity: the error is proof a first request
// reached Stripe and was recorded, and every settlement PI carries
// metadata.settlement_id — so the caller can look the resource up instead of
// retrying. Recovery: settlement.ts::recoverIdempotencyConflict.
// =============================================================================
export function isIdempotencyConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { type?: string }).type === "StripeIdempotencyError";
}
