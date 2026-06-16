#!/usr/bin/env bash
# =============================================================================
# check-schema-drift.sh — enforce schema.sql ↔ migrations/ agreement
#
# The repo has two halves that MUST agree by hand and nothing else enforces it:
#   • schema.sql      — the snapshot a fresh dev/prod DB boots from (initdb.d),
#                       including a seed of _migrations recording every baked-in
#                       migration as already applied.
#   • migrations/     — the incremental log prod replays on top of schema.sql.
#
# When they drift (e.g. a new migration added but schema.sql not regenerated)
# a fresh deploy breaks: either it silently lacks the new objects, or migrate.ts
# re-runs old migrations against the already-built schema and dies. This guard
# turns "remember to regenerate schema.sql" into a checkable invariant.
#
# It runs four checks, cheapest first:
#   0. SEED COMPLETENESS (no DB): schema.sql's _migrations seed lists exactly
#      the files in migrations/.
#   3. OBJECT PRESENCE (no DB): every object a migration CREATEs and does not
#      later DROP/RENAME-away is present by name in schema.sql. Closes the one
#      gap the other three miss — a migration seeded as applied (Check 0 green)
#      whose object BODY was omitted from schema.sql: migrate.ts skips the
#      seeded migration so the object is never created and Checks 1/2 stay green
#      against the (consistent-but-incomplete) schema.sql. Runs alongside Check 0.
#   1. NO-OP MIGRATE (DB): a fresh DB built from schema.sql, then run through the
#      real migrate.ts, reports "All migrations already applied."
#   2. CANONICAL DUMP (DB): loading schema.sql and dumping it back reproduces
#      schema.sql exactly. This enforces that schema.sql is a clean pg_dump and
#      not hand-edited into a non-canonical state (the failure mode behind the
#      hand-appended 098/099 blocks). The fix for a failure is always: regenerate
#      schema.sql with pg_dump, never edit it by hand.
#
# Check 3 scope / known limits:
#   - Covers OBJECT-level creates: TABLE / INDEX / TYPE / FUNCTION / TRIGGER / VIEW
#     (CREATE [OR REPLACE] [UNIQUE] [MATERIALIZED] …, with IF [NOT] EXISTS /
#     CONCURRENTLY). EXTENSION/SCHEMA/SEQUENCE and CONSTRAINT-backed indexes
#     (ALTER TABLE … ADD CONSTRAINT … UNIQUE/PRIMARY KEY) are out of scope.
#   - Net-surviving-set is computed in CHRONOLOGICAL order across the whole chain,
#     so create→drop, create→drop→recreate, and ALTER … RENAME TO all resolve
#     correctly (a renamed-away or dropped object is not demanded).
#   - COLUMN-level drift (ALTER TABLE … ADD COLUMN whose column is missing from
#     schema.sql) is NOT covered — a possible Phase 2. The mechanical
#     pg_dump-and-re-append discipline still backs that gap.
#   - FUNCTION bodies are checked for PRESENCE by name only, not for content.
#   - Presence is a name-grep in schema.sql; a genuinely-reviewed exotic CREATE
#     form can be excused with a trailing `drift-ok` marker on the line.
#
# NOTE on what this does NOT check: there is no genesis migration — migration 001
# already ALTERs an `accounts` table that only schema.sql ever created — so the
# migration chain cannot be replayed from an empty DB, and a structural "schema
# == migrations-from-zero" check is not possible. schema.sql IS the base; the
# guard verifies the two halves agree, it cannot reconstruct one from the other.
# Closing that fully would mean extracting a 000_base.sql genesis migration —
# which would also make Check 3's name-grep obsolete (a from-zero replay is the
# gold standard this heuristic stands in for until then).
#
# Uses the running dev Postgres container for throwaway databases; runs the
# host-side migrate.ts over the exposed port. Read-only w.r.t. your real dev DB.
#
# Usage:  scripts/check-schema-drift.sh
# Env:    PG_CONTAINER       postgres container name (default platform-pub-dev-postgres-1)
#         POSTGRES_PASSWORD  DB password; falls back to .env if unset (CI sets it)
#         PG_HOST_PORT       host port the container's 5432 is published on (default 5432)
# Exit:   0 = consistent, 1 = drift (with a diff), 2 = environment not ready,
#         3 = a migration-created object is missing from schema.sql (Check 3)
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="${PG_CONTAINER:-platform-pub-dev-postgres-1}"
PGUSER="platformpub"
DB_SCHEMA="schemacheck_from_schema"
PGPORT="${PG_HOST_PORT:-5432}"   # host port the container's 5432 is published on

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
die()  { red "❌ $*" >&2; exit 1; }
skip() { red "⚠  $*" >&2; exit 2; }
miss() { red "❌ $*" >&2; exit 3; }

# --- locate the DB password for the host-side migrate.ts (TCP, needs auth) ----
# Prefer an env-provided password (CI sets POSTGRES_PASSWORD directly); fall
# back to reading it from .env for local dev.
PGPASS="${POSTGRES_PASSWORD:-}"
if [ -z "$PGPASS" ]; then
  [ -f .env ] || skip ".env not found and POSTGRES_PASSWORD unset — cannot authenticate"
  PGPASS="$(grep -E '^POSTGRES_PASSWORD=' .env | head -1 | cut -d= -f2-)"
  PGPASS="${PGPASS%\"}"; PGPASS="${PGPASS#\"}"   # strip optional surrounding quotes
  PGPASS="${PGPASS%\'}"; PGPASS="${PGPASS#\'}"
fi
[ -n "$PGPASS" ] || skip "POSTGRES_PASSWORD is empty"

# =============================================================================
# Check 0 — seed list == migrations/ (fast, no DB)
# =============================================================================
on_disk="$(find migrations -maxdepth 1 -name '*.sql' -printf '%f\n' | sort)"
in_seed="$(grep -oE "'[0-9]{3}_[a-z0-9_]+\.sql'" schema.sql | tr -d "'" | sort -u)"
if ! diff <(printf '%s\n' "$on_disk") <(printf '%s\n' "$in_seed") >/tmp/schema-seed.diff; then
  red "Check 0 FAILED: schema.sql _migrations seed does not match migrations/"
  echo "  '<' = file on disk but not seeded; '>' = seeded but no such file:" >&2
  sed 's/^/    /' /tmp/schema-seed.diff >&2
  die "regenerate schema.sql (or fix the seed block) so the two agree."
fi
grn "✓ Check 0: _migrations seed lists all $(printf '%s\n' "$on_disk" | wc -l | tr -d ' ') migration files"

# =============================================================================
# Check 3 — object presence: every migration-created object that survives the
# chain (not later DROP'd or RENAME'd away) appears by name in schema.sql
# (fast, no DB). See the header for scope/limits.
# =============================================================================
# Emit a chronological "C|D <kind> <name>" stream from migrations/, then fold it
# in order to the net-surviving set. Statements are split on ';' (after stripping
# line comments) so a multi-line `ALTER … RENAME TO` is one record; CREATE names
# always sit on the statement's first tokens. A `drift-ok` line is excused.
survivors="$(
  for f in $(find migrations -maxdepth 1 -name '*.sql' | sort); do
    sed -E '/drift-ok/d; s/--.*$//' "$f" | awk 'BEGIN{RS=";"}
    {
      s=$0; gsub(/[\n\t]/," ",s); gsub(/  +/," ",s); sub(/^ +/,"",s)
      n=split(s, w, /[ (]+/); if(n<2) next
      for(i=1;i<=n;i++) W[i]=toupper(w[i])
      verb=W[1]
      if(verb=="CREATE"||verb=="DROP"){
        i=2
        while(W[i]=="OR"||W[i]=="REPLACE"||W[i]=="UNIQUE"||W[i]=="MATERIALIZED") i++
        kind=W[i]; i++
        if(kind!="TABLE"&&kind!="INDEX"&&kind!="TYPE"&&kind!="FUNCTION"&&kind!="TRIGGER"&&kind!="VIEW") next
        while(W[i]=="CONCURRENTLY") i++
        if(W[i]=="IF"){i++; if(W[i]=="NOT")i++; if(W[i]=="EXISTS")i++}
        name=tolower(w[i]); sub(/^public\./,"",name); gsub(/[;,]+$/,"",name)
        if(name!="") print (verb=="CREATE"?"C":"D"), tolower(kind), name
      } else if(verb=="ALTER"){            # object rename = drop old + create new
        kind=W[2]
        if(kind!="TABLE"&&kind!="INDEX"&&kind!="TRIGGER"&&kind!="TYPE"&&kind!="VIEW") next
        oldn=tolower(w[3]); sub(/^public\./,"",oldn)
        for(i=3;i<n;i++) if(W[i]=="RENAME"&&W[i+1]=="TO"){
          newn=tolower(w[i+2]); sub(/^public\./,"",newn); gsub(/[;,]+$/,"",newn)
          print "D",tolower(kind),oldn; print "C",tolower(kind),newn; break
        }
      }
    }'
  done | awk '
    $1=="C"{k=$2" "$3; if(!(k in seen)){seen[k]=1; ord[++m]=k} live[k]=1}
    $1=="D"{k=$2" "$3; live[k]=0}
    END{for(j=1;j<=m;j++) if(live[ord[j]]) print ord[j]}'
)"

# Match the object's DEFINING statement, not a bare name — a name like `tags`
# also appears as a column, a constraint (`tags_pkey`) and an FK ref
# (`public.tags(id)`), so a bare-name grep would mask a removed table body.
# pg_dump qualifies table/type/function/view with `public.`; index/trigger names
# are unqualified (the `ON public.<tbl>` carries the schema). `(public\.)?` stays
# tolerant of either, and `\b` stops `tags` matching `tags_archive`.
missing=""
while read -r kind name; do
  [ -z "$name" ] && continue
  case "$kind" in
    table)    pat="CREATE TABLE (public\.)?${name}\b" ;;
    index)    pat="CREATE (UNIQUE )?INDEX (CONCURRENTLY )?(public\.)?${name}\b" ;;
    type)     pat="CREATE TYPE (public\.)?${name}\b" ;;
    function) pat="CREATE (OR REPLACE )?FUNCTION (public\.)?${name}\b" ;;
    trigger)  pat="CREATE (CONSTRAINT )?TRIGGER ${name}\b" ;;
    view)     pat="CREATE (OR REPLACE )?(MATERIALIZED )?VIEW (public\.)?${name}\b" ;;
    *)        pat="\b${name}\b" ;;
  esac
  grep -qiE "$pat" schema.sql || missing="${missing}    ${kind} ${name}"$'\n'
done <<< "$survivors"

if [ -n "$missing" ]; then
  red "Check 3 FAILED: migration-created object(s) absent from schema.sql"
  echo "  (seeded as applied, so migrate.ts skips them and Checks 1/2 stay green):" >&2
  printf '%s' "$missing" >&2
  miss "regenerate schema.sql from a fully-migrated DB so these objects are baked in."
fi
grn "✓ Check 3: all $(printf '%s\n' "$survivors" | grep -c . ) migration-created objects present in schema.sql"

# =============================================================================
# environment: dev Postgres must be up; temp DBs are cleaned on exit
# =============================================================================
docker exec "$CONTAINER" pg_isready -U "$PGUSER" >/dev/null 2>&1 \
  || skip "postgres container '$CONTAINER' not ready (docker compose up postgres)"

drop_dbs() {
  docker exec "$CONTAINER" psql -U "$PGUSER" -d postgres \
    -c "DROP DATABASE IF EXISTS $DB_SCHEMA WITH (FORCE);" >/dev/null 2>&1 || true
}
trap drop_dbs EXIT
drop_dbs   # clear leftovers from any killed prior run

# =============================================================================
# Check 1 — fresh DB from schema.sql, then migrate.ts is a no-op
# =============================================================================
docker exec "$CONTAINER" psql -U "$PGUSER" -d postgres -c "CREATE DATABASE $DB_SCHEMA;" >/dev/null
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$DB_SCHEMA" -q -v ON_ERROR_STOP=1 < schema.sql >/dev/null \
  || die "schema.sql failed to load into a fresh database"

migrate_out="$(DATABASE_URL="postgresql://$PGUSER:$PGPASS@localhost:$PGPORT/$DB_SCHEMA" \
  node_modules/.bin/tsx shared/src/db/migrate.ts 2>&1)" || {
  printf '%s\n' "$migrate_out" | sed 's/^/    /' >&2
  die "migrate.ts errored against a schema.sql-built DB (it should be a clean no-op)"
}
if ! printf '%s\n' "$migrate_out" | grep -q "All migrations already applied"; then
  printf '%s\n' "$migrate_out" | sed 's/^/    /' >&2
  die "migrate.ts found pending migrations on a schema.sql-built DB — schema.sql is stale relative to migrations/"
fi
grn "✓ Check 1: migrate.ts is a no-op on a schema.sql-built DB"

# =============================================================================
# Check 2 — schema.sql round-trips: load it, dump it back, must be identical
# =============================================================================
# Normalise so the diff isolates real structural differences, not formatting:
# drop comments, psql \restrict tokens (random per run), blank lines, and the
# _migrations data seed (--schema-only omits it, so it lives only in the file).
norm() {
  grep -vE "^--|^\\\\(un)?restrict |^INSERT INTO public\._migrations|^[[:space:]]*\('[0-9]{3}_" \
    | sed '/^[[:space:]]*$/d'
}
docker exec "$CONTAINER" pg_dump -U "$PGUSER" --schema-only --no-owner --no-privileges "$DB_SCHEMA" \
  | norm > /tmp/schema-roundtrip.sql
norm < schema.sql > /tmp/schema-committed.sql
if ! diff /tmp/schema-committed.sql /tmp/schema-roundtrip.sql >/tmp/schema-struct.diff; then
  red "Check 2 FAILED: schema.sql is not a canonical pg_dump (it round-trips dirty)"
  echo "  '<' = committed schema.sql; '>' = what pg_dump produces after loading it:" >&2
  sed 's/^/    /' /tmp/schema-struct.diff | head -60 >&2
  echo "  (full diff: /tmp/schema-struct.diff)" >&2
  die "regenerate schema.sql with pg_dump from a fully-migrated DB — do not hand-edit it."
fi
grn "✓ Check 2: schema.sql is a canonical pg_dump (round-trips clean)"

grn "✔ schema.sql and migrations/ are consistent."
