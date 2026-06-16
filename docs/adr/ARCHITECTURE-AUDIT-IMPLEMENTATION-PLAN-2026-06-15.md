# Implementation Plan — Architectural Audit Outcomes (2026-06-15)

**Companion to:** `docs/adr/ARCHITECTURE-AUDIT-ADR-2026-06-15.md`
**Status:** Spade-ready plans for the accepted decisions, grounded in a full-tree
read of the current code. One plan per audit item. Item 2 is **parked pending
re-scope** (see below); the other seven are ready to dig.

Execution order follows the ADR's own suggested order:
`1a → 7, 8 → (2 parked) → 3 → 6 → 5 → 4`. Item 1b stays deferred.

**Progress:** 1a, 7, 8, **2(A) shipped 2026-06-16**; **item 3 Phase 0 + Phase 1
+ Phase 2 + Phase 3 (reader-balance) shipped 2026-06-16** (Phase 0 = table +
append-only guard + `recordLedger` helper; Phase 1 = dual-write across all five
money paths + CI adjacency tripwire; Phase 2 = the four `SUM()` read-model views
+ the reconciliation script; Phase 3 = closed the `subscription-convert` latent
tab-credit gap, migration 121 opening-balance backfill + view widen, and cut
`GET /my/tab` over to `ledger_reader_balance` — see item 3 header); **item 6
(DM reactions) shipped 2026-06-16** (migration 122 `dm_likes`→`dm_reactions`,
typed + txn-guarded toggle, web kept heart-only — see item 6 header); **item 5
(outbound retry helper) shipped 2026-06-16** (`feed-ingest/src/lib/outbound-retry.ts`
owns the claim→attempt→retry/abandon/reschedule skeleton; both workers refactored
behaviour-preserving — see item 5 header). Next up: item 4 (gateway god-file
split), then item 3 Phase 3 **writer-side** cutover (deferred — semantic mismatch,
see header).

Migration numbers below say "next free NNN" — the chain is now at `122` (item 6
took it); assign sequentially at implementation time so two items don't collide.

---

## Item 2 — Finish UNIVERSAL-POST — **re-scoped to a denormalisation tidy (A); (A) SHIPPED 2026-06-16**

**Outcome (A).** Migration `118_drop_feed_items_tier.sql` drops the dead
`feed_items.tier` column (`content_tier` enum) + its `tier_consistency` CHECK.
`fi.tier` removed from `FEED_SELECT` (`feed-sql.ts`). The `content_tier` enum,
`feed_items.biddability_tier`, and `external_items.tier` all stay.

**Deviation from the plan — the write sites were undercounted.** The plan's
step 1 (focused on the read path) asserted `tier` was "never written with a
non-default value" and implied dropping it meant only editing `FEED_SELECT` +
the migration. Ground truth: `feed_items.tier` was written by **15
`INSERT INTO feed_items`** statements — `'tier1'` for native rows, `ei.tier` /
`'tier2'`/`'tier3'`/`'tier4'` for external — so the column body **was** populated
(just never read; `post-mapper.ts` ignored the selected `fi.tier`, nothing
ordered/filtered by it). Dropping the column therefore required stripping `tier`
from **every** insert or they'd fail at runtime (tsc does not validate SQL
strings, so the build stayed green — a recursive `grep "INSERT INTO feed_items"`
is what surfaced them). Sites cleaned: `publication-publisher.ts` (×2),
`scheduler.ts`, `routes/notes.ts`, `routes/articles/publish.ts`,
`routes/external-items.ts` (×3, one needing positional `$n` renumbering),
`feed-items-reconcile.ts` (×3), and the ingest adapters
`activitypub-ingest.ts` / `atproto-ingest.ts` / `email-ingest.ts` /
`feed-ingest-rss.ts` / `feed-ingest-nostr.ts` / `external-parent-prefetch.ts`.
The optional integrity-strengthening CHECK (plan step 4) was **not** taken — out
of scope for the tidy; record it as a future option.

**Verify (done):** gateway + feed-ingest `tsc` build clean; `scripts/check-schema-drift.sh`
all four checks green (incl. Check 1 no-op + Check 2 canonical round-trip);
schema.sql diff = column + constraint removed only; root `npm run lint` 0 errors.
Runtime feed render is the operator's after a rebuild (the dropped column fed
nothing, so no behaviour change is expected).

The re-scope rationale and the deferred Plan (C) follow, retained for reference.

### Why the audit's literal action was dropped

The ADR's stated action ("drop `article_id`/`note_id`/`external_item_id` +
`exactly_one_source`") does **not** survive a read of the code. `feed_items` is not
one half-finished migration; it carries **two independent axes** in opposite states:

- **Identity axis — already done, not mid-flight.** `post_id` / `version` /
  `biddability_tier` are minted and maintained by a single DB trigger
  (`feed_items_post_identity`, migrations 098/099). App code only *reads* them.
  There is no dual-write to finish and ~nil app-side maintenance cost to remove —
  the audit's "both models live, every read/write maintains both" premise is wrong
  on this axis.
- **Storage axis — intrinsic, not deprecated.** `article_id` / `note_id` /
  `external_item_id` are the live FK pointers (with `ON DELETE CASCADE`) to three
  genuinely different body tables (`articles`: title/dek/cover/tags/markdown/paywall;
  `notes`: short content; `external_items`: source URI/interaction_data/protocol).
  They are joined in `feed-sql.ts` (`FEED_JOINS`), `feed-items-reconcile.ts`
  (`ON CONFLICT (note_id|article_id|external_item_id)`), `author.ts`,
  `post-thread.ts`, `external-context-gc.ts`, `scheduler.ts`,
  `publication-publisher.ts`, and the ingest adapters. `post_id` is a
  `sha256(protocol, handle)` **text hash** — it identifies *which post*, not *which
  table holds the body*, so it cannot substitute for these FKs.
- **`exactly_one_source` is not redundant with `item_type`.** `item_type`
  (article/note/external) and `exactly_one_source` (exactly one id non-null)
  constrain different things, and nothing links them. Dropping the CHECK *weakens*
  integrity; it removes no duplication.

The genuinely "real" end-state the audit reached for — one content spine so bodies
hang off `post_id` — is option **C** below: weeks of work, and it only *relocates*
the polymorphism (three body shapes are intrinsic to the domain). Its sole prize is
federation/self-host, the same driver as the deferred genesis extraction (1b). So C
is deferred to that effort, and item 2 is re-scoped to the cleanup that is actually
finishable now.

### Plan (A) — denormalisation tidy

**Goal.** Remove the denormalised cruft that 098/099 left behind on `feed_items` —
*not* the FKs — and optionally strengthen the slot invariant. Small, low risk.

**The confirmed dead column.** `feed_items.tier` (`content_tier` enum, tier1–4),
distinct from `biddability_tier` (A/B/C/D). Verified: it is **never written with a
non-default value** and **never read into the Post DTO** — `feed-sql.ts:52` selects
`fi.tier` but `post-mapper.ts` ignores it. Its `tier_consistency` CHECK only pins
native rows to `tier1`. (Do **not** confuse it with `external_items.tier`, which
*is* live — written `'tier3'` by the ingest paths and surfaced in `AuthorModal` /
`author.ts`. The `content_tier` enum stays; `external_items` still uses it.)

**Steps.**
1. **Confirm dead-ness once more at implementation time** (guard against a late
   reader): `grep -rn "fi\.tier\b\|\.tier\b" gateway/src/lib/post-mapper.ts
   gateway/src/routes/` and confirm the selected `fi.tier` flows nowhere. Drop
   `fi.tier` from the `FEED_SELECT` in `gateway/src/lib/feed-sql.ts:52`.
2. **Migration (next free NNN):** `ALTER TABLE feed_items DROP CONSTRAINT
   tier_consistency;` then `ALTER TABLE feed_items DROP COLUMN tier;`. Leave the
   `content_tier` enum in place (`external_items` depends on it).
3. **Sweep for any other now-derivable denormalised columns** before writing the
   migration — candidates to *assess* (not assumed dead): `version` is literally a
   copy of `nostr_event_id` for native rows (only diverges for external content
   hashes), so it is cheap-but-not-free duplication — **keep** it (the external case
   makes it load-bearing; document the native-copy in a comment). Treat author
   denormalisation (`author_name`/`author_avatar`/`author_username`) as live (it's
   the no-join byline cache), not cruft.
4. **Optional integrity strengthening (separate, reversible):** add a CHECK binding
   `item_type` to its matching id (`item_type='article' ⟺ article_id IS NOT NULL`,
   etc.). This is the *opposite* of the audit's instinct — it tightens, not loosens —
   and makes `exactly_one_source` subsumable if ever wanted. Land as its own migration
   only after backfill verification (`SELECT count(*) … WHERE item_type='article' AND
   article_id IS NULL` must be 0 across all three types first).
5. Regenerate `schema.sql` via `pg_dump`, re-append the `_migrations` seed in the
   same step, run `scripts/check-schema-drift.sh`.

**Verify.** Feed renders unchanged (the dropped column fed nothing); drift guard
green; `npm run build` in gateway. If step 4 is taken, the pre-flight NULL-count
query returns 0 for all three types before the constraint is added.

**Risk.** Low. The only trap is the `tier` / `biddability_tier` / `external_items.tier`
naming overload — step 1's re-confirm is there precisely to avoid dropping the wrong one.

### Plan (C) — Unified content spine — **DEFERRED (federation/self-host)**

Recorded in full so the future effort starts from facts, not a re-derivation.

**What it is.** Replace the three body-FK columns on `feed_items` with a single
reference to one content identity keyed by `post_id`, so "one post = one content
identity" is true in storage, not just in the derived hash.

**Why it's deferred, not adopted.**
- It does **not eliminate** polymorphism — `articles`, `notes`, `external_items` are
  three genuinely different schemas. A unified spine either (i) becomes a wide sparse
  table, or (ii) keeps a `content_kind` discriminator + per-kind body tables — i.e.
  the *same* polymorphism relocated off `feed_items` onto the spine. The cleanliness
  win is real (one join target, one identity) but it is not "remove a redundant model".
- Its only load-bearing justification is **federation / self-host**: a portable
  content spine addressable by a protocol-stable id, decoupled from the local
  `feed_items` timeline row. That is the **same driver as 1b** (genesis extraction
  for from-empty replay) — schedule them together as one "make the schema portable"
  effort, not piecemeal.

**Shape, when it happens.**
- New `posts` (or `content`) table: `post_id` (PK, the existing derived hash),
  `content_kind` (article|note|external), `body_ref` (FK into the per-kind body
  table) **or** absorb bodies as nullable subtype columns. Keep the per-kind body
  tables; they hold genuinely different fields.
- `feed_items` becomes a **timeline projection** over `posts` — it keeps `post_id`
  (already present), and the three FK columns retire *only after* every read path
  joins via `posts` instead.
- Migration is staged like item 3's ledger: add spine → dual-write (`posts` row
  minted alongside each `feed_items` insert, extend the 098 trigger) → repoint every
  reader (`FEED_JOINS`, reconcile, GC, publisher, scheduler, `author.ts`,
  `post-thread.ts`, ingest adapters) → drop the three FKs + `exactly_one_source`.

**Read paths that must move before the FKs can go** (the full blast radius, captured
now): `gateway/src/lib/feed-sql.ts` (`FEED_JOINS`), `feed-ingest/src/tasks/
feed-items-reconcile.ts`, `gateway/src/routes/author.ts`, `post-thread.ts`,
`feed-ingest/src/tasks/external-context-gc.ts`, `gateway/src/workers/scheduler.ts`,
`gateway/src/services/publication-publisher.ts`, `gateway/src/routes/notes.ts`,
`gateway/src/routes/external-items.ts`, and the `activitypub/atproto/email/nostr/rss`
ingest adapters. Each currently keys off one of the three source-id columns.

**Trigger to revisit C:** the federation/self-host milestone (same gate as 1b), or a
concrete need to address a post's content independently of its local timeline row.

---

## Item 1a — Harden the schema drift guard — **SHIPPED 2026-06-16**

**Outcome.** Check 3 (object presence) landed in `scripts/check-schema-drift.sh`
exactly as planned below: a pure-text, no-DB check that folds every migration's
`CREATE`/`DROP`/`ALTER…RENAME TO` into the net-surviving object set (in
chronological order, so create→drop→recreate and renames resolve) and asserts each
survivor's **defining statement** (`CREATE TABLE public.<n>`, `CREATE INDEX <n>`, …
— not a bare-name grep, which a column/constraint/FK-ref of the same name would
mask) appears in `schema.sql`. New exit code `3`; CI surfaces it with no new job.
Documented limits (script header): object-level only — constraint-backed indexes
and `ADD COLUMN` are the residual Phase-2 gap; function bodies checked for presence
not content; `drift-ok` line marker is the escape hatch.

**It immediately caught a real bug.** Migration 022's
`idx_read_events_reader_article` (composite index on `read_events(reader_id,
article_id)` covering the key-service payment-verification lookup) was seeded as
applied but its body was **omitted from `schema.sql`** — so fresh-boot DBs silently
lacked it while incrementally-migrated prod had it. Fixed by adding the canonical
pg_dump line to `schema.sql` (verified byte-canonical by Check 2's round-trip).
Verified: clean tree green; deleting a table body / a trigger each fails with exit 3
(the trigger case is the worst — Checks 0/1/2 all stay green, only Check 3 catches).

The original plan follows, retained for reference.

---

**Goal.** Close the one gap CLAUDE.md documents: a migration whose filename is
seeded into `_migrations` but whose **object body was omitted from `schema.sql`**
passes all three existing checks green. (Checks 0/1/2 in
`scripts/check-schema-drift.sh` catch missing-seed, pending-migration, and
non-canonical-dump, but not missing-body, because `migrate.ts` skips a
seeded-as-applied migration so the object is never created and nothing notices.)

**Why heuristic, not gold-standard.** The gold standard is a from-empty replay,
which is blocked by the missing genesis migration (item 1b, deferred). Until then,
a static object-presence check is the achievable hardening.

**Steps.**
1. Add **Check 3 — object presence** to `scripts/check-schema-drift.sh` (no DB
   needed; pure text, runs alongside Check 0).
2. For every file in `migrations/`, extract the identifiers of objects it
   *creates*: `CREATE TABLE`, `CREATE [UNIQUE] INDEX`, `CREATE TYPE`,
   `CREATE [OR REPLACE] FUNCTION`, `CREATE TRIGGER`, `CREATE [MATERIALIZED] VIEW`.
   Normalise (strip `IF NOT EXISTS`, schema-qualify to `public.` default).
3. Compute the **net surviving set** = created − dropped across the whole chain
   (so the `116 drops a column 094 added` / `DROP TABLE` cases don't false-positive).
   Track `DROP TABLE|INDEX|TYPE|FUNCTION|TRIGGER|VIEW`.
4. Assert each survivor's identifier appears in `schema.sql`. Non-zero exit (new
   code `3`) on any survivor missing, printing filename + object.
5. Wire into the CI `schema` job (`.github/workflows/ci.yml`) — it already runs
   the script, so no new job, just the new exit code surfaces.

**Scope notes / known limits (document in the script header).**
- Phase 1 covers **object-level** creates (table/index/type/function/trigger/view).
- **Column-level** drift (`ALTER TABLE … ADD COLUMN` whose column is missing from
  `schema.sql`) is a stretch — `ADD COLUMN` / `DROP COLUMN` netting per table. Mark
  as optional Phase 2; the mechanical pg_dump-and-re-append discipline still backs it.
- `CREATE OR REPLACE FUNCTION` bodies aren't compared for *content*, only presence.

**Verify.** Deliberately delete one table body from a scratch copy of `schema.sql`
(keep its seed line) → Check 3 must fail. Restore → green. Run the full script
against `master` → still green (no false positives on the real tree).

**Risk.** Low. Pure additive check; worst case is a false positive on an exotic
`CREATE` form, fixed by tightening the regex or an inline allowlist marker
(mirror the existing `hairline-ok` convention).

---

## Item 7 — Park trust — **SHIPPED 2026-06-16**

**Outcome.** Trust is parked behind `TRUST_SYSTEM_ENABLED` (server) /
`NEXT_PUBLIC_TRUST_ENABLED` (client), both default OFF. feed-ingest builds its
crontab conditionally (`feed-ingest/src/index.ts`): the three trust schedules
(`trust_layer1_refresh` + the two `trust_epoch_aggregate` variants) aren't
registered when off (the bulk of the parked compute); the task handlers stay in
`taskList` so any already-queued job still resolves, and a startup log records
the parked state. UI degrades: `TrustPip` renders a neutral grey dot (not null),
`PipPanel` hides its trust sections + status framing and skips the trust fetch,
the Network "vouches" tab is dropped, and `WriterActivity`'s Vouch button +
`VouchModal` + `TrustProfile` are hidden (with the trust fetch skipped). Tables
and every `LEFT JOIN trust_layer1` are untouched (degrade to NULL); `TRUST_DRY_RUN`
left as-is.

**Two deviations from the plan, both ground-truth forced:**
- **Neutral dot, not null.** `VolumeBar` (per-feed author-volume — explicitly
  *kept*) lives inside `PipPanel`, whose only opener is the pip. Nulling the pip
  would strand author-volume. Resolved (with the maintainer) by degrading the pip
  to a neutral, semantically-empty dot so the panel stays reachable while the
  trust sections inside it hide.
- **Server helper in `shared`, not `gateway`.** The only server consumer is
  feed-ingest, which can't import from `gateway/`. `trustSystemEnabled()` lives in
  `shared/src/lib/env.ts` so both gateway and feed-ingest can read it.
- **`WriterActivity` added to the gate list.** The plan's file list missed it; it
  renders `TrustProfile` + the Vouch action + `VouchModal` on the native writer
  profile, so it's gated too.

**Verify (done):** `shared` + `feed-ingest` build clean; web `tsc --noEmit` 0
errors; hairline guard shows only pre-existing `PipPanel` debt (none on touched
lines). Runtime checks (feed cards render with neutral pip, no vouch tab, crons
unscheduled) are the operator's — web needs a rebuild to observe.

The original plan follows, retained for reference.

---

**Goal.** Stop the compute for a display-only subsystem nobody is viewing; leave
tables and `LEFT JOIN`s in place (confirmed: trust is display-only — ordering is
by `published_at` / `boosted_at` / `fi.score`, never `trust_weight`/`pip_status`).

**Feature-flag pattern.** Follow the existing `DISCOVERY_PUBLISH_ENABLED` /
`ATPROTO_ASSISTED_ENABLED` shape (`process.env.X === "1"`). New helper
`trustSystemEnabled()` in `gateway/src/lib/` (server) + `NEXT_PUBLIC_TRUST_ENABLED`
(client). **Default OFF** (parked unless explicitly enabled).

**Steps.**
1. **Background tasks** — `feed-ingest/src/index.ts`: gate the two crontab lines
   (`trust_layer1_refresh` @ 01:00 daily, `trust_epoch_aggregate` quarterly +
   Mon/Thu) and their `taskList` registrations (lines 21-22, 85-89, 119-120) on
   `trustSystemEnabled()`. Cleanest: build the crontab string conditionally so the
   schedules simply aren't registered when off. This is the bulk of the compute saving.
2. **UI surfaces** — gate render on `NEXT_PUBLIC_TRUST_ENABLED`:
   - `web/src/components/ui/TrustPip.tsx` — render `null` when off. (Appears in the
     card-chassis byline row; hiding it leaves the byline intact — verify spacing.)
   - `web/src/components/workspace/PipPanel.tsx` — the trust sections
     (`TrustSignals`, `EncounterRow`, `PollQuestions`); keep `VolumeBar` (that's
     feed author-volume, **not** trust — do not flag it off).
   - `web/src/components/network/NetworkPanel.tsx` — hide the **vouches** tab;
     `web/src/components/trust/VouchList.tsx`, `VouchModal.tsx`.
3. **Leave untouched:** all `trust_*` tables, every `LEFT JOIN trust_layer1`
   (`feed-sql.ts:99`, `post-thread.ts:129`, `replies.ts:316`) — they degrade to
   NULL against stale tables, ordering unaffected.
4. Keep `TRUST_DRY_RUN` as-is (orthogonal).

**Verify.** With flag off: feed cards render (no pip), threads order chronologically
unchanged, network page has no vouch tab, `feed-ingest` logs show the two trust
tasks never scheduled. `scripts/check-hairlines.sh` on touched web files.

**Risk.** Fully clean per the audit. Only watch item: TrustPip removal from the
byline row — confirm the `·`-separated byline doesn't leave a dangling separator.

---

## Item 8 — Park traffology — **SHIPPED 2026-06-16**

**Outcome.** The `traffology-ingest` (port 3005) + `traffology-worker` service
blocks are commented out in `docker-compose.yml` (reversible; the npm workspaces,
`schema.traffology.*`, and the gateway `/concurrent/*` routes stay in repo).
nginx drops `traffology-ingest` from the nginx `depends_on` and `/ingest/` now
`return 404;` (a straggler beacon gets a cheap 404, not a 502 against a missing
upstream). The client beacon is gated on `NEXT_PUBLIC_TRAFFOLOGY_ENABLED` (default
OFF). Gateway untouched — its `/concurrent/*` reads already fail soft, and its
`TRAFFOLOGY_INGEST_URL` env is left in place (harmless; fails soft against the
absent container).

**Deviation from the plan, ground-truth forced:** the plan said gate the IIFE in
`web/src/lib/traffology.ts`. But that `.ts` is **not bundled** — the served
`web/public/traffology.js` is a hand-built minified artifact, and a `NEXT_PUBLIC`
var wouldn't inline into it. So the authoritative gate is in the article page
(`web/src/app/article/[dTag]/page.tsx`): when off, neither `<TraffologyMeta>` nor
`<Script src="/traffology.js">` renders, so the browser never loads the beacon.
That plus the nginx 404 is belt-and-suspenders; the `.ts` source is left as-is.

**Verify (done):** `docker compose config -q` valid; `--services` no longer lists
either traffology service; web `tsc --noEmit` 0 errors. Runtime check (no
`/ingest/beacon` requests on an article load) is the operator's after a web
rebuild.

The original plan follows, retained for reference.

---

**Goal.** Stop two separately-deployed containers + their compute for an unused
subsystem; leave schema + npm workspaces in repo. Gateway needs no change (stale
table reads work; the two `/concurrent/*` endpoints already fail soft via try/catch
at `traffology.ts:40-49,60-70`).

**Steps.**
1. **Containers** — `docker-compose.yml`: remove (or comment) the
   `traffology-ingest` (lines ~192-209, port 3005) and `traffology-worker`
   (lines ~213-224) service blocks.
2. **nginx** — `nginx.conf`: drop `traffology-ingest` from the nginx service's
   `depends_on`, and either delete the `location /ingest/` block (lines 78-88) or
   replace its body with `return 404;`. Let `/ingest/*` 404.
3. **Client beacon (gate at source)** — `web/src/lib/traffology.ts`: the IIFE
   posts to `/ingest/beacon` via `navigator.sendBeacon` (init / 30s heartbeat /
   unload). Gate the whole IIFE on `NEXT_PUBLIC_TRAFFOLOGY_ENABLED` (default off)
   so readers' browsers stop firing at a dead endpoint. Also short-circuit
   `web/src/components/traffology/TraffologyMeta.tsx` to render nothing when off.
4. **UI pages (optional)** — `web/src/app/traffology/{page,overview,piece/[pieceId]}`
   can stay (they degrade to empty / stale), or hide their nav entry behind the same
   flag. Not required for parking.
5. **Leave untouched:** `schema.traffology.*` (12 tables), `traffology-ingest/` +
   `traffology-worker/` workspaces, `gateway/src/routes/traffology.ts`.

**Verify.** `docker compose config` no longer lists the two services; nginx starts
without the dependency; load an article → no `/ingest/beacon` requests in network
tab; existing traffology pages load without 5xx (stale/empty).

**Risk.** Slightly more involved than trust (two containers + one nginx edit + a
client flag) but no hard dependency breaks. The only hard coupling was nginx
`depends_on`, removed in step 2.

---

## Item 3 — Unified append-only ledger *(keystone)* — **Phase 0 + 1 + 2 + 3(reader-balance) SHIPPED 2026-06-16**

**Outcome (Phase 3 — reader-balance cutover + opening-balance backfill).** The
read-side ground truth was narrower than "point balance reads at the views": of
the four read-models, only the **reader tab** is backed by a mutated running-total
column (`reading_tabs.balance_pence`) with a symmetric ledger mirror, so it is the
only one cleanly cut over. What shipped:

1. **Closed a Phase-1 latent gap first (prerequisite).** `subscription-convert.ts`
   decrements the tab on a spend→subscription credit-back (`balance_pence = …
   − $1`) but had **no** `recordLedger()` — a real reader-tab movement with no
   mirror, so `ledger_reader_balance` already diverged from the column forward-only
   (not just by the un-backfilled opening balance). The CI tripwire had missed it
   because its marker regex only matched `balance_pence = balance_pence +` (plus);
   the `−` credit-back escaped. Fixed: added the `recordLedger()` (new
   `subscription_credit` trigger, **+credit**, counterparty = the writer), widened
   the marker to `balance_pence = balance_pence [-+]`, and registered the file
   (`check-ledger-adjacency.sh` → six paths). Verified the widened scan surfaces no
   *other* unregistered minus-movement.

2. **Opening-balance backfill — migration `121`.** Per `reading_tabs` row, posts one
   `opening_balance` entry = `(L − B)` where `L = −SUM(real reader entries)` and
   `B = reading_tabs.balance_pence`, so `−SUM(entries incl. opening) == B` to the
   penny. `L` is computed directly over the five real reader-tab triggers (incl.
   `subscription_credit`), **not** via the view, so it is correct regardless of the
   view's filter. Then `CREATE OR REPLACE VIEW ledger_reader_balance` to also count
   `subscription_credit` + `opening_balance` (columns unchanged). Order matters:
   backfill against the real-movement sum first, widen the view second. Only
   non-zero deltas are posted, so the migration is **inert on a fresh/empty DB**
   (no tabs ⇒ no opening rows). Proved on a synthetic DB: partial-ledger gap,
   pure-pre-Phase-1 (no ledger), and already-aligned accounts all reconcile to
   `diff = 0` after the backfill (the already-aligned one gets no row).

3. **Cut `GET /my/tab` over to the view.** `my-account.ts` now reads the
   reader-facing balance from `ledger_reader_balance`, not `rt.balance_pence`. API
   contract unchanged; web needs no change.

4. **`reading_tabs.balance_pence` retained as the locked operational running total.**
   Deliberately did **not** "stop mutating the column": settlement reserves against
   it with `SELECT … FOR UPDATE` (a `SUM()` view can't be row-locked), and the
   threshold/fallback logic compares it. So display reads the ledger; settlement
   reads+locks the column; they agree by construction. Dropping the column is a
   later phase gated on a settlement-concurrency redesign.

5. **Writer-earnings / publication-distribution reads NOT cut over (deviation,
   ground-truth forced).** `ledger_writer_earnings` sums money **paid out** (entries
   emitted at the payout flip), but the dashboard's `getWriterEarnings()` sums
   **earned-incl-pending** (`read_events` in `platform_settled`+`writer_paid`) —
   different quantities, *not* a drop-in repoint. Those views stay
   reconciliation-only (their Part-B gap remains "expected") until the ledger models
   writer-side accrual, which is its own piece of work (the deferred writer-side
   cutover).

**Verify (done):** `shared` + `gateway` + `payment-service` `tsc` build clean; root
`npm run lint` 0 errors; `check-ledger-adjacency.sh` green (six paths; widened
marker fires on the minus-movement, surfaces no new escapees); full vitest green
(payment-service 46, gateway 141); `check-schema-drift.sh` all four green (Check 0
lists 121 migrations; Check 3 counts the widened view; Check 1 no-op + Check 2
canonical round-trip — the only schema diff is the view's `WHERE … IN (…)`
gaining the two triggers + the `121` seed line); synthetic backfill reconciliation
proven to `diff = 0`. The backfill INSERT itself runs only on prod (live tabs) at
migrate time; on a fresh boot it is a no-op. Runtime `/my/tab` render is the
operator's after a rebuild (balance is identical to the column by construction).

The Phase 2 outcome + the plan follow, retained for reference.

---

**Outcome (Phase 2 — read-model views + reconciliation).** Migration
`120_ledger_views.sql` adds the four `SUM()` read-models the plan names, as plain
(non-materialised) views over the append-only `ledger_entries` — cheap and always
current against the existing `(account_id,created_at)`/`(ref_table,ref_id)`/
`(trigger_type)` indexes, and inert (nothing reads them until Phase 3):

- `ledger_reader_balance(account_id, balance_pence)` — a reader's tab DEBT =
  `−SUM(amount_pence)` over the four reader-tab triggers
  (`read_accrual`/`vote_charge`/`pledge_fulfil`/`tab_settlement`). Reconciles
  (forward-only, see below) against `reading_tabs.balance_pence`.
- `ledger_writer_earnings(account_id, earned_pence)` — money received =
  `SUM(amount_pence)` over `writer_payout` + `publication_split`.
- `ledger_publication_distribution(publication_id, distributed_pence)` — splits
  resolved to their publication by joining `ledger_entries.ref_id` →
  `publication_payout_splits` → `publication_payouts`.
- `ledger_platform_tax(account_id, tax_paid_pence)` — downvote behaviour tax =
  `−SUM` of `vote_charge` entries with `counterparty_id IS NULL` (the NULL
  counterparty is what distinguishes a downvote/platform charge from an upvote's
  author credit).

**Deviation from the plan — `ledger_` prefix on the view names.** The plan named
them bare (`reader_balance`, `writer_earnings`, …); they ship prefixed
(`ledger_reader_balance`, …) so the read-model namespace is unambiguous and
greps cleanly back to its spine. Behaviour-identical; record the prefix when
wiring Phase 3 reads.

**The reconciliation is `scripts/reconcile-ledger.sql`** (run against a migrated
DB), in two parts: **Part A — row-level ledger↔source consistency** (every entry
vs its originating row in `|amount_pence|` + counterparty; must always be empty,
catches a wrong-magnitude/wrong-row dual-write), and **Part B — aggregate
balance** vs the live tables (`reading_tabs`, flipped payouts).

**⚠ Phase 3 prerequisite — opening-balance backfill (the plan's gap, surfaced
here).** The ledger began **empty** at Phase 1; historic `reading_tabs` balances
and past payouts were never backfilled. So `ledger_reader_balance` equals
`reading_tabs.balance_pence` **only for accounts with no pre-Phase-1 activity** —
Part B's diff for everyone else is precisely their un-backfilled opening balance,
not a bug (the script says so). Phase 3 therefore cannot just "point reads at the
views": it must **first** post a one-time opening-balance entry per account
(`trigger_type='opening_balance'`, ref = the tab/payout row) so `SUM` == the live
running total, then cut reads over and stop mutating `reading_tabs.balance_pence`.
Until that backfill, Part B reads as "the views agree to the penny for everything
that has moved since the ledger went live."

**Verify (done):** the four views compile + run against a throwaway DB built from
`schema.sql` + migration 120 (0 rows — no ledger data yet, SQL valid);
`scripts/check-schema-drift.sh` all four green (Check 0 lists 120 migrations;
Check 3 counts the four new views; Check 1 no-op + Check 2 canonical round-trip
both pass — the diff is the four views + the two tables pg_dump's dependency-sort
relocated under them + the `120` seed line, each object present exactly once);
`check-ledger-adjacency.sh` green (no money-write code changed this phase). No TS
changed, so build/lint/tests are unaffected.

The original Phase 0/1 outcomes + the plan follow, retained for reference.

---


**Outcome (Phase 1 — dual-write the money paths).** Every money MOVEMENT now
emits a `ledger_entries` row via `recordLedger(client, …)` **inside the same
transaction** as the table write it records, across all five paths the plan
named: `accrual.ts` (recordGatePass accrued read; convertProvisionalReads — one
entry per converted read + per converted vote_charge), `settlement.ts`
(confirmSettlement), `payout.ts` (writer payout + per publication split),
`votes.ts` (accrued vote charge), `drives.ts` (pledge fulfilment).

**Sign convention (documented in `shared/src/lib/ledger.ts`), pinned by the two
Phase-2 reconciliation anchors and the schema:**
- **Reader-tab entries mirror `reading_tabs.balance_pence` movements** — emitted
  exactly when (and by the amount) the tab moves, so the reconciliation holds by
  construction. Accrual / vote / pledge = **−amount** (debit, reader owes more);
  settlement = **+settled** (credit, debt paid down). Hence
  `reading_tabs.balance_pence == −SUM(reader tab-affecting entries)`. Provisional
  reads/votes (no card ⇒ no tab movement) get **no** entry until they convert.
- **Writer / publication-member entries = money received at payout** —
  **+amount**, counterparty `NULL`. Hence `SUM(payout entries) ==` historic
  writer/publication payout sums.
- **Platform is never an `account_id`** (no platform account row — `account_id`
  is `NOT NULL`); it is always the `NULL` counterparty. Platform fee /
  behaviour-tax is therefore *implicit* (the gap between what a reader is charged
  and what a writer receives), derived in Phase 2 from counterparty-`NULL`
  entries — **not** the audit's literal "net-to-writers / platform-fee as their
  own rows at settlement", which the `account_id NOT NULL` schema forbids. This
  is why the writer side lands at payout, not settlement.

**Idempotency at the payout sites (the dual-write danger zone).** The four
reader-tab sites are each a single txn with no resume loop, so they are
naturally one-entry-per-row. The two payout sites *do* re-run on crash-resume
(Stripe sits between reserve and complete, retried with a stable key), so each
gates its ledger emit on the actual `pending→initiated` status flip
(`UPDATE … WHERE status='pending'` + `rowCount` check) — a resume can't
double-post. `processPublicationSplits`' previously-standalone `pool.query`
status flip was wrapped in a `withTransaction` so the flip and its ledger entry
commit together (else a committed flip with a lost entry would never be
re-selected).

**CI tripwire.** `scripts/check-ledger-adjacency.sh` (the plan's "CI grep")
guards both failure modes: (1) each registered money-path file must keep ≥ its
expected `recordLedger()` count; (2) no backend file may perform a money
movement (tab-balance write or charge/payout-table INSERT) without being in the
registry. Wired into the CI `backend` job after the build. Both guards verified
to fire on negative tests.

**Deviation from the plan — no live-DB rollback test (still).** The plan's
Verify lists a `recordLedger` rollback unit test; the repo *still* has no
DB-backed test harness (every test, including the one DB-touching gateway test,
pure-`vi.mock`s `withTransaction`/`pool`), so a true rollback assertion remains
infeasible and disproportionate — and the rollback property is now *structural*
(recordLedger issues on the caller's in-flight client, same guarantee as
`enqueueRelayPublish`). In its place, `payment-service/tests/ledger.test.ts`
locks the helper's contract (param/column order, signed-amount passthrough,
counterparty/currency defaults) in the repo's pure-unit-test style. Call-site
**sign** correctness is verified at Phase 2 reconciliation, by design.

**Verify (done):** `shared` + `payment-service` + `gateway` `tsc` build clean;
`npx eslint` 0 errors; `npx knip` unchanged vs. baseline (recordLedger now has
callers; my change adds zero findings); `check-ledger-adjacency.sh` green (+
both guards fire on negative tests); `scripts/check-schema-drift.sh` all four
green (no schema change this phase); full vitest suites green (payment-service
46 incl. 5 new, gateway 141). Runtime money-flow correctness is Phase 2's
penny-reconciliation job, not observable from Phase 1 alone (no reads yet).

The original plan follows, retained for reference.

---

**Outcome (Phase 0 — table + guard).** Migration `119_ledger_entries.sql` adds the
`ledger_entries` table exactly as specced below (signed `amount_pence`, FKs to
`accounts(id)` on `account_id`/`counterparty_id`, the three indexes
`(account_id,created_at)`/`(ref_table,ref_id)`/`(trigger_type)`), plus the
append-only guard: `ledger_entries_append_only()` + a `BEFORE UPDATE OR DELETE …
FOR EACH ROW` trigger that `RAISE`s — mirroring how 098 owns `feed_items`. The
`recordLedger(client, entry)` helper lives in `shared/src/lib/ledger.ts`, taking
the in-flight `PoolClient` (same shape as `enqueueRelayPublish`), a typed
`LedgerTriggerType`, and a plain signed-amount INSERT. **Phase 0 is inert: no
callers, no reads.** Phase 1 wires the money paths.

**Verify (done):** `shared` `tsc` build clean; `scripts/check-schema-drift.sh` all
four green (Check 3 now counts the table + function + trigger + 3 indexes; Check 1
no-op + Check 2 canonical round-trip both pass); schema.sql diff = the new objects
+ the `119` seed line only. Append-only guard exercised against a live
schema.sql-built DB: INSERT succeeds, `UPDATE`/`DELETE` each raise
`ledger_entries is append-only`.

**Deviation from the plan — no `recordLedger` rollback unit test yet.** The plan's
overall Verify lists a rollback unit test, but `shared` has **zero** test files and
no DB-backed test harness; standing one up for a caller-less Phase 0 is
disproportionate. Deferred to Phase 1, where real money-path callers give the
rollback assertion something to wrap (and the CI money-write/ledger-adjacency grep
lands alongside it). The guard's raise-on-mutate was instead verified directly
against a live DB (above).

The original plan follows, retained for reference.

---

**Goal.** One append-only ledger so "how does writer X make a living here?" is a
single query, not a hand-union of eight surfaces. Balances become `SUM()` views.

**Prior art to build on (important).** Two append-only logs already exist and
should inform the shape rather than be reinvented:
- `read_events` — already append-only, already the spine for reading revenue
  (`provisional → accrued → platform_settled → writer_paid`), with FKs to
  `reading_tabs`/`tab_settlements`/`writer_payouts`.
- `subscription_events` — append-only journal of subscription charges/earnings.

**Scope correction.** Of the audit's eight surfaces, `dm_pricing` is a **price
book, not a money movement** (no funds flow through it) — exclude it from the
ledger; it stays a config table. The real money events are: reads, settlements,
writer payouts, publication payouts/splits, vote charges, pledge fulfilment.

**Ledger table (next free NNN):**
```
ledger_entries (
  id            uuid pk,
  account_id    uuid not null   references accounts(id),   -- whose ledger
  counterparty_id uuid          references accounts(id),   -- other side (nullable: platform)
  amount_pence  bigint not null,                           -- signed; + credit, − debit
  currency      text not null default 'GBP',
  trigger_type  text not null,        -- 'read_accrual','tab_settlement','writer_payout',
                                       -- 'publication_split','vote_charge','pledge_fulfil', …
  ref_table     text not null,        -- originating table
  ref_id        uuid not null,        -- originating row
  created_at    timestamptz not null default now()
)
```
Indexes: `(account_id, created_at)`, `(ref_table, ref_id)`, `(trigger_type)`.
**Append-only discipline:** no UPDATE/DELETE; corrections are reversing entries.
Enforce with a `BEFORE UPDATE OR DELETE` trigger that raises, mirroring how 098
owns `feed_items` identity.

**Phasing (each phase shippable, non-breaking until the last):**
1. **Phase 0 — table + guard** (migration NNN). Add `ledger_entries` + the
   append-only trigger. No reads yet.
2. **Phase 1 — dual-write.** Every money path emits a ledger entry **in the same
   transaction** as its existing write. Sites (from the audit ground-truth):
   - `payment-service/src/services/accrual.ts` — read accrual, provisional→accrued.
   - `payment-service/src/services/settlement.ts` — `tab_settlements` insert/complete
     (reader debit, platform fee, net-to-writers).
   - `payment-service/src/services/payout.ts` — `writer_payouts`,
     `publication_payouts` + `publication_payout_splits`.
   - `gateway/src/routes/votes.ts` — `vote_charges` insert.
   - `gateway/src/routes/drives.ts` — pledge fulfilment (`pledges` → `read_events`).
   Add a single helper `recordLedger(client, entry)` in `shared/src/lib/` taking the
   in-flight `PoolClient` (same pattern as `enqueueRelayPublish`) so the entry rolls
   back with its txn.
3. **Phase 2 — views.** Build read-models over `ledger_entries`:
   `reader_balance` (= `SUM(amount_pence)` per account), `writer_earnings`,
   `publication_distribution`, `platform_tax` (downvotes / behaviour charges).
   Reconcile against the live `reading_tabs.balance_pence` etc. in a scratch query
   until they agree to the penny.
4. **Phase 3 — cut over reads.** Point balance reads at the views; stop mutating
   `reading_tabs.balance_pence` as a running total (keep the column as a cache or
   drop after the view is trusted). Settlement/payout read from the same spine.

**Item-4 tension (designed-in).** Money writes today span **two services**
(`gateway` votes/pledges + `payment-service` reads/settlement/payout) over **one
shared Postgres**. The ledger write rides inside whichever transaction already owns
the money mutation, so it stays a local (not distributed) write **as long as item 4
keeps the split at module boundaries, not separate services**. If a payment service
is ever truly split out (own DB), the ledger write becomes a transactional boundary
to resolve at that time — flagged, not solved here.

**Verify.** Reconciliation query: for every account, `SUM(ledger_entries)` ==
current `reading_tabs.balance_pence` (Phase 2), and writer/publication payout totals
match historic sums. Schema regen + `scripts/check-schema-drift.sh`. Unit tests on
`recordLedger` rollback (entry absent if the enclosing txn aborts).

**Risk.** Largest item. Dual-write window (Phase 1→3) is the danger zone — a money
path that writes its table but forgets the ledger entry silently under-reports.
Mitigate by funnelling **all** money writes through `recordLedger` and a CI grep
asserting each money-table INSERT site has an adjacent ledger call.

---

## Item 6 — DM reactions — **SHIPPED 2026-06-16**

**Outcome.** Migration `122_dm_reactions.sql` takes the rename-in-place path (the
table is empty, so the equivalent fresh-table+copy the plan flagged as overkill
was skipped): `ALTER TABLE dm_likes RENAME TO dm_reactions`, `ADD COLUMN
reaction_type text NOT NULL DEFAULT 'like'`, swap `UNIQUE(message_id, user_id)`
→ `UNIQUE(message_id, user_id, reaction_type)`, and rename the carried-over
pkey/FK constraints + `idx_dm_likes_message` to the new name for a clean dump
(the drift guard nets `ALTER … RENAME TO` for table+index, so Check 3 resolves
them).

**Deviation from the plan — no DB CHECK on the reaction set.** The plan offered
an optional `CHECK` on an allowed reaction set; instead the vocabulary
(`DM_REACTION_TYPES = like/love/laugh/wow/sad/angry`, exported from
`gateway/src/services/messages.ts`) is **app-controlled** and enforced by the
route's zod `z.enum`, so adding a reaction needs no migration. The DDL stays
vocabulary-agnostic.

**Service + route.** `toggleMessageLike` → `toggleMessageReaction(messageId,
userId, reactionType='like')`, now wrapped in `withTransaction` — this closes the
previously-unguarded race the plan called out (old `messages.ts:455`): the
DELETE-then-INSERT commits atomically and a `23505` unique-violation resolves to
"reacted". The POST route keeps its path `/messages/:messageId/like` (back-compat),
accepts an optional `reaction_type` (zod enum, default `'like'`), and still
responds `{ liked }` (the web client consumes that field and ignores the body).

**Conservative scope (per the plan's "web can stay single-`'like'` initially").**
`loadConversationMessages`' per-message subqueries read `dm_reactions` filtered to
`reaction_type='like'`, so the `likeCount`/`likedByMe` response shape is
unchanged and **web is untouched** (the heart stays a single 'like'). The schema +
API are now reaction-ready for a future picker. The optional N+1 retire
(jsonb-grouped reaction counts) was **not** taken — it only earns its keep once a
picker consumes grouped counts; deferred with the picker.

**Verify (done):** gateway `tsc` build clean; `scripts/check-schema-drift.sh` all
four green (Check 0 lists 122 migrations; Check 3 = 268 objects with the
table/index rename netted; Check 1 no-op + Check 2 canonical round-trip — diff =
the rename + new column + constraint swap + the `122` seed line, plus pg_dump's
dependency re-sort of the relocated table); root `npm run lint` 0 errors;
`check-ledger-adjacency.sh` green (no money path touched); full gateway vitest 141
green. Runtime react/unreact is the operator's after a web rebuild (heart
behaviour is identical by construction).

The original plan follows, retained for reference.

---

**Goal.** Migrate `dm_likes` → a reactions table now, while it's effectively empty
(created migration 032; near-zero rows). DM-scoped, not app-wide.

**Steps.**
1. **Migration (next free NNN).** `dm_likes` is `(id, message_id, user_id,
   created_at)` with `UNIQUE(message_id, user_id)`. Either:
   - `ALTER TABLE dm_likes RENAME TO dm_reactions;`
     `ADD COLUMN reaction_type text NOT NULL DEFAULT 'like';`
     drop `UNIQUE(message_id, user_id)`, add `UNIQUE(message_id, user_id,
     reaction_type)`; add CHECK on an allowed reaction set if desired.
   - (Equivalent fresh-table + copy is overkill given it's empty.)
2. **Service** — `gateway/src/services/messages.ts`:
   - `toggleMessageLike(messageId, userId)` → `toggleMessageReaction(messageId,
     userId, reactionType)`: DELETE-then-INSERT keyed on the triple. Wrap the
     DELETE/INSERT in a txn and handle the unique-violation race (currently
     unguarded at `messages.ts:455`).
   - `loadConversationMessages` aggregate (currently per-message `COUNT` + `EXISTS`
     at `messages.ts:234-235`): return reaction counts grouped by `reaction_type`
     and the caller's own reactions. Consider one windowed/`jsonb_object_agg`
     query to retire the N+1 while here.
3. **Route** — `gateway/src/routes/messages.ts:144` — accept `reaction_type` in the
   POST body (default `'like'` for back-compat).
4. **Web** — `web/src/components/messages/MessageThread.tsx`: the heart toggle
   (lines 391-419) can stay single-`'like'` initially (schema-ready), or add a small
   reaction picker. Keep the optimistic-update pattern; key local state by
   `(messageId, reactionType)`.
5. Schema regen + drift guard.

**Verify.** React/unreact with two reaction types on the same message; counts
group correctly; unique constraint blocks duplicate `(message,user,type)`; existing
`'like'` rows survive the rename with `reaction_type='like'`.

**Risk.** Cheap now, annoying later. Note the audit's flagged-not-blocking adjacency:
paid-DM refund/chargeback, fee-on-sender-block, minors-and-payments — out of scope
for this item but tracked.

---

## Item 5 — Outbound delivery shared retry helper — **SHIPPED 2026-06-16**

**Outcome.** `feed-ingest/src/lib/outbound-retry.ts` exposes `runOutboundJob<Row>(spec)`,
which owns the one genuinely-shared skeleton: **claim → attempt → on-throw:
increment counter → compare-to-max → branch retry-vs-abandon → reschedule a
versioned single-attempt job** (`jobKey = \`${taskName}_${rowId}_r${n}\``,
`maxAttempts: 1`, `runAt: computeBackoff(n)`). Both workers were refactored onto it,
behaviour-preserving:
- `relay-publish.ts` — its `failAndMaybeRetry` (+ the inline empty-relayUrls and
  discovery "in-house only" branches, both now `throw` into the helper's catch)
  collapsed into `claim`/`attempt`/`onRetry`/`onAbandon`/`cleanup` closures.
  `computeBackoff` + `defaultRelayUrls` stay module-level (the test imports
  `computeBackoff`). `RelayOutboxRow` is now the `Row` generic; the `PoolClient`
  import is gone with the helper.
- `outbound-cross-post.ts` — its catch block collapsed likewise; `markFailed` +
  `loadConfig` stay module functions; `cfg` is a task-scope `let` loaded inside
  `claim` (after the guards, as before) and read by `attempt` + `computeBackoff`.

**Three deviations from the plan's `e.g.` signature, all to keep the two workers'
divergence intact (the plan's own "do not over-unify" warning):**
- **The worker owns its client, not the helper.** The plan sketched `claim: (client)
  => row` with the helper owning `pool.connect()`. Taken literally that would force
  cross-post (today autocommit on `pool`, holding **no** connection across its
  Mastodon/Bluesky round-trip) to hold a pooled connection for the whole job — a real
  resource regression under load. So `claim` takes no client; each worker owns its
  client/txn lifecycle via the closures (relay opens one txn-scoped connection +
  advisory lock held across the relay round-trip; cross-post stays on `pool`). The
  helper's `cleanup` hook runs in `finally` for release/rollback.
- **Success persist lives in `attempt`, not a separate `onSuccess`.** `attempt` does
  the delivery *and* the `status='sent'` UPDATE (+ COMMIT for relay), and `throw`s on
  any failure — including relay's discovery "in-house relay only" *logical* failure,
  which became a thrown Error routing through the identical retry machinery (was a
  direct `failAndMaybeRetry` call).
- **`bumpAndPersist`/`onAbandon` split into `onRetry`/`onAbandon`** (clearer than one
  branching closure); counters abstracted behind `attemptsOf`/`maxOf` (relay
  `attempts`/`max_attempts` vs cross-post `retry_count`/`max_retries`); status vocab
  (sent/failed/abandoned vs sent/retrying/failed) and backoff curve
  (`min(2^n min,1h)±jitter` vs `delay·2^(n-1)`) stay worker-supplied. The **enqueue**
  side (`relay-outbox.ts`/`outbound-enqueue.ts`) was left untouched per the plan.

**Verify (done):** `feed-ingest` `tsc` build clean; the pre-existing
`relay-publish.test.ts` (12 tests — query order, param positions, jobKey,
COMMIT/ROLLBACK-as-last-call, the deletion-path retry) passes **unchanged**, proving
the relay path is behaviour-identical through the helper; added
`outbound-cross-post.test.ts` (5 tests — success / retry+versioned-jobKey /
abandon-at-max / already-sent no-op / invalid-linked-account → failed) since that
path had **no** prior coverage and was heavily restructured; full feed-ingest suite
161 green (156 + 5 new); `eslint` 0 on the four touched files. Runtime is the
operator's after a feed-ingest rebuild (retry timing / abandon / job-key versioning
are identical by construction).

The original plan follows, retained for reference.

---

**Goal.** Extract one retry helper parameterised by max-attempts / backoff /
success-rule, killing duplicated claim-backoff-reschedule plumbing across the two
outbound workers — **without** forcing their genuinely-divergent semantics to converge.

**The two workers & what diverges (keep divergent):**
- `feed-ingest/src/tasks/relay-publish.ts` — `relay_outbox`, 10 attempts,
  `SELECT FOR UPDATE SKIP LOCKED`, **entity-level advisory lock**
  (`pg_try_advisory_xact_lock`), **partial-success** (any relay accepts ⇒ sent)
  with **discovery-event special-casing** (profile/follow_list/relay_list require a
  public-mesh relay to accept), backoff `min(2^n min, 1h) ±10% jitter`, statuses
  `pending/sent/failed/abandoned`, `attempts` = completions.
- `feed-ingest/src/tasks/outbound-cross-post.ts` — `outbound_posts`, 3 retries
  (config-driven), **no lock**, plain success, backoff `delay·2^(n-1)` no jitter,
  statuses `pending/sent/failed/retrying`, `retry_count` = retries.

**Duplicated machinery to extract:** the claim+status-guard, the
increment→check-max→update-row→`helpers.addJob(versioned jobKey, maxAttempts:1)`
reschedule (relay `failAndMaybeRetry` lines 147-197 ≈ cross-post catch lines 317-356).

**Steps.**
1. Add `feed-ingest/src/lib/outbound-retry.ts` exposing e.g.
   ```
   runOutboundJob({
     taskName, rowId,
     claim,            // (client) => row | null   (worker owns its SELECT + lock)
     attempt,          // (row) => Promise<void>    (throws on failure)
     attemptsOf, maxOf,// row → counters (abstract attempts vs retry_count)
     bumpAndPersist,   // (client,row,nextAt,err) => void  (worker owns status vocab)
     computeBackoff,   // (n) => Date
     onAbandon,        // (client,row,err) => void
     helpers,
   })
   ```
   The helper owns the **control flow** (claim → attempt → on-throw:
   increment/compare-max/branch retry-vs-abandon/schedule versioned job with
   `maxAttempts:1`); the workers pass in their **divergent pieces** (lock, success
   rule, backoff fn, status writes).
2. Refactor `relay-publish.ts` to call it — its advisory lock and
   discovery-partial-success live inside the passed `claim`/`attempt` closures
   (behaviour-preserving).
3. Refactor `outbound-cross-post.ts` likewise.
4. Leave the **enqueue** side as-is (`shared/src/lib/relay-outbox.ts::
   enqueueRelayPublish` and `gateway/src/lib/outbound-enqueue.ts` — they already
   share the `ON CONFLICT DO NOTHING` + `add_job` shape and aren't the duplication
   the audit targets).

**Verify.** Both workers' existing tests pass unchanged; force a failure on each
path and confirm identical retry timing / abandon-after-max / job-key versioning to
pre-refactor. Behaviour diff = none.

**Risk.** Low (behaviour-preserving extraction). The trap is over-unifying — do
**not** collapse the status vocabularies or counter semantics into the helper; keep
them in the worker-supplied closures.

---

## Item 4 — Gateway module boundaries (god-file split)

**Goal.** Split the two god-files into internal module folders and define domain
seams **inside the single deployable**. No service extraction. Reversible.

**Consistency note.** `docs/adr/GATEWAY-DECOMPOSITION.md` deliberately did **not**
cover these two files and warns "don't extract just because big." This item is an
**internal split** (one Fastify plugin → a folder of concern-files re-exported
through `index.ts`), not extraction — consistent with that ADR.

**4a — `external-items.ts` (2769 lines) → `gateway/src/routes/external-items/`:**
- `index.ts` — the `externalItemsRoutes(app)` plugin; registers the sub-routers.
- `engagement.ts` — `GET …/engagement` + `fetchBluesky/MastodonEngagement` (≈196-270,
  982-1061).
- `interactions.ts` — `POST …/like|repost|poll-vote|reply` (≈510-975); dispatches to
  `lib/outbound-enqueue`.
- `hydration/parent.ts`, `hydration/quote.ts`, `hydration/thread.ts` — the per-protocol
  context/quote/thread walks (≈1067-2166).
- Move the **shared hydration internals** consumed by workers
  (`willHydrateThread`, `hydrateExternalThreadContext`,
  `persistHydratedThreadNodes`, `hydrate{Bluesky,Mastodon,Nostr}Thread`, ≈2206-2693)
  into `gateway/src/lib/external-hydration.ts` — they're imported outside the route
  file, so they belong in `lib/`, not a route module.
- Keep the four TTL caches with their consumers (engagement/parent/quote/thread).

**4b — `feeds.ts` (2064 lines) → `gateway/src/routes/feeds/`:**
- `index.ts` — the `feedsRoutes(app)` plugin.
- `crud.ts` — feed list/create/patch/order/delete/merge + `seedStarterFeeds`
  (≈335-642).
- `sources.ts` — `addSource` / `removeSource` (DELETE handler) / move / patch.
  **CRITICAL: keep `addSource`, the `removeSource` DELETE handler, and the
  `markFollowListDirty` calls together** — they jointly maintain the
  feed-derived `external_subscriptions` invariant + the kind-3 follow graph
  (CLAUDE.md Invariants). Do not scatter them.
- `items.ts` — `GET …/items` + `sourceFilteredItems` + `placeholderExploreItems`
  + cursor codec (≈656-705, 1381-1449, 1887-2064).
- `saves.ts` — saves CRUD (≈1234-1374).
- `author-volume.ts` — author-volume get/set/clear (≈804-959).

**Sequencing.** Do 4b (`feeds`) and 4a (`external-items`) as separate PRs. Each is a
pure move-and-re-export: no behaviour change, no route-path change (registration in
`gateway/src/index.ts:226,255` keeps the same plugin + prefix). Land item 3's
money-path edits (`votes.ts`, `drives.ts`) **before or independent of** this so the
ledger work isn't rebasing across a large file move.

**Verify.** Route table unchanged (`app.printRoutes()` diff = none); `npm run build`
in `gateway`; root `npm run lint` at 0 errors (promise-safety across moved files);
smoke the feed item-list + add/remove-source + an external like/reply.

**Risk.** Reversible and low, but it's a big diff — review as moves, not rewrites.
The one real hazard is breaking the `external_subscriptions` invariant by splitting
`addSource`/`removeSource`; the plan keeps them co-located to prevent it. Promote any
of these modules to a real service **only** on demonstrated deploy/scale/blast-radius
need — not in this item.

---

## Item 1b — Extract `000_base.sql` genesis — **DEFERRED**

Unchanged from the ADR: only if/when self-host needs a true from-empty replay.
Extract a genesis migration from today's `schema.sql`, after which `001+` replay on
top, `schema.sql` becomes regenerated output, and a from-zero CI replay (the real
fix for the item-1a gap) becomes possible. Schedule as its own scoped task.
