# platform-pub — independent audit

**Date:** 2026-06-02 · **Commit:** `3001c41` · **Method:** tooling-led whole-repo sweep (tsc strict across all 9 workspaces, eslint, repo-wide dead-export scan, structural-smell greps, migration/schema reconciliation, targeted reads of flagged code). Prior audit docs deliberately ignored.

> **Resolution status (2026-06-02, post-verification).** Findings independently re-verified against the code before action.
> - **#2 — FIXED.** `shared/src/db/migrate.ts` `needsNoTxn` now also detects `CONCURRENTLY`; the no-txn log line names the reason.
> - **#3 — FIXED.** `gateway/src/routes/feeds.ts` now has one format-tagged cursor codec (`encodeFeedCursor`/`decodeFeedCursor`) with self-describing `scored:`/`explore:` tags; the two divergent 2-part parsers are gone. A cursor from the wrong branch (or any untyped/stale string) decodes to `undefined` → clean restart, never a mis-ordered page.
> - **#1 — DEFERRED to a dedicated session** (the schema/migration regeneration is the riskiest change and wants its own focused pass + a fresh-DB boot test). Still the top priority; nothing else in here blocks a deploy the way it does.
> - **#4 — CORRECTION: largely a false finding.** The resolver is *not* stubbed. `classifyInput` classifies `bluesky_handle`/`fediverse_handle`/`did`/`ambiguous_at`, and the dispatch runs real Phase-B chains backed by fully-implemented `resolveAtproto`/`resolveActivityPubHandle`/`resolveActivityPubByActor`. The only defect is the **stale header comment** at `resolver.ts:33` ("Bluesky/fediverse chains are stubs returning coming soon") — delete it. (See also the related overstatement in #10: `web/` is not unlinted — it runs `next lint`; the accurate point is only that the *root* config's floating-promise rule doesn't reach `web/`.)

## Baseline (stated honestly, because it's unusual)

The mechanical hygiene is high and worth not second-guessing:

- **Compiles clean under `strict`** across all nine workspaces once `shared` is built. Every type error I first saw was downstream of `shared/dist` not existing.
- **Floating-promise lint clean** — the net the eslint config exists to provide.
- Parameterised SQL throughout; the injection sweep found nothing.
- Internal-service auth fails closed (`!expectedToken ||`) and each service `requireEnv`s its secrets at boot.
- 7 TODO/FIXME total, **0** `@ts-ignore`, **0** empty catch blocks, **3** dead exports repo-wide.

So the findings below are not a code-quality indictment. They cluster in three places: **the deploy/migration path**, **a few load-bearing "temporary" decisions that calcified**, and **the untyped DB-row boundary**.

---

## High — will break a fresh deploy

**1. `schema.sql` is stale and the migration story is internally contradictory.**

- `schema.sql` is documented (DEPLOYMENT.md:199, 320, 698) as "synced through migration **097**." There are **101** migrations. 098–101 are the entire UNIVERSAL-POST-ADR work (post identity, external-author identity, repost edges, relay-free nostr) — referenced across live code: `post-feed.ts`, `post-thread.ts`, `author-card.ts`, `external-items.ts`, `post-mapper.ts`, `repost-edge.ts`, `web/src/lib/post/*`. So this drift lands on the newest, most active path.
- `schema.sql` is a **schema-only** `pg_dump` (zero `COPY` statements). A fresh DB therefore boots with an **empty `_migrations` table** — *not* "pre-seeded accordingly" as DEPLOYMENT.md:199 claims. That claim is false.
- Consequence, both branches broken:
  - *Don't run migrate* (what the doc tells you to do for a fresh DB): you're silently missing 098–101.
  - *Do run migrate*: empty `_migrations` ⇒ all 101 treated as pending ⇒ it runs `001`'s `CREATE TABLE` against the already-built schema and dies on the first conflict.
- **Fix:** regenerate `schema.sql` from a fully-migrated DB on every release (or drop it and make `migrate.ts` the only path), and seed `_migrations` in the same dump so fresh = consistent. Decide on *one* mechanism; right now two half-mechanisms interfere.

---

## Medium — latent bugs

**2. `migrate.ts` wraps every migration in `BEGIN/COMMIT`, but two use `CREATE INDEX CONCURRENTLY`.**
`shared/src/db/migrate.ts` only exempts `ALTER TYPE … ADD VALUE` from its transaction via the `needsNoTxn` regex. Migrations **022** and **083** use `CONCURRENTLY`, which Postgres refuses inside a transaction block. They've never actually run through the runner (they're baked into `schema.sql` ≤097), so the failure is dormant — it detonates for anyone migrating a DB initialised from a pre-022/083 schema. **Fix:** broaden `needsNoTxn` to detect `CONCURRENTLY` (and any other non-transactional DDL), or split such statements into their own files.

**3. `feeds.ts` has two incompatible cursor parsers.**
`parseCursor` (L1092) accepts 3-part `score:ts:id` *and* 2-part; `parseScoredCursor` (L1700) accepts 2-part only. Their 2-part interpretations **disagree**: `parseCursor` reads `ts:id`, `parseScoredCursor` reads `score:id`. The placeholder path (L1717) mints/parses 3-part; the source-filtered path (L1618) uses 2-part-only.
- *Documented* failure (comment at L370): feed gains its first source mid-session → stale 3-part cursor rejected → client restarts from page 1.
- *Undocumented* failure: a 2-part cursor read by the wrong parser is silently mis-ordered (timestamp interpreted as score), not rejected.
**Fix:** one cursor codec for the endpoint, format-tagged, parsed in one place.

---

## Design / function-level

**4. `resolver.ts` advertises capabilities it stubs.** The `InputType` union declares `bluesky_handle`, `fediverse_handle`, `did`, `ambiguous_at`, but the header comment notes these are "stubs returning coming soon." Meanwhile `feed-ingest` *does* have working `activitypub.ts` / `atproto.ts` adapters. So ingest can pull from AP/ATProto, but the user-facing resolve path (subscribe/invite/dm) can't classify them. Either wire the resolver to the adapters that exist, or remove the union members so the type stops lying about coverage.

**5. The "placeholder" explore-fallback is load-bearing.** `/feeds/:id/items` with `source_count === 0` falls through to `placeholderExploreItems` — framed in comments as temporary "until source-set wiring is done." It's the default experience of every empty vessel and carries its own (incompatible, see #3) cursor scheme. A temporary measure that became permanent without being promoted to a real, owned code path.

**6. No central, validated config.** `shared/src/lib/env.ts` is a `requireEnv` helper, not a schema. 58 ad-hoc `process.env.X` reads across services; secrets compared with `!==` rather than `crypto.timingSafeEqual` (low severity, but free to fix). A single zod-validated config object parsed once at boot would remove the "silently `undefined`" class entirely.

**7. The DB→object boundary is untyped — the one place strict mode buys nothing.** 117 of 143 eslint warnings are `no-explicit-any`, concentrated in hand-written SQL mapping (`pool.query<any>`, `params: any[]`, `SELECT ${FEED_SELECT}` mapped to untyped rows). Strict TS guards everything *except* the layer most likely to drift when a column is renamed. Worth generating row types (or a thin typed query wrapper) for the high-traffic feed/post queries at minimum.

---

## Dead code (low, but you asked)

**8. Three genuinely dead exports** (referenced only at their own definition, repo-wide):
- `shared/src/lib/http-client.ts:452` `validateWebSocketUrl` — explicitly a "back-compat … kept for callers" shim whose comment redirects new code to `pinnedWebSocketOptions`. Zero callers. Textbook forgotten intention.
- `shared/src/auth/keypairs.ts:13` `getAccountPubkey`.
- `payment-service/src/types/index.ts:78` `TabSettlement`.

**9. ~25 unused locals/imports** (eslint `no-unused-vars`), e.g. `pool` imported-unused in `traffology-worker/src/tasks/{aggregate-daily,interpret}.ts`, `destroySession` in `shared/src/auth/accounts.ts`, `WriterPayout`/`HandledStripeEvent` types in `payment-service`.

---

## Process / coverage gaps

**10. eslint ignores `web/**` entirely.** The 263-file frontend — the bulk of the code — has no lint coverage, *including* the floating-promise rule that's the stated reason the config exists. Client-side async is exactly where unhandled promises bite. Add a web eslint pass.

**11. `web` is absent from the root `workspaces` array.** It has a separate dependency tree and install. Easy to forget in CI/build orchestration (`npm run build --workspaces` skips it). Confirm the deploy actually builds it.

**12. Documentation sprawl ≈ forgotten intentions at scale.** 74 markdown files (16 root + 26 `planning-archive/` + 32 `docs/`). `planning-archive/` duplicates live docs (`AUDIT.md`, `DESIGN.md`, `FEED-ALGORITHM.md`…). Six overlapping design specs (`ALLHAUS-DESIGN`, `DESIGN-BRIEF`, `DESIGN`, `WORKSPACE-DESIGN-SPEC`, `WIREFRAME-DECISIONS-CONSOLIDATED`, `WIREFRAME-PLAN`). `REVIEW-PLAN.md` is 378KB, `feature-debt.md` 164KB. No reader can tell which is authoritative. Nominate one source of truth per domain; archive the rest out of the repo.

---

## Suggested order

1. Finding #1 (schema/migration) — blocks clean deploys, hits current code.
2. #2, #3 — latent data-correctness bugs.
3. #10 (lint web) — cheap, catches the next #3 before it ships.
4. #4, #5, #7 — design debt to schedule.
5. #8, #9, #12 — housekeeping.

I did not re-run the prior security audit's scope. I could not run `knip` (its oxc parser tries to allocate ~4 GiB; the container has 3.9 GiB total), so cross-workspace dead-code detection here was grep-based and may miss dynamically-referenced symbols.
