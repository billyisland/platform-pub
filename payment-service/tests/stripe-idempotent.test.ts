import { describe, it, expect, vi } from "vitest";
import {
  executeStripeIdempotent,
  stripeErrorCode,
} from "../src/lib/stripe-idempotent.js";
import {
  isTerminalChargeError,
  isTerminalTransferError,
} from "../src/lib/charge-errors.js";

// =============================================================================
// executeStripeIdempotent — the shared classify-and-signal saga step. Its whole
// job is to draw the terminal-vs-ambiguous line correctly and NEVER swallow an
// ambiguous error (which would let the flow roll back → double-pay). These tests
// pin exactly that contract against the two real named classifiers.
// =============================================================================

const terminalTransfer = { type: "StripeInvalidRequestError", code: "x" };
const ambiguousTransfer = { type: "StripeConnectionError" };
const terminalCharge = { type: "StripeCardError", code: "card_declined" };
const ambiguousCharge = { type: "StripeAPIError" };

describe("executeStripeIdempotent — success", () => {
  it("returns { ok: true, object } when the create resolves", async () => {
    const res = await executeStripeIdempotent(
      "writer-payout",
      "payout-1",
      async () => ({ id: "tr_123" }),
      isTerminalTransferError,
    );
    expect(res).toEqual({ ok: true, object: { id: "tr_123" } });
  });

  it("invokes the call exactly once and does not retry on success", async () => {
    const call = vi.fn(async () => ({ id: "pi_1" }));
    await executeStripeIdempotent("settlement", "s-1", call, isTerminalChargeError);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("executeStripeIdempotent — terminal (signal back, no throw)", () => {
  it("returns { ok: false, err } on a terminal transfer error", async () => {
    const res = await executeStripeIdempotent(
      "writer-payout",
      "payout-1",
      async () => {
        throw terminalTransfer;
      },
      isTerminalTransferError,
    );
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ ok: false, err: terminalTransfer });
  });

  it("returns { ok: false, err } on a terminal charge error (card declined)", async () => {
    const res = await executeStripeIdempotent(
      "settlement",
      "settlement-1",
      async () => {
        throw terminalCharge;
      },
      isTerminalChargeError,
    );
    expect(res).toMatchObject({ ok: false, err: terminalCharge });
  });
});

describe("executeStripeIdempotent — ambiguous (re-throw, NEVER swallow)", () => {
  it("re-throws the ORIGINAL ambiguous transfer error", async () => {
    await expect(
      executeStripeIdempotent(
        "tribute-payout",
        "tribute-payout-1",
        async () => {
          throw ambiguousTransfer;
        },
        isTerminalTransferError,
      ),
    ).rejects.toBe(ambiguousTransfer);
  });

  it("re-throws the ORIGINAL ambiguous charge error", async () => {
    await expect(
      executeStripeIdempotent(
        "settlement",
        "settlement-1",
        async () => {
          throw ambiguousCharge;
        },
        isTerminalChargeError,
      ),
    ).rejects.toBe(ambiguousCharge);
  });

  it("a StripeCardError is AMBIGUOUS for a transfer (narrower classifier) — re-thrown", async () => {
    // The transfer classifier is deliberately narrower: only
    // StripeInvalidRequestError is terminal, because double-pay is worse than
    // double-charge. A card error (which doesn't occur on transfers anyway) must
    // NOT be treated as terminal here.
    await expect(
      executeStripeIdempotent(
        "publication-split",
        "pub-split-1",
        async () => {
          throw { type: "StripeCardError" };
        },
        isTerminalTransferError,
      ),
    ).rejects.toBeDefined();
  });
});

describe("stripeErrorCode", () => {
  it("prefers code, then type, then fallback", () => {
    expect(stripeErrorCode({ code: "insufficient_funds", type: "X" }, "fb")).toBe(
      "insufficient_funds",
    );
    expect(stripeErrorCode({ type: "StripeInvalidRequestError" }, "fb")).toBe(
      "StripeInvalidRequestError",
    );
    expect(stripeErrorCode({}, "transfer_rejected")).toBe("transfer_rejected");
    expect(stripeErrorCode(null, "fb")).toBe("fb");
  });
});
