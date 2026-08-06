// =============================================================================
// Environment Variable Validation
//
// Call requireEnv() at service startup to fail fast on missing config.
// =============================================================================

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export function requireEnvMinLength(name: string, minLength: number): string {
  const value = requireEnv(name)
  if (value.length < minLength) {
    throw new Error(
      `Environment variable ${name} must be at least ${minLength} characters (got ${value.length})`
    )
  }
  return value
}

// Trust subsystem master switch (Layer 1/2/4). Default OFF — the trust graph is
// parked (architecture-audit item 7): a display-only subsystem nobody is
// viewing. When off, feed-ingest stops scheduling the trust crons and the web
// UI hides the trust surfaces (the pip degrades to a neutral dot). Tables and
// the LEFT JOINs stay in place and degrade to NULL. Mirrors the
// DISCOVERY_PUBLISH_ENABLED shape; lives in shared so both gateway and
// feed-ingest can read it. Client counterpart: NEXT_PUBLIC_TRUST_ENABLED.
export function trustSystemEnabled(): boolean {
  return process.env.TRUST_SYSTEM_ENABLED === "1"
}

// Tribute authoring (Upstream Edges Phase 2). Default OFF.
//
// THE REASON IS THE PAYMENT PERIMETER — NOT AN INCOMPLETE FEATURE. Do not flip
// this in a flag cleanup. Redirecting a slice of one Writer's earnings to third
// parties who have no relationship with the paying Reader is the clearest
// money-remittance shape in the tree (Harper James ¶3.32–3.35), and under the
// Platform stance it does not ship without its own advice. Specs:
// `docs/adr/PAYMENT-PERIMETER-ADR.md` W6 · `UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md`.
//
// (This comment previously gave the pre-Phase-3 settlement-apportionment
// question as the reason — a gate that resolved in June 2026. Rewritten
// 2026-08-06: a stale reason on a live brake is how a brake gets released.)
//
// When off, the tribute routes 404 and the lifecycle sweep is not scheduled; the
// credit/citation/dispute edges (Phase 1) are unaffected. Same shape as
// TRUST_SYSTEM_ENABLED. Client counterpart: NEXT_PUBLIC_TRIBUTES_ENABLED.
export function tributesEnabled(): boolean {
  return process.env.TRIBUTES_ENABLED === "1"
}

// Pledge drives (crowdfund + commission) — parked 2026-07-13. Default OFF: the
// whole commissioning/pledging subsystem ships dark while it's out of play. When
// off, every /drives route 403s (create/pledge/accept/decline/…), so no new drive
// or pledge can be created; the fulfilment plumbing (matchDriveForPublish /
// fulfillDrive / drive-expiry) is left in place and simply goes inert — with no
// open drive, the publish-time match is a harmless no-op. Tables, ledger trigger
// type (pledge_fulfil) and the draftId threading are untouched, so flipping this
// back on revives the feature whole. Same shape as TRUST_SYSTEM_ENABLED. Client
// counterpart: NEXT_PUBLIC_PLEDGES_ENABLED.
export function pledgesEnabled(): boolean {
  return process.env.PLEDGES_ENABLED === "1"
}

// Stripe funds segregation / allocated funds (FUNDS-SEGREGATION-INTEGRATION.md).
// Default OFF — the beta is sandbox-only until Stripe enables it on the live
// account, and flipping it changes how every payout transfer is funded. When on:
// settlement PaymentIntents are created with allocated_funds enabled, the
// allocation-sync sweep reads each charge's locked balance back from Stripe, and
// the payout cycles pack their earnings onto charges as N child transfers each
// carrying source_transaction + an explicit application_fee_amount. When off,
// behaviour is byte-identical to today (one aggregate transfer per payout, the
// fee left implicit in the platform balance) and nothing writes the segregation
// tables. Read by payment-service (settlement, payout, webhook clients) and the
// gateway; auth.ts's Stripe client is deliberately NOT on the preview API
// version — it drives Connect onboarding and reader card setup, neither of which
// carries allocation, and a preview version moving under those paths locks
// writers out of onboarding or readers out of attaching a card. Same shape as
// TRUST_SYSTEM_ENABLED. No web twin — this is entirely server-side.
export function allocatedFundsEnabled(): boolean {
  return process.env.STRIPE_ALLOCATED_FUNDS === "1"
}

// The preview API version the allocated-funds beta requires on every Stripe API
// request. Runtime behaviour is governed by this header string, not by the
// stripe-node version (pinned at 2023-10-16 types), so the four call sites cast
// it rather than taking a v14→v18 major on this critical path.
export const ALLOCATED_FUNDS_API_VERSION =
  "2026-06-24.preview; allocated_funds_preview=v1"

// Cross-source identity-link detection (Slice 8 P3). Default OFF — the daily
// detection task writes GLOBAL links that suppress cross-posted duplicates in
// everyone's feed, so it ships dark behind this switch. When off, feed-ingest
// doesn't schedule the detect cron; user-asserted links (P2) are unaffected.
// Same shape as TRUST_SYSTEM_ENABLED. Spec: SLICE-8-IDENTITY-LINKING-PLAN.md §P3.
export function identityLinkDetectEnabled(): boolean {
  return process.env.IDENTITY_LINK_DETECT_ENABLED === "1"
}
