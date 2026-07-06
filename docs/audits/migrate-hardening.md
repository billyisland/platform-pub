# migrate.ts hardening — two small changes

> **Status (2026-07-06): fully SHIPPED.** §1 + §2 + side-fix (incl. the
> check-schema-drift.sh scope caveat, in the same pass). §3: decided **drop**
> (owner decision, same day) — migration 145 removes `is_writer`/`is_reader`
> (+ the genesis-only `idx_accounts_is_writer`), the session `isWriter` claim,
> the API response fields, and the six tautological web gates; the export guard
> is gone (export-mandatory), drives keeps a plain existence check; moderation
> rides `accounts.status` (auth middleware already 403s non-active). The
> "moderation lever" option was rejected as illusory: nothing gated publishing
> on `is_writer`, so making it real would have meant building new enforcement
> against the every-account-writes model. See FIX-PROGRAMME.md 2026-07-06.

Both changes touch `shared/src/db/migrate.ts` only — it is the sole runner
(DEPLOYMENT.md invokes it directly; `payment-service`'s `npm run migrate`
points at a `src/db/migrate.ts` that doesn't exist — stale script, tracked
below as a side-fix). Independent; can ship separately.

---

## 1. Numeric sort — dodge the 1000-migration cliff

**Problem.** Pending migrations are sorted lexicographically
(`migrate.ts:62`). At migration 1000, `1000_` sorts before `999_`
(`'1' < '9'`), so a fresh rebuild — or a deploy with both pending — runs them
out of order. Re-padding to four digits later doesn't work either: `0137_`
sorts before `136_`, so it would mean renaming all historical files *and*
rewriting every `filename` row in `_migrations` (the runner matches applied
migrations by exact filename).

**Fix.** Sort by numeric prefix, with a lexicographic tiebreak so two files
accidentally sharing a number (merge collision) stay deterministic:

```ts
// in migrate.ts, replace .sort() with:
.sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b))
```

`parseInt` reads leading digits and stops at the first non-digit, so
`136_ledger_writer_earned.sql` → `136`. Works for 3-digit and 4-digit names
alike; no renames, no history rewrite.

**Guard (required, not optional).** A filename without a numeric prefix makes
the comparator return `NaN`, and a NaN-returning comparator gives
*unspecified* sort order — silent misordering, the exact bug class this
section fixes. So the guard must ship with the sort change:

```ts
for (const f of files) {
  if (Number.isNaN(parseInt(f, 10))) {
    throw new Error(`Migration filename lacks numeric prefix: ${f}`)
  }
}
```

**Scope caveat — the cliff is wider than migrate.ts.**
`scripts/check-schema-drift.sh` carries three more 3-digit / lexicographic
assumptions that break at migration 1000:

- Check 0's seed-extraction regex `'[0-9]{3}_[a-z0-9_]+\.sql'` (line ~98)
  won't match a 4-digit filename → Check 0 false-fails (loud).
- Check 2's `norm` filter strips seed lines by `\('[0-9]{3}_` (line ~216) →
  a 4-digit seed line survives normalisation and the roundtrip diff
  false-fails (loud).
- Check 3 folds the CREATE/DROP stream in `find | sort` order (line ~117) —
  once sort order diverges from chronology, the net-surviving set goes wrong
  **silently** (false pass or false fail).

The migrate.ts fix removes the *dangerous* failure (silent out-of-order
apply); the script fixes (`[0-9]{3,4}` or `[0-9]+`, plus a numeric `sort -t_
-k1,1n` in Check 3) should land in the same pass or be tracked alongside.

---

## 2. Checksums — detect edits to already-applied migrations

**Problem (actual threat model).** If an applied migration file is edited
afterwards, the edited file becomes misleading dead text on prod and on fresh
boots — but note it does **not** diverge a fresh rebuild, contrary to the
obvious intuition: fresh DBs boot from `schema.sql`, whose `_migrations` seed
marks every migration applied, so an already-applied-then-edited migration
never executes anywhere (prod skips it, fresh boots skip it, and the
schema.sql regen procedure — throwaway-from-committed — skips it too). The
real risks are narrower but still worth closing:

- **A lagging DB genuinely diverges.** Any DB behind that point (a stale dev
  DB — this has happened: dev sat missing 127/128 for a while) executes the
  *edited* version while prod ran the original. Nothing detects it.
- **Humans and tooling read the file as history.** Check 3 of
  `check-schema-drift.sh` parses migration bodies for object presence; an
  edit that adds/drops a whole object is caught there, but column- or
  body-level edits are invisible to every existing check.

`check-schema-drift.sh` keeps `schema.sql` ↔ `migrations/` internally
consistent but never compares against a live database's history — that
comparison is what this adds.

**Fix.**

### 2a. Column — runner bootstrap, NOT a migration

Do not ship a migration file for this. The verify/backfill code below must
query the `checksum` column on **every** run, including the run that would
apply such a migration — a `SELECT … checksum` against a prod DB that hasn't
applied it yet dies with `column does not exist` before the pending loop ever
executes, and the migration can never apply itself. (A lagging DB hits the
same wall earlier: the new two-column `INSERT` runs for every pending
migration, including ones sorted *before* the column-adding one.)

`_migrations` is already runner-owned bootstrap DDL (`CREATE TABLE IF NOT
EXISTS`, migrate.ts:37). Extend the bootstrap in the same place:

```ts
await client.query(
  'ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT',
)
```

Every DB — prod, lagging dev, fresh boot — self-heals before any query
touches the column, and the column flows into `schema.sql` at the next
pg_dump regen exactly the way the table itself does.

### 2b. Record on apply

```ts
import crypto from 'crypto'

const checksum = crypto.createHash('sha256').update(sql).digest('hex')

// replace both INSERT sites (txn + no-txn paths, migrate.ts:93 and :107):
await client.query(
  'INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)',
  [filename, checksum],
)
```

### 2c. Verify on every run

After the bootstrap + loading `appliedSet`, after `migrationsDir` is resolved
and known to exist, before diffing:

```ts
const { rows: appliedRows } = await client.query<{
  filename: string; checksum: string | null
}>('SELECT filename, checksum FROM _migrations')

for (const row of appliedRows) {
  const filepath = path.join(migrationsDir, row.filename)
  if (!fs.existsSync(filepath)) continue // deleted historical file: tolerate
  const hash = crypto.createHash('sha256')
    .update(fs.readFileSync(filepath, 'utf8')).digest('hex')

  if (row.checksum === null) {
    // backfill: stamp existing rows from current file contents. This is the
    // steady state for every fresh boot, not just a one-time prod event —
    // schema.sql's seed inserts filenames only, so a fresh DB's first migrate
    // run stamps all rows from the checked-out files. Trusting the files is
    // correct by construction there (a fresh boot never executed them; its
    // schema came from schema.sql). The check only ever protects long-lived
    // DBs whose rows were stamped on a previous run.
    await client.query(
      'UPDATE _migrations SET checksum = $1 WHERE filename = $2',
      [hash, row.filename],
    )
  } else if (row.checksum !== hash) {
    throw new Error(
      `Checksum mismatch: ${row.filename} was edited after being applied. ` +
      `Corrections go in a NEW migration. ` +
      `(If the rewrite was deliberate, update the checksum row by hand.)`,
    )
  }
}
```

**Policy.** Mismatch is always fatal — no override flag. For a deliberate
rewrite (rare, solo-operator), hand-update the `checksum` row.

**Drift-guard interplay (verified).** Check 1 still passes: on a
schema.sql-built throwaway DB the bootstrap adds the column, the backfill
stamps all rows, then "All migrations already applied" prints. Check 2's
`norm` already strips the filename-only seed lines. The seed block stays
filename-only (NULL checksums backfill on first run).

### Order of operations

1. Ship the code change (bootstrap + record + verify — one commit, no
   migration file).
2. Run migrate against the dev throwaway used for schema regen; regenerate
   `schema.sql` (pg_dump) in the same step so the new column appears in the
   snapshot and `check-schema-drift.sh` stays green.
3. First prod run adds the column and backfills all 144 rows (count as of
   2026-07-06; whatever is applied at deploy time).

### Side-fix while in here

`payment-service/package.json` `"migrate": "node -r tsx/esm src/db/migrate.ts"`
targets a nonexistent file (only `shared/src/db/migrate.ts` exists). Delete
the script or point it at the shared runner; CLAUDE.md's "each backend
service also has its own `db/migrate.ts`" is stale with it.

---

## 3. accounts.ts — stale reader/writer taxonomy

**Problem.** The header comment in `shared/src/auth/accounts.ts` narrates a
reader→writer upgrade model that no longer exists:

- Both signup paths (`accounts.ts:70` magic-link, `google-auth.ts:312` OAuth)
  set `is_writer, is_reader` to `TRUE, TRUE` for every account, and nothing
  anywhere sets either to `FALSE` — there is no upgrade path, and
  `is_writer = TRUE` checks (`gateway/src/routes/drives.ts:80`,
  `export.ts:122`) are tautologies.
- `accounts.ts:87`: `createSession(..., { isWriter: false })` contradicts the
  row just inserted as `TRUE` — and disagrees with the OAuth path, which
  passes the real value (`google-auth.ts:190`). Harmless today only because
  nothing reads the session flag: no server code consumes `session.isWriter`
  (only `session.ts` packs/unpacks it), and `/me` returns `account.isWriter`
  from the DB (`auth.ts:279`).
- The distinctions that actually gate behaviour are Stripe-shaped:
  - `stripe_customer_id` — card on file, can settle a tab (*can pay*)
  - `stripe_connect_id` + `stripe_connect_kyc_complete` — Connect onboarded,
    can receive payouts (*can be paid* — the precondition for paywalling)
  - `default_article_price_pence` — has set a price

**Fix.**

1. Rewrite the header comment to describe the live model: every account gets
   a keypair and full capability at signup; the operative axes are
   can-pay × can-be-paid.
2. Fix `isWriter: false` → pass the real value (or drop the field from the
   session payload entirely — touches the `SessionPayload` type in
   `shared/src/auth/session.ts:34/59/65/119`; old cookies carrying the claim
   just have an ignored extra field, no invalidation needed).
3. Decide the fate of `is_writer` / `is_reader`:
   - **Drop** — bigger than "migration + two checks": the column rides API
     response shapes (`/me` auth.ts:279, `follows.ts:177`, `writers.ts:435`)
     and real web consumers gate UI on it (`ExportModal.tsx:77`,
     `DashboardPanel.tsx:167` tab list, `LedgerPanel.tsx:40` earnings fetch,
     `NetworkPanel.tsx:292`, `FollowersTab`). All tautologically true today,
     but dropping the columns means updating those shapes or synthesising
     `isWriter: true` at the response layer.
   - **Keep as moderation lever** — e.g. setting `is_writer = FALSE`
     de-writers an account, and the tautological checks become real guards.
     **Carve-out required:** `export.ts:122` gates the account-export route —
     the one that ships the custodial nsec, which is export-mandatory
     (CLAUDE.md invariant / NETWORK-CONCIERGE-ADR). De-writering must never
     lock a user out of exporting their own identity key, so that specific
     guard comes out regardless of which option is chosen.

No urgency; bundle with the next touch of the auth code.
