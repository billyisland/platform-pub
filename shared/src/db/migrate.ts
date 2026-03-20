import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import pg from 'pg'

// =============================================================================
// Migration Runner
//
// Simple, sequential migration runner. Tracks applied migrations in a
// _migrations table. Runs all .sql files in the migrations/ directory
// in lexicographic order.
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
// =============================================================================

const { Pool } = pg

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  })

  const client = await pool.connect()

  try {
    // Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    // Get already-applied migrations
    const { rows: applied } = await client.query<{ filename: string }>(
      'SELECT filename FROM _migrations ORDER BY filename'
    )
    const appliedSet = new Set(applied.map((r) => r.filename))

    // Find migration files
    const migrationsDir = path.resolve(process.cwd(), 'migrations')

    if (!fs.existsSync(migrationsDir)) {
      console.log('No migrations/ directory found — nothing to run.')
      return
    }

    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()

    const pending = files.filter((f) => !appliedSet.has(f))

    if (pending.length === 0) {
      console.log('All migrations already applied.')
      return
    }

    console.log(`Found ${pending.length} pending migration(s):`)

    for (const filename of pending) {
      const filepath = path.join(migrationsDir, filename)
      const sql = fs.readFileSync(filepath, 'utf8')

      console.log(`  Applying: ${filename}`)

      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO _migrations (filename) VALUES ($1)',
          [filename]
        )
        await client.query('COMMIT')
        console.log(`  ✓ ${filename}`)
      } catch (err) {
        await client.query('ROLLBACK')
        console.error(`  ✗ ${filename} — rolled back`)
        throw err
      }
    }

    console.log(`\nDone. ${pending.length} migration(s) applied.`)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
