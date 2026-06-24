// =============================================================================
// per-read-net — the single definition of a read's writer-side net.
//
// The platform fee is applied PER ROW then floored: a read worth `amount_pence`
// nets `amount_pence − FLOOR(amount_pence * feeBps / 10000)` to the writer. This
// formula was hand-duplicated across ~12 SQL sites in three files (payout.ts,
// publications/revenue.ts, my-account.ts) with no shared definition; Upstream
// Edges Phase 3 introduced two MORE consumers that must agree with those to the
// penny (settlement apportionment freezes each accrual against this net; the
// author carve and the dashboard display subtract accruals from it). If the
// formula drifted between the money paths and the display paths, conservation
// and the author's dashboard would diverge — so it lives here, once.
//
// Per-row-then-floor (not sum-then-floor) is deliberate and matches the existing
// settlement/payout rounding rule: the platform absorbs the dust, so the writer
// keeps a sub-penny per row rather than losing N pennies collapsed into one fee
// (payout.ts runPayoutCycle comment; tests/payout-math.test.ts).
// =============================================================================

/** Writer-side net of a single read, in pence. JS twin of {@link readNetSql}. */
export function perReadNetPence(amountPence: number, platformFeeBps: number): number {
  return amountPence - Math.floor((amountPence * platformFeeBps) / 10000)
}

/**
 * SQL fragment for the per-read net of `amountExpr`, given a bound parameter
 * placeholder (e.g. '$2') carrying the fee bps. Use inside aggregates so the
 * money and display queries share one definition:
 *   `SUM(${readNetSql('r.amount_pence', '$2')})`
 * `amountExpr` and `feeBpsParam` must be trusted (a column ref / a bound
 * placeholder) — never interpolate user input.
 */
export function readNetSql(amountExpr: string, feeBpsParam: string): string {
  return `(${amountExpr} - FLOOR(${amountExpr} * ${feeBpsParam} / 10000))`
}
