#!/usr/bin/env bash
#
# check-hairlines.sh — sitewide tripwire for the NO-HAIRLINES rule.
#
# The rule (CLAUDE.md › Design system rules › No hairlines, no outlines,
# no single-pixel anything): the site never separates, outlines, or
# decorates anything with a 1px line. Separation is whitespace and rhythm;
# emphasis is the 4px slab (`.slab-rule-4`); structural borders are >= 2px.
#
# This script greps web/src for every form a 1px line can take and exits
# non-zero if any are found. It is a heuristic tripwire, not a proof — read
# each match. A genuine, reviewed false positive (e.g. a `1px` that is a
# micro-transform, not a line) may carry a trailing `hairline-ok` marker on
# the same line to be ignored; that marker MUST be accompanied by a reason.
#
# Usage:
#   scripts/check-hairlines.sh            # scan all of web/src
#   scripts/check-hairlines.sh <path...>  # scan specific files/dirs (e.g. staged set)
#
# Exit codes: 0 = clean, 1 = hairlines found.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGETS=("${@:-$ROOT/web/src}")

# Each entry: "label::PCRE pattern". Patterns are tuned to catch 1px-resolving
# forms while NOT flagging legitimate >=2px borders/outlines (e.g. the 2px a11y
# focus outlines and 4px slab rules).
PATTERNS=(
  "literal 1px (border/shadow/size)::(?<![0-9])1px"
  # A bare `1` in a JS style object is a 1px line at render — React appends the
  # unit for you. `height: 1` reads as a number and greps as nothing, so the
  # `1px` pattern above never sees it. That is how a divider rule shipped past
  # this script in the landing-demo bundle (GateDemo, 2026-07-27).
  "numeric 1 in a style object (renders as 1px)::(height|width|borderWidth|border(Top|Bottom|Left|Right)Width|outlineWidth)\s*:\s*1\s*[,}]"
  "tailwind bare 1px border width::[\"'\` :]border(-[tblrxyse])?[\"'\` ]"
  "tailwind 1px arbitrary border::border-\[1px\]|border-(t|b|l|r|x|y|s|e)-\[1px\]"
  "tailwind divide (1px between children)::\bdivide-[xy](?!-[0-9])"
  "tailwind 1px ring::\bring-(1|px)\b"
  "tailwind 1px outline::\boutline-(1|px)\b"
  "tailwind 1px line element::\b[hw]-px\b|\b[hw]-\[1px\]"
  "raw <hr> element::<hr"
  "named hairline token::hairline"
)

found=0
for entry in "${PATTERNS[@]}"; do
  label="${entry%%::*}"
  pattern="${entry##*::}"
  # -P PCRE, exclude lines carrying an explicit reviewed `hairline-ok` marker.
  hits="$(grep -rPn --include='*.tsx' --include='*.ts' --include='*.css' \
            "$pattern" "${TARGETS[@]}" 2>/dev/null | grep -v 'hairline-ok' || true)"
  if [[ -n "$hits" ]]; then
    if [[ $found -eq 0 ]]; then
      echo "✗ HAIRLINE CHECK FAILED — single-pixel lines are banned sitewide."
      echo ""
    fi
    found=1
    count="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
    echo "── ${label}  (${count})"
    printf '%s\n' "$hits"
    echo ""
  fi
done

if [[ $found -eq 0 ]]; then
  echo "✓ No hairlines found."
  exit 0
fi

echo "Fix: replace 1px borders/dividers/outlines with whitespace, a .slab-rule-4,"
echo "or a >=2px treatment. See CLAUDE.md › Design system rules › No hairlines."
exit 1
