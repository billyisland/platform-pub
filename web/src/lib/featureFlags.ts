// =============================================================================
// Client feature flags
//
// NEXT_PUBLIC_* env vars are inlined at build time, so these read as plain
// constants in the bundle. Each gates a subsystem that has been *parked*
// (architecture-audit 2026-06-15, items 7 & 8) — defaulting OFF so the
// subsystem ships dark until an operator flips it on. Server counterparts live
// in shared/src/lib/env.ts (trustSystemEnabled) and the per-service env.
// =============================================================================

// Trust graph (Layer 1/2/4) — item 7. When off the trust pip degrades to a
// neutral dot, the PipPanel trust sections hide (VolumeBar, a non-trust
// per-feed control, stays), and the Network "vouches" tab is dropped.
export function trustEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TRUST_ENABLED === "1";
}

// Reader-telemetry beacon (traffology) — item 8. When off the article page
// stops loading the beacon script + meta, so readers' browsers don't POST to
// the parked /ingest/* endpoint.
export function traffologyEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TRAFFOLOGY_ENABLED === "1";
}

// Pledge drives (commissioning + pledging) — parked 2026-07-13. When off, every
// pledge/commission entry point hides: the DM "Commission" button, the dashboard
// "New pledge drive"/drive/commission cards (subscription offers in the same tab
// stay), the profile ProfileDriveCard, and the Ledger "my pledges" list. The
// gateway /drives routes 403 in lockstep. Server counterpart: PLEDGES_ENABLED
// (shared/src/lib/env.ts). Revive by setting both to "1".
export function pledgesEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PLEDGES_ENABLED === "1";
}
