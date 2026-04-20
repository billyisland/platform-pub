# Code Quality Hardening

Task document for Claude Code. This is a reference catalogue — it documents every viable tool, not a mandate to adopt them all. Read the priority guidance before implementing anything.

## Current state

**What exists:**
- TypeScript `strict: true` via `tsconfig.base.json` (all backend services inherit it)
- `next lint` in `web/` (Next.js default ESLint — no custom `.eslintrc`)
- Vitest in all backend services + shared (4 test files, ~478 lines total)
- Zod for runtime validation on API inputs

**What does not exist:**
- No CI pipeline (no `.github/workflows/`)
- No ESLint on backend services (gateway, payment-service, key-service, key-custody, shared)
- No Prettier or formatting enforcement anywhere
- No test coverage reporting
- No dependency auditing
- No complexity metrics
- No circular dependency detection
- No dead code / unused export detection
- No import boundary enforcement
- No SQL migration linting

## Codebase shape

| Service | Dir | Files | Lines | Tests |
|---|---|---|---|---|
| Web frontend | `web/src/` | 126 | 15,582 | 0 |
| API gateway | `gateway/src/` | 36 | 11,757 | 0 |
| Payment service | `payment-service/src/` | 11 | 2,030 | 1 (settlement) |
| Key service | `key-service/src/` | 10 | 915 | 1 (crypto) |
| Key custody | `key-custody/src/` | 5 | 448 | 1 (crypto) |
| Shared library | `shared/src/` | 13 | 1,221 | 1 (session) |
| SQL schema | `schema.sql` | 1 | ~800 | — |
| Migrations | `migrations/` | 38 | ~1,200 | — |

45 tables, 96 indexes, 102 foreign keys.

---

## Priority guidance — what to actually do

This document catalogues every non-LLM tool worth considering. That does not mean they should all be adopted, especially not at once. Over-tooling has real costs:

**CI friction.** Every tool added to the pipeline is another thing that can fail, another config to maintain, and another reason a PR gets blocked. If a contributor pushes a one-line fix and CI fails because Prettier disagrees with a trailing comma in an unrelated file, that's tax, not quality assurance. The cumulative effect is that people batch changes into larger, harder-to-review commits to avoid running the gauntlet repeatedly.

**Alert fatigue.** If knip reports 40 unused exports, eslint-plugin-security flags 15 false-positive `detect-object-injection` warnings, and SonarCloud shows a technical debt estimate of 3 days — you stop reading any of it. The tools that matter get buried under noise from the tools that don't. This is worse than having fewer tools, because you lose the signal.

**Overlapping jurisdiction.** dependency-cruiser and madge both catch circular dependencies. ESLint complexity rules and SonarCloud both measure function complexity. When two tools disagree or report the same thing differently, you spend time reconciling rather than fixing. Pick one authority per concern.

**Maintenance drag.** Every config file is a surface that needs updating when the codebase changes. Add a new service? Update the CI workflow, the ESLint config, the dependency-cruiser rules, the knip config, and the Prettier ignore. For a solo developer or tiny team, that overhead is disproportionate.

### What to do now (pre-launch, single developer)

**Do immediately:** Tier 1a (CI with `tsc --noEmit` and `vitest run`). This catches regressions with almost zero configuration overhead. TypeScript strict mode and Vitest already exist — they're just not running automatically.

**Do this week:** Tier 1b (ESLint on backend services), but only the promise-safety rules: `no-floating-promises` and `no-misused-promises`. These two rules alone justify the entire ESLint setup. An unhandled promise rejection in a Fastify route handler crashes the process in production; this catches them at lint time. Everything else in the ESLint config is nice-to-have by comparison.

**Skip or defer everything else** until one of these conditions is met:
- A second regular contributor joins (import boundaries, Prettier, and architectural enforcement start earning their keep when you're no longer the only person who knows the architecture)
- The codebase is post-launch and in maintenance mode (dead code detection, complexity dashboards, and coverage thresholds become useful when the rate of change slows and stability matters more than velocity)
- A specific problem emerges that a specific tool solves (formatting inconsistency actually causing merge pain → adopt Prettier; circular dependency found in production → add madge to CI)

Prettier in particular is ceremony for its own sake if you're the sole author and the code is already consistent. dependency-cruiser encodes boundaries you already hold in your head. knip finds dead code you probably already know is dead. These tools exist to compensate for the limits of team-scale coordination — they add less value when coordination isn't a bottleneck.

The tiers below are ordered by value-to-effort ratio. Treat them as a menu, not a checklist.

---

## Tier 1 — CI pipeline and backend linting

### 1a. GitHub Actions CI

Create `.github/workflows/ci.yml`. It should run on push to `master` and on all PRs. Jobs:

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      # Install all workspaces
      - run: npm ci --prefix shared
      - run: npm ci --prefix gateway
      - run: npm ci --prefix payment-service
      - run: npm ci --prefix key-service
      - run: npm ci --prefix key-custody
      - run: npm ci --prefix web
      # Type-check every service
      - run: npx tsc --noEmit -p shared/tsconfig.json
      - run: npx tsc --noEmit -p gateway/tsconfig.json
      - run: npx tsc --noEmit -p payment-service/tsconfig.json
      - run: npx tsc --noEmit -p key-service/tsconfig.json
      - run: npx tsc --noEmit -p key-custody/tsconfig.json
      # Web uses next build which type-checks implicitly
      - run: cd web && npx next lint

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci --prefix shared
      - run: npm ci --prefix gateway
      - run: npm ci --prefix payment-service
      - run: npm ci --prefix key-service
      - run: npm ci --prefix key-custody
      - run: cd shared && npx vitest run
      - run: cd gateway && npx vitest run
      - run: cd payment-service && npx vitest run
      - run: cd key-service && npx vitest run
      - run: cd key-custody && npx vitest run

  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci --prefix shared
      - run: npm ci --prefix gateway
      - run: npm ci --prefix payment-service
      - run: npm ci --prefix key-service
      - run: npm ci --prefix key-custody
      - run: npm ci --prefix web
      # Fail on high/critical vulnerabilities only
      - run: |
          for dir in shared gateway payment-service key-service key-custody web; do
            echo "=== Auditing $dir ==="
            cd $dir && npm audit --audit-level=high && cd ..
          done
```

Note: the install steps may need adjusting — the `shared/` symlink in each service means the service `npm ci` might need `shared/` built first. Check whether each service's `package.json` references `shared` via `file:../shared` or a symlink, and add a `cd shared && npm run build` step before the service installs if needed.

### 1b. ESLint for backend services

Install at the root level so all services share one config:

```bash
npm install -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-plugin-import
```

Create `eslint.config.mjs` at the repo root using flat config:

```js
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['*/src/**/*.ts'],
    ignores: ['web/**', '**/dist/**', '**/node_modules/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: true,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Catch actual bugs
      '@typescript-eslint/no-floating-promises': 'error',   // Critical for Fastify
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',

      // Code hygiene
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'warn',

      // Import discipline
      'no-duplicate-imports': 'error',
    },
  },
];
```

The `no-floating-promises` rule is the single most valuable addition here. An unhandled promise rejection in a Fastify route handler crashes the process. This catches them at lint time.

Add an `eslint` script to the root `package.json`:

```json
{
  "scripts": {
    "lint": "eslint gateway/src payment-service/src key-service/src key-custody/src shared/src",
    "lint:fix": "eslint --fix gateway/src payment-service/src key-service/src key-custody/src shared/src"
  }
}
```

Add `npm run lint` to the CI `typecheck` job.

### 1c. ESLint plugin for security

```bash
npm install -D eslint-plugin-security
```

Add to the flat config's plugins and enable:

```js
rules: {
  'security/detect-object-injection': 'warn',
  'security/detect-non-literal-regexp': 'warn',
  'security/detect-unsafe-regex': 'error',
  'security/detect-buffer-noassert': 'error',
  'security/detect-eval-with-expression': 'error',
  'security/detect-no-csrf-before-method-override': 'error',
  'security/detect-possible-timing-attacks': 'warn',
}
```

---

## Tier 2 — Formatting, coverage, and import boundaries

### 2a. Prettier

```bash
npm install -D prettier
```

Create `.prettierrc` at repo root:

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

Create `.prettierignore`:

```
dist/
node_modules/
package-lock.json
.next/
```

Add scripts to root `package.json`:

```json
{
  "scripts": {
    "format": "prettier --write '**/*.{ts,tsx,js,json,md}'",
    "format:check": "prettier --check '**/*.{ts,tsx,js,json,md}'"
  }
}
```

Add `npm run format:check` to CI. Run `npm run format` once to normalise the entire codebase, then commit that as a single formatting-only commit so git blame stays useful (`git blame --ignore-rev`).

### 2b. Test coverage reporting

```bash
cd shared && npm install -D @vitest/coverage-v8
cd ../gateway && npm install -D @vitest/coverage-v8
cd ../payment-service && npm install -D @vitest/coverage-v8
cd ../key-service && npm install -D @vitest/coverage-v8
cd ../key-custody && npm install -D @vitest/coverage-v8
```

In each service, if there's no `vitest.config.ts`, create one (or add to existing):

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts'],
    },
  },
});
```

Update CI test job to run with coverage:

```yaml
- run: cd shared && npx vitest run --coverage
- run: cd gateway && npx vitest run --coverage
# ... etc
```

Do NOT set a coverage threshold yet. Current coverage is effectively near zero (4 test files across ~32k lines). The goal at this stage is visibility — see the number, decide later when to enforce a floor. A reasonable first target once tests are written would be 40% line coverage on backend services.

### 2c. Import boundary enforcement with dependency-cruiser

```bash
npm install -D dependency-cruiser
```

Create `.dependency-cruiser.cjs` at repo root:

```js
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-web-to-backend',
      comment: 'Web client must not import backend code directly',
      severity: 'error',
      from: { path: '^web/src' },
      to: { path: '^(gateway|payment-service|key-service|key-custody)/src' },
    },
    {
      name: 'no-cross-service-imports',
      comment: 'Services must not import from each other (use HTTP/events)',
      severity: 'error',
      from: { path: '^gateway/src' },
      to: { path: '^(payment-service|key-service|key-custody)/src' },
    },
    {
      name: 'no-cross-service-imports-payment',
      severity: 'error',
      from: { path: '^payment-service/src' },
      to: { path: '^(gateway|key-service|key-custody)/src' },
    },
    {
      name: 'no-cross-service-imports-key',
      severity: 'error',
      from: { path: '^key-service/src' },
      to: { path: '^(gateway|payment-service|key-custody)/src' },
    },
    {
      name: 'no-cross-service-imports-custody',
      severity: 'error',
      from: { path: '^key-custody/src' },
      to: { path: '^(gateway|payment-service|key-service)/src' },
    },
    {
      name: 'no-circular',
      comment: 'No circular dependencies',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
  },
};
```

Add to root `package.json`:

```json
{
  "scripts": {
    "depcheck": "depcruise gateway/src payment-service/src key-service/src key-custody/src shared/src --config .dependency-cruiser.cjs"
  }
}
```

Note: `shared/` imports are allowed from all services — that's the point of a shared library. The rules above only forbid direct cross-service imports.

---

## Tier 3 — Dead code, unused deps, and complexity

### 3a. Dead code detection with knip

```bash
npm install -D knip
```

Create `knip.json` at repo root:

```json
{
  "workspaces": {
    "shared": {
      "entry": ["src/index.ts"],
      "project": ["src/**/*.ts"]
    },
    "gateway": {
      "entry": ["src/index.ts"],
      "project": ["src/**/*.ts"]
    },
    "payment-service": {
      "entry": ["src/index.ts"],
      "project": ["src/**/*.ts"]
    },
    "key-service": {
      "entry": ["src/index.ts"],
      "project": ["src/**/*.ts"]
    },
    "key-custody": {
      "entry": ["src/index.ts"],
      "project": ["src/**/*.ts"]
    },
    "web": {
      "entry": ["src/app/**/page.tsx", "src/app/**/layout.tsx"],
      "project": ["src/**/*.{ts,tsx}"]
    }
  },
  "ignore": ["scripts/**", "migrations/**"]
}
```

Run: `npx knip`

This will report unused exports, unused dependencies in `package.json`, unused files, and unlisted dependencies. Expect noise on the first run — triage the output and add ignores for false positives (e.g. TipTap extensions that are imported dynamically).

### 3b. Circular dependency detection with madge

```bash
npm install -D madge
```

Add to root `package.json`:

```json
{
  "scripts": {
    "circular": "madge --circular --extensions ts gateway/src && madge --circular --extensions ts payment-service/src && madge --circular --extensions ts key-service/src && madge --circular --extensions ts key-custody/src && madge --circular --extensions ts shared/src"
  }
}
```

`dependency-cruiser` also catches circulars (see Tier 2c), so this is a belt-and-braces check. `madge` gives cleaner output for debugging specific cycles. Choose one for CI; keep both available locally.

### 3c. Complexity metrics

No package to install — use `npx` one-shots.

**Option A — eslint complexity rules.** Add to the existing ESLint config:

```js
rules: {
  'complexity': ['warn', { max: 15 }],        // cyclomatic complexity per function
  'max-depth': ['warn', { max: 4 }],           // nesting depth
  'max-lines-per-function': ['warn', { max: 150, skipComments: true, skipBlankLines: true }],
}
```

These are warnings, not errors. The point is to surface the most complex functions for review, not to block PRs. The gateway's route handlers and the payment settlement logic are the most likely offenders.

**Option B — standalone reporting.** For a one-off complexity audit:

```bash
npx cr gateway/src --format json > complexity-report.json
```

(`cr` is `complexity-report`.) This produces per-function cyclomatic and cognitive complexity scores. Sort by score, review the top 10.

---

## Tier 4 — SQL and schema quality

### 4a. Migration linting with squawk

```bash
pip install squawk-cli
# or: brew install squawk
```

Run against all migrations:

```bash
squawk migrations/*.sql
```

Squawk checks for PostgreSQL-specific antipatterns:
- Adding a column with a volatile default (full table rewrite + lock)
- Creating an index without `CONCURRENTLY`
- `NOT NULL` constraint additions without a default
- Missing `IF NOT EXISTS` on index/type creation

This is not a CI gate (migrations are applied once and never re-run), but run it before writing new migrations to catch problems early.

### 4b. Schema health checks

Run these queries against the local database to find structural issues:

**Foreign keys missing indexes** (causes slow deletes and joins):

```sql
SELECT
  conrelid::regclass AS table_name,
  conname AS fk_name,
  a.attname AS column_name
FROM pg_constraint c
JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
WHERE contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND a.attnum = ANY(i.indkey)
  );
```

**Unused indexes** (bloat without benefit — run after the app has been exercised):

```sql
SELECT schemaname, relname, indexrelname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexrelname NOT LIKE '%_pkey'
ORDER BY pg_relation_size(indexrelid) DESC;
```

**Tables without primary keys** (should be zero but worth verifying):

```sql
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename NOT IN (
    SELECT table_name FROM information_schema.table_constraints
    WHERE constraint_type = 'PRIMARY KEY'
  );
```

These are manual / periodic checks, not CI.

---

## Tier 5 — Dashboard-level analysis (periodic, not CI)

### 5a. SonarCloud

Free for public repos. Connect at sonarcloud.io, link the GitHub repo. It provides:
- Cognitive complexity per function (better than cyclomatic for readability assessment)
- Duplicated code blocks across the entire codebase
- Technical debt estimate (time-to-fix aggregate)
- Security hotspot detection

Not a CI gate. Review the dashboard weekly/fortnightly.

### 5b. Git-based hotspot analysis

No tool needed — just git:

```bash
# Files with the most churn (most commits)
git log --format=format: --name-only | sort | uniq -c | sort -rn | head -20

# Files changed by the most distinct authors (bus factor / complexity proxy)
git log --format='%an' --name-only | awk '/^$/{next} /^[^\t]/{author=$0;next} {print author, $0}' | sort -u | awk '{print $NF}' | sort | uniq -c | sort -rn | head -20
```

High-churn files that also have high complexity scores are the most valuable targets for refactoring and test coverage.

---

## Implementation order

**Now:**
1. **CI pipeline** (1a) — immediate, everything else depends on this
2. **Backend ESLint** (1b, promise-safety rules only) — same PR as CI

**When a second contributor joins or post-launch:**
3. **Prettier** (2a) — one formatting commit, then enforce in CI
4. **Import boundaries** (2c) — catches architectural drift across multiple authors
5. **Coverage reporting** (2b) — add to CI, no threshold until tests are written
6. **Security lint rules** (1c) — extend the existing ESLint config

**When a specific need arises:**
7. **knip** (3a) — run once to clean up dead code, add to CI if accumulation is a problem
8. **Complexity rules** (3c) — add to ESLint as warnings if large functions are causing bugs
9. **squawk** (4a) — run before each new migration
10. **Schema checks** (4b) — run once against local DB, fix any missing FK indexes
11. **SonarCloud** (5a) — connect when a team dashboard would be useful
12. **Hotspot analysis** (5b) — run once to identify refactoring targets
