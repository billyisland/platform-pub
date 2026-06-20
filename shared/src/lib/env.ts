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

// Cross-source identity-link detection (Slice 8 P3). Default OFF — the daily
// detection task writes GLOBAL links that suppress cross-posted duplicates in
// everyone's feed, so it ships dark behind this switch. When off, feed-ingest
// doesn't schedule the detect cron; user-asserted links (P2) are unaffected.
// Same shape as TRUST_SYSTEM_ENABLED. Spec: SLICE-8-IDENTITY-LINKING-PLAN.md §P3.
export function identityLinkDetectEnabled(): boolean {
  return process.env.IDENTITY_LINK_DETECT_ENABLED === "1"
}
