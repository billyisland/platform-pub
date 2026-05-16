#!/bin/bash
# Stop hook: run tsc --noEmit on services with modified .ts/.tsx files.
# Uses git status to detect changes since hooks don't receive a file list.

PROJECT="/home/ejklake/platform-pub-dev"

MODIFIED=$(cd "$PROJECT" && git diff --name-only --diff-filter=ACMUX 2>/dev/null; git diff --cached --name-only --diff-filter=ACMUX 2>/dev/null)

if [ -z "$MODIFIED" ]; then
  exit 0
fi

SERVICES=$(echo "$MODIFIED" | grep '\.tsx\?$' | cut -d/ -f1 | sort -u)

if [ -z "$SERVICES" ]; then
  exit 0
fi

ERRORS=""
for svc in $SERVICES; do
  if [ -f "$PROJECT/$svc/tsconfig.json" ]; then
    OUTPUT=$(cd "$PROJECT/$svc" && npx tsc --noEmit 2>&1)
    if [ $? -ne 0 ]; then
      ERRORS="${ERRORS}tsc errors in ${svc}:\n${OUTPUT}\n\n"
    fi
  fi
done

if [ -n "$ERRORS" ]; then
  printf '%s' "$ERRORS" | jq -Rs '{
    decision: "block",
    reason: .,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: "Fix these TypeScript errors before finishing."
    }
  }'
fi

exit 0
