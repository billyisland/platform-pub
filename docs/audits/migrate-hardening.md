# migrate.ts hardening — two small changes

Both changes touch `shared/src/db/migrate.ts` only (plus one migration file for #2).
Independent; can ship separately.

---

## 1. Numeric sort — dodge the 1000-migration cliff

**Problem.** Pending migrations are sorted lexicographically. At migration 1000,
`1000_` sorts before `999_` (`'1' < '9'`), so a fresh rebuild — or a deploy with
both pending — runs them out of order. Re-padding to four digits later doesn't
work either: `0137_` sorts before `136_`, so it would mean renaming all
historical files *and* rewriting every `filename` row in `_migrations`.

**Fix.** Sort by numeric prefix instead of alphabetically:

```ts
// in migrate.ts, replace .sort() with:
.sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
```

`parseInt` reads leading digits and stops at the first non-digit, so
`136_ledger_writer_earned.sql` → `136`. Works for 3-digit and 4-digit names
alike; no renames, no history rewrite.

**Guard (optional).** Fail loudly if a file lacks a numeric prefix:

```ts
for (const f of files) {
  if (Number.isNaN(parseInt(f, 10))) {
    throw new Error(`Migration filename lacks numeric prefix: ${f}`)
  }
}
```

---

## 2. Checksums — detect edits to already-applied migrations

**Problem.** If an applied migration file is edited afterwards, prod skips it
forever (filename already in `_migrations`) while a fresh rebuild gets the
edited version. The schemas diverge silently. `check-schema-drift.sh` keeps
`schema.sql` ↔ `migrations/` internally consistent but never compares against
the live database's history — this is the one drift it can't see.

**Fix.**

### 2a. Migration (e.g. `137_migrations_checksum.sql`)

```sql
ALTER TABLE _migrations ADD COLUMN checksum TEXT;
```

### 2b. Record on apply

```ts
import crypto from 'crypto'

const checksum = crypto.createHash('sha256').update(sql).digest('hex')

// replace both INSERT sites:
await client.query(
  'INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)',
  [filename, checksum],
)
```

### 2c. Verify on every run

After loading `appliedSet`, before diffing:

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
    // backfill: stamp existing rows from current file contents (one-time,
    // trusts present state — prod and repo agree today)
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

---

## Order of operations

1. Ship both code changes + migration `137` together.
2. First run backfills 136 checksum rows, applies `137`, records it *with* its
   checksum.
3. Regenerate `schema.sql` (pg_dump) so `check-schema-drift.sh` stays green —
   the new column and seed rows must appear in the snapshot.

---

## 3. accounts.ts — stale reader/writer taxonomy

**Problem.** The header comment in `shared/src/auth/accounts.ts` narrates a
reader→writer upgrade model that no longer exists:

- The signup `INSERT` sets `is_writer, is_reader` to `TRUE, TRUE` for every
  account — there is no upgrade path, and `is_writer = TRUE` checks elsewhere
  (`gateway/src/routes/drives.ts:80`, `export.ts:122`) are tautologies.
- Line 87: `createSession(..., { isWriter: false })` contradicts the row just
  inserted as `TRUE`. Session and DB disagree until next re-login. Harmless
  today only because nothing meaningful hangs on the flag.
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
   session payload entirely).
3. Decide the fate of `is_writer` / `is_reader`:
   - **Drop** — migration removing both columns + delete the tautological
     checks; or
   - **Keep as moderation lever** — e.g. setting `is_writer = FALSE`
     de-writers an account. If kept, the tautological checks become real
     guards and should stay.

No urgency; bundle with the next touch of the auth code.
