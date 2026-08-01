import { describe, it, expect, beforeEach, afterEach } from "vitest";

// =============================================================================
// allocatedFundsParam — the brand pre-flight.
//
// WHAT THIS PINS, AND WHY IT IS NOT A FORMALITY. Asking for allocation on a card
// brand the beta will not accept does NOT yield "a charge with no allocated
// funds" (which is what settlement.ts and stripe-client.ts both used to claim).
// Measured 2026-08-01 against the segregation sandbox: the create fails with a
// Stripe 500 — `StripeAPIError`, no code, `stripe-should-retry: false` — and a
// 500 is correctly classified AMBIGUOUS by isTerminalChargeError, because it may
// mean the PaymentIntent WAS created and rolling back would risk a double
// charge. Which means the settlement row stays `pending` with no PI id, the
// resume sweep retries and 500s forever, `sweepDueSettlements` skips that tab
// permanently on its `NOT EXISTS pending` guard, `card_action_required_at` is
// never set (ambiguous is deliberately not the terminal path), the reads stay
// `accrued`, and the writer never earns. Silent, permanent, per-reader.
//
// So `mastercard → {}` is not a nice-to-have; it is the whole fix, and it is the
// assertion to mutate against. Revert the brand check in allocatedFundsParam and
// the Mastercard/JCB/UnionPay cases below go red while everything else stays
// green — which is what makes this file evidence rather than decoration.
//
// THE SET IS MEASURED, NOT DOCUMENTED. `scripts/segregation-probes.ts --brands
// --repeat 5`: ten tokens × three modes, beta+param repeated five times, with a
// Visa positive control in the same window. Fifty samples, no mixed results. Two
// results overturned prior comments in this repo — Mastercard is INELIGIBLE (all
// three variants 0/5, so it is the network and not one test card), and Diners is
// ELIGIBLE despite appearing in no brand list, because it routes over Discover.
// Eligibility follows the NETWORK, not the `brand` string. Re-run the probe
// before editing the set; do not reason it out from Stripe's docs.
// =============================================================================

const FLAG = "STRIPE_ALLOCATED_FUNDS";

/**
 * Imported fresh per test, because `allocatedFundsEnabled()` reads
 * `process.env` at CALL time but the module is cached across tests — a stale
 * import would silently test the wrong branch.
 */
async function load() {
  const mod = await import("../src/lib/stripe-client.js");
  return mod;
}

let original: string | undefined;
beforeEach(() => {
  original = process.env[FLAG];
});
afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

describe("allocatedFundsParam — flag off", () => {
  it("returns {} for an eligible brand, so the spread is a no-op", async () => {
    delete process.env[FLAG];
    const { allocatedFundsParam } = await load();
    expect(allocatedFundsParam("visa")).toEqual({});
  });

  it("returns {} for an ineligible brand too — the flag dominates", async () => {
    delete process.env[FLAG];
    const { allocatedFundsParam } = await load();
    expect(allocatedFundsParam("mastercard")).toEqual({});
  });
});

describe("allocatedFundsParam — flag on, ELIGIBLE brands ask for allocation", () => {
  const eligible = ["visa", "amex", "discover", "diners"];

  for (const brand of eligible) {
    it(`${brand} → allocated_funds[enabled]=true (measured 5/5)`, async () => {
      process.env[FLAG] = "1";
      const { allocatedFundsParam } = await load();
      expect(allocatedFundsParam(brand)).toEqual({
        allocated_funds: { enabled: true },
      });
    });
  }

  it("diners is eligible even though no brand list names it — it routes over Discover", async () => {
    process.env[FLAG] = "1";
    const { allocatedFundsParam } = await load();
    expect(allocatedFundsParam("diners")).toEqual({
      allocated_funds: { enabled: true },
    });
  });
});

describe("allocatedFundsParam — flag on, INELIGIBLE brands must NOT ask", () => {
  // The regression that matters. Each of these returned 0/5 at beta+param while
  // charging perfectly well without it; asking anyway 500s the create and wedges
  // the reader's tab permanently.
  const ineligible = ["mastercard", "jcb", "unionpay"];

  for (const brand of ineligible) {
    it(`${brand} → {} (measured 0/5 — asking would 500 and wedge the tab)`, async () => {
      process.env[FLAG] = "1";
      const { allocatedFundsParam } = await load();
      expect(allocatedFundsParam(brand)).toEqual({});
    });
  }

  it("Mastercard debit and prepaid are ineligible too — it is the NETWORK, not one test card", async () => {
    process.env[FLAG] = "1";
    const { allocatedFundsParam } = await load();
    // Stripe reports all three variants as brand `mastercard`; the probe tested
    // the tokens separately and all three returned 0/5.
    expect(allocatedFundsParam("mastercard")).toEqual({});
  });
});

describe("allocatedFundsParam — default-deny on anything unrecognised", () => {
  // Omitting allocation is the SAFE direction: the charge succeeds, syncAllocations
  // stamps 0, earnings route to the residual — money right, coverage poorer.
  // Wrongly INCLUDING a brand is the direction that wedges readers.
  it("null brand (the payment method could not be expanded) gets no allocation", async () => {
    process.env[FLAG] = "1";
    const { allocatedFundsParam } = await load();
    expect(allocatedFundsParam(null)).toEqual({});
  });

  it("an unknown/unmeasured brand gets no allocation", async () => {
    process.env[FLAG] = "1";
    const { allocatedFundsParam } = await load();
    expect(allocatedFundsParam("cartes_bancaires")).toEqual({});
  });

  it("an empty string gets no allocation", async () => {
    process.env[FLAG] = "1";
    const { allocatedFundsParam } = await load();
    expect(allocatedFundsParam("")).toEqual({});
  });
});

describe("allocatedFundsParam — brand normalisation", () => {
  // Stripe returns lower-case, but a caller reading the brand from a differently
  // cased source must not silently fall through to default-deny: that failure is
  // invisible (the charge still succeeds) and shows up only as a residual that
  // should have been segregated.
  it("upper-case is normalised", async () => {
    process.env[FLAG] = "1";
    const { allocatedFundsParam } = await load();
    expect(allocatedFundsParam("VISA")).toEqual({
      allocated_funds: { enabled: true },
    });
  });

  it("surrounding whitespace is normalised", async () => {
    process.env[FLAG] = "1";
    const { allocatedFundsParam } = await load();
    expect(allocatedFundsParam("  Amex  ")).toEqual({
      allocated_funds: { enabled: true },
    });
  });

  it("but normalisation does not rescue an ineligible brand", async () => {
    process.env[FLAG] = "1";
    const { allocatedFundsParam } = await load();
    expect(allocatedFundsParam("  MASTERCARD ")).toEqual({});
  });
});

describe("ALLOCATION_ELIGIBLE_CARD_BRANDS — the measured set itself", () => {
  it("holds exactly the four brands the probe measured at 5/5", async () => {
    const { ALLOCATION_ELIGIBLE_CARD_BRANDS } = await load();
    expect([...ALLOCATION_ELIGIBLE_CARD_BRANDS].sort()).toEqual([
      "amex",
      "diners",
      "discover",
      "visa",
    ]);
  });

  it("does NOT contain mastercard — the single most consequential entry", async () => {
    const { ALLOCATION_ELIGIBLE_CARD_BRANDS } = await load();
    expect(ALLOCATION_ELIGIBLE_CARD_BRANDS.has("mastercard")).toBe(false);
  });
});
