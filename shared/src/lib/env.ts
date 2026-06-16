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
