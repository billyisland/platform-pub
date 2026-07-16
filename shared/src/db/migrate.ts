import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import pg from "pg";

// =============================================================================
// Migration Runner
//
// Simple, sequential migration runner. Tracks applied migrations in a
// _migrations table. Runs all .sql files in the migrations/ directory
// in numeric-prefix order (lexicographic tiebreak), so 1000_ sorts after
// 999_ — a filename without a numeric prefix is an error.
//
// Usage:
//   npx tsx shared/src/db/migrate.ts
//
// Migration file naming convention:
//   001_initial_schema.sql
//   002_add_email_to_accounts.sql
//   003_create_notifications_table.sql
//
// The initial schema (schema.sql) is applied by docker-compose on first
// boot via the initdb.d volume mount. This runner handles incremental
// migrations after that.
//
// Checksums: each applied migration's sha256 is recorded, and every run
// verifies applied rows against the files on disk — editing an
// already-applied migration is fatal (corrections go in a NEW migration).
// The `checksum` column is runner-owned bootstrap DDL, deliberately NOT a
// migration file: the verify/record code touches the column on every run,
// including runs against DBs that predate it, so it must self-heal before
// any migration is considered. NULL checksums (schema.sql's seed inserts
// filenames only; pre-checksum prod rows) are backfilled from the current
// file contents on first sight.
// =============================================================================

const { Pool } = pg;

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const client = await pool.connect();

  // Serialise concurrent runners (M24): two simultaneous `migrate.ts` invocations
  // would both read the same applied set and double-apply a pending migration —
  // and for the no-transaction path (ALTER TYPE ADD VALUE / CONCURRENTLY) a
  // partial double-apply cannot be rolled back. A session-level advisory lock on
  // this connection makes the second runner wait for the first. Released
  // implicitly when the connection closes; explicitly in finally for promptness.
  const MIGRATE_LOCK_KEY = 481723; // stable, migrate-runner-owned
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);

  try {
    // Ensure migrations tracking table exists (checksum column is bootstrap
    // DDL too — see header; it must exist before any code below touches it)
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      "ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT",
    );

    // Get already-applied migrations
    const { rows: applied } = await client.query<{
      filename: string;
      checksum: string | null;
    }>("SELECT filename, checksum FROM _migrations ORDER BY filename");
    const appliedSet = new Set(applied.map((r) => r.filename));

    // Find migration files
    const migrationsDir = path.resolve(process.cwd(), "migrations");

    if (!fs.existsSync(migrationsDir)) {
      console.log("No migrations/ directory found — nothing to run.");
      return;
    }

    // Verify applied migrations against the files on disk. NULL checksum →
    // backfill from current contents (the steady state on every fresh boot:
    // schema.sql's seed inserts filenames only, and a fresh DB never executed
    // the files — its schema came from schema.sql — so trusting them is
    // correct by construction). Mismatch → fatal, no override flag.
    for (const row of applied) {
      const filepath = path.join(migrationsDir, row.filename);
      if (!fs.existsSync(filepath)) continue; // deleted historical file: tolerate
      const hash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(filepath, "utf8"))
        .digest("hex");

      if (row.checksum === null) {
        await client.query(
          "UPDATE _migrations SET checksum = $1 WHERE filename = $2",
          [hash, row.filename],
        );
      } else if (row.checksum !== hash) {
        throw new Error(
          `Checksum mismatch: ${row.filename} was edited after being applied. ` +
            `Corrections go in a NEW migration. ` +
            `(If the rewrite was deliberate, update the checksum row by hand.)`,
        );
      }
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"));

    // A non-numeric prefix would make the comparator return NaN, and a
    // NaN-returning comparator gives an UNSPECIFIED sort order — silent
    // misordering, the exact bug class the numeric sort exists to fix.
    for (const f of files) {
      if (Number.isNaN(parseInt(f, 10))) {
        throw new Error(`Migration filename lacks numeric prefix: ${f}`);
      }
    }

    // Numeric-prefix sort (lexicographic would run 1000_ before 999_), with a
    // lexicographic tiebreak so two files sharing a number (merge collision)
    // stay deterministic.
    files.sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));

    const pending = files.filter((f) => !appliedSet.has(f));

    if (pending.length === 0) {
      console.log("All migrations already applied.");
      return;
    }

    console.log(`Found ${pending.length} pending migration(s):`);

    for (const filename of pending) {
      const filepath = path.join(migrationsDir, filename);
      const sql = fs.readFileSync(filepath, "utf8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");

      console.log(`  Applying: ${filename}`);

      // Statements Postgres refuses to run inside a transaction block. Both
      // must run outside BEGIN/COMMIT, so they cannot be rolled back on failure.
      //   - ALTER TYPE … ADD VALUE (new enum members)
      //   - CREATE/DROP INDEX CONCURRENTLY (e.g. migrations 022, 083)
      const noTxnReason = /ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE/i.test(sql)
        ? "ALTER TYPE ADD VALUE"
        : /\bCONCURRENTLY\b/i.test(sql)
          ? "CONCURRENTLY"
          : null;
      const needsNoTxn = noTxnReason !== null;

      if (needsNoTxn) {
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)",
            [filename, checksum],
          );
          console.log(`  ✓ ${filename} (no-transaction: ${noTxnReason})`);
        } catch (err) {
          console.error(
            `  ✗ ${filename} — failed (no-transaction, cannot rollback)`,
          );
          throw err;
        }
      } else {
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)",
            [filename, checksum],
          );
          await client.query("COMMIT");
          console.log(`  ✓ ${filename}`);
        } catch (err) {
          await client.query("ROLLBACK");
          console.error(`  ✗ ${filename} — rolled back`);
          throw err;
        }
      }
    }

    console.log(`\nDone. ${pending.length} migration(s) applied.`);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY])
      .catch(() => {});
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
