# Implementation Plan — Architectural Audit Outcomes (2026-06-15)

**Companion to:** `docs/adr/ARCHITECTURE-AUDIT-ADR-2026-06-15.md`
**Status:** Spade-ready plans for the accepted decisions, grounded in a full-tree
read of the current code. One plan per audit item. Item 2 is **parked pending
re-scope** (see below); the other seven are ready to dig.

Execution order follows the ADR's own suggested order:
`1a → 7, 8 → (2 parked) → 3 → 6 → 5 → 4`. Item 1b stays deferred.

**Progress:** 1a, 7, 8 **shipped 2026-06-16** (see each item's header). Next up:
item 3 (the ledger keystone), then 6 → 5 → 4. Item 2 is re-scoped to tidy (A).

Migration numbers below say "next free NNN" — the chain is currently at `117`;
assign sequentially at implementation time so two items don't collide.

---

## Item 2 — Finish UNIVERSAL-POST — **re-scoped to a denormalisation tidy (A)**

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

## Item 3 — Unified append-only ledger *(keystone)*

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

## Item 6 — DM reactions

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

## Item 5 — Outbound delivery shared retry helper

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
