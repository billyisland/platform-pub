// =============================================================================
// executeStripeIdempotent — the shared classify-and-signal step of the four
// money sagas (writer / publication-split / tribute transfers, and the
// settlement charge). It owns EXACTLY the hazardous, identical part of every
// Stripe money-moving create:
//
//   1. make the idempotent create call (stable idempotency key supplied by the
//      caller — same key across a crash-resume so Stripe dedupes a resource that
//      did go through);
//   2. classify the failure as TERMINAL (a deterministic rejection that created
//      nothing) vs AMBIGUOUS/transient (the resource may have been created
//      before the response was lost);
//   3. on AMBIGUOUS → re-throw so the resume sweep retries with the SAME key
//      (NEVER roll back on ambiguous — that double-charges / double-pays);
//   4. on TERMINAL → return `{ ok: false, err }` and let the FLOW run its own
//      per-flow terminal cleanup (settlement: drop the pending-guard + flag
//      card_action_required_at; payout: roll back claimed reads/accruals).
//
// It deliberately does NOT own the terminal cleanup or any cross-step control
// flow — that would need a per-flow flag, the banned shape (PAYMENTS ADR §1.1).
// The classifier is passed in and stays NAMED at the call site
// (isTerminalChargeError vs the deliberately narrower isTerminalTransferError —
// that divergence is real, keep it visible). `flowName` is for log context so
// per-flow distinguishability of the ambiguous-retry log does not regress.
//
// Stripe-client-free (the `call` thunk is injected), so it is unit-testable
// without constructing a Stripe client at import — mirrors charge-errors.ts.
// =============================================================================
import logger from "./logger.js";

export type StripeIdempotentOutcome<T> =
  | { ok: true; object: T }
  | { ok: false; err: unknown };

export async function executeStripeIdempotent<T>(
  flowName: string,
  idempotencyKey: string,
  call: () => Promise<T>,
  isTerminal: (err: unknown) => boolean,
): Promise<StripeIdempotentOutcome<T>> {
  try {
    const object = await call();
    return { ok: true, object };
  } catch (err) {
    if (isTerminal(err)) {
      // Deterministic rejection — Stripe created nothing. Signal back; the flow
      // marks its row failed and releases its claims. NO re-throw: this is a
      // handled terminal outcome, not a retry.
      return { ok: false, err };
    }
    // Ambiguous/transient (connection / API / rate-limit / timeout / idempotency
    // replay): the resource MAY have been created before the response was lost.
    // Re-throw the ORIGINAL error (unwrapped — preserves downstream webhook /
    // classifier matching and stack traces) so resumePending* retries with the
    // stable key. Rolling back here would move the money twice.
    logger.warn(
      { flowName, idempotencyKey, err },
      "Stripe idempotent create ambiguous — re-throwing for resume sweep",
    );
    throw err;
  }
}

// Extract a stable failure-reason string from a Stripe error for the row's
// `failure_reason` column — the `err.code ?? err.type ?? fallback` idiom the
// three transfer flows and the settlement charge each repeated verbatim.
export function stripeErrorCode(err: unknown, fallback: string): string {
  if (!err || typeof err !== "object") return fallback;
  return (
    (err as { code?: string }).code ??
    (err as { type?: string }).type ??
    fallback
  );
}
