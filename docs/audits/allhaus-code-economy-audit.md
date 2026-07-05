# platform-pub — Code Economy Audit

**Date:** 2026-07-05 · **Scope:** concision of expression, efficiency of organisation, and database-call intelligence across all services (~106k lines TS: web 47k, gateway 33k, feed-ingest 12k, payment-service 6k, shared 3.5k). Companion to the logic/payment-economy report of the same date.

**Verdict:** the codebase is economical in *pattern* but uneven in *adoption*. Where a discipline exists — the ledger funnel, `per-read-net.ts`, the extracted `feed-sql.ts`/`dedup-sql.ts`, the one-round-trip workspace bootstrap, the three-phase Stripe pattern reused verbatim across four payout kinds — it is excellent, and clearly the product of the audit-and-remediate cadence visible in feature-debt.md. The waste is where a discipline was declared but not propagated (SQL sites still hand-roll the fee formula the shared helper exists to prevent), where the hot path pays a per-request tax nobody priced (auth), and where index hygiene applied to new tables was never backported to old ones.

---

## 0. Implementation status (2026-07-05)

The safe, verifiable findings were implemented and the DB/test/lint gates run green; a few claims did not survive verification and are corrected below. Verification run: `payment-service` 88/88 tests, `gateway` 141/141, root `npm run lint` 0 errors, `web` `next build` clean, `check-schema-drift.sh` / `check-ledger-adjacency.sh` / `check-hairlines.sh` exit 0.

| # | Item | Disposition |
| --- | --- | --- |
| 6.4 | `readNetSql` sweep | **Done.** Eight sites across `my-account.ts` (176/304), `publications/revenue.ts` (×4), `payout.ts` (901/1024). `computePublicationSplits` pool-fee comment added (6.4). |
| 1.5 | Accrual config cache | **Done — bigger than reported.** `getConfig()`/`invalidateConfig()` had **zero callers**; the whole cache (and its `loadConfig`/`PlatformConfig`/`CONFIG_TTL_MS`) was dead code, deleted outright. The audit framed it as "redundant with `loadConfig`"; it was never wired to anything. |
| 6.1 | Auth account-check cache | **Done.** 8s in-process TTL map in `middleware/auth.ts`, consumed by `requireAuth`/`optionalAuth`; `invalidateAuthCache()` wired at all four write sites (logout-all, self-deactivate, both moderation suspends). `auth-middleware.test.ts` updated to reset the module-level cache between cases. |
| 6.5 | `timeAgo` dedup | **Done, with correction.** Not "three byte-identical copies": `NotificationsPanel`/`ReportCard` are identical (long form, "5m ago"); `ConversationList` is a **distinct compact variant** ("5m", "now") and `PlayscriptReply` has **none**. Unified into `web/src/lib/format.ts::timeAgo(iso, { compact? })`, preserving both renderings. |
| 6.5 | `x-internal-token` guard | **Done, with correction.** Four inline checks in **one** file (`payment.ts`), not five scattered preHandlers; the "`payment.ts:117,134` raw-string guards" don't exist (that file validates via zod `.uuid()`). Collapsed to one `requireInternalToken` preHandler on the four mutating routes (the two `/earnings` GETs stay intentionally open) + constant-time compare. |
| 6.5 | UUID dedup | **Done.** New canonical `gateway/src/lib/uuid.ts` (`UUID_RE` + `isUuid`); ~13 local defs replaced with imports; `feeds/shared.ts` and `articles/shared.ts` re-export it. Standardised on case-insensitive (safe superset). |
| 6.3 | Partial payout indexes | **Done (add-only), with two corrections.** Migration `138` adds the two settled-unpaid partial indexes, `schema.sql` regenerated + drift-checked. (a) Keyed on the real seek columns `read_events(writer_id)` / `vote_charges(recipient_id)`, **not** the audit's `(writer_payout_id)` (which is `IS NULL` across the whole partial set — zero selectivity). (b) The bare `idx_*_state` indexes are **kept**, not dropped — state-only scans exist (revenue dashboards, reader statement, settlement) and no `EXPLAIN` evidence yet shows them unused; dropping them is a separate measured follow-up. |
| 1.6 | Ledger scale-horizon note | **Done.** One-paragraph note added to the `ledger.ts` header. |
| 6.2 | Set-based ledger INSERTs | **Deferred (see §1.4 note).** Real perf finding, but the fix conflicts with the ledger-adjacency CI guard (Guard 1 counts `recordLedger()` calls per file against a registered minimum; an `INSERT…SELECT` removes them) and needs a full reconciliation run on a clean DB (dev DB has known migration drift). Doing it safely means coordinated guard changes — beyond a mechanical sweep; the correctness half also rests on the companion logic report's finding 6, unverified here. |
| 6.6 | Extend `knip` to gateway/web | **Deferred.** `npx knip` runs in CI; extending the config without first triaging the dead-code findings turns CI red. The triage is the real work, not the config line. |
| 6.6 | Split `payout.ts` | **Deferred.** Structural; the audit itself schedules it after the money-path changes. |

---

## 1. Database calls

### 1.1 The hottest query in the system is an uncached per-request SELECT  ·  [DONE — see §0]

> Note: "hottest query" is a reasoned hypothesis, not a profiled measurement (the audit concedes it was "a tax nobody priced"). The fix is still a clear win — one guaranteed round trip per authed request removed — but the superlative is unmeasured.

`requireAuth` and `optionalAuth` (`gateway/src/middleware/auth.ts:61, 107`) hit `accounts` for `status, sessions_invalidated_at` on **every authenticated request**. JWT verification is free; this lookup makes every API call cost a DB round trip before the route runs. The two things it buys — suspension and logout-all-devices — tolerate seconds of staleness. A 5–10s in-process cache keyed by account id (or a token-version claim checked against a small cached map) removes the single largest source of aggregate query volume in the gateway at near-zero behavioural cost.

### 1.2 The "single definition" of read-net has eight holdouts  ·  [DONE — see §0]

> **Correction:** eight sites, not nine — and the count in this paragraph originally omitted `my-account.ts`. The full set (now swept): `payout.ts:901`/`:1024`, `publications/revenue.ts:281/283/285/299`, and `my-account.ts:176/304`.

`per-read-net.ts` exists precisely because the fee formula "was hand-duplicated across ~12 SQL sites… if the formula drifted, conservation and the dashboard would diverge." The consolidation was incomplete: `payout.ts:901` and `:1024` (publication eligibility and per-article earnings), four sites in `gateway/src/routes/publications/revenue.ts:281–299`, and two in `gateway/src/routes/my-account.ts` still inlined `amount_pence - FLOOR(amount_pence * $n / 10000)`. They happened to match; the module's own header explains why that's not good enough. (`computePublicationSplits`' pool-fee floor at `payout.ts:68` is a different formula — sum-then-floor on gross — which is itself a divergence from the per-row rule worth an explicit comment or reconciliation.)

### 1.3 Index hygiene was applied to the new tables and not backported  ·  [DONE (add-only) — see §0]

The tribute tables got the right treatment: partial indexes matching their exact hot predicates (`idx_tribute_accruals_released_unclaimed`, `_swept_unclaimed`). The older money tables did not. The daily payout cycle's workhorse predicate — `read_events WHERE state = 'platform_settled' AND writer_payout_id IS NULL` (and the same on `vote_charges`) — has no matching index; it leans on `idx_read_events_state`, a single low-cardinality column whose selectivity collapses as terminal-state rows (`writer_paid`, `charged_back`) accumulate forever. Add partial indexes mirroring the tribute pattern, and consider dropping `idx_read_events_state` and `idx_vote_charges_state` outright — bare state indexes on append-forever tables are write overhead with shrinking read value. Same review for `idx_tribute_accruals_state`.

### 1.4 Row-at-a-time ledger writes inside locked transactions  ·  [DEFERRED — see §0]

`confirmSettlement` posts one `recordLedger` INSERT per settled read, sequentially, inside the transaction that holds the tab lock (`settlement.ts:560`); `convertProvisionalReads` does the same per converted read and vote (`accrual.ts:270`). A heavy reader's settlement means hundreds of serial round trips under lock. Both loops are pure projections of rows already selected in the same transaction — each is expressible as a single `INSERT INTO ledger_entries … SELECT …`, which is also *safer*: the confirmSettlement version would derive from the same `tab_settlement_id` predicate as the advancement UPDATE, eliminating the select-vs-update snapshot gap flagged as finding 6 in the logic report. One change fixes a correctness bug and a performance smell together. (`processPublicationSplits`' per-split account SELECT is a milder N+1; N is member count, leave it.)

### 1.5 Two config caches stacked  ·  [DONE — dead code, see §0]

`AccrualService` maintains its own 5-minute config cache with an `invalidateConfig()` method (`accrual.ts:57–73`) on top of `loadConfig`'s 30-second shared cache. **[CORRECTED — see §0]** On verification it was worse than redundant: `getConfig()` and `invalidateConfig()` had **zero callers** — `recordGatePass` never reads config (the fee is applied downstream via `readNetSql`). The entire cache, plus its now-unused `loadConfig`/`PlatformConfig`/`CONFIG_TTL_MS`, was dead code and was deleted outright (not "call `loadConfig()` directly" — nothing was calling anything).

### 1.6 Ledger views: fine now, note the horizon  ·  [DONE (note added) — see §0]

`ledger_reader_balance` / `ledger_writer_earned` are plain views aggregating each account's *entire* append-only history per query, served by `idx_ledger_entries_account_created`. Correct and cheap at current scale; per-dashboard-hit cost grows linearly with account age forever. When it bites, the fix is a materialized running balance or a summary row — worth a one-line note in the ledger header so the eventual migration is anticipated rather than diagnosed.

### 1.7 Where DB calls are organised intelligently

Credit where due: the workspace front door was collapsed to a single `bootstrap()` round trip (the old list + per-feed sources + items fan-out is gone); feed candidate SQL lives once in `feed-sql.ts`/`post-mapper.ts` with the route importing fragments; `getOrCreateTab` and the unlock upserts handle their races correctly; `places` where batch semantics matter (`UPDATE … RETURNING` in the vote-charge conversion, `ANY($1::uuid[])` in the chargeback applier) use them. The system's *best* query code and its laggards coexist file-by-file — the pattern library exists; it needs sweeping.

---

## 2. Duplication

**[CORRECTED / DONE — see §0]** `timeAgo` lived in three components — `NotificationsPanel.tsx` and `ReportCard.tsx` (byte-identical long form) and `ConversationList.tsx` (a *distinct compact variant*); `PlayscriptReply.tsx` has **none** (the original claim here was wrong on both). Unified into `web/src/lib/format.ts` with a `compact` option preserving both renderings. The UUID regex appeared ~13 times as local `UUID_RE` defs across gateway route params — now one canonical `gateway/src/lib/uuid.ts` (`z.string().uuid()` remains the choice for the zod-validated params). The `x-internal-token` check was hand-copied **four times in one file** (`payment.ts`), not five scattered preHandlers — collapsed to a single `requireInternalToken` preHandler that also fixes the non-constant-time comparison. The web `slugify` mirror of `shared/src/lib/slug.ts` is deliberate and drift-tested — that's the right way to duplicate; the `timeAgo`s and UUID regexes were the wrong way.

The largest duplication, though, is a product decision: retired paid voting still threads `vote_charges` through accrual conversion, settlement advancement, payout eligibility, chargeback planning, KYC reconciliation, the gateway route, the shared pricing lib, and the web controls. Every money-path fix pays a voting tax until it's excised.

---

## 3. Organisation and file shape

**Gateway routes are a fat-controller layer.** 268 `.query(` call sites live directly in `gateway/src/routes` versus 46 in services+lib — the payment-service's shape (thin routes, logic in services, pure functions for testable math) never crossed over. This is a known parked item (the "gateway monolith") and I wouldn't force a repository layer — inline SQL is honest and greppable — but the *test surface* consequence is real: the route files with the most queries (`auth.ts` 17, `drives.ts` 20, `feeds/sources.ts` 14) are exactly the ones without pure extractable cores, and it shows in what the test suite can and can't pin.

**A handful of files carry disproportionate mass.** `payout.ts` (1,983 lines) is three independent payout cycles plus KYC reconciliation sharing one class for no reason beyond a shared Stripe client — split by cycle; each half becomes reviewable. On the web side, `WorkspaceView.tsx` (1,561), `FeedComposer.tsx` (1,426), `UpstreamEdges.tsx` (1,300), and `resolver.ts` (1,496, gateway) are the decomposition debt; everything else in a 153-component tree is reasonably sized. `gateway/src/index.ts` registering ~40 route modules by hand is verbose but harmless.

**Dead-code tooling doesn't cover where dead code accrues.** `knip.json` scopes only `scripts` and `shared`; gateway and web — where the feed-retirement and route-retirement passes have repeatedly left orphans that later audits hunted by grep — are unconfigured. Extending knip to those workspaces automates a chore feature-debt.md shows being done manually every few weeks. `planning-archive/` (1.6 MB, 36 files) is harmless in-repo history; fine to keep, but it and `docs/` together are ~3 MB of prose in every clone — a candidate for a separate branch if it keeps growing.

---

## 4. Concision of expression

The code itself is tight: minimal abstraction ceremony, no speculative generics, pure functions where math needs testing, and the SQL is written directly rather than through an ORM's fog. Where the codebase spends words is *comments* — `ledger.ts` is roughly 60% commentary, and the settlement/payout/chargeback files carry long narrative headers restating ADR reasoning. For a solo-maintained system with this much invariant density, most of that earns its keep; the ledger sign-convention block and the chargeback conservation proof are exactly what a future you needs. The marginal cases are comments that restate an ADR paragraph verbatim (they drift when the ADR is amended) and changelog-style annotations (`FIX #12`, `STRIPE audit S1`) that accumulate without expiry — consider a convention that fix-tags older than N months get folded into plain description. Minor; the comment culture is a net asset.

---

## 5. Ranked recommendations

First, cache the auth account check (1.1) — largest query-volume win, one file. Second, convert the two ledger loops to set-based INSERTs (1.4) — fixes a correctness race and a hot-lock smell in one change. Third, add the two partial indexes and retire the bare state indexes (1.3). Fourth, finish the `readNetSql` adoption sweep (1.2) — mechanical, nine sites. Fifth, split `payout.ts` and extend knip to gateway/web (3). The duplication items (2) are an afternoon; do them opportunistically. The voting excision is the big organisational dividend but is gated on the product decision already flagged in the companion report.

---

## 6. Fix implementation plan

Ordered by the §5 ranking, with the corrections surfaced while verifying this audit against the tree (2026-07-05): the `readNetSql` sweep is **eight** sites not six — it must include `my-account.ts:176,304`, which `per-read-net.ts`'s own header already names; the `x-internal-token` duplication is **four inline checks in one file** (`payment-service/src/routes/payment.ts`), not five scattered preHandlers, so its fix is local; `timeAgo` is **three** byte-identical copies (`NotificationsPanel`, `ReportCard`, `ConversationList` — *not* `PlayscriptReply`, which has none).

Each step is independently shippable and independently revertable. Money-path steps (6.2, 6.3) must keep `scripts/check-ledger-adjacency.sh` and `scripts/reconcile-ledger.sql` green; schema steps (6.3) must pass `scripts/check-schema-drift.sh`.

### 6.1 Cache the auth account check — `gateway/src/middleware/auth.ts`  ·  [DONE — see §0]

- Add a module-level `Map<accountId, { status, sessions_invalidated_at, expdAt }>` with a 5–10s TTL, consulted by both `requireAuth` (`:61`) and `optionalAuth` (`:108`) before the `SELECT`.
- On a cache hit inside TTL, skip the DB round trip; on miss/expiry, do the existing query and populate the entry.
- **Correctness bound the cache must respect:** the two things the row gates — suspension and logout-all-devices — become up-to-TTL-stale. That is acceptable *only* because both are already eventually-consistent (a live session persists until its own expiry today). Add `invalidateAuthCache(accountId)` and call it from the suspension path and the `sessions_invalidated_at` writer so an admin action is not silently deferred by up to TTL.
- Keep it in-process (no Redis) — the gateway is single-writer for this; a per-instance map is enough and matches `loadConfig`'s existing pattern.
- **Verify:** hit any authed route twice within TTL and confirm one `accounts` query, not two (query log / `pg_stat_statements`); suspend a test account and confirm access is revoked within TTL after `invalidateAuthCache`.

### 6.2 Set-based ledger INSERTs — `settlement.ts:554`, `accrual.ts:262`  ·  [DEFERRED — see §0]

> Deferred on verification: an `INSERT…SELECT` removes the `recordLedger()` calls that `check-ledger-adjacency.sh` Guard 1 counts per file against a registered minimum, so the CI guard would need coordinated changes, and the balance-parity claim needs a reconciliation run on a clean DB. Not a mechanical sweep. The steps below stand for when it's picked up deliberately.

Replace each `for … recordLedger()` loop with one `INSERT INTO ledger_entries (…) SELECT … FROM read_events WHERE <same predicate>`:

- **`confirmSettlement`** (`settlement.ts:559` loop): derive the INSERT from the *same* `tab_settlement_id = $1 AND state = 'platform_settled'` predicate the select at `:554` uses, so the ledger rows and the advancement `UPDATE` read one snapshot — this closes the select-vs-update gap flagged as finding 6 in the companion logic report. Preserve the `net === 0` skip as `WHERE <readNetSql(...)> <> 0`.
- **`convertProvisionalReads`** (`accrual.ts:262`, plus the vote-charge loop below it): one INSERT…SELECT per relation; the summed debit must still equal the single `reading_tabs.balance_pence` increment posted just above (`accrual.ts:270`) — assert this in the test, since the whole point of the ledger mirror is `−SUM == balance`.
- `recordLedger` is the funnel the adjacency tripwire keys on; an INSERT…SELECT bypasses it, so **the trigger-type set at these two sites is unchanged** (`writer_accrual`, `read_accrual`, and the vote trigger) and the set-based rows must carry the identical `trigger_type`/`ref_table`/`ref_id`/counterparty columns. Confirm `scripts/check-ledger-adjacency.sh` still recognises the site (it greps for the balance-mirror marker, not for `recordLedger` specifically — verify the marker survives, or the CI job fails).
- **Verify:** run `scripts/reconcile-ledger.sql` before/after on a seeded settlement + conversion; balances identical to the penny. Add a unit test that a multi-read settlement posts exactly one round trip.

### 6.3 Partial indexes + retire bare state indexes — migration `138_payout_predicate_indexes.sql`  ·  [DONE (add-only), CORRECTED — see §0]

- Add partial indexes mirroring the tribute pattern — **as shipped**, keyed on the real seek columns (the audit's `(writer_payout_id)` key is `IS NULL` across the whole partial set, so it carries no selectivity):
  - `CREATE INDEX idx_read_events_settled_unpaid ON read_events (writer_id) WHERE state = 'platform_settled' AND writer_payout_id IS NULL;`
  - `CREATE INDEX idx_vote_charges_settled_unpaid ON vote_charges (recipient_id) WHERE state = 'platform_settled' AND writer_payout_id IS NULL;`
- **Not done:** dropping `idx_read_events_state` / `idx_vote_charges_state`. State-only scans exist (revenue dashboards, reader statement, settlement) and there's no `EXPLAIN` evidence the bare indexes are unused; retiring them (and reviewing `idx_tribute_accruals_state`) is a separate measured follow-up, not a blind drop.
- **Follow the schema discipline (CLAUDE.md):** apply the migration to a dev DB, regenerate `schema.sql` via `pg_dump`, re-append the `_migrations` seed in the same step, then run `scripts/check-schema-drift.sh` (must exit 0). Do **not** hand-edit `schema.sql` or the seed line.
- Use `CREATE INDEX CONCURRENTLY` in the prod runbook note (can't run inside the migration txn) — or accept the brief lock at current table size and document it.
- **Verify:** `EXPLAIN` the payout-cycle query (`payout.ts:895`-region) before/after — confirm an index scan on the new partial index, not a seq/`idx_*_state` scan.

### 6.4 Finish the `readNetSql` sweep — eight sites, three files  ·  [DONE — see §0]

Replace each inline `amount_pence - FLOOR(amount_pence * $n / 10000)` with `readNetSql('<col>', '$n')`:

| File | Lines |
| --- | --- |
| `gateway/src/routes/my-account.ts` | 176, 304 |
| `gateway/src/routes/publications/revenue.ts` | 281, 283, 285, 299 |
| `payment-service/src/services/payout.ts` | 901, 1024 |

- Import `readNetSql` where not already imported (`revenue.ts`, `my-account.ts`).
- Mind the parameter placeholder: the helper takes the *placeholder string* (`'$2'`), so each call must pass the site's actual fee-bps parameter index — check each query's arg array.
- **Leave `payout.ts:68` alone** but add a one-line comment: `computePublicationSplits` uses sum-then-floor on gross (pool fee), a deliberately *different* formula from the per-row rule — flag it so a future reader doesn't "consolidate" it into `readNetSql` and change the rounding.
- **Verify:** `tests/payout-math.test.ts` and the per-read-net tests stay green; the rendered SQL is behaviourally identical (pure refactor), so a reconciliation run should show zero delta.

### 6.5 Duplication cleanup (opportunistic afternoon)  ·  [DONE, CORRECTED — see §0]

- **`timeAgo` → one helper.** Extract to `web/src/lib/time.ts` (or reuse an existing date util if one exists); import in `NotificationsPanel.tsx`, `ReportCard.tsx`, `ConversationList.tsx`. Three identical copies → one.
- **UUID validation → one schema.** ~13 hand-rolled `UUID_RE` literals + 23 `z.string().uuid()` calls. Standardise on `z.string().uuid()` for Zod-validated params; for the raw-string guards (`payment.ts:117,134`, the `UUID_RE` route consts), export a single `UUID_RE` (or `isUuid()`) from a shared module and import it.
- **`x-internal-token` → one guard in `payment.ts`.** The four inline `req.headers['x-internal-token'] !== expectedToken` checks (`payment.ts:44,79,149,167`) collapse to one Fastify preHandler registered on the internal routes — and fix the non-constant-time `!==` on the secret (`crypto.timingSafeEqual` over equal-length buffers) in that one place. This is local to `payment-service`; no cross-service plugin needed.
- **Verify:** `npm run lint` (root, 0 errors) + the web `next build` pre-flight for the `timeAgo` move.

### 6.6 Structural (larger, schedule deliberately)

- **Split `payout.ts` (1,983 lines)** by cycle — writer payout / publication distribution / tribute payout / KYC reconciliation — each into its own service module sharing the Stripe client via injection, not co-location. Pure refactor; land behind the same test suite. Do this *after* 6.2/6.4 so the money-path changes aren't tangled with a file move.
- **Extend `knip.json`** to the `gateway` and `web` workspaces so the dead-code sweep the team currently does by grep every few weeks runs in CI. Expect an initial batch of findings from the feed-/route-retirement orphans; triage once, then it stays clean. **[DEFERRED — see §0:** `npx knip` is already a CI job, so extending the config without first doing the triage pass turns CI red; the triage is the real work.**]**
- **`ledger.ts` horizon note (1.6).** One-line comment in the ledger view header anticipating the materialized-running-balance migration, so the eventual scale fix is planned, not diagnosed.

### 6.7 Not in scope here

The voting excision (§2, largest organisational dividend) stays gated on the product decision in the companion report — do not begin threading `vote_charges` out until that lands, or the money-path steps above will churn.
