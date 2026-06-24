#!/usr/bin/env bash
#
# check-ledger-adjacency.sh — tripwire for the unified-ledger dual-write rule.
#
# The rule (Architecture-audit 2026-06-15 item 3, keystone; docs/adr/
# ARCHITECTURE-AUDIT-IMPLEMENTATION-PLAN-2026-06-15.md › Item 3 › Risk): during
# the dual-write window (Phase 1→3) every money MOVEMENT must emit a
# ledger_entries row inside the same transaction as the table write that
# records it (via shared/src/lib/ledger.ts::recordLedger). A path that writes
# its money table but forgets the ledger entry silently UNDER-REPORTS — the
# exact failure the ledger exists to abolish. This is the CI grep the plan
# names to mitigate it.
#
# It is a heuristic tripwire, not a proof — read each match. Two guards:
#   1. REGISTRY — each known money-path file must import + call recordLedger at
#      least its expected number of times. Removing a call (or the import)
#      trips this; adding more does not.
#   2. NEW-SITE SCAN — any backend file that performs a money MOVEMENT (a tab
#      balance write, or an INSERT into a charge/payout money table) but is NOT
#      in the registry trips the scan: a new money path appeared without being
#      wired to the ledger. Register it here AND add the recordLedger call. The
#      scan covers all four backend source roots that could host a money path:
#      gateway/src, payment-service/src, feed-ingest/src, shared/src.
#
# RESIDUAL GAP (read before trusting this green): both guards are PRESENCE
# checks, not DELTA checks. Guard 1 counts recordLedger() calls per FILE (not
# per write-site) and Guard 2's marker is a single-line regex with exact
# spacing — so a money write that DOES call recordLedger() but with the WRONG
# signed delta (a clamp/floor on the column the ledger entry doesn't mirror, or
# a cross-line / aliased / odd-spacing balance write) passes both guards. This
# tripwire would NOT have caught the three HIGH 2026-06-20-audit divergences on
# its own. The structural fix is the negative-balance policy itself (same signed
# delta, no clamp — CLAUDE.md › Money ledger), which removes the conditions that
# produce divergence; this script only catches a DROPPED or UNREGISTERED call.
#
# Money movements that DON'T move a tab balance or a payout/charge table (e.g.
# the provisional read_events INSERT, or the tab_settlements 'pending' reserve)
# carry their ledger entry at the later point where the balance actually moves
# (conversion / settlement confirm) — by design (see ledger.ts), so the markers
# below deliberately key off balance writes + payout/charge inserts, not every
# read_events INSERT.
#
# Usage:   scripts/check-ledger-adjacency.sh
# Exit codes: 0 = clean, 1 = a registered site lost its ledger call or a new
# unregistered money-write site appeared.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Registry: "relpath::min recordLedger() calls" ────────────────────────────
# The min is a floor, not an exact count — adding sites is fine, dropping one
# below the floor fails. Counts as of Phase 1:
#   accrual.ts   3  (recordGatePass + convert loop: reads + vote_charges)
#   settlement.ts 2 (confirmSettlement reader credit; reverseSettlement's F3
#                    reversal-entry loop — the tribute_accruals INSERT writes no
#                    ledger row, accruals live outside the ledger)
#   payout.ts    3  (writer payout + publication split + tribute payout — Phase 3)
#   votes.ts     1  (accrued vote charge)
#   drives.ts    1  (pledge fulfilment)
#   subscription-convert.ts 1 (spend→subscription tab credit-back)
#   upstream-edges.ts 2 (dispute stake debit + withdrawal refund)
REGISTRY=(
  "payment-service/src/services/accrual.ts::3"
  "payment-service/src/services/settlement.ts::2"
  "payment-service/src/services/payout.ts::3"
  "gateway/src/routes/votes.ts::1"
  "gateway/src/routes/drives.ts::1"
  "gateway/src/routes/articles/subscription-convert.ts::1"
  "gateway/src/routes/upstream-edges.ts::2"
)

# Money-movement markers for the new-site scan (PCRE).
# Match a tab-balance write in EITHER direction — both an accrual (+) and a
# credit-back (−) move the tab and so both need a mirror entry. The original
# regex only caught '+', which let subscription-convert.ts's '− $1' credit
# escape the scan (the Phase-3 latent gap); '[-+]' closes that.
MARKERS='balance_pence = balance_pence [-+]|balance_pence = GREATEST\(0, balance_pence|INSERT INTO vote_charges|INSERT INTO writer_payouts|INSERT INTO publication_payout_splits|INSERT INTO tribute_accruals|INSERT INTO tribute_payouts'

failed=0

# ── Guard 1: registered files keep their ledger calls ────────────────────────
for entry in "${REGISTRY[@]}"; do
  file="${entry%%::*}"
  min="${entry##*::}"
  if [[ ! -f "$file" ]]; then
    echo "✗ LEDGER ADJACENCY — registered money path missing: $file"
    echo "  (file moved/renamed? update the registry in $(basename "$0"))"
    failed=1
    continue
  fi
  count="$(grep -c 'recordLedger(' "$file" 2>/dev/null || echo 0)"
  if [[ "$count" -lt "$min" ]]; then
    echo "✗ LEDGER ADJACENCY — $file has $count recordLedger() call(s), expected >= $min"
    echo "  A money write here lost its ledger entry — it will silently under-report."
    failed=1
  fi
done

# ── Guard 2: no money-write site outside the registry ────────────────────────
mapfile -t hit_files < <(grep -rlPn --include='*.ts' "$MARKERS" gateway/src payment-service/src feed-ingest/src shared/src 2>/dev/null | sort -u)
for f in "${hit_files[@]}"; do
  registered=0
  for entry in "${REGISTRY[@]}"; do
    [[ "${entry%%::*}" == "$f" ]] && registered=1 && break
  done
  if [[ "$registered" -eq 0 ]]; then
    echo "✗ LEDGER ADJACENCY — money-write site not registered: $f"
    echo "  This file moves a tab balance or inserts a charge/payout row but is"
    echo "  not in the ledger registry. Add a recordLedger() call in the same"
    echo "  transaction, then register the file in $(basename "$0")."
    failed=1
  fi
done

if [[ "$failed" -eq 0 ]]; then
  echo "✓ Ledger adjacency: all money-write sites carry a recordLedger() call."
  exit 0
fi

echo ""
echo "See docs/adr/ARCHITECTURE-AUDIT-IMPLEMENTATION-PLAN-2026-06-15.md › Item 3,"
echo "and shared/src/lib/ledger.ts for the sign convention."
exit 1
