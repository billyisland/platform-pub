#!/usr/bin/env bash
#
# check-read-chargeable.sh — tripwire for the free-allowance gift rule.
#
# The rule (product ruling 2026-07-29; migration 164): the £5 free allowance is
# a GIFT, and attaching a card does not revoke it. So a read has two distinct
# amounts, and confusing them is how the gift gets billed back:
#
#   read_events.amount_pence       the article's LIST PRICE at read time
#   read_events.chargeable_pence   what the reader OWES and the writer EARNS
#                                  (= amount_pence − allowance_consumed_pence,
#                                   a GENERATED column)
#
# Every money computation over read_events must use `chargeable_pence`. Using
# `amount_pence` charges the reader for pence we gave away and pays a writer for
# pence nobody was ever charged — the bug migration 164 fixed, which had been
# live and silent since `convertProvisionalReads` was written.
#
# It is a heuristic grep, not a proof — read each match. Two guards:
#   1. NET SCAN — readNetSql(...) / perReadNetPence(...) compute the writer-side
#      net of a read. Neither may be handed an `amount_pence` expression. This is
#      the single highest-value check: those two helpers are the one home for the
#      per-read fee arithmetic, so every money path over reads flows through one
#      of them.
#   2. READ-QUERY SCAN — a SQL fragment that SUMs or compares `amount_pence`
#      with a read_events alias (`r.`/`re.`/bare inside a read_events query) in
#      the money files. Deliberate list-price uses are legitimate (the INSERT in
#      recordGatePass, a receipt display) and carry a trailing `list-price-ok`
#      marker with a written reason on the same line.
#
# Why the type system can't do this: these are SQL strings. The one place TS DOES
# help is chargeback.ts's `ReversalRead.chargeablePence`, deliberately renamed
# from `amountPence` so a regression there is a compile error, not a silent
# NaN — see migration 164's companion change.

set -uo pipefail
cd "$(dirname "$0")/.."

failed=0

# --- Guard 1: the net helpers must never be handed a list price --------------

echo "→ Guard 1: readNetSql / perReadNetPence never take amount_pence"
net_hits=$(grep -rn --include=*.ts \
  -e "readNetSql([\"'][^\"']*amount_pence" \
  -e "perReadNetPence([a-zA-Z_.]*[aA]mount[Pp]ence" \
  gateway/src payment-service/src feed-ingest/src shared/src 2>/dev/null \
  | grep -v "list-price-ok" \
  | grep -v "^shared/src/lib/per-read-net.ts:" || true)

if [[ -n "$net_hits" ]]; then
  echo ""
  echo "✗ A per-read net is being computed from the LIST PRICE, not the"
  echo "  chargeable amount. This bills the free-allowance gift back to the"
  echo "  reader and pays writers for pence nobody was charged."
  echo ""
  echo "$net_hits" | sed 's/^/    /'
  echo ""
  echo "  Use chargeable_pence (SQL) / chargeablePence (TS). If this really is"
  echo "  a list-price display, add a trailing 'list-price-ok' marker with a"
  echo "  reason on the same line."
  failed=1
fi

# --- Guard 2: money aggregates over read_events ------------------------------

echo "→ Guard 2: read_events money aggregates use chargeable_pence"
agg_hits=$(grep -rn --include=*.ts \
  -e "SUM(r\.amount_pence" -e "SUM(re\.amount_pence" \
  -e "r\.amount_pence > 0" -e "re\.amount_pence > 0" \
  -e "r\.amount_pence = 0" -e "re\.amount_pence = 0" \
  gateway/src payment-service/src feed-ingest/src shared/src 2>/dev/null \
  | grep -v "list-price-ok" || true)

if [[ -n "$agg_hits" ]]; then
  echo ""
  echo "✗ A read_events money aggregate/predicate uses the LIST PRICE:"
  echo ""
  echo "$agg_hits" | sed 's/^/    /'
  echo ""
  echo "  Use chargeable_pence, or mark the line 'list-price-ok' with a reason."
  failed=1
fi

if [[ "$failed" -eq 0 ]]; then
  echo "✓ Read money paths compute from chargeable_pence, not the list price."
  exit 0
fi

echo ""
echo "See migrations/164_read_chargeable_pence.sql for the rule and why the two"
echo "amounts differ, and payment-service/tests/free-allowance-gift-integration.test.ts"
echo "for the behaviour it protects."
exit 1
