#!/usr/bin/env bash
#
# check-ledger-adjacency.sh — tripwire for the unified-ledger dual-write rule.
#
# The rule (Architecture-audit 2026-06-15 item 3, keystone; docs/adr/
# ARCHITECTURE-AUDIT-IMPLEMENTATION-PLAN-2026-06-15.md › Item 3 › Risk): every
# money MOVEMENT must emit a ledger_entries row inside the same transaction as
# the table write that records it. A path that writes its money table but forgets
# the ledger entry silently UNDER-REPORTS — the exact failure the ledger exists
# to abolish. This is the CI grep the plan names to mitigate it.
#
# The two funnels (both in shared/src/lib/ledger.ts):
#   • recordLedger(...)       — inserts a ledger_entries row ONLY. Used by the
#                               payout-side sagas (which mutate no running-balance
#                               column) and for extra non-tab ledger legs.
#   • applyLedgerDelta(...)   — the TAB primitive (PAYMENTS ADR §1.8): moves
#                               reading_tabs.balance_pence by a signed delta AND
#                               posts the mirror recordLedger entry at −delta, as
#                               one indivisible, unclamped pair. EVERY reading_tabs
#                               balance write must go through it (the raw column
#                               UPDATE + adjacent recordLedger pattern is retired).
#
# It is a heuristic tripwire, not a proof — read each match. Three guards:
#   1. REGISTRY — each known money-path file must call a ledger funnel
#      (applyLedgerDelta or recordLedger) at least its expected number of times.
#      Removing a call (or the import) trips this; adding more does not.
#   2. RAW-BALANCE SCAN — a reading_tabs balance write (the `balance_pence =
#      balance_pence ±`, `= reading_tabs.balance_pence + EXCLUDED`, or `= GREATEST`
#      forms) may appear ONLY inside the sanctioned primitive
#      shared/src/lib/ledger.ts::applyLedgerDelta. A match in ANY other backend
#      file is a raw balance write that BYPASSES the primitive — the divergence
#      bug class §1.8 abolishes — and trips the scan. Route it through
#      applyLedgerDelta.
#   3. PAYOUT-INSERT SCAN — any backend file that INSERTs into a charge/payout
#      money table (writer_payouts / publication_payout_splits / tribute_accruals
#      / tribute_payouts) but is NOT in the registry trips the scan: a new
#      money path appeared unwired. Register it AND add the ledger call. The scan
#      covers all four backend source roots: gateway/src, payment-service/src,
#      feed-ingest/src, shared/src.
#
# RESIDUAL GAP (read before trusting this green): Guards 1/3 are PRESENCE checks,
# not DELTA checks — a payout INSERT with a mismatched recordLedger amount passes.
# Guard 2 is the structural closer for the TAB side: because every balance write
# now runs through applyLedgerDelta, which derives the ledger sign from the column
# delta and cannot clamp, the three HIGH 2026-06-20-audit divergences (settlement
# GREATEST, subscription credit-back, pledge non-upsert) are removed BY
# CONSTRUCTION, not merely detected. Guard 2 keeps them from creeping back in via
# a fresh raw UPDATE.
#
# Money movements that DON'T move a tab balance or a payout/charge table (e.g.
# the provisional read_events INSERT, or the tab_settlements 'pending' reserve)
# carry their ledger entry at the later point where the balance actually moves
# (conversion / settlement confirm) — by design (see ledger.ts).
#
# Usage:   scripts/check-ledger-adjacency.sh
# Exit codes: 0 = clean, 1 = a registered site lost its ledger call, a raw
# balance write bypassed the primitive, or a new unregistered payout-write site
# appeared.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The single sanctioned home of raw reading_tabs balance writes.
LEDGER_PRIMITIVE="shared/src/lib/ledger.ts"

# ── Registry: "relpath::min ledger-funnel calls" ─────────────────────────────
# The min is a floor, not an exact count — adding sites is fine, dropping one
# below the floor fails. A "funnel call" is applyLedgerDelta( or recordLedger(.
# Counts as of PAYMENTS ADR §1.8 (tab sites moved to applyLedgerDelta):
#   accrual.ts               2  (recordGatePass + convertProvisionalReads loop —
#                                both now applyLedgerDelta)
#   settlement.ts            4  (confirmSettlement applyLedgerDelta + its
#                                writer_accrual recordLedger loop; reverseSettlement
#                                applyLedgerDelta + its writer/tribute reversal loop)
#   payout.ts                4  (writer payout + publication split + tribute payout
#                                + tribute_carve — all recordLedger; payout-side
#                                sagas stay out of applyLedgerDelta)
#   drives.ts                1  (pledge fulfilment — applyLedgerDelta)
#   subscription-convert.ts  1  (spend→subscription tab credit-back — applyLedgerDelta)
#   upstream-edges.ts        2  (dispute stake debit + withdrawal refund — applyLedgerDelta)
#   subscriptions/shared.ts  2  (subscription_charge tab debit via applyLedgerDelta +
#                                subscription_earning writer credit via recordLedger)
REGISTRY=(
  "payment-service/src/services/accrual.ts::2"
  "payment-service/src/services/settlement.ts::4"
  "payment-service/src/services/payout.ts::4"
  "gateway/src/routes/drives.ts::1"
  "gateway/src/routes/articles/subscription-convert.ts::1"
  "gateway/src/routes/upstream-edges.ts::2"
  "gateway/src/routes/subscriptions/shared.ts::2"
)

# Raw reading_tabs balance-write marker (Guard 2). Sanctioned ONLY in the primitive.
BAL_MARKER='balance_pence = balance_pence [-+]|balance_pence = reading_tabs\.balance_pence|balance_pence = GREATEST'

# Charge/payout money-table INSERT marker (Guard 3), registry-scoped.
PAYOUT_MARKER='INSERT INTO writer_payouts|INSERT INTO publication_payout_splits|INSERT INTO tribute_accruals|INSERT INTO tribute_payouts'

failed=0

# ── Guard 1: registered files keep their ledger-funnel calls ─────────────────
for entry in "${REGISTRY[@]}"; do
  file="${entry%%::*}"
  min="${entry##*::}"
  if [[ ! -f "$file" ]]; then
    echo "✗ LEDGER ADJACENCY — registered money path missing: $file"
    echo "  (file moved/renamed? update the registry in $(basename "$0"))"
    failed=1
    continue
  fi
  count="$(grep -cE 'applyLedgerDelta\(|recordLedger\(' "$file" 2>/dev/null || echo 0)"
  if [[ "$count" -lt "$min" ]]; then
    echo "✗ LEDGER ADJACENCY — $file has $count ledger-funnel call(s), expected >= $min"
    echo "  A money write here lost its applyLedgerDelta/recordLedger call — it will"
    echo "  silently under-report."
    failed=1
  fi
done

# ── Guard 2: raw balance writes live ONLY in the primitive ───────────────────
mapfile -t bal_files < <(grep -rlPn --include='*.ts' "$BAL_MARKER" gateway/src payment-service/src feed-ingest/src shared/src 2>/dev/null | sort -u)
for f in "${bal_files[@]}"; do
  if [[ "$f" != "$LEDGER_PRIMITIVE" ]]; then
    echo "✗ LEDGER ADJACENCY — raw reading_tabs balance write bypasses the primitive: $f"
    echo "  A reading_tabs.balance_pence mutation may only live inside"
    echo "  $LEDGER_PRIMITIVE::applyLedgerDelta. Route this write through"
    echo "  applyLedgerDelta so the column + mirror ledger entry move as one"
    echo "  unclamped pair (PAYMENTS ADR §1.8)."
    failed=1
  fi
done

# ── Guard 3: no charge/payout-write site outside the registry ────────────────
mapfile -t hit_files < <(grep -rlPn --include='*.ts' "$PAYOUT_MARKER" gateway/src payment-service/src feed-ingest/src shared/src 2>/dev/null | sort -u)
for f in "${hit_files[@]}"; do
  registered=0
  for entry in "${REGISTRY[@]}"; do
    [[ "${entry%%::*}" == "$f" ]] && registered=1 && break
  done
  if [[ "$registered" -eq 0 ]]; then
    echo "✗ LEDGER ADJACENCY — charge/payout-write site not registered: $f"
    echo "  This file inserts a charge/payout row but is not in the ledger"
    echo "  registry. Add a recordLedger() call in the same transaction, then"
    echo "  register the file in $(basename "$0")."
    failed=1
  fi
done

if [[ "$failed" -eq 0 ]]; then
  echo "✓ Ledger adjacency: all money-write sites carry a ledger-funnel call, and"
  echo "  all reading_tabs balance writes route through applyLedgerDelta."
  exit 0
fi

echo ""
echo "See docs/adr/ARCHITECTURE-AUDIT-IMPLEMENTATION-PLAN-2026-06-15.md › Item 3,"
echo "docs/audits/PAYMENTS-FIXES-AND-DILEMMAS.md › §1.8, and"
echo "shared/src/lib/ledger.ts for the sign convention."
exit 1
