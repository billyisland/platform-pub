# all.haus — audit verification & prioritised backlog

Verification of the round-1 audit against the code on `master` (4a91f…), then a
ranked backlog. Every item has a **Verified:** line pointing at the files/lines
that confirm (or refute) the diagnosis, so nothing has to be re-checked before
work starts.

Ranking is by **correctness risk × blast radius × effort**. P0 items can
corrupt state or silently lose user money. P1 items are drift hazards or
confusion-inducing but not actively broken. P2 items are housekeeping.

Two audit claims did not hold up on verification and are called out at the end
(§ Rejected).

> **STATUS — 2026-06-07: Round 1 (§1–§25) is fully resolved.** Re-verified
> item-by-item against `master`; every P0/P1/P2 finding below is fixed, mostly
> via refactors this doc predates (route files → directories, `access.ts` →
> `article-access/`, workers → `gateway/src/workers/`, shared `slug.ts` /
> `advisory-locks.ts`, npm workspaces). The detailed entries are kept as a
> historical trail — **do not treat the P0/P1 sections as open work.** Two
> findings were resolved differently than proposed: §23 — `feeds.ts` was *not*
> renamed (`feeds.ts` = timeline and `external-feeds.ts` = CRUD now coexist);
> §24 — root `.md` count is now **9**, not the 22 it was trimmed toward. The
> P3 items (§26 outbox — now partly shipped per RELAY-OUTBOX-ADR; §28–30) and
> everything from the 2026-06-03 round onward remain the live backlog.

---

## P0 — correctness bugs (fix before anything else) — ✅ ALL RESOLVED (2026-06-07)

### 1. Scheduler: v2 encryption failure leaves a paywalled article with no vault

**Verified:** `gateway/src/workers/scheduler.ts:159-232`. `publishPersonalDraft`
publishes v1 (free teaser) to the relay at line 159, indexes the article in
the DB at lines 169-199 with `access_mode='paywalled'` and
`nostr_event_id=v1.id`, **then** tries to encrypt v2 at line 206. If
`createVault` throws (line 299), the catch at line 224 logs and continues.
The draft is deleted at line 58 on the outer success path.

Result: the article is live on the relay (v1, free content only), the DB
marks it paywalled, and there is no payload tag anywhere. Readers who try to
unlock get nothing — there's nothing to unlock. The writer thinks the
scheduled publish succeeded.

**Fix:** wrap v1 publish + DB insert + vault + v2 publish + DB update in a
single transaction-like unit. The relay publish can't literally be rolled
back, but the ordering can be inverted: create the vault first, build both
events, publish v1 and v2 in sequence, then insert the DB row with the final
event_id. If any step before the DB insert fails, the draft stays on
`article_drafts` for retry. (The same inversion is probably worth applying to
the client-side publish path in `web/src/lib/publish.ts`, but the scheduler
is the one that silently eats the failure.)

### 2. Scheduler: nostr_event_id UPDATE not in a transaction with v2 publish

**Verified:** `gateway/src/workers/scheduler.ts:217-223`. `publishToRelay(v2)`
at 217, then `UPDATE articles SET nostr_event_id = v2.id` at 220. If the
relay publish succeeds but the UPDATE fails, DB points at v1 while the relay
serves v2. The fix from #1 subsumes this.

### 3. `recordSubscriptionRead` is two non-atomic inserts

**Verified:** `gateway/src/services/access.ts:100-121`. Two separate
`pool.query` calls, no transaction. If the second insert fails, the unlock
sticks but the `subscription_events` audit row is missing. Not catastrophic
(the read *did* happen, the reader *did* get access) but the ledger is then
wrong, and everywhere else in the codebase uses `withTransaction` for
paired writes.

**Fix:** wrap in `withTransaction`. Five-line change.

### 4. Expiry-warning dedup is fire-and-forget, not awaited

**Verified:** `gateway/src/routes/subscriptions.ts:1099-1103`. `pool.query(…)`
without `await`; `.catch` attached, but the function returns before the
insert completes. If the process receives SIGTERM between email send and
dedup insert landing, the reader gets the warning email twice (next cycle
sees no dedup row).

**Fix:** `await` the insert. One character.

### 5. Subscription expiry-warning marker abuses `event_type`

**Verified:** `gateway/src/routes/subscriptions.ts:1098-1103` inserts with
`event_type='subscription_charge'`, `amount_pence=0`, and a magic
description `'Expiry warning sent'`. The dedup `NOT EXISTS` at line 1086
matches on that description. Any `SUM(amount_pence) WHERE
event_type='subscription_charge'` query that forgets the description filter
will still produce the right number (amount is 0), but anything that
`COUNT(*) WHERE event_type='subscription_charge'` will over-count.

**Fix:** add `'expiry_warning_sent'` to the `event_type` enum (or CHECK
constraint) and use it here. Migration + two-line code change.

### 6. Platform fee hardcoded in one place, read from config in two others

**Verified:** `gateway/src/routes/subscriptions.ts:1118` computes
`Math.round(pricePence * 0.08)`. `gateway/src/routes/v1_6.ts:79-82` and
`gateway/src/routes/publications.ts:1259` both read
`platform_config.platform_fee_bps` defaulting to 800.
`shared/src/db/client.ts:91` loads it into the shared config object as
`platformFeeBps`. Change the config row and subscription earnings silently
continue at 8%.

**Fix:** replace the `* 0.08` with
`Math.round(pricePence * platformFeeBps / 10000)`, reading `platformFeeBps`
from either `loadConfig()` (which it already has) or one direct query.
One-line fix + test.

---

## P1 — drift hazards, inconsistencies, sealing — ✅ ALL RESOLVED (2026-06-07)

### 7. Duplicated `generateDTag` (three live definitions, one tested-equal)

**Verified:**
- `gateway/src/workers/scheduler.ts:265-274` — local copy
- `gateway/src/services/publication-publisher.ts:363-372` — exported
- `web/src/lib/publish.ts:202` — third copy
- `web/tests/publish.test.ts:45` explicitly asserts "identical output to
  gateway generateDTag for same input and time" — the duplication is known
- `scheduler.ts:131` uses the *local* copy for personal drafts, but the file
  also imports from `publication-publisher.js` (it's called transitively
  through `publishToPublication`). Same file uses both definitions.

**Fix:** move to `shared/src/lib/nostr.ts` (or similar), export a single
`generateDTag`, import from all three sites. The web copy stays where it is
— it's still in a different package — but switch it to re-export from
shared once workspaces exist (P2 item §18). Delete the scheduler's local
copy now regardless.

### 8. Slug generation duplicated four times in the gateway

**Verified:** the `slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g,
'').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, …)` pattern appears
identically in:
- `gateway/src/routes/articles.ts:66-71` (slice 120)
- `gateway/src/workers/scheduler.ts:163-167` (slice 120)
- `gateway/src/workers/scheduler.ts:267-271` (slice 80, inside `generateDTag`)
- `gateway/src/services/publication-publisher.ts:365-369` (slice 80)

**Fix:** a single `slugify(title, maxLen)` in `shared/src/lib/slug.ts`.

### 9. Background workers exported from route files

**Verified:**
- `gateway/src/routes/subscriptions.ts:937` exports `expireAndRenewSubscriptions`
- `gateway/src/routes/drives.ts:822` exports `expireOverdueDrives`
- `gateway/src/index.ts:22,35` imports both; `:271,274,286,289` runs them
  under advisory locks alongside the scheduler
- `gateway/src/workers/scheduler.ts` is the only worker that lives in
  `workers/` as a first-class module

The entry-point importing route modules to invoke long-running loops is
inverted: in effect `subscriptions.ts` is both a route file and a worker
module with a route-file's name.

**Fix:** move both workers into `gateway/src/workers/`, keep the route file
pure.

### 10. Advisory-lock IDs leave a hole (100003)

**Verified:** `gateway/src/index.ts:245-247` defines
`LOCK_SUBSCRIPTIONS=100001`, `LOCK_DRIVES=100002`, `LOCK_SCHEDULER=100004`.
100003 is missing. Classic "we removed a worker" smell — safe today, confusing
tomorrow, and these are spread across two services (the feed-ingest
jetstream listener also uses advisory locks in
`feed-ingest/src/jetstream/listener.ts:115`).

**Fix:** a single `shared/src/lib/advisory-locks.ts` exporting
`ADVISORY_LOCKS.SUBSCRIPTIONS` etc. as a const object, with a comment for
the gap. Twenty minutes.

### 11. Env-validation helper exists, three services reimplement it

**Verified:** `shared/src/lib/env.ts` exports `requireEnv` / `requireEnvMinLength`.
Used in `gateway/src/index.ts`, `gateway/src/routes/{articles,auth,linked-accounts,unsubscribe}.ts`.
Not used in:
- `key-service/src/index.ts:18-23` (handwritten `for (const name of …)`)
- `key-custody/src/index.ts:28-33` (same)
- `payment-service/src/index.ts:15-17` (same)

**Fix:** five-minute find-and-replace across three entry files.

### 12. Five `(req as any).session?.sub` casts in traffology routes

**Verified:** `gateway/src/routes/traffology.ts:30,58,80,115,195`. Every
other route in the gateway (38 `as any` occurrences across 14 files, but
those are mostly Nostr-event type boundaries) uses `req.session!.sub!` with
`preHandler: requireAuth`. The traffology routes already declare
`preHandler: requireAuth` at each handler — the cast just isn't using the
typed `req.session` at all.

**Fix:** replace the five casts. If the route type isn't picking up the
augmented `req.session`, add the fastify module augmentation in
`gateway/src/types/fastify.d.ts` (whichever file currently declares it) and
point the traffology imports at it.

### 13. Three services have pure re-export `db/client.ts` shims

**Verified:**
- `key-service/src/db/client.ts` — 2 lines, re-exports `pool`,
  `withTransaction`, `loadConfig` from `../../shared/src/db/client.js`
- `key-custody/src/db/client.ts` — 2 lines, re-exports `pool`,
  `withTransaction`
- `payment-service/src/db/client.ts` — 5 lines, comment + re-export

Gateway imports `pool` directly from the shared path without a shim.
Inconsistent and hides which service has its own pool config from a casual
reader.

**Fix:** delete the three shims, update imports. Low risk.

### 14. Mixed transaction idioms inside the same file

**Verified:** `gateway/src/routes/publications.ts` contains 9 `BEGIN` /
`COMMIT` / `ROLLBACK` tokens and 0 uses of `withTransaction`. Other route
files (articles, notes, subscriptions partially) use `withTransaction`
exclusively. The split is by file, not by operation — no reason for it.

**Fix:** mechanical. Convert each manual BEGIN block in `publications.ts`
(and tags.ts, if it does the same) to `withTransaction(async client => …)`.

### 15. Stale docker-compose.yml header comment

**Verified:** `docker-compose.yml:1-17` lists postgres, strfry, gateway,
payment, keyservice, web, nginx, blossom, certbot. The compose file
actually defines additionally: key-custody, feed-ingest,
traffology-ingest, traffology-worker.

**Fix:** 30 seconds.

### 16. Cursor parser accepts non-UUID ids

**Verified:** `gateway/src/routes/feed.ts:39-59`. The 2-part branch at 50-54
checks `id.length >= 36` but not UUID format. Downstream SQL parameterises
the value so there's no injection risk; cosmetic sloppiness.

**Fix:** cheap — import a uuid regex or reuse `z.string().uuid()`. Low
priority unless this path becomes security-sensitive.

### 17. Start script mismatch with Dockerfile

**Verified:** `gateway/package.json` (and each service's) declares
`"start": "node dist/src/index.js"`. `gateway/Dockerfile:13` runs
`./gateway/node_modules/.bin/tsx gateway/src/index.ts` directly. The `start`
script is never invoked; the build target in the Dockerfile is vestigial.

**Fix:** either make the Dockerfile build and run the built JS (preferred
for production), or remove the `"start"` scripts that don't work. Currently
tsx-at-runtime is production behaviour, which is a correctness concern
(re-transpiling source on every boot, no type check in the container).
Flagging as P1 rather than P0 because it works today.

---

## P2 — housekeeping, naming, dead code — ✅ ALL RESOLVED (2026-06-07; §23/§24 resolved differently — see status note)

### 18. Adopt npm workspaces (or pnpm workspaces)

**Verified:** root `package.json` has no `workspaces` field, and the
Dockerfile has a symlink dance (`RUN ln -sf /app/shared /app/gateway/shared`)
to make `../../shared/src/…` imports work from each service. The
re-export shims in §13 exist because of the same pressure. Per-service
`tsconfig.json` files override `rootDir` to `.` specifically so the
symlinked `shared/` compiles into each service's `dist/`.

**Fix:** root `package.json` `"workspaces": ["gateway", "shared",
"payment-service", "key-service", "key-custody", "feed-ingest",
"traffology-ingest", "traffology-worker", "web"]`, each service depends on
`@platform-pub/shared: "*"`, Dockerfiles use `npm install --workspaces` then
the symlink goes away. One day of work; removes a whole category of
papercuts.

### 19. Split `web/src/lib/api.ts`

**Verified:** 1,685 lines, 87 exports. File comment already groups exports
into `auth`, `payment`, `articles`, `keys`, `content`, `feed`, `follows`,
`search`, `writers`, `replies`, `myArticles`, `bookmarks`, `tags`,
`readingHistory`, `readingPositions`, `readingPreferences`, `notifications`,
`votes`, `messages`, `dmPricing`, … — those are the natural file splits.

**Fix:** split into `web/src/lib/api/{auth,articles,feed,…}.ts`. Keep `api.ts`
as `export * from './api/auth'` for one release to avoid a mass-rename, then
delete it. Mechanical, cheap.

### 20. Split the three gateway mega-route-files

**Verified:**
- `gateway/src/routes/publications.ts` — 1,353 lines, 29 routes (members,
  invites, offers, articles, settings, masthead)
- `gateway/src/routes/articles.ts` — 1,153 lines
- `gateway/src/routes/subscriptions.ts` — 1,138 lines

Each is readable today but adding anything new takes a full-file read to
find the right spot.

**Fix:** convert each to a directory of 4-6 files, grouped by feature
(`publications/core.ts` + `publications/members.ts` + `publications/invites.ts`
+ …). Two days' work, no behavioural change. Pair with §9 so workers move
out cleanly.

### 21. Delete six confirmed-unused components

**Verified (all six have zero `import` statements in web/src):**
- `web/src/components/feed/NoteComposer.tsx` (188 lines) — replaced by
  `ComposeOverlay`
- `web/src/components/ui/NotificationBell.tsx` (274 lines)
- `web/src/components/ui/ErrorBoundary.tsx` (43 lines)
- `web/src/components/ui/UserSearch.tsx` (105 lines)
- `web/src/components/dashboard/DrivesTab.tsx` (93 lines)
- `web/src/components/icons/ThereforeMark.tsx` (43 lines)

Total: 746 lines.

`globals.css:551` has a CSS selector `[class*="NoteComposer"]` that is stale
after the deletion — remove it in the same change.

**Fix:** delete the files. One-line follow-up to confirm
`web/src/app/**` has no dynamic imports referencing them (the grep was
negative, but dynamic imports would need a second-pass check).

### 22. Delete `provenance-ikb.jsx` from repo root

**Verified:** `provenance-ikb.jsx`, 547 lines, at the repo root. The only
`.jsx` file in a TypeScript codebase. No imports from anywhere. Audit was
right: orphaned prototype.

**Fix:** `git rm provenance-ikb.jsx`.

### 23. Rename ambiguous files

**Verified:**
- `gateway/src/routes/feed.ts` — the unified timeline / explore endpoint
- `gateway/src/routes/feeds.ts` — external feed subscriptions CRUD
- `gateway/src/routes/v1_6.ts` — `/my/tab` + `/my/account-statement`; name
  reflects a historical migration, not intent. (Both endpoints are in
  live use — see §Rejected.)

**Fix:**
- `feed.ts` → `timeline.ts`
- `feeds.ts` → `external-feeds.ts`
- `v1_6.ts` → `my-account.ts` (or split the two handlers into `reading-tab.ts`
  and `account-statement.ts`)

### 24. Move audit-and-planning markdowns out of repo root

**Verified:** `ls /home/ejklake/platform-pub-dev/*.md` returns **22** files
(audit claimed 32). Still a lot for a repo root. Big ADRs
(ALLHAUS-REDESIGN-SPEC, UNIVERSAL-FEED-ADR, ALLHAUS-OMNIBUS,
TRAFFOLOGY-MASTER-ADR-2, PUBLICATIONS-SPEC, OWNER-DASHBOARD-SPEC,
EMAIL-ON-PUBLISH-SPEC, UI-DESIGN-SPEC, GATEWAY-DECOMPOSITION,
ALLHAUS-ADR-UNIFIED, REDESIGN-SCOPE) plus audit reports plus currency/bucket
design notes.

**Fix:** `docs/adr/` for specs, `docs/audits/` for audit reports. Keep
`README.md`, `CLAUDE.md`, `DEPLOYMENT.md`, `feature-debt.md`, and this file
(`docs/audits/AUDIT-BACKLOG.md`) at root.

### 25. Near-empty root package.json

**Verified:** three runtime deps (for the seed script), no `workspaces`
field, no `scripts` beyond trivial ones. Not a bug; root cause of §18.

**Fix:** subsumed by §18.

---

## P3 — bigger architectural moves (do only if returns justify)

### 26. Outbox pattern for relay publishing

Every place that publishes a Nostr event is doing `INSERT ...;
publishToRelay(signed)` with ad-hoc retry. The scheduler v1/v2 hazard (§1),
`recordSubscriptionRead` (§3), publication-publisher, and the notes route
deletion flow would all be cleaner as "write intended-publish record in
transaction, worker picks it up and publishes". feed-ingest already runs
Graphile Worker; extending it to a gateway outbox is the permanent fix for
the whole class. Estimated week of work; biggest correctness dividend of
anything on this list.

Only do this after §1-6 are shipped as tactical fixes — the outbox
replaces them, but shouldn't block them.

### 27. Promote gate-pass orchestration into a dedicated module

**Verified:** `gateway/src/routes/articles.ts` (the `/articles/:nostrEventId/gate-pass`
handler), `gateway/src/services/access.ts` (check + record helpers), and
payment-service each own a piece. Gateway also computes
`readerPubkeyHash` inline and manages tab creation. Three roles in one
handler.

**Fix:** pull gateway-side access + gate-pass orchestration into
`gateway/src/services/article-access/` (module of 3-4 files). Half-day.

### 28. Consider merging key-service and key-custody

**Verified:** 918 + 447 lines, 15 files total. Security split is real
(key-custody holds `ACCOUNT_KEY_HEX`, key-service holds
`KMS_MASTER_KEY_HEX`); not obvious whether that justifies two containers.
Not pressing.

**Fix:** defer unless consolidating services becomes a priority for
operational reasons.

### 29. Gateway audit categories the round-1 audit didn't cover

The round-1 audit explicitly flagged that it did not read the DM / NIP-17
messages route (`gateway/src/services/messages.ts`, 563 lines), the
Stripe webhook handler, the Traffology ingest flow, the resolver
(`gateway/src/lib/resolver.ts`, 727 lines), the ATProto OAuth client setup
(`shared/src/lib/atproto-oauth.ts`), and most of the feed-ingest adapters
(33 files, 4,716 lines). Round-2 audit should target these; the payment
webhook is the most load-bearing and the likeliest to harbour correctness
bugs of the class in §1-6.

### 30. Run a proper dead-code sweep

Round-1 only ran the unused-component scan on `web/src/components/`. A
`ts-prune` / `knip` pass across the whole repo (both packages and
services) is likely to find more orphaned exports, especially in
`web/src/app/` route handlers and hooks. Low effort, one run gives the full
list.

---

## Rejected / overstated audit claims

### `/my/account-statement` has "no web consumer" — WRONG

**Verified:** `web/src/components/account/AccountLedger.tsx:51` calls
`GET /api/v1/my/account-statement?filter=…&limit=…&offset=…`. The endpoint
is live and consumed. The audit missed this grep.

The route file name `v1_6.ts` is still bad (§23) and the `/my/tab` and
`/my/account-statement` handlers could profitably be split, but neither
handler is abandoned code.

### "32 markdown files in repo root" — overstated

Actual count: 22. Still noisy (§24), but the number in the audit was
wrong.

### "content_preview .slice(0, 200) in one place, who-knows-what elsewhere"
— not verified further, flagged as speculation

The round-1 audit flagged this as a TODO-verify rather than a claim.
`articles.ts:147` does use `.slice(0, 200)`. A full audit of all
`feed_items` inserts (publication-publisher, note ingest, external-feed
dual-writes in feed-ingest) is worthwhile but wasn't in scope here.
Folded into §29.

### "`as any` count in gateway" — 38, not 42

Audit said 42; actual is 38 across 14 gateway files. Directionally correct,
small miscount. The substantive claim — that traffology.ts has 5 of them
and they're all auth-extraction shortcuts — is true (§12).

---

## Suggested attack order — ✅ COMPLETED (Round 1 work all landed)

_Historical: this was the plan when §1–§25 were open. All of it shipped; kept
for the trail._

A week of focused work, roughly:

**Day 1 (P0 bugs)**
§1 (scheduler vault), §2 (subsumed), §3 (access.ts transaction),
§4 (await warning insert), §5 (event_type enum), §6 (platform_fee_bps).
Each has unit-test coverage — land each as its own commit with a
regression test.

**Day 2 (P1 consolidation)**
§7 + §8 (slug/dTag), §10 (advisory-lock constants), §11 (env helper),
§12 (traffology casts), §13 (db/client shims), §15 (compose header).
All small, all mechanical.

**Day 3 (P1 structural)**
§9 (move workers), §14 (transaction idiom convergence), §17 (build-for-prod).
Need a little more care — changes to startup and CI.

**Day 4-5 (P2 refactors)**
§19 (split api.ts), §20 (split mega-routes), §21-24 (deletions + renames
+ docs tidy). Each is mechanical but the diffs are large, so take them one
at a time and confirm the build stays green after each.

**Later**
§18 (workspaces) and §26 (outbox) — each a week-ish project, done when
the organisational appetite is there. §29-30 are the next audit round, not
work.

---

# Audit round — 2026-06-03 (last two days of commits)

Deep audit of the 22 commits spanning 2026-06-01..03 (external-quote feature,
byline/author-identity, workspace dock redesign, one-post-per-card, deploy/
schema/lint hygiene). Findings ranked as before. **Two HIGH items were fixed in
the same pass and are recorded here as Done for the trail; the rest are open.**

## Fixed in this pass

### A1 (was HIGH) — Stored XSS via `quoted_url` on external quote-notes — ✅ FIXED

**Verified:** `gateway/src/routes/notes.ts:41` accepted `quotedUrl:
z.string().optional()` with no protocol guard; stored verbatim (`:117`) and
rendered as `<a href={preview.url}>` in `web/src/components/post/QuotedEmbed.tsx:101`.
React does not strip `javascript:`/`data:` URIs from `href`. An authenticated
user could POST `{ isQuoteComment, quotedPostId, quotedUrl: "javascript:…" }`
straight to `/api/v1/notes`; the payload fires for any viewer who clicks the
quoted tile (stored XSS, not self-XSS). Normal UI only emits `https://` via
`originWebUrl`, so it was invisible in manual testing.

**Fix applied:** `notes.ts` now refines `quotedUrl` to `^https?://` (primary,
server-side); `QuotedEmbed.tsx` additionally only assigns `href` when the value
passes the same `^https?://` test (defence in depth). Feature is two days old
(migration 102) so no malicious rows exist to backfill.

### A2 (was MEDIUM) — Over-limit external quote orphans a relay event — ✅ FIXED

**Verified:** `web/src/lib/publishNote.ts:52` appends `"\n\n" + quotedUrl` to the
published body, but `Composer.tsx:471` counted only `body.length` against the
1000-char limit. A body within the box limit could exceed `content.max(1000)`
at the gateway (`notes.ts:30`); because `signPublishAndIndex` publishes to the
relay *before* indexing, the index POST 400s and leaves a live-but-unindexed
Nostr event.

**Fix applied:** `Composer.tsx` reserves `quotedUrl.length + 2` in `charCount`
for external quotes, so the box gate matches the published body length.

## Open — P1 (drift hazard / false confidence, not actively broken)

### B1 — Schema-drift guard's blind spot contradicts the CLAUDE.md claim

**Verified:** `scripts/check-schema-drift.sh` runs three checks, none of which
builds a DB *from migrations* to compare against `schema.sql`. If a migration's
filename is in the `_migrations` seed but its object body is absent from
`schema.sql`, Check 0 passes (file is seeded), Check 1 passes (migrate.ts sees
it already-applied → "All migrations already applied"), Check 2 passes (round-
trips consistently without the object). The common mistake — add a migration,
forget to regenerate `schema.sql` — *is* caught (seed won't list it → Check 0
fails). The blind spot opens only on a hand-edited/partial regen (seed lists the
file, dump body stale). CLAUDE.md/the script header still imply the guard catches
"seeded but effect-missing" drift; it does not. The script's own NOTE concedes a
true `schema == migrations-from-zero` check needs a `000_base.sql` genesis.
**Fix:** the CLAUDE.md wording has been corrected (2026-06-03) to state the guard's
real scope and the seeded-but-effect-missing blind spot. **Remaining (open):**
fully closing it requires extracting a `000_base.sql` genesis migration and adding
a fourth build-from-migrations diff check.

### B2 — Infinite-scroll duplicate-fetch race

**Verified:** `web/src/components/workspace/WorkspaceView.tsx:468`
(`loadMoreVesselItems`) reads the `loadingMore` guard from `vesselsRef.current`,
which only updates on a committed render, while `Vessel.tsx:181` fires
`onLoadMore` on every near-end scroll event with no throttle. A single fling can
fire 2+ requests with the same cursor before React commits the guard; interleaved
responses can skip or re-fetch a page (visible cards de-dupe, but `nextCursor`
gets overwritten). **Fix:** a synchronous imperative latch (`Set<feedId>` ref
set/cleared in the callback), not React state.

## Open — P2 (housekeeping / latent)

### C1 — Latent multi-statement `CONCURRENTLY` hazard in migrate runner

**Verified:** `shared/src/db/migrate.ts:84`. The no-txn guard matches
`\bCONCURRENTLY\b` against the whole file *including comments* (migrations 022/083
only contain the word in comment text — no real CONCURRENTLY statement), and runs
the file via one `client.query(sql)`. A future file mixing `CREATE INDEX
CONCURRENTLY` with any other statement would still throw "cannot run inside a
transaction block" (libpq wraps a multi-statement simple-query in an implicit
txn). Not a regression — no such file exists — but the guard doesn't deliver the
general safety the commit implied. **Fix:** match real statements (strip comments
first) and split no-txn files statement-by-statement.

### C2 — Stray `{ }` JSX dropped five next-lint suppressions

**Verified:** the promise-safety lint pass (f9cbf3f) replaced
`eslint-disable-next-line` comments with empty `{ }` expressions at
`ArticleEditor.tsx:367`, `ArticleCard.tsx:178`, `ExternalCard.tsx:267`,
`NoteCard.tsx:330`, `Composer.tsx:1336`, silently dropping
`no-img-element`/`click-events-have-key-events` suppressions. Harmless only while
`next lint` is dormant; those lines will error the moment it's wired up. **Fix:**
restore the disable comments (or address the underlying lint).

### C3 — External-Nostr quotes drop the permalink

**Verified:** `web/src/lib/post/origin-url.ts:11`. `nevent`/`naddr` URIs (relay-
free, migration 101) match neither the atproto nor the `^https?://` branch →
returns `null`, so quoting an external Nostr post produces a linkless mini and no
URL appended to the body. Renders fine, degrades silently. **Fix:** construct an
`njump.me` URL for the nostr branch.

### C4 — Dead code after one-post-per-card

**Verified:** `web/src/components/workspace/ParentContextTile.tsx` and
`ReplyGroupCard.tsx` are unreachable (gateway dropped the `reply_group` envelope,
`feeds.ts`), and `PostCard.tsx`'s `header` prop is now unused. Inert. **Fix:**
delete the orphaned components + prop.

### C5 — Orphaned `expandedByFeed` keys

**Verified:** `WorkspaceView.tsx` clears `expandedByFeed` on per-feed refresh and
`refreshAll`, but not on feed delete/merge/hide. Inert (vessel ids are unique and
gone, never re-read). **Fix:** drop the key in `onDeleted`/merge/hide handlers.

### C6 — Cosmetic doc/label drift

- `buildExternalProfileUrl` (`gateway/src/lib/author-resolve.ts:87`) interpolates
  an atproto handle into a URL without `encodeURIComponent` (not a `javascript:`/
  redirect vector — scheme is hardcoded `https://bsky.app`).
- The "unified feed cursor codec" (6ec3ada) is a raw `tag:value:value` string,
  not base64 as the commit/CLAUDE.md framing implies (decode is properly
  defensive — no injection). Cosmetic wording mismatch.
- ~~CLAUDE.md still references the removed `validateWebSocketUrl` helper (d23f464).~~
  ✅ FIXED 2026-06-07 — the SSRF invariant now cites `pinnedWebSocketOptions`
  (`shared/src/lib/http-client.ts:407`), the real ws:/wss: helper.

---

# Audit round — 2026-06-07 (last three days of commits)

Deep audit of the ~45 commits spanning 2026-06-04..07 (subscription auto-renewal
hardening, feed-ingest perf tranches A–C, Nostr outbound interop Phase A,
feed/thread display fixes, the Glasshouse overlay refactor). Five parallel
work-stream audits; the two HIGH items were re-verified directly against source
and the live dev DB. Mechanical guards both green for this range (schema drift
0/1/2; hairline tripwire — no *new* 1px treatments). To-do checkboxes below;
nothing fixed yet.

## Open — HIGH

- [x] **D1 — Feed throughput cap (migration 106) is inert on every real DB.** ✅ FIXED 2026-06-07
  **Verified (live dev DB):** `migrations/106_feed_ingest_enqueue_cap.sql` is
  config-only (`INSERT INTO platform_config`), but `schema.sql` carries **no**
  `platform_config` seed data while its `_migrations` seed marks 106
  already-applied. So on any schema.sql-bootstrapped DB (dev `initdb.d` + prod
  fresh boots) `migrate.ts` skips 106 and the key is never created;
  `feed-ingest-poll.ts:27-30` resolves `max_enqueue_per_tick || max_concurrent
  || 100` → falls back to **10**, the exact ceiling 602d7d7/30750f4 set out to
  lift. Confirmed `feed_ingest_max_enqueue_per_tick` absent on the live dev DB
  (`feed_ingest_max_concurrent=10` present). This is the "seeded filename,
  omitted body" gap CLAUDE.md warns passes all three drift checks. **Same
  omission strands** `feed_ingest_rss_max_interval_seconds`, backoff/decay
  factors, and the engagement cap — all on code defaults, none operator-tunable.
  **Fix:** add `platform_config` seed rows to `schema.sql` (then re-run the
  drift guard), or default the poll code to 100 instead of relying on the seed.
  **Fix applied:** took the code option — `feed-ingest-poll.ts` now resolves
  `feed_ingest_max_enqueue_per_tick || 100`, dropping the `feed_ingest_max_concurrent`
  fallback that pinned the cap at 10. This restores migration 106's intended
  default on every DB (legacy *and* fresh) with no schema/migration risk.
  **Remaining (broader, not D1):** `platform_config` carries **zero** seed rows
  in `schema.sql`, so all operator-tunable keys (rss interval, backoff/decay,
  engagement cap, …) are absent on fresh prod boots and run on code defaults.
  Closing that is the genesis-seed work tracked under B1 — out of scope here.
  **✅ THAT REMAINDER IS NOW CLOSED (2026-07-20).** Taking the code option here
  treated the symptom, and the root cause resurfaced six weeks later during
  resonance step 5 — the same diagnosis, rediscovered from scratch. Fixed
  properly: defaults live in `shared/src/db/config-defaults.sql`, applied by
  `migrate.ts` on every run, with drift-guard Checks 4a/4b/4c enforcing it. 46
  dials were seeded on dev (31 migration-seeded + 15 that had no default row
  anywhere, including the six money dials — platform fee, free allowance, both
  settlement thresholds — silently dropped from `schema.sql` by the f8c73e6
  regeneration). The lesson this entry now carries: a config key that is
  unreachable is a *structural* defect, and patching one consumer's fallback
  leaves the mechanism broken for every other key. See FIX-PROGRAMME 2026-07-20.

- [x] **D2 — Mastodon thread/quote id-space fixed in only 1 of 4 write paths.** ✅ FIXED 2026-06-07
  **Verified:** b2f64ac keyed *hydration* on the federated `uri`, but
  `fetchMastodonParent` (`gateway/src/routes/external-items.ts:1319`),
  `fetchQuoteFromSource` (`:1724/1742`), and both prefetch-worker inserts
  (`feed-ingest/src/tasks/external-parent-prefetch.ts:456/472/493/694`) still
  store `source_item_uri = status.url` (human web URL). Consequences: (a) dedup
  forks — `ON CONFLICT (protocol, source_item_uri)` never matches the
  ingest-stored federated-uri row, recreating the duplicate `external_items` row
  b2f64ac claims to eliminate (silent; first render still works); (b) Mastodon
  quote **re-root is broken** — `derive_post_id` over the web URL ≠ the host's
  federated `source_quote_uri`, so clicking a Mastodon quote tile re-roots to
  nothing (Bluesky at:// uris match, so Bluesky works). **Fix:** `status.uri ||
  status.url` applied at all four call sites (same one-liner as b2f64ac).
  **Fix applied:** `sourceItemUri` now keys on `status.uri || status.url || …`
  in `fetchMastodonParent` + `fetchQuoteFromSource` (gateway `external-items.ts`)
  and both prefetch-worker inserts (`external-parent-prefetch.ts`). **Note:** any
  `url`-keyed forked rows already in a DB stay as orphans; new fetches key
  correctly and the live duplicate stops being minted (no backfill required —
  feature is days old).

- [x] **D3 — Unsanitized Mastodon HTML stored in the prefetch worker (latent
  stored-XSS).** ✅ FIXED 2026-06-07 **Verified:** `external-parent-prefetch.ts:477` and `:715`
  insert raw `status.content` into `content_html` with **no** `sanitizeContent`
  (the call appears nowhere in that file), unlike every other path. `content_html`
  is rendered via `dangerouslySetInnerHTML` in `QuotedPostTile.tsx:126` /
  `ExternalPlayscriptEntry.tsx:82`. Currently latent *only because* D2's keying
  bug means these rows are never served — fixing D2 without adding sanitize turns
  it live. **Fix:** wrap `status.content` in `sanitizeContent` regardless of D2;
  do not let a bug be the mitigation.
  **Fix applied:** imported `sanitizeContent` into `external-parent-prefetch.ts`
  and wrapped `status.content` in both inserts (parent + quote), matching every
  other ingest path.

## Open — MEDIUM

- [x] **D4 — Subscription retry-once can double-charge on a commit failure.** ✅ FIXED 2026-06-07
  **Verified:** `gateway/src/workers/subscription-expiry.ts:162-175`. The retry
  assumes the renewal transaction is atomic, but a failure of the COMMIT itself
  (or a connection drop after commit) throws to the caller while the DB applied
  the debit + period roll. The retry re-runs with no idempotency guard — the
  renewal `UPDATE` keys only on `id`, and `logSubscriptionCharge` always INSERTs
  a fresh charge/earning pair. **Fix:** add a `WHERE current_period_end < now()`
  precondition (treat `rowCount=0` as already-done) or a per-period idempotency
  key. (Tab clamp, annual discount, publication routing, migration 103 all
  verified correct & well-tested.) **Carried (product call):** catch-up
  multi-charge after downtime — one charge per missed period per hourly tick.
  **Fix applied:** the period-roll `UPDATE` is now the transaction's first
  mutation, gated `AND current_period_end < now()` (precision-safe vs. keying on
  the exact `Date`). On a committed-but-unacked retry the period has already
  moved into the future ⇒ 0 rows ⇒ the transaction returns early before the tab
  deduct / `logSubscriptionCharge` / signing, so the renewal is idempotent. New
  regression test in `gateway/tests/subscription-expiry.test.ts` covers the
  0-row guard path; existing 5 renewal tests unchanged & green.

- [x] **D5 — Discovery dirty-flag clear race drops a coalesced follow update.** ✅ FIXED 2026-06-07
  **Verified:** `gateway/src/lib/discovery-publish.ts:209-218`. A follow/unfollow
  landing between the follow-list read inside `republishFollowList` and the
  `follow_list_dirty = FALSE` clear is lost until the 7-day self-heal. **Fix:**
  conditional clear / claim pattern (clear only if unchanged, or clear-before-read).
  **Fix applied:** switched Phase A to a claim pattern — the dirty flag is now
  cleared *before* `republishFollowList` reads the follow set, so a concurrent
  follow/unfollow re-marks the row (via `markFollowListDirty`) and is caught next
  cycle instead of being clobbered by a post-publish clear. On republish failure
  the flag is restored (guarded on `status='active' AND publish_follow_graph`) so
  no work is dropped. Worst case is one idempotent double-publish of a replaceable
  kind-3, never a lost update.

- [x] **D6 — Discovery outbox marks `sent` when *any* relay accepts.** ✅ FIXED 2026-06-07
  **Verified:** `feed-ingest/src/tasks/relay-publish.ts:90`; in-house relay is
  first in the target list, so a row is `sent` even if every public fan-out relay
  rejected — defeats public-mesh delivery once `PUBLIC_FANOUT_RELAY_URLS` is set.
  Already noted as a deferred fast-follow in NOSTR-OUTBOUND-INTEROP-ADR §3.3;
  ships dark, so Medium. **Fix:** per-relay ACK accounting on discovery rows
  before the flag is flipped in prod.
  **Fix applied:** added `publishNostrToRelaysDetailed` (returns `{eventId,
  succeeded[], failed[]}`; `publishNostrToRelays` is now a thin back-compat
  wrapper for the cross-post caller). `relay-publish.ts` gates discovery entity
  types (`profile`/`follow_list`/`relay_list`): when public fan-out relays were
  targeted but none accepted (in-house-only ACK), it routes through
  `failAndMaybeRetry` instead of marking `sent`. Non-discovery rows keep the
  one-accepts rule. New regression tests cover the in-house-only retry and the
  public-accepted→sent paths.

- [ ] **D7 — Composer dead-code residue from f9e07f1.** **Verified:**
  `web/src/components/workspace/Composer.tsx` — the commit removed the recipient/
  broadcast UI but not the machinery; `chips` is now permanently `[]`, making
  `isPrivate`, the private-DM send branch (the sole remaining use of the
  `messagesApi` import, lines 434-446), and the crossPost chip paths unreachable.
  Misleading (contradicts the commit), not a runtime bug. **Fix:** delete the
  dead chip/resolver paths and the now-unused `messagesApi` import.

- [ ] **D8 — `FeedComposer` source row bypasses `ProfileLink`.** **Verified:**
  `web/src/components/workspace/FeedComposer.tsx:879` — account sources render
  `source.display.href` (`/:username`) as a bare `next/link` `<Link>`, full-page-
  navigating instead of opening the URL-synced profile overlay. Violates the
  sitewide ProfileLink rule. (Publication/external/tag hrefs on the same
  component are legitimately non-profile.) **Fix:** route through `<ProfileLink>`
  or `openProfileHref`/`isModifiedClick` for the account branch only.

## Open — LOW / NIT

- [ ] **D9 — Per-host enqueue throttle silently caps total throughput.**
  `feed-ingest/src/tasks/feed-ingest-poll.ts:91-119` — even with the per-tick cap
  raised, `hostSources.slice(0, maxPerHost)` (2) means effective ceiling is
  `2 × distinct_hosts`/tick with no skip log; nostr sources bucket by relay and
  can starve. **Fix:** add a skipped-due-to-host log; consider per-host relocation.
- [ ] **D10 — Stale `reply_to_author` never re-NULLed** when a parent is
  deleted/unresolvable (`feed-ingest/src/tasks/feed-items-author-refresh.ts:54-78`,
  migration 105) — the JOIN-only refresh leaves the old denormalised name in place.
- [ ] **D11 — `signAndEnqueue` signs outside the enqueue transaction**
  (`gateway/src/lib/discovery-publish.ts:104-122`) — safe for discovery
  specifically (event derived from already-committed state) but diverges from the
  canonical relay-outbox invariant; a future co-committed side effect would break
  silently. Flag/comment, no functional fix needed.
- [ ] **D12 — Inline `<video>` omits `referrerPolicy="no-referrer"`**
  (`web/src/components/post/PostMedia.tsx:242-261`) — leaks the all.haus referrer
  to third-party media hosts on play (poster `<img>` paths already set it).
  Cleanup/autoplay logic itself is correct.
- [ ] **D13 — Latent overlay history/scroll-lock edge cases.** `_handlePop` in
  `stores/reader.ts:119` / `stores/profileOverlay.ts:93` has no entry-ownership
  guard (stacked-overlay Back collision); `Glasshouse.tsx:50-55` scroll-lock can
  leak if two Glasshouses unmount out of LIFO order. Both unreachable in current
  UI — fix if overlay stacking is ever enabled.
- [ ] **D14 — `feed-batching.test.ts` covers only the pure helpers** — the
  multi-row VALUES builders / `$${b+1}` param-offset arithmetic, in-fetch dedup,
  atproto debounce reset, and cursor-flush merge-back are untested (correct now,
  unguarded against regression).

## Verified clean (no action)
Glasshouse z-index contract (scrim 55 / pane 56 / ForallMenu crisp at 60),
✕-only dismissal, all redirect shims (incl. `/messages` `#hash` client forward),
`overlays.ts` param handling, palette discipline, one-post-per-card (quote
embeds the only exempt grammar), Bluesky quote/re-root paths, native↔external
id-space separation, discovery dark-launch defaults + advisory-lock
acquire/release, NIP-05 response safety, subscription tab clamp / annual discount
/ publication routing / migration 103.
