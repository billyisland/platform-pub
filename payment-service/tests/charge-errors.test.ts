import { describe, it, expect } from "vitest";
import {
  isTerminalChargeError,
  isTerminalTransferError,
  isIdempotencyConflict,
} from "../src/lib/charge-errors.js";

// =============================================================================
// isTerminalChargeError — the decision that decides whether completeSettlement
// marks a settlement 'failed' (releasing the pending-guard, unfreezing the tab)
// or re-throws to retry. Getting this wrong either freezes the tab forever
// (transient mis-classified as nothing) or abandons a charge that may have
// succeeded (transient mis-classified as terminal). STRIPE audit S1.
// =============================================================================

describe("isTerminalChargeError — terminal (mark failed, unfreeze)", () => {
  it("treats a card decline as terminal", () => {
    expect(
      isTerminalChargeError({ type: "StripeCardError", code: "card_declined" }),
    ).toBe(true);
  });

  it("treats an SCA authentication_required as terminal", () => {
    expect(
      isTerminalChargeError({
        type: "StripeCardError",
        code: "authentication_required",
        payment_intent: { id: "pi_123" },
      }),
    ).toBe(true);
  });

  it("treats an unusable/detached payment method as terminal", () => {
    expect(
      isTerminalChargeError({
        type: "StripeInvalidRequestError",
        code: "payment_method_unactivated",
      }),
    ).toBe(true);
  });
});

describe("isTerminalChargeError — transient / non-charge (re-throw, retry)", () => {
  it("treats a connection error as transient", () => {
    expect(isTerminalChargeError({ type: "StripeConnectionError" })).toBe(false);
  });

  it("treats an API error as transient", () => {
    expect(isTerminalChargeError({ type: "StripeAPIError" })).toBe(false);
  });

  it("treats a rate-limit error as transient", () => {
    expect(isTerminalChargeError({ type: "StripeRateLimitError" })).toBe(false);
  });

  it("treats an idempotency error as transient (code bug, not a decline)", () => {
    expect(isTerminalChargeError({ type: "StripeIdempotencyError" })).toBe(
      false,
    );
  });

  it("treats an auth error (bad API key) as transient", () => {
    expect(isTerminalChargeError({ type: "StripeAuthenticationError" })).toBe(
      false,
    );
  });
});

describe("isTerminalChargeError — defensive on odd shapes", () => {
  it("is false for null / undefined", () => {
    expect(isTerminalChargeError(null)).toBe(false);
    expect(isTerminalChargeError(undefined)).toBe(false);
  });

  it("is false for a plain Error with no Stripe type", () => {
    expect(isTerminalChargeError(new Error("boom"))).toBe(false);
  });

  it("is false for a string / number", () => {
    expect(isTerminalChargeError("StripeCardError")).toBe(false);
    expect(isTerminalChargeError(42)).toBe(false);
  });
});

// =============================================================================
// isTerminalTransferError — narrower than the charge variant because the
// failure mode on transfers.create is DOUBLE-PAY: only a deterministic
// StripeInvalidRequestError (no transfer created) is safe to roll back; every
// ambiguous error must re-throw so resume retries with the stable key.
// STRIPE audit S1 follow-on (writer + tribute payout orphans).
// =============================================================================

describe("isTerminalTransferError — terminal (mark failed, release for re-pay)", () => {
  it("treats a revoked-capability invalid request as terminal", () => {
    expect(
      isTerminalTransferError({
        type: "StripeInvalidRequestError",
        code: "account_capabilities_disabled",
      }),
    ).toBe(true);
  });

  it("treats an insufficient-balance invalid request as terminal (no transfer created)", () => {
    expect(
      isTerminalTransferError({
        type: "StripeInvalidRequestError",
        code: "balance_insufficient",
      }),
    ).toBe(true);
  });
});

describe("isTerminalTransferError — ambiguous / transient (re-throw, NEVER roll back)", () => {
  it("is NOT terminal for a connection error (transfer may have been created)", () => {
    expect(isTerminalTransferError({ type: "StripeConnectionError" })).toBe(
      false,
    );
  });

  it("is NOT terminal for an API error", () => {
    expect(isTerminalTransferError({ type: "StripeAPIError" })).toBe(false);
  });

  it("is NOT terminal for a rate-limit error", () => {
    expect(isTerminalTransferError({ type: "StripeRateLimitError" })).toBe(
      false,
    );
  });

  it("is NOT terminal for an idempotency error", () => {
    expect(isTerminalTransferError({ type: "StripeIdempotencyError" })).toBe(
      false,
    );
  });

  it("is NOT terminal for a card error (does not apply to transfers)", () => {
    expect(isTerminalTransferError({ type: "StripeCardError" })).toBe(false);
  });

  it("is false for null / plain Error / primitives", () => {
    expect(isTerminalTransferError(null)).toBe(false);
    expect(isTerminalTransferError(new Error("boom"))).toBe(false);
    expect(isTerminalTransferError("StripeInvalidRequestError")).toBe(false);
  });
});

describe("isIdempotencyConflict — the one ambiguous error a retry can never clear (§0o.1)", () => {
  it("matches a StripeIdempotencyError", () => {
    expect(
      isIdempotencyConflict({
        type: "StripeIdempotencyError",
        rawType: "idempotency_error",
      }),
    ).toBe(true);
  });

  it("stays AMBIGUOUS to both terminal classifiers (recovery, never rollback)", () => {
    const err = { type: "StripeIdempotencyError" };
    expect(isTerminalChargeError(err)).toBe(false);
    expect(isTerminalTransferError(err)).toBe(false);
  });

  it("does not match other ambiguous types, terminal types, or junk", () => {
    expect(isIdempotencyConflict({ type: "StripeConnectionError" })).toBe(false);
    expect(isIdempotencyConflict({ type: "StripeCardError" })).toBe(false);
    expect(isIdempotencyConflict(null)).toBe(false);
    expect(isIdempotencyConflict(new Error("boom"))).toBe(false);
    expect(isIdempotencyConflict("StripeIdempotencyError")).toBe(false);
  });
});
