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

---

## P0 — correctness bugs (fix before anything else)

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

## P1 — drift hazards, inconsistencies, sealing

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

## P2 — housekeeping, naming, dead code

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

## Suggested attack order

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
