# Implementation Plan — Architectural Audit Outcomes (2026-06-15)

**Companion to:** `docs/adr/ARCHITECTURE-AUDIT-ADR-2026-06-15.md`
**Status:** Spade-ready plans for the accepted decisions, grounded in a full-tree
read of the current code. One plan per audit item. Item 2 is **parked pending
re-scope** (see below); the other seven are ready to dig.

Execution order follows the ADR's own suggested order:
`1a → 7, 8 → (2 parked) → 3 → 6 → 5 → 4`. Item 1b stays deferred.

Migration numbers below say "next free NNN" — the chain is currently at `117`;
assign sequentially at implementation time so two items don't collide.

---

## Item 2 — Finish UNIVERSAL-POST — **PARKED, re-scope required**

The ADR's stated action ("drop `article_id`/`note_id`/`external_item_id` +
`exactly_one_source`") does **not** survive a read of the code:

- `post_id` is a **derived text hash** (`feed_items_derive_post_id(protocol,
  stableOriginHandle)`, migration 098) — **not** a foreign key. It identifies a
  post across versions/relays; it does not encode which body table holds the
  content.
- The three source-id columns are the **live FK join keys** (with `ON DELETE
  CASCADE`) to `articles` / `notes` / `external_items`, used in `feed-sql.ts`
  (`FEED_JOINS`), `feed-items-reconcile.ts` (`ON CONFLICT (note_id|article_id|
  external_item_id)`), `author.ts`, `post-thread.ts`, `external-context-gc.ts`,
  `scheduler.ts`, `publication-publisher.ts`. They cannot be dropped without a
  substitute path to the bodies.
- The "dual-maintenance cost" the item cites is ~nil in app code: `post_id` /
  `version` / `biddability_tier` are maintained **only** by the DB trigger
  `feed_items_post_identity` (098/099). App code reads, never writes them.
- The UNIVERSAL-POST ADR is still **Proposed**, contains **no drop-step**, and
  explicitly chose `post_id` as a derived column *on* `feed_items` so it would
  not replace the source tables.

**Decision (2026-06-15):** Park and return to the audit author for a corrected
end-state. Two coherent re-scopes exist — (a) minimal: drop only the now-redundant
`exactly_one_source` CHECK (`item_type` already encodes the slot), keep the FKs;
(b) the real project: build a unified content identity table so bodies hang off
`post_id`, *then* retire the FKs (weeks, touches every read path). Neither is
planned here until the intended scope is confirmed.

---

## Item 1a — Harden the schema drift guard

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

## Item 7 — Park trust

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

## Item 8 — Park traffology

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
