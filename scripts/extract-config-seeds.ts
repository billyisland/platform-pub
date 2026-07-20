import fs from "fs";
import path from "path";

// =============================================================================
// extract-config-seeds.ts — emit every `INSERT INTO platform_config` statement
// found in migrations/, to stdout, in chronological order.
//
// Used by scripts/check-schema-drift.sh (Check 4c) to prove that
// shared/src/db/config-defaults.sql covers every dial the historical migrations
// ever seeded: the guard applies config-defaults.sql to an empty table, then
// replays this output on top with ON CONFLICT DO NOTHING and asserts the row
// count did not move. A key dropped from the defaults file inserts here and
// trips the check.
//
// Why a real splitter and not a grep: several seed blocks carry descriptions
// containing a semicolon ("reserved; inert until zap ingestion") or an em dash,
// and the values span many lines. A naive `sed '/INSERT/,/;/p'` truncates those
// blocks mid-statement — it silently dropped 6 of migration 158's 10 keys when
// this gap was first being measured. Postgres does the parsing of the emitted
// SQL; this file only has to find statement boundaries, which means respecting
// string literals, `''` escapes, dollar-quoting and both comment forms.
// =============================================================================

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      buf += c;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            buf += "''";
            i += 2;
            continue;
          }
          buf += "'";
          i++;
          break;
        }
        buf += sql[i];
        i++;
      }
      continue;
    }
    if (sql.startsWith("--", i)) {
      const j = sql.indexOf("\n", i);
      const end = j === -1 ? sql.length : j;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const j = sql.indexOf("*/", i);
      const end = j === -1 ? sql.length : j + 2;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql.startsWith("$$", i)) {
      const j = sql.indexOf("$$", i + 2);
      const end = j === -1 ? sql.length : j + 2;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === ";") {
      out.push(buf + ";");
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

const dir = path.resolve(process.cwd(), "migrations");
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));

let count = 0;
for (const f of files) {
  for (const stmt of splitStatements(fs.readFileSync(path.join(dir, f), "utf8"))) {
    // Match on a comment-stripped copy so prose mentioning the table doesn't
    // qualify; emit the ORIGINAL statement so nothing is lost in translation.
    const bare = stmt
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ")
      .trim();
    if (!/^INSERT\s+INTO\s+platform_config\b/i.test(bare)) continue;
    // Every emitted statement must be idempotent — two historical seeds (038,
    // 052) carry no ON CONFLICT clause, which was fine once but not on replay.
    const sql = /ON\s+CONFLICT/i.test(bare)
      ? stmt.trim()
      : `${stmt.trim().replace(/;\s*$/, "")}\nON CONFLICT (key) DO NOTHING;`;
    console.log(`-- from ${f}`);
    console.log(sql.endsWith(";") ? sql : `${sql};`);
    console.log();
    count++;
  }
}
console.error(`extract-config-seeds: ${count} statement(s) from ${files.length} migrations`);
