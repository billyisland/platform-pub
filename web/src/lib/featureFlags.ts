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
