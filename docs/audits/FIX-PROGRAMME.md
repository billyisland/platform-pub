# all.haus — consolidated fix programme

Merges `docs/audits/platform-pub-review.md` (DM path, resolver, feed-ingest, Stripe,
dead-code sweep) and `docs/audits/AUDIT-BACKLOG.md` (scheduler, access, subscriptions,
service structure, refactor debt) after spot-verification against `master`.

Both audits hold up on the things I re-checked against source. Where they
overlap (unused components, workspace setup, `generateDTag`/slug duplication)
they agree; where they don't overlap they are complementary — `AUDIT-BACKLOG`
§29 explicitly flagged DM / resolver / Stripe webhook as out of its scope, and
those are the core of `platform-pub-review`. Claims rejected by either audit
(`/my/account-statement` orphan, 32-md-file count, 42 `as any`) survive my
cross-check as rejected.

Priority is **correctness risk × blast radius × effort**. P0 items can silently
lose user money or corrupt state. P1 are real bugs but not actively destroying
data, or drift hazards. P2 is housekeeping. P3 is bigger architectural work.

Each item points at files/lines so the diagnosis can be re-checked before work
starts.

---

## Progress

- **2026-04-20** — round-3 batches A–G shipped (§64, §67, §70, §71, §72,
  §73, §74, §75, §76, §77, §78, §79, §80, §81, §82, §83, §84, §85, §86,
  §87). §64 — `IP_HASH_SALT` now
  `requireEnv`'d at module load in `traffology-ingest/src/routes/beacon.ts`
  instead of defaulting to a hardcoded salt. §67 — ranking UPDATE moved
  inside `aggregate-hourly.ts`'s `withTransaction`, so ranks can't drift
  away from the `total_readers` they're derived from (unused `pool` import
  dropped). §70 — Mastodon `Idempotency-Key` now `outbound_posts.id`
  instead of `sha256(text + replyTo)`, so draft edits between retries no
  longer defeat Mastodon's dedup window; `MastodonOutboundInput` gained
  `idempotencyKey`, caller in `outbound-cross-post.ts` passes `row.id`.
  §71 — partial-success warn log in `nostr-outbound.ts` when some relays
  reject (caller still marks `sent` per the one-accepts rule; the log
  gives us signal without changing semantics). §72 — outbound retry
  `jobKey` versioned as `outbound_cross_post_${id}_r${retry}` so
  Graphile Worker's dedup can't collapse the retry into the in-flight
  job and lose the backoff delay. §78 — `/.well-known/oauth-client-metadata.json`
  and `/.well-known/jwks.json` now set `Content-Type: application/json`
  + `Cache-Control: public, max-age=3600` so PDSes polling for JWKS
  rotation don't hammer origin. §79 — `outbound-token-refresh.ts` logs
  sanitised `{ errName, errMessage: str.slice(0, 200) }` instead of the
  raw error object, removing the DPoP/token-leak-through-logs surface.
  §80 — `atproto_oauth_pending_states` TTL bumped 10min → 15min so a
  callback arriving at `expires_at` can't race the 5min prune cron.
  §81 — loopback `redirect_uri` now reads `process.env.PORT ?? '3000'`
  instead of hardcoding `:3000`, so dev gateways on alternate ports
  don't silently fail with redirect mismatch. §82 — `atproto-oauth.ts`
  asserts `baseUrl.startsWith('https://')` before casting in the prod
  branch; typo'd `ATPROTO_CLIENT_BASE_URL=http://...` fails fast
  instead of producing malformed client metadata. §83 —
  `atprotoClientMetadata()` + `atprotoJwks()` single-call helpers
  deleted; the two well-known route handlers now call `getAtprotoClient()`
  directly. §84 — publication CMS title edit now dual-writes to
  `feed_items.title` in the same handler, closing the drift window
  that relied on the 05:00 reconcile cron. §87 — personal-draft
  scheduler now dual-writes the `feed_items` row inside a transaction
  (mirroring `routes/articles/publish.ts`), so scheduled personal
  articles appear in the unified timeline immediately instead of
  waiting up to 24h for reconcile. Paywalled branch's v2 event-id
  rewrite also wrapped in a transaction so articles + feed_items can't
  end up pointing at different events. §73 — dropped the stray
  `?? item.summary` fallback on RSS `content_preview` (was always
  redundant: the RSS adapter's own `rawHtml` fallback already derives
  `contentText` from `summary` when `contentText` would otherwise be
  null, so the second fallback in the ingest path just masked what
  was already happening). §74 — new `activitypub_instance_health_prune`
  task drops rows whose last_success_at AND last_failure_at are both
  &gt; 90 days old; weekly Sunday 07:00 UTC cron. §75 — Bluesky adapter's
  `renderHtml` now runs its output through `sanitizeContent` like RSS
  and ActivityPub, so if we ever broaden the RichText walk the
  sanitiser is already in the path. §76 — gateway boot now eagerly
  calls `getAtprotoClient()` before `app.listen`; a malformed
  `ATPROTO_PRIVATE_JWK` fails the boot instead of the first
  OAuth-dependent request. Loopback dev is a no-op there since no
  JWK is required. §77 — `outbound_token_refresh` now distinguishes
  transient atproto errors (PDS 5xx, `ECONNRESET`/`ETIMEDOUT` + the
  rest of the undici transport set, walked through `cause` up to 4
  levels) from terminal ones; transient errors leave `is_valid=TRUE`
  and retry next cron tick instead of hassling the user with a
  reconnect prompt over a 30-second PDS blip. §85 — added three
  drift-repair UPDATEs to `feed_items_reconcile` (articles: title +
  content_preview; notes: content_preview; external: title +
  content_preview + author_name + author_avatar) so the reconcile
  safety net closes drift as well as missing rows. Per-case counts
  mirrored in the WARN log. §86 — new
  `shared/src/lib/text.ts::truncatePreview` that uses
  `Array.from(text).slice(0, 200).join('')` (code-point-aware) so JS
  content_preview writes agree with Postgres `LEFT(..., 200)` for
  emoji/astral-plane content. Swapped in across nine feed_items write
  paths (gateway publish.ts, notes.ts, publication-publisher.ts ×2,
  scheduler.ts; feed-ingest feed-ingest-rss.ts, feed-ingest-nostr.ts,
  atproto-ingest.ts, activitypub-ingest.ts). Error-truncation
  `.slice(0, 200)` call sites (log messages, HTTP error bodies) kept
  as-is — not content_preview-producing. Deferred from this round:
  §65 (observation dedup — needs semantic decision on temporal
  bucketing), §66 (cron `jobKey` — graphile-worker's `known_crontabs`
  slot-dedup already blocks duplicate fires for a given minute, so
  the claimed bug reproduces only on clock skew > 60s; leaving for
  when that surfaces), §68 (concurrent-reader endpoint auth —
  docker-internal network mostly contains it; revisit when/if those
  endpoints get exposed), §69 (JSONB zod validation on
  observation.values — not load-bearing until a third observation
  type ships). All 8 workspace builds clean; gateway 24/24 tests +
  shared 28/28 + feed-ingest 42/42 tests green; knip clean.
- **2026-04-20** — §61 gate-pass orchestration shipped. New
  `gateway/src/services/article-access/` directory with three modules:
  `access-check.ts` (the `checkArticleAccess` function + `AccessCheckResult`
  interface, lifted unchanged from the old `services/access.ts`),
  `unlock-records.ts` (`recordSubscriptionRead` + `recordPurchaseUnlock`,
  also lifted unchanged), and `gate-pass.ts` (the new `performGatePass`
  orchestrator). Barrel `index.ts` re-exports `checkArticleAccess` (used
  by `routes/replies.ts`) and `performGatePass` (used by the route
  handler). Old `services/access.ts` deleted; gateway test path updated
  to import directly from `./access-check.js` so the orchestrator's
  module-load `requireEnv` calls don't fire in unit tests.
  `routes/articles/gate-pass.ts` is now a thin HTTP wrapper: it builds
  the input, calls `performGatePass`, and a `switch` over the
  discriminated `GatePassResult` translates each `kind` to the same
  status + body the inline handler used to send (200/400/402/403/404/
  500/502). The orchestrator catches `ECONNREFUSED`/`ENOTFOUND`/
  `fetch failed`-shape errors itself and returns
  `{ kind: 'service_unreachable' }`; anything else propagates so the
  route's outer try/catch can log + return 500. Side cleanups:
  `READER_HASH_KEY` and `INTERNAL_SERVICE_TOKEN` dropped from
  `routes/articles/shared.ts` (only the orchestrator needs them now —
  `PAYMENT_SERVICE_URL` stays because `routes/articles/earnings.ts`
  still uses it for proxying); the get-or-create-tab dance and the
  HMAC reader-pubkey-hash computation moved into private helpers
  (`getOrCreateTab`, `isNetworkError`) inside `gate-pass.ts`; the
  key-service POST collapsed into one `fetchContentKey` helper used
  by both the free-access and post-payment branches (was duplicated
  inline before). CLAUDE.md "Article access logic lives in…" pointer
  updated to the new directory layout. Gateway 24/24 tests + web
  75/75 tests + build green; knip clean.
- **2026-04-20** — stragglers §21, §36, §57 shipped; §37 deferred.
  §21 — `sendMessage` now returns `{ messageIds, skippedRecipientIds }`
  instead of silently dropping recipients whose `nostr_pubkey` is null.
  `SendMessageResult` type in `gateway/src/services/messages.ts`, web
  `messages.send()` return type in `web/src/lib/api/messages.ts`, and
  `MessageThread.tsx` all updated; the web client `console.warn`s on
  partial delivery so dev signal is there pending a proper UI surface
  (no UX spec for partial-delivery toast yet, so no visible widget).
  §36 — verified per-row `SUM(amount - FLOOR(amount * fee / 10000))`
  matches the existing "platform absorbs rounding dust" rule tested in
  `payout-math.test.ts:183` and `settlement.test.ts:135`. A 1p read at
  8% bps correctly floors fee to zero; summing-then-flooring would
  instead collapse N sub-penny fees into a non-zero aggregate. Comment
  at `payout.ts` eligibility query now documents intent + points at the
  existing tests, so the pattern isn't misread as a bug during the next
  audit pass. §57 — cursor parser UUID validation tightened from
  `id.length >= 36` to a proper `^[0-9a-f]{8}-…-[0-9a-f]{12}$` regex.
  Legacy fallback branch (no-id plain-unix-seconds) unchanged — still
  injects the sentinel max-uuid. §37 (Stripe apiVersion bump) —
  deferred: installed stripe SDK is v14.25.0, which pins
  `LatestApiVersion = '2023-10-16'` at the type level, so a bare
  `apiVersion` string swap won't compile. Requires a coordinated SDK
  dependency bump (v14 → v17+) + end-to-end Stripe flow testing that
  needs network + a Stripe test account. Stays as the opportunistic
  item the original audit framed it as — piggyback next time
  webhook.ts/payout.ts/settlement.ts are touched with those resources
  available. Gateway 24/24 tests, payment-service 41/41, web 75/75, all
  builds clean.
- **2026-04-20** — §53 mega-route-file split shipped: the three largest
  gateway route modules (`publications.ts` 1,353 lines / 29 routes,
  `articles.ts` 1,153 / 13 routes, `subscriptions.ts` 959 / 13 routes) now
  live in directories (`routes/publications/`, `routes/articles/`,
  `routes/subscriptions/`) composed by an `index.ts` that re-exports the
  single top-level function each gateway registrar already calls
  (`publicationRoutes`, `articleRoutes`, `subscriptionRoutes`). Files
  grouped by concern — publications: core CRUD, members, CMS, public
  reads, revenue/rate-card; articles: publish/index, gate-pass
  orchestration, earnings, writer-side manage, subscription-convert;
  subscriptions: reader↔writer lifecycle, writer's subscriber
  management, publication subs, event history, pricing settings.
  `subscriptions/index.ts` re-exports `logSubscriptionCharge` (consumed
  by `workers/subscription-expiry.ts`) so the API surface beyond the
  gateway is unchanged. Mechanical split with zero behavioural change.
  Gateway type-check + 24/24 tests green, web 75/75 tests green, all 8
  workspace builds clean.
- **2026-04-20** — §58/59 follow-up: knip `types` strict-gate cleanup.
  Dropped `export` on 45 internal-only type/interface declarations across
  14 files flagged by `knip --include types`: feed-ingest adapters
  (`MastodonOutbound{Input,Result}`, `ActorMetadata`,
  `OutboxFetch{Options,Result}`, `AtprotoReplyRef`,
  `AtprotoPost{Input,Result}`, `RssFetch{Options,Result}`,
  `NormalisedItem`), feed-ingest libs (`ActivityPubIngestSource`,
  `AtprotoIngestSource`, `TruncateOptions`), gateway libs
  (`ActorProfile`, `AtprotoProfile`, `SubscriptionEventParams`,
  `EnqueueCrossPostInput`, `SignedNostrEvent`, `EnqueueNostrOutboundInput`,
  `InputType`, `MatchType`, `Confidence`, `ResolverMatch`,
  `ResolverResult` — `ResolveContext` kept exported since `routes/resolve.ts`
  still imports it per §49), gateway middleware/services
  (`PublicationMember`, `AccessCheckResult`, `InboxConversation`,
  `ConversationMessage`, `SendMessageResult`, `DecryptRequest`,
  `DecryptResult`, `DmPricingSummary`, `PublishToPublication{Input,Result}`),
  key-custody (`GeneratedKeypair`), payment-service
  (`PortableReceiptParams`, `ReadClassification`, `Split`, `SplitResult`,
  `PayoutStatus`, `WriterPayout`, `HandledStripeEvent`), traffology
  (`GeoResult`, `UAResult`, `KnownDomain`). CI workflow simplified: the
  `--include=files,dependencies,exports,unlisted,binaries` gate is now
  the default `npx knip` run (types is part of the default set now that
  the baseline is zero). All 8 workspace builds clean, 113 backend tests
  green, 75 web tests green, knip clean on the full default gate.
- **2026-04-20** — §58/59 follow-up polish: deleted the dead
  `shared/src/index.ts` barrel (zero consumers — the 202-import rewrite
  standardised exclusively on `@platform-pub/shared/<subpath>.js`),
  dropped the now-unreachable `main` field and `"."` / `"./*"` entries
  from `shared/package.json`'s exports map (keeping only `./*.js`
  which is the form every consumer uses). Removed `tsc` from
  `knip.json` `ignoreBinaries` (each workspace declares `typescript`
  as a devDep, so knip resolves it). All 7 backend Dockerfiles got
  `RUN npm prune --omit=dev` between build and `NODE_ENV=production`
  — previously production images shipped the full dev toolchain
  (tsx/vitest/typescript). `ApiError` now exported from
  `web/src/lib/api/client.ts` so error handlers can `instanceof`
  it. All 113 backend tests + 75 web tests green, knip clean, web
  type-check clean.
- **2026-04-20** — §58 + §59 shipped together (they were coupled — knip
  can only see the full graph once workspaces eliminate the symlink dance).
  npm workspaces adopted at root with 8 members (`shared`, `gateway`,
  `payment-service`, `key-service`, `key-custody`, `feed-ingest`,
  `traffology-ingest`, `traffology-worker` — `web/` stays standalone).
  Each consumer now lists `"@platform-pub/shared": "*"` and imports via
  `@platform-pub/shared/<subpath>` (202 imports rewritten across services
  + test mocks). `shared/package.json` exposes an `exports` map so subpath
  imports work both in dev (npm hoists `@platform-pub/*` into
  `node_modules/@platform-pub/`) and inside Docker images. All 7 backend
  Dockerfiles rewritten to `npm ci --workspace=… --include-workspace-root`
  then per-workspace `npm run build` — no more symlink dance, no more
  per-service lockfiles (now one `package-lock.json` at root). Per-service
  tsconfigs set `"rootDir": "src"` (removes the workaround that let tsc
  silently accept rootDir violations via symlinked source). The conversion
  revealed latent type errors in `feed-ingest/src/adapters/rss.ts` —
  custom RSS fields (`'content:encoded'`, `author`) weren't in the default
  `Parser` generic; fixed by typing `Parser<unknown, RssItemExtras>` with
  explicit `customFields` item list. `traffology-ingest` + `-worker` got
  `--passWithNoTests` on their `test` script (no test files yet, but they
  declared `"test": "vitest run"` which fails CI with exit 1). Knip v6.5.0
  wired at root with `knip.json`: scripts/ as entry+project pattern for
  the repo's `.ts` scripts, shared-workspace override (its `exports` map
  lets knip reach all public surfaces), `ignoreBinaries` for `tsc`/`next`/
  `vitest`/`tsx`, `ignoreDependencies` list for workspace-transitive deps
  (`pino`, `pg`, `jose`, `nostr-tools`, etc. — imported transitively via
  `@platform-pub/shared`, so per-service `package.json` declares them but
  no direct imports appear). Dead-code sweep from knip's initial report:
  4 singleton-service classes dropped `export` (`VaultService`,
  `PayoutService`, `AccrualService`, `SettlementService` — only the
  `const xService = new XService()` singleton is imported externally), and
  3 genuinely unused functions deleted outright (`nip44Encrypt` HTTP
  wrapper in gateway's key-custody-client, `decryptArticleBodyXChaCha` in
  key-service/src/lib/crypto.ts, `getTotalCount` in traffology-ingest's
  concurrent-tracker). `countGraphemes` in feed-ingest/src/lib/text.ts
  unexported (internal-only). CI workflow rewritten: one `npm ci` at root
  replaces 5 per-prefix installs, build + test run via
  `npm run X --workspaces --if-present`, knip gates on
  `files,dependencies,exports,unlisted,binaries`. Types category excluded
  from the strict gate — a 46-type baseline remains (mostly internal-only
  input/result interfaces paired with exported functions; cleanup is
  mechanical but out of scope for this session). `web/` CI path unchanged
  (still standalone `cd web && npm ci`). Local verification: 7/7
  workspace builds clean, all tests green (11 key-service + 41
  payment-service + 19 key-custody + 42 feed-ingest + shared + gateway,
  traffology-\* pass-with-no-tests), ESLint 0 errors, knip clean on
  strict categories. Follow-up tracked: drop `export` on the 46 unused
  types, move web/ into the workspace once Next.js toolchain compat is
  verified, consider promoting `types` back into the knip strict gate
  once cleanup lands.
- **2026-04-20** — §55 markdown reorg shipped: cleared 5 stale
  LibreOffice lock files (none of the documents were open — leftovers
  from prior crashes dated Apr 12–16), then moved 22 of the 26
  root-level markdowns into `docs/adr/` (14 forward-looking specs:
  `ALLHAUS-ADR-UNIFIED`, `ALLHAUS-OMNIBUS`, `ALLHAUS-REDESIGN-SPEC`,
  `CODE-QUALITY`, `EMAIL-ON-PUBLISH-SPEC`, `GATEWAY-DECOMPOSITION`,
  `OWNER-DASHBOARD-SPEC`, `PUBLICATIONS-SPEC`, `REDESIGN-SCOPE`,
  `TRAFFOLOGY-MASTER-ADR-2`, `UI-DESIGN-SPEC`, `UNIVERSAL-FEED-ADR`,
  `platform-bucket-system-design`, `platform-pub-currency-strategy`)
  and `docs/audits/` (8 post-hoc reviews: `ADMIN-PAGE-AUDIT`,
  `AUDIT-BACKLOG`, `AUDIT-REPORT`, `FIX-PROGRAMME`,
  `SUBSCRIPTIONS-GAP-ANALYSIS`, `all-haus-frontend-audit`,
  `platform-pub-review`, `universal-feed-audit`). Four files remain
  at root per the §55 spec: `README.md`, `CLAUDE.md`, `DEPLOYMENT.md`,
  `feature-debt.md`. `git mv` used for the 17 tracked files so rename
  history is preserved; plain `mv` for the 5 untracked ones
  (`ALLHAUS-ADR-UNIFIED`, `ALLHAUS-OMNIBUS`, `AUDIT-BACKLOG`,
  `REDESIGN-SCOPE`, `platform-pub-review` — no prior commits, so zero
  history loss). Bulk path-rewrite via `perl -pi -e` with a negative
  lookbehind `(?<!/)FILENAME\.md` pattern (idempotent — already-prefixed
  refs skip) rewrote every remaining bare reference across `CLAUDE.md`,
  `feature-debt.md`, the moved docs (adr↔audits cross-refs), 7
  feed-ingest task/adapter files, `gateway/src/routes/reading-positions.ts`,
  and 8 migration SQL files. `planning-archive/` intentionally not
  touched — that's frozen historical snapshot. Post-rewrite grep across
  the whole tree (ex. planning-archive, .git, .claude) returns zero
  bare references, confirming the regex was exhaustive.
- **2026-04-20** — Day 7 §52 api.ts split shipped: 1,568-line
  `web/src/lib/api.ts` split into 16 modules under `web/src/lib/api/`
  (`client.ts` for the shared `request()` + `ApiError` infra, plus
  `auth`, `account`, `articles`, `feed`, `notifications`, `votes`,
  `messages`, `social`, `drives`, `admin`, `publications`, `resolver`,
  `external-feeds`, `linked-accounts`, `trust`, `writers`). `api.ts`
  is now a 25-line pure-re-export facade with a note flagging it as
  transitional — all 76 consumers keep working unchanged. Restored a
  `WriterProfile` type into the new `api/writers.ts` module: §48
  dropped it alongside the `writers` API grouping, but 4 consumers
  still import the type (`[username]/page.tsx`, `WriterActivity`,
  `WorkTab`, `SocialTab`), so the orphan import surfaced as a
  type-check failure in this session's verify step. Post-fix:
  type-check clean, 75/75 web tests green.
  §55 still deferred (LibreOffice lock files on 5 specs).
- **2026-04-20** — Day 6 P2 deletions + renames shipped: §47
  (deleted 8 orphan components — `NoteComposer.tsx`,
  `NotificationBell.tsx`, `ErrorBoundary.tsx`, `UserSearch.tsx`,
  `DrivesTab.tsx`, `ThereforeMark.tsx`, `OffersTab.tsx`,
  `FeaturedWriters.tsx`; removed the stale `[class*="NoteComposer"]`
  print selector in globals.css and updated stale comment references
  in `format.ts` and `ProposalsTab.tsx`); §48 (web `lib/api.ts`
  pruned — deleted unused `keys`/`follows`/`search`/`writers`
  groupings and their types `KeyResponse`, `WriterProfile`,
  `ProfileFollower`, `ProfileFollowing`, `PublicSubscription`;
  dropped `export` on `SignupInput`, `SignupResult`,
  `GatePassResponse`, `ResolvedContent`, `Publication`;
  `lib/ndk.ts` kind constants trimmed to the three actually
  used — `KIND_ARTICLE`, `KIND_NOTE`, `KIND_DELETION`; dropped
  redundant `export default` on the three editor nodes since
  all consumers use the named export; `decryptVaultContentAesGcm`
  left as a non-exported internal — the test exercises the
  XChaCha variant which remains exported); §49 (gateway
  `lib/errors.ts` deleted as orphan; `routes/resolve.ts` now
  imports `ResolveContext` type from the resolver lib so the
  inline string-union doesn't drift from the canonical type;
  `services/messages.ts` types reached by namespace import
  `* as messages`, no change needed); §50 (removed unused
  `date-fns`, `clsx` from web `package.json`; added missing
  explicit `@tiptap/core` + `prosemirror-state` deps to stop
  relying on transitive resolution through `@tiptap/react`);
  §51 (deleted 547-line orphan `provenance-ikb.jsx` at repo
  root); §54 (gateway routes renamed: `routes/feed.ts` →
  `routes/timeline.ts` with `feedRoutes` → `timelineRoutes`,
  `routes/feeds.ts` → `routes/external-feeds.ts` with
  `feedsRoutes` → `externalFeedsRoutes`, `routes/v1_6.ts` →
  `routes/my-account.ts` with `v1_6Routes` → `myAccountRoutes`;
  endpoint paths (`/feed`, `/my/tab`, etc.) unchanged so no
  client or test changes needed; CLAUDE.md references
  updated). §52 (api.ts split) and §55 (markdown reorg)
  deferred — §55 specifically because stale LibreOffice
  lock files on 5 specs suggest the user may still have
  them open. All 127 tests still green (52 gateway + 75 web).
- **2026-04-20** — Day 5 payments cleanup shipped: §32
  (`reservePublicationPayout` no longer duplicates the allocation
  maths — the DB fetches its own rows, maps to camelCase, and the
  result is passed through the pure `computePublicationSplits`;
  splits / platformFee / flatFee / remainingPool / flatFeeShareIds
  all destructure out of the pure result, so production and the
  payout-math unit tests now exercise the same code path); §34
  (`confirmPayout` adds `RETURNING id` and logs a `warn` when
  zero rows are updated — distinguishes unknown-transfer webhooks
  from legitimate duplicate deliveries); §35 (`handleFailedPayout`
  clears `completed_at = NULL` on the failed flip so reporting
  doesn't show a payout as both failed and completed; wraps
  `failed_reason` in `COALESCE` so a retry's reason doesn't stomp
  the first failure's context). §33 is already covered by §4's
  finalise split and noted in-code. All 15 payout-math tests still
  green.
- **2026-04-20** — Day 5 feed-ingest shipped: §22 (kind 30023
  now keyed on `naddr` — pubkey + kind + d-tag — via a new
  `isParameterizedReplaceable` helper; upsert is a ratchet:
  `ON CONFLICT (protocol, source_item_uri) DO UPDATE … WHERE
  external_items.published_at < EXCLUDED.published_at`, returning
  `(xmax = 0) AS was_insert` so feed_items dual-writes distinguish
  insert-vs-revision-update; kind-5 deletion now also handles NIP-09
  `a`-tag addresses, reconstructing the naddr from
  `kind:pubkey:dtag` and matching source_item_uri); §23 (migration
  075 adds `external_sources.metadata_updated_at`, kind-0 profile
  writes gated on strictly-newer `created_at`, ratchet persists via
  `metadata_updated_at = CASE WHEN $5 IS NOT NULL THEN
  to_timestamp(…) ELSE metadata_updated_at END`); §24
  (`fetchFromRelay` sends `['CLOSE', subId]` before socket close on
  timeout, guarded by `readyState === OPEN`); §25 (sub IDs
  `fi-${randomUUID()}`); §26 (per-relay validation runs through
  `Promise.all(rawEvents.map(async …))` — Schnorr verify is sync
  but the event loop can interleave IO between verifies now
  instead of pinning for the full batch); §27 (AP `newCursor`
  advances only past Create/Note/isPublic-passing activities);
  §28 (AP pagination requires `CUTOFF_STREAK_THRESHOLD=5`
  consecutive below-cutoff items before stopping, so scheduled
  posts / per-page ordering jitter don't truncate the run); §29
  (`WILDCARD_DID_THRESHOLD=150` — above it, Jetstream subscribes
  without `wantedDids` and `handleMessage` drops events whose DID
  isn't in `sourceByDid`); §30 (DID-set changes while staying
  above the wildcard threshold skip the reconnect entirely —
  filter is in-memory only); §31 (new `appendWithinBudget` in
  `lib/text.ts` counts graphemes on body + tail, reserves tail
  length before truncating body; outbound-cross-post uses it so
  Mastodon quote URLs survive long-body truncation). All feed-ingest
  type-checks pass; gateway tests still green.
- **2026-04-20** — Day 4 P1 structural shipped: §13 (BLUESKY_HANDLE
  regex restricted to `.bsky.social`/`.bsky.team`; new `dotted_host`
  classification handles bare-domain inputs by racing URL/RSS discovery
  and atproto probe in parallel — RSS hosts no longer burn an AppView
  round-trip); §14 (`nostr_profile` Phase B chain — temporary WS to
  relay hints from `nprofile`, falling back to `NOSTR_PROFILE_RELAYS`
  defaults, REQ kind 0, picks newest by `created_at`, populates
  displayName/about/picture on the matching `nostr_external` source);
  §15 (`status: 'pending' | 'complete'` on `ResolverResult` — seed row
  is `pending`, Phase B overwrites with `complete`; web client polls on
  status, not pendingResolutions length); §16 (`ResolveContext` wired —
  `invite`/`dm` skip all external Phase B chains since those surfaces
  only act on native_account matches, which Phase A already produced);
  §17 (`tryWellKnownPaths` runs all 7 probes via `Promise.all` and
  picks first hit by WELL_KNOWN_PATHS order; per-origin memo with 5-min
  TTL, 1000-entry cap); §18 (migration 074 — pg_trgm GIN indexes on
  `accounts.username` + `accounts.display_name` so `searchPlatform`
  ILIKE no longer full-scans); §45 (raw BEGIN/COMMIT/ROLLBACK in
  `publications.ts` × 3 and `tags.ts` × 1 → `withTransaction`,
  notifications insert moved out of the transaction so it can't roll
  back the membership write); §46 (all 7 service Dockerfiles now
  `npm run build` and `node dist/src/index.js` — type-check happens at
  image-build time, no per-boot tsx transpile cost); §19 (DM send
  loop collapsed — new `nip44EncryptBatch` in key-custody decrypts
  the sender's privkey once and encrypts for all recipients in one
  HTTP hop; sendMessage drops missing-pubkey recipients before
  encrypt, then writes all rows via a single multi-row INSERT inside
  the transaction). All gateway/web/key-custody tests still pass.
- **2026-04-20** — Day 3 P1 mechanical shipped: §38+§39 (shared
  `slugify`/`generateDTag` in `shared/src/lib/slug.ts`, gateway
  scheduler/publication-publisher/articles now import from it; web keeps its
  mirror with a comment — test already asserts identical output); §40
  (`expireAndRenewSubscriptions` → `workers/subscription-expiry.ts`,
  `expireOverdueDrives` → `workers/drive-expiry.ts`; `logSubscriptionCharge`
  stays in `routes/subscriptions.ts` and is imported by the worker since the
  in-process subscribe/renew endpoints also use it); §41 (advisory-lock IDs
  centralised in `shared/src/lib/advisory-locks.ts`, `JETSTREAM` consolidated
  with the gateway IDs, 100003 gap documented); §42 (`requireEnv` /
  `requireEnvMinLength` adopted by key-service, key-custody, payment-service);
  §43 (five `(req as any).session?.sub` in traffology → `req.session!.sub!`);
  §44 (deleted `db/client.ts` re-export shims in all three services, imports
  go directly to `shared/src/db/client.js`); §56 (docker-compose header
  refreshed to list all 13 services); §20 (dropped duplicate `rsa2` join in
  `loadConversationMessages`, read `nostr_pubkey` from `rsa`); §6 (`listInbox`
  mute filter moved inside `array_agg FILTER`, HAVING guards 1:1 DMs with
  muted counterparty, block check mirrors the send path's "hide if any member
  has blocked me"). All gateway/web/shared tests still pass (155 total).
- **2026-04-19** — Day 2 remainder shipped: §11 (group-DM duplicates
  confirmed; migration 073 adds `send_id UUID` to `direct_messages`,
  `sendMessage` emits one UUID per logical send across all N rows and
  wraps the inserts + conversation bump in a transaction,
  `loadConversationMessages` uses `DISTINCT ON (send_id)` preferring the
  row addressed to the viewer so NIP-44 decryption stays correct).
  §12 (pulled the DM 402 path entirely — removed `dm_payment_required`
  branch from `sendMessage`, the route handler, and `MessageThread.tsx`;
  `dm_pricing` table + admin CRUD kept so config persists for when a real
  charge-and-unblock endpoint ships; dead `getDmPrice` helper removed).
  §5 (renamed `publishNip17Async` → `publishConversationPulse` with a
  docstring explaining it is a conversation-activity beacon, not real
  NIP-17; real gift-wrap remains a separate, deferred feature).
- **2026-04-19** — Day 2 P0 Stripe orphans shipped: §3 (writer payout split
  into reserve→Stripe→complete with stable idempotency key `payout-${payoutId}`;
  new `resumePendingWriterPayouts` recovers crashed mid-flight payouts on the
  next cycle), §4 (publication payout same shape, N-multiplied — per-split
  `pub-split-${payoutId}-${accountId}` stable keys, per-split independent
  status updates so one Stripe failure no longer rolls back the others). §4
  subsumes §33 (dead "mark completed" block replaced by deterministic flip
  in finalisation) and, as a bonus, gives KYC-waiting splits a retry
  mechanism — previously they sat pending forever with no path forward. No
  migrations: schema already allowed `stripe_transfer_id NULL` and
  `'pending'` status for both tables.
- **2026-04-19** — Day 1 P0 shipped: §1 (scheduler vault ordering), §2 (Stripe
  webhook `processed_at` nullable dedup), §7 (`recordSubscriptionRead` wrapped
  in transaction), §8 (await the expiry-warning insert), §9 (new
  `expiry_warning_sent` event_type — migration 072), §10 (subscription charge
  reads `platformFeeBps` from config). Migrations 071–072 added.

---

## P0 — correctness bugs (fix first)

### 1. Scheduler: v2 encryption failure leaves paywalled article with no vault

**Verified:** `gateway/src/workers/scheduler.ts:127-232`. `publishPersonalDraft`
publishes v1 (free teaser) to the relay at :159, inserts the article at
:169-199 with `access_mode='paywalled'`, **then** tries v2 encrypt at :206.
Catch at :224 logs and continues. Draft is deleted on the outer success path.
Result: article is live on the relay (free content only), DB marks it
paywalled, no payload tag. Readers unlock and get nothing. Writer thinks it
shipped.

**Fix:** invert ordering — create vault first, build both events, publish v1
and v2 in sequence, insert DB row with final `event_id` once. Any failure
before DB insert leaves the draft on `article_drafts` for retry. Wrap in a
single logical unit; relay publish can't truly be rolled back but the DB
commit can anchor the "done" state.

### 2. Stripe webhook dedup race (event loss on crash)

**Verified:** `payment-service/src/routes/webhook.ts:56-78`. INSERT marks
event-seen *before* handler runs. If the process dies between INSERT and
`handleStripeEvent` return, the dedup row survives, Stripe retry hits the
duplicate branch and acks, event is lost. The `DELETE on catch` at :71 helps
only when the handler returns an error — a crash bypasses it.

**Fix:** add `processed_at TIMESTAMP NULL` column to `stripe_webhook_events`,
set it only on successful completion, dedup on `processed_at IS NOT NULL`.
Gives you a reconciliation log of attempted-but-failed events as a bonus.

### 3. Stripe transfer orphan — writer payouts

**Verified:** `payment-service/src/services/payout.ts:342-361`. Inside
`withTransaction`, `stripe.transfers.create` runs at :342 *before* the
`writer_payouts` INSERT at :355. If the INSERT (or either subsequent UPDATE)
throws, the transaction rolls back — but the Stripe transfer already
happened. Idempotency key is `payout-${writerId}-${randomUUID()}` per call
(:351), so retries don't dedupe against the orphan.

**Fix:** write payout row as `status='pending'` *before* calling Stripe, then
update to `'initiated'` after. Use a stable idempotency key
`payout-${payoutId}` so retries land on the same transfer.

### 4. Stripe transfer orphan — publication payouts (same shape, N-multiplied)

**Verified:** `payment-service/src/services/payout.ts:641-690`. Transfers
created in the loop at :661 *before* `publication_payout_splits` rows INSERT
at :683. Any later throw rolls the transaction back with real transfers
pending. Idempotency key includes `randomUUID()` (:671) so retries don't
dedupe.

**Fix:** insert all split rows as `status='pending'` first in one batch, then
iterate transfers updating to `'initiated'` or `'failed'`. Key on
`pub-split-${payoutId}-${accountId}` — no UUID.

### 5. NIP-17 publish is a fiction

**Verified:** `gateway/src/services/messages.ts:550-563`. `publishNip17Async`
signs a kind-14 event with `content: ''` and a `['conversation', convId]`
tag, publishes to the relay. No gift-wrap (1059), no seal (13), no
ciphertext, leaks conversation ID, reveals sender, decrypts to nothing. The
`event as any` cast on :558 is the tell. Real content lives in `direct_messages`
as NIP-44 envelopes; relay gets platform-internal metadata carrying a NIP-17
sticker.

**Fix:** choose one — rename to `publishConversationPulse` and own the
honest meaning, or stand up gift-wrap properly (kind-13 seal around the
kind-14, kind-1059 wrap around the seal, one wrap per recipient). Shipping
this as "NIP-17" is actively misleading.

### 6. `listInbox` mute filter drops whole conversations

**Verified:** `gateway/src/services/messages.ts:126-127`.
```sql
LEFT JOIN mutes m ON m.muter_id = $1 AND m.muted_id = cm.user_id
WHERE m.muter_id IS NULL
```
`cm` is pre-aggregation, so in a 3-person group where you've muted one
person, the entire conversation vanishes from your inbox — not just the
muted speaker. Also no block filter even though send/create both enforce it,
so a convo with someone who later blocked you stays in your inbox and 403s
on send.

**Fix:** move the mute check to filter members *inside* `array_agg` (or
aggregate into `member_ids` then filter down), and mirror the `blocks`
check the send path uses.

### 7. `recordSubscriptionRead` is two non-atomic inserts

**Verified:** `gateway/src/services/access.ts:100-121`. Two `pool.query`
calls, no transaction. If the second fails, the unlock sticks but the
`subscription_events` audit row is missing. Not catastrophic (the read did
happen) but the ledger drifts, and every other paired-write path in the
codebase uses `withTransaction`.

**Fix:** five-line wrap in `withTransaction`.

### 8. Expiry-warning dedup INSERT is fire-and-forget

**Verified:** `gateway/src/routes/subscriptions.ts:1099-1103`. `pool.query(…)`
without `await`, `.catch` attached. Function returns before the insert
lands. SIGTERM between email send and DB write → reader gets the warning
email twice next cycle.

**Fix:** add `await`. One character.

### 9. Expiry-warning marker abuses `event_type='subscription_charge'`

**Verified:** `gateway/src/routes/subscriptions.ts:1098-1103` inserts
`event_type='subscription_charge'`, `amount_pence=0`, description magic-
string `'Expiry warning sent'`. Dedup at :1086 matches on the description.
`SUM(amount_pence)` queries stay correct (amount is 0), but any
`COUNT(*) WHERE event_type='subscription_charge'` over-counts.

**Fix:** add `'expiry_warning_sent'` to the `event_type` enum, use it.
Migration + two lines.

### 10. Platform fee hardcoded in subscription-charge path

**Verified:** `gateway/src/routes/subscriptions.ts:1118` —
`Math.round(pricePence * 0.08)`. `gateway/src/routes/v1_6.ts:79-82` and
`gateway/src/routes/publications.ts:1259` both read
`platform_config.platform_fee_bps`. `shared/src/db/client.ts:91` exposes it
as `platformFeeBps` already loaded. Change the config row and subscription
earnings silently stay at 8%.

**Fix:** `Math.round(pricePence * platformFeeBps / 10000)` reading from the
config object the function already has. One line + regression test.

### 11. **Verify first** — group-DM sender-side duplicates

**Flagged by `docs/audits/platform-pub-review.md` §1.** `direct_messages` has one
`recipient_id` per row, so a group send inserts N rows. The
`loadConversationMessages` WHERE at `messages.ts:182` matches
`sender_id = $2` OR `recipient_id = $2`, so the sender sees their own
message N times (once per recipient row).

Determines whether the rework is "tidy the N+1" or "rethink data model".
Verify by sending a group DM and inspecting the returned list before
doing anything else — five minutes. Fix likely needs a message-envelope
row + per-recipient-ciphertext row rather than N envelope rows.

### 12. **Verify first** — is the DM 402 `dm_payment_required` ever consumed?

**Flagged by `docs/audits/platform-pub-review.md` §1.** `sendMessage`
(`messages.ts:296-308`) returns 402 with a price when any recipient
charges. Grep shows the string `dm_payment_required` only in the
definition and the throw — no endpoint takes payment and then unblocks
the send. Until one exists, this feature is "block with a price tag on
it", not a paywall.

Also all-or-nothing for groups (comment at :296 says "Full per-recipient
charging is a fast-follow"). Either ship the charge-and-unblock endpoint
or pull the 402 path until it's ready — the current state is worst of
both.

---

## P1 — real bugs and drift hazards

### Resolver (`gateway/src/lib/resolver.ts`)

**13. Bluesky handle regex eats dotted RSS hosts.** `BLUESKY_HANDLE`
(:135) matches any `word.word.word`, and the classifier at :149 tests it
before `AMBIGUOUS_AT` / `PLATFORM_USERNAME`. Paste `myblog.substack.com`
into the subscribe field and it classifies as a Bluesky handle and burns
an AppView round-trip before falling through. Almost certainly why
RSS-only inputs feel slow.
**Fix:** order URL > npub > did > fediverse > **ambiguous_at** >
**bluesky_handle** (existing checks), and require `.bsky.social` /
known bsky suffixes before the generic-dotted fallback, or gate
Bluesky-handle behind a successful AppView probe.

**14. Nostr inputs skip profile enrichment.** For npub/nprofile/hex_pubkey
Phase A emits an `external_source` match with only the hex pubkey
(:189-238). No Phase B kind-0 fetch. Paste an npub, see "unknown account".
Bluesky and Fediverse both enrich via `fetchActorProfile` /
`atprotoGetProfile`. This is the "half-wired branch" most clearly
present in this file.
**Fix:** add a `nostr_profile` entry to the Phase B pending chain;
resolver opens a temporary relay connection, REQs kind 0 for the pubkey,
updates the match.

**15. `pendingResolutions` has ambiguous completion signal.** `resolveAsync`
writes `pendingResolutions: []` on finish, but a mid-flight poll sees the
seed row with the original array. No way to tell "still running" from
"done, no matches".
**Fix:** add `status: 'pending' | 'complete'` or `completed_at` to
`resolver_async_results`. Poll returns the column.

**16. `ResolveContext` is dead.** Type has four values, passed into
`resolveAsync` at :301, read nowhere. `gateway` knip run flagged all six
public types from `resolver.ts` as unused externally, confirming it.
**Fix:** remove the parameter, or actually use it to bias which chain
runs first.

**17. `tryWellKnownPaths` serial loop is a silent amplifier.** 7 paths ×
default timeout = 7× slowdown on dead origins. No cache, two users pasting
the same URL hit origin 14×.
**Fix:** `Promise.any` over the first two, fall back to the rest only on
failure. Memoize ~5 min.

**18. `searchPlatform` uses leading-wildcard ILIKE.** Line 697
`pattern = '%' + escaped + '%'`. Btree index can't help. Full scan per
free-text query.
**Fix:** `pg_trgm` GIN index on `username` + `display_name`, or prefix-
only fast path.

### DM path (`gateway/src/services/messages.ts`)

**19. N+1 on send hot path.** Lines 297-308 pricing loop, then :317-332
serial encrypt + insert. 10-person group = 20+ DB round-trips + 10 serial
key-custody HTTP hops.
**Fix:** one `getDmPrice` query with `ANY()`, one batched encrypt call
(if key-service doesn't have a batch endpoint, add one — the encryption
itself is CPU-bound, not blocking), single multi-row INSERT.

**20. `rsa`/`rsa2` duplicate join.** `messages.ts:219-221` joins
`accounts` twice on `rdm.sender_id`, one alias for username
(`rsa.username`), another for pubkey (`rsa2.nostr_pubkey`). Same join.
**Fix:** collapse to `rsa`, select both columns.

**21. Silent skip on missing recipient pubkey.** `messages.ts:319-322`
logs and continues on missing pubkey; message not delivered but send
returns success. No way for caller to know.
**Fix:** return `{ messageIds, skippedRecipientIds }` in the response
payload, or fail hard if anyone's missing a pubkey (shouldn't happen in
practice but "shouldn't" is load-bearing here).

### Feed-ingest (`feed-ingest/src/**`)

**22. Kind 30023 ignores replaceable semantics.** `feed-ingest-nostr.ts`
stores each kind-30023 under an `nevent` URI (:384), not `naddr`. Author
updates a draft → second feed item appears. Feed shows stale versions.
**Fix:** for replaceable kinds (10000-19999, 30000-39999), key on
`naddr1(pubkey, kind, d-tag)`; upsert rather than insert.

**23. Kind-0 profile updates race metadata-refresh task.** Ingest path at
`feed-ingest-nostr.ts:243-268` updates `display_name`/`avatar_url` on
`external_sources`; separate `source-metadata-refresh` task does the
same. Two writers, no timestamp ordering. `COALESCE($3, display_name)`
at :264 handles null but not staleness.
**Fix:** make ingest compare-and-set — only write if the kind-0 event's
`created_at` is newer than a stored `metadata_updated_at` column. Or
drop the ingest-side update entirely and let metadata-refresh own it.

**24. Nostr `fetchFromRelay` doesn't CLOSE on timeout.** Lines 304-366,
timeout at :319 resolves without sending `CLOSE`. Only EOSE path does
(:347). Misbehaving relays that never EOSE keep the sub open 10s then
get the socket yanked. Some relays flag this as abuse.
**Fix:** send `['CLOSE', subId]` in the timeout branch before resolving.

**25. Nostr sub ID collisions.** `subId = 'feed-ingest-${Date.now()}'`
(:313). Millisecond collisions on busy relays.
**Fix:** UUID or monotonic counter.

**26. Nostr `verifyEvent` pins a core.** Schnorr verification runs
serially inside the relay-fetch loop — 5 relays × 50 events = 250 serial
verifies in the ingest hot path.
**Fix:** `Promise.all` across events per relay. Worker thread only if
throughput becomes an issue.

**27. AP outbox cursor anchors to skipped activities.** `activitypub.ts:162`
sets `newCursor = activityId` regardless of whether the activity passed
the Create/Note/isPublic filters. Skipped Announce at the top of the
outbox → cursor anchors to a non-ingestable item. If that item ever
changes/disappears (some Mastodon instances do), dedup breaks.
**Fix:** only advance cursor past activities that pass all filters.

**28. AP `cutoffMs` stop condition brittle.** Lines 175-179 stops paging
once `publishedAt < cutoffMs`. Mastodon outboxes can contain scheduled
(future) posts or per-page ordering off-by-one. Single stray older item
ends pagination early.
**Fix:** page by activity count (e.g. 200) or until you see N consecutive
items below cutoff, not the first.

**29. Jetstream DID cap at ~150-200 sources.** `listener.ts:249` appends
every DID as a `wantedDids` query param; WebSocket upgrade URL is bounded
by Jetstream server (~8-16 KB). ADR claims arbitrary scale; this is the
pinch point.
**Fix:** two options — DID-hash shard across N listener processes (each
owns half of the DID space), or once DID count exceeds ~150, subscribe
to wildcard firehose and filter client-side. Either is a half-day.

**30. Jetstream DID-set change replays everything.** Any change tears
down and reopens from `oldestCursor()` across all sources (:227-239).
ON CONFLICT saves the DB but bandwidth/CPU burn.
**Fix:** spin up a second scoped listener for just the new DID(s),
catch-up to live, then merge into the main filter at the next
reconnect boundary.

**31. Mastodon outbound truncation clips the quote URL.** `outbound-
cross-post.ts:125` appends source URL to `text`, then
`truncateWithLink(combined, { max })` truncates the end. Long quotes →
URL (the part that makes it a quote) is what gets cut.
**Fix:** budget is `maxChars − URL length − separator`, applied to
`text` *before* append.

### Payments (other)

**32. `computePublicationSplits` duplicate implementation.** 202 lines of
unit tests cover the pure function. `initiatePublicationPayout`
(`payout.ts:511`) **reimplements the same logic inline** at :535-629 —
flat fees, revenue_bps, standing shares, same order, same rounding. Bug
fixes have to land twice; the tests validate a function the DB path
doesn't use. The DB path also does `UPDATE publication_article_shares
SET paid_out = TRUE` inside the loop (:589) whereas the pure function
tracks IDs for the caller — it rolls back correctly by luck (transaction)
not design.
**Fix:** refactor `initiatePublicationPayout` to call the pure function,
then drive the DB writes off its result.

**33. Dead status-flag block at payout.ts:706-714.** Both disjuncts of
`allInitiated` check the same thing ("no splits with positive amounts").
The only time it's true is when the payout was empty, in which case
status was set to `'initiated'` at :635 and the UPDATE is a no-op. When
it's false (normal case), UPDATE sets status to `'initiated'` — already
what it was. Whole block does nothing. Intent was probably
`'completed'` when all transfers succeeded.
**Fix:** decide intent and implement it, or delete the block.

**34. `confirmPayout` is silent on missing row.** `payout.ts:407` straight
UPDATE, no `RETURNING`, no rowcount check. `transfer.paid` webhook for
an unknown `stripe_transfer_id` logs "confirmed" and returns success.
Stripe thinks it's fine; no payout record associates.
**Fix:** add `RETURNING id`, warn (and surface to reconciliation) when
rowcount is 0.

**35. `handleFailedPayout` status machine under-specified.** `failed_reason`
overwritten each call (no history). `completed_at` never cleared — a
completed payout that later receives `transfer.failed` (reversals can
cause this) ends up `status='failed'` *and* `completed_at != NULL`.
**Fix:** null `completed_at` when transitioning to failed; append to a
`failure_history jsonb` or log table rather than overwriting.

**36. Writer-eligibility rounding bias.** `payout.ts:261` per-row
`SUM(amount - FLOOR(amount * fee / 10000))` differs from
`total - FLOOR(total * fee / 10000)` by up to N pence (one per row).
1p read × 5% fee → floor(0.05) = 0, writer gets 1p, platform gets 0.
Probably intentional (platform absorbs dust) — verify against accrual
tests and document.

**37. Stripe API version is two years old.** `apiVersion: '2023-10-16'`
pinned in webhook.ts and payout.ts. Comment at payout.ts:90 already
acknowledges it (`'transfer.paid' not in SDK v14 types`). Bump when
touching these files anyway.

### Scheduler / cross-service plumbing

**38. `generateDTag` duplicated three times.** `scheduler.ts:265-274`,
`publication-publisher.ts:363-372`, `web/src/lib/publish.ts:202`. The
web test at `publish.test.ts:45` asserts identical output to gateway —
duplication is known. `scheduler.ts:131` uses the local copy while the
file *also* imports from `publication-publisher.js` (via
`publishToPublication`). Same file, two implementations.
**Fix:** move to `shared/src/lib/nostr.ts`, import from all three.

**39. Slug generation duplicated four times.** Identical pattern at
`articles.ts:66-71`, `scheduler.ts:163-167`, `scheduler.ts:267-271`
(inside `generateDTag`), `publication-publisher.ts:365-369`.
**Fix:** `slugify(title, maxLen)` in `shared/src/lib/slug.ts`. Subsumes
§38's slug step.

**40. Background workers exported from route files.**
`subscriptions.ts:937` exports `expireAndRenewSubscriptions`,
`drives.ts:822` exports `expireOverdueDrives`. `gateway/src/index.ts`
imports both and runs them under advisory locks. Inverted — `workers/`
already exists for this.
**Fix:** move both into `gateway/src/workers/`. Pair with P2 §48 (route-
file split) so the empty shells don't carry legacy worker exports.

**41. Advisory-lock IDs have a hole (100003).** `gateway/src/index.ts:245-247`
defines SUBSCRIPTIONS=100001, DRIVES=100002, SCHEDULER=100004. 100003
missing — classic "removed a worker" smell. Feed-ingest jetstream
listener at `listener.ts:115` also uses advisory locks in a separate
service.
**Fix:** `shared/src/lib/advisory-locks.ts` exporting a const object.
Document the gap in a comment.

**42. Env helper ignored by three services.** `shared/src/lib/env.ts`
exports `requireEnv` / `requireEnvMinLength`. Gateway uses it;
`key-service/src/index.ts:18-23`, `key-custody/src/index.ts:28-33`,
`payment-service/src/index.ts:15-17` each hand-rolled `for (const name
of ...)`.
**Fix:** five-minute find-and-replace.

**43. Traffology `(req as any).session?.sub` casts.**
`gateway/src/routes/traffology.ts:30,58,80,115,195` — five casts, all on
routes that already have `preHandler: requireAuth`. Other gateway routes
use `req.session!.sub!`.
**Fix:** replace the five casts. If the module augmentation in
`gateway/src/types/fastify.d.ts` isn't reaching this file, fix the
typing-import or the `tsconfig` include.

**44. `db/client.ts` shims in three services.** `key-service/src/db/client.ts`,
`key-custody/src/db/client.ts`, `payment-service/src/db/client.ts` are
pure re-exports from `shared/src/db/client.js`. Gateway imports shared
directly.
**Fix:** delete the shims, update imports.

**45. Mixed transaction idioms inside same file.**
`gateway/src/routes/publications.ts` has 9 raw `BEGIN`/`COMMIT`/`ROLLBACK`
tokens, 0 `withTransaction`. Other route files use `withTransaction`
exclusively. Split is by file, not by operation.
**Fix:** mechanical convert in `publications.ts` (and `tags.ts` if
similar). No behavioural change.

**46. Start script mismatch with Dockerfile.** Each service
`package.json` declares `"start": "node dist/src/index.js"`;
`gateway/Dockerfile:13` runs `tsx gateway/src/index.ts`. `start` never
invoked, build target vestigial. Production is re-transpiling on every
boot with no type check in the container.
**Fix:** make the Dockerfile build and run the built JS. Flagged P1
not P0 because it works today — but "works" hides a real correctness
concern (no type check in prod build).

---

## P2 — housekeeping, dead code, refactor

### Dead code (delete now)

**47. Unused components.** Six confirmed orphans with zero imports:
- `web/src/components/feed/NoteComposer.tsx` (188 lines, replaced by
  `ComposeOverlay`)
- `web/src/components/ui/NotificationBell.tsx` (274)
- `web/src/components/ui/ErrorBoundary.tsx` (43)
- `web/src/components/ui/UserSearch.tsx` (105)
- `web/src/components/dashboard/DrivesTab.tsx` (93)
- `web/src/components/icons/ThereforeMark.tsx` (43)

`platform-pub-review` §5 also flagged `OffersTab.tsx` and
`FeaturedWriters.tsx` — double-check with a fresh grep before deletion.
`globals.css:551` has a stale `[class*="NoteComposer"]` selector; remove
in the same change. Also the six test files whose subjects are
themselves orphans.

**48. Knip findings in web.** `lib/api.ts`: `keys`, `follows`, `search`,
`writers` API groupings + a dozen orphan response types (`SignupResult`,
`GatePassResponse`, `ResolvedContent`, `Publication`, etc.) unused.
`lib/ndk.ts`: `KIND_VAULT`, `KIND_RECEIPT`, `KIND_DRAFT`, `KIND_CONTACTS`,
`KIND_REACTION` unused. `lib/vault.ts`: three decrypt helpers unused.
Editor nodes (`EmbedNode`, `ImageUpload`, `PaywallGateNode`): named +
default export of same thing.
**Fix:** delete the unused API groupings (one-liners). For vault helpers,
confirm they're not server-imported before deleting. For kind constants,
delete — planned surface that didn't land.

**49. Knip findings in gateway.** `src/lib/errors.ts` (15-line `sendError`
helper) imported by nothing; routes keep `reply.status().send()`. Either
adopt or delete.

All six public types from `resolver.ts` (`InputType`, `MatchType`,
`Confidence`, `ResolveContext`, `ResolverMatch`, `ResolverResult`) unused
externally → route handler returns raw output without typing it.

All six from `messages.ts` (`InboxConversation`, `ConversationMessage`,
`SendMessageResult`, `DecryptRequest`, `DecryptResult`, `DmPricingSummary`)
unused externally → same pattern.
**Fix:** either type the route responses against these (cheap, recovers
the service-to-route contract) or remove `export`. Pick one per file,
not one per type.

**50. Unused + unlisted deps.** `date-fns`, `clsx` in `package.json`,
never imported — free weight to cut. `@tiptap/core` and
`prosemirror-state` imported but not listed — resolve through transitive
`@tiptap/react`, will break if tiptap upgrades unbundled.

**51. `provenance-ikb.jsx` at repo root.** 547 lines, only `.jsx` file
in the repo, no imports.
**Fix:** `git rm`.

### Refactor / naming

**52. Split `web/src/lib/api.ts`.** 1,685 lines, 87 exports, already
grouped in-file by domain. Split into `api/{auth,articles,feed,…}.ts`;
keep `api.ts` as `export *` for one release; delete.

**53. Split three gateway mega-route-files.** `publications.ts` 1,353
lines / 29 routes, `articles.ts` 1,153, `subscriptions.ts` 1,138. Split
each into a directory. Pair with §40 so the worker extraction happens
at the same time.

**54. Rename ambiguous files.** `routes/feed.ts` → `timeline.ts`,
`routes/feeds.ts` → `external-feeds.ts`, `routes/v1_6.ts` →
`my-account.ts` (or split into `reading-tab.ts` + `account-statement.ts`).
Both v1_6 handlers are live — `AccountLedger.tsx:51` consumes
`/my/account-statement` — so this is a rename, not a deletion.

**55. Move audit/planning markdowns out of root.** 22 `.md` files at
root (audit claimed 32 — overstated).
**Fix:** `docs/adr/` for specs (ALLHAUS-REDESIGN-SPEC, UNIVERSAL-FEED-ADR,
ALLHAUS-OMNIBUS, etc.), `docs/audits/` for `docs/audits/platform-pub-review.md`,
`docs/audits/AUDIT-BACKLOG.md`, this file. Keep `README.md`, `CLAUDE.md`,
`DEPLOYMENT.md`, `feature-debt.md` at root.

**56. Stale docker-compose.yml header.** Comment at :1-17 lists 9
services; actual file also has key-custody, feed-ingest, traffology-
ingest, traffology-worker. 30-second fix.

**57. Cursor parser accepts non-UUID ids.** `routes/feed.ts:39-59` —
`id.length >= 36` check but no UUID format. No injection risk
(parameterised). Cosmetic.

---

## P3 — bigger moves (do when the return justifies it)

**58. Root `knip.json` + CI hook failing on new unused exports.** The
single biggest quality lever available. Refactor corpses — `lib/format.ts`
says `// Consolidated from ArticleCard, NoteCard, FeaturedWriters` and
those files are still there — would have become build errors at the
moment of creation. Pair with workspace setup (§59) so knip sees the
full graph.

**59. Adopt npm (or pnpm) workspaces.** Root `package.json` has no
`workspaces`. Dockerfiles do a symlink dance
(`RUN ln -sf /app/shared /app/gateway/shared`) to make
`../../shared/src/…` imports work. Per-service tsconfigs override
`rootDir` to `.` specifically so symlinked `shared/` compiles into each
service's `dist/`. The shims in §44 exist because of the same pressure.
**Fix:** one day, removes a whole category of papercuts.

**60. Outbox pattern for relay publishing.** Every `INSERT … ;
publishToRelay(signed)` with ad-hoc retry — the scheduler v1/v2 hazard
(§1), `recordSubscriptionRead` (§7), publication-publisher, notes
deletion — becomes "write intended-publish record in transaction,
worker picks it up". feed-ingest already runs Graphile Worker; extend it
to a gateway outbox. Week of work, biggest correctness dividend on
this list. Do the tactical fixes §1-10 first — they ship individually;
the outbox replaces them but shouldn't gate them.

**61. Gate-pass orchestration module.**
`routes/articles.ts`'s `/articles/:nostrEventId/gate-pass` handler,
`services/access.ts`, and payment-service each own a piece. Gateway
also computes `readerPubkeyHash` inline and manages tab creation — three
roles in one handler. Pull gateway-side orchestration into
`services/article-access/`. Half-day.

**62. Consider merging key-service + key-custody.** 918 + 447 lines, 15
files. Security split is real (different key material in each) but may
not justify two containers. Defer.

**63. Round-3 audit targets.** Not covered by either prior round:
Traffology ingest flow (`traffology-ingest`, `traffology-worker`), most
feed-ingest adapters (33 files, 4.7k lines), ATProto OAuth client setup
(`shared/src/lib/atproto-oauth.ts`), full sweep of `feed_items` insert
sites (publication-publisher, note ingest, external-feed dual-writes)
for `content_preview` / truncation consistency, full `ts-prune`
alongside `knip` across all services. **Scoped on 2026-04-20 — see
§64-§87 below for the produced findings.** ts-prune deleted from the
scope: knip's `types` gate subsumes it.

---

## Round-3 findings — §64-§87 (scoped 2026-04-20)

### Traffology (`traffology-ingest`, `traffology-worker`)

**64. `IP_HASH_SALT` silently defaults to `'traffology-default-salt'`.**
**Verified:** `traffology-ingest/src/routes/beacon.ts:21` —
`process.env.IP_HASH_SALT ?? 'traffology-default-salt'`. If the env var
is missing in prod, every deploy ships with the same hardcoded salt
baked into source; IP hashes become reversible against a precomputed
rainbow table of IPv4 space. **Fix:** adopt `requireEnvMinLength` from
`shared/src/lib/env.ts` (used by all other services per §42), fail fast
on boot if the salt is missing or too short.

**65. `insertObservation` has no ON CONFLICT — reruns duplicate rows.**
**Verified:** `traffology-worker/src/tasks/interpret.ts:349-358`.
Application-level `NOT EXISTS` guards in each `detect*` function at
`:66-70, :125-129, :183-188, :232-235, :308-313` are racy — interpret
reruns (worker restart, cron double-fire) can sail past the check
before the insert lands. **Fix:** add `UNIQUE (piece_id, observation_type)`
or `ON CONFLICT DO NOTHING` keyed on the same tuple.

**66. Aggregate cron tasks declared without `jobKey`.**
**Verified:** `traffology-worker/src/index.ts:39-49`. `aggregate_hourly`,
`aggregate_daily`, `aggregate_weekly` are cron-scheduled without
Graphile Worker's dedup key. A clock-skew double-fire would run the
whole pipeline twice; upserts protect final state but intermediate
queries see inconsistent snapshots mid-run. **Fix:** add
`jobKey: '${taskName}-${bucketTimestamp}'` so the second fire
coalesces.

**67. Rank UPDATE runs outside the hourly-aggregate transaction.**
**Verified:** `traffology-worker/src/tasks/aggregate-hourly.ts:182-204`.
`piece_stats`/`source_stats`/`half_day_buckets` inserts sit inside
`withTransaction`; the subsequent ranking UPDATE runs on the outer
`pool`. A crash between commit and ranking leaves writers seeing stats
with stale rank until the next hourly tick. **Fix:** move the ranking
UPDATE inside the same transaction.

**68. Concurrent-reader endpoints accept any `writerId` unauth'd.**
**Verified:** `traffology-ingest/src/routes/concurrent.ts:12-38`.
`GET /concurrent/:pieceId` and `GET /concurrent/writer/:writerId`
have no auth hook. The service is docker-internal today (nginx doesn't
route to :3005 directly, only the gateway reaches it over the compose
network), so the practical blast radius is any container inside the
compose network — not internet. **Fix:** either mirror
`INTERNAL_SERVICE_TOKEN` (as key-service uses) or push the auth
decision into the gateway route and keep ingest internal. Scoped to
P2 because the network boundary mostly contains it today.

**69. Observation `values` column is unvalidated JSONB.**
**Verified:** `traffology-worker/src/tasks/interpret.ts:349-358` accepts
`Record<string, unknown>`. Downstream queries cast fields
back to text/int at `:187, :312` with no guard. A schema drift in one
detect function silently produces NULLs in dashboards. **Fix:** a
discriminated union + zod parse at insert would pay for itself the
first time an observation type is added.

### Feed-ingest adapters

**70. Mastodon `Idempotency-Key` hashes user-editable text.**
**Verified:** `feed-ingest/src/tasks/activitypub-outbound.ts:112-113`
— key is `sha256('${replyTo}::${text}')`. If a cross-post fails, the
user edits the draft, and retry fires, Mastodon sees a new request
and may double-post. **Fix:** key on `outbound_posts.id` (the row is
written before the first attempt per §3's row-first idiom) — stable
across retries, not derived from mutable content.

**71. Nostr outbound treats any-relay-accepts as success.**
**Verified:** `feed-ingest/src/lib/nostr-outbound.ts:27-51` — returns
success if ≥1 relay accepts; caller at
`outbound-cross-post.ts:180` marks the outbound row `sent` and never
retries. Readers on rejecting relays never see the post. **Fix:**
return `{ succeeded, failed, total }` and leave retry logic to the
caller — probably "retry if `failed/total > 0.5`" with a cap.

**72. Outbound retry `jobKey` collides with the original enqueue.**
**Verified:** `feed-ingest/src/tasks/outbound-cross-post.ts:204-217`.
The retry enqueue uses `outbound_cross_post_${row.id}` — identical
to the original. Graphile Worker jobKey dedups, so the retry merges
with the already-in-flight job and loses the backoff delay. **Fix:**
versioned key `outbound_cross_post_${row.id}_r${retryCount}`, or drop
the jobKey entirely and rely on the `outbound_posts.status` FSM.

**73. RSS `content_preview` falls back to `summary` when other
adapters don't.** **Verified:** `feed-ingest/src/tasks/feed-ingest-rss.ts:131`
— `(item.contentText ?? item.summary ?? '').slice(0, 200)`. Nostr
(`feed-ingest-nostr.ts:237`), Mastodon (`activitypub-ingest.ts:81`),
Bluesky (`atproto-ingest.ts:86`) all use contentText only. RSS items
with null contentText + non-null summary render previews other
adapters wouldn't have. **Fix:** pick one — either everyone gets the
summary fallback or no-one does; most likely summary is the right
choice everywhere, RSS is just the only one that gets it today.

**74. `activitypub_instance_health` grows without bound.**
**Verified:** migration 056 defines the table; `activitypub-ingest.ts`
UPSERTs into it per poll. There's no prune cron for hosts that stopped
responding months ago. **Fix:** add a cleanup task mirroring
`resolver_results_prune` — delete rows whose last_success_at and
last_failure_at are both older than 90 days.

**75. HTML sanitisation lives at different layers per adapter.**
**Verified:** `adapters/rss.ts:99` runs `sanitizeContent` on raw HTML;
`adapters/activitypub.ts:266` same; `adapters/atproto.ts:331` builds
HTML from a RichText walk with no central sanitiser;
`feed-ingest-nostr.ts:206` has no HTML step at all. If the sanitise
rules change, RSS + Mastodon track; Bluesky drifts. **Fix:** wrap
the atproto HTML builder's output in `sanitizeContent` before write
so the three HTML-producing adapters share one code path.

### ATProto OAuth (`shared/src/lib/atproto-oauth.ts`)

**76. JWK parse happens lazily on first `getAtprotoClient()` call.**
**Verified:** `shared/src/lib/atproto-oauth.ts:92-162`. `buildClient()`
is invoked on first use; if `ATPROTO_PRIVATE_JWK` is malformed JSON
or missing required fields, the failure shows up on the first
OAuth-dependent request, not at server boot. The catch at `:96-99`
nulls the cache so subsequent callers hit the same error, which is
good for recovery but bad for boot-time detection. **Fix:** call
`getAtprotoClient()` in gateway's startup sequence behind a
try/catch — the prod branch (non-loopback) needs the JWK valid or
the server is functionally degraded anyway, so failing boot is
honest.

**77. DPoP refresh error has no recoverable-vs-terminal split.**
**Verified:** `feed-ingest/src/tasks/outbound-token-refresh.ts:97-102`
— any error from `client.restore(did, 'auto')` flips the account to
`is_valid=FALSE`. A transient PDS outage or DNS blip reads the same
as a revoked refresh token; users see "reconnect your Bluesky
account" for what should have been a 30-second dip. **Fix:** parse
the error — PDS 5xx / network → leave valid, retry next tick;
`invalid_grant` / `invalid_token` → flip invalid and surface the
reconnect prompt.

**78. `.well-known/*` endpoints lack explicit `Content-Type` and
cache headers.** **Verified:** `gateway/src/index.ts:212-213`. Both
`/.well-known/oauth-client-metadata.json` and `/.well-known/jwks.json`
rely on Fastify's default serialisation with no `Cache-Control`.
PDSes polling for JWKS rotation hit origin every request. **Fix:**
`reply.type('application/json').header('Cache-Control',
'public, max-age=3600')` on both.

**79. Token-refresh cron logs `{ err }` without sanitisation.**
**Verified:** `outbound-token-refresh.ts:98` logs the raw error object
on refresh failure. If the `@atproto/oauth-client-node` error message
ever embeds partial DPoP proof or token values, those land in logs.
Not verified in the current library version, but the shape is
fragile. **Fix:** `logger.warn({ err: { name: err.name, code: err.code,
message: err.message?.slice(0, 200) }, id, did })` — never pass the
raw object through.

**80. `atproto_oauth_pending_states` TTL is 10min with no grace window
before prune.** **Verified:** `shared/src/lib/atproto-oauth.ts:61`
(`ttlMs = 10 * 60 * 1000`) + `feed-ingest/src/tasks/atproto-oauth-states-prune.ts`.
A callback that arrives exactly at `expires_at` may race the 5min
prune cron. Edge-casey but not impossible. **Fix:** make prune
condition `expires_at < now() - interval '30 seconds'`, or bump TTL
to 15min.

**81. Loopback dev redirect_uri hardcodes `127.0.0.1:3000`.**
**Verified:** `atproto-oauth.ts:116`. If the dev gateway runs on a
different port (e.g. `PORT=3010` override), OAuth loopback silently
fails with a redirect mismatch. **Fix:** `process.env.PORT ??
'3000'` — one line.

**82. `baseUrl` cast to `https://${string}` without enforcement.**
**Verified:** `atproto-oauth.ts:140-141`. The loopback branch accepts
any `http://localhost…` or `http://127.0.0.1…` URL; the prod branch
casts `baseUrl` to `https://${string}` without checking the scheme
actually starts with `https://`. An operator setting
`ATPROTO_CLIENT_BASE_URL=http://all.haus` (scheme typo) passes the
non-loopback gate and produces malformed client metadata. **Fix:**
`if (!baseUrl.startsWith('https://')) throw new Error(…)` before the
cast.

**83. `atprotoClientMetadata()` + `atprotoJwks()` are single-call
passthroughs.** **Verified:** `atproto-oauth.ts:164-170`. Both are
`getAtprotoClient().then((c) => c.clientMetadata | c.jwks)`. The
only callers are the two well-known route handlers in
`gateway/src/index.ts`. **Fix:** inline at call sites, delete the
helpers.

### `feed_items` content-preview consistency

**84. Publication CMS article edit bypasses `feed_items`.**
**Verified:** `gateway/src/routes/publications/cms.ts:159-163` — PATCH
builds a dynamic UPDATE over `articles` columns (`title`, `summary`,
`price_pence`, `show_on_writer_profile`) with no corresponding
`feed_items` write. `title` is denormalised into `feed_items.title`
at publish time (`routes/articles/publish.ts:102`), so a title
edit drifts immediately. Price edits matter too — paywalled-vs-free
badging reads from the denormalised row. Drift window is bounded by
`feed_items_reconcile` (daily 05:00) but that's a 24h visible skew.
**Fix:** add a `feed_items` UPDATE for the changed columns inside
the same transaction; title, summary, price all map cleanly.

**85. `feed_items_reconcile` inserts missing rows but never repairs
drifted previews.** **Verified:**
`feed-ingest/src/tasks/feed-items-reconcile.ts:22-99`. Three INSERT
blocks use `ON CONFLICT DO NOTHING`. If §84 produced a drifted
title/preview and the row already exists, reconcile leaves it alone.
**Fix:** add a fourth pass — UPDATE `feed_items` where the source
row's `updated_at > feed_items.updated_at`, recompute `content_preview`,
`title`, `author_name`. Safety net, daily cadence, not hot path.

**86. `.slice(0, 200)` (JS) and `LEFT(…, 200)` (SQL) truncate at
different boundaries for multibyte content.** **Verified:** seven
adapters/routes use `.slice(0, 200)`; the reconcile SQL uses
`LEFT(…, 200)`. `.slice` counts UTF-16 code units, `LEFT` counts
characters in pg's default encoding. Same content hits different
truncation points if ingested via one path vs reconciled via another.
No active data loss today but will produce visible preview drift for
emoji-heavy / CJK content. **Fix:** one shared
`truncatePreview(content: string): string` in `shared/src/lib/text.ts`,
grapheme-aware via `Intl.Segmenter`; use everywhere JS-side and
either mirror the rule in reconcile or call via a plpython/deno UDF
(probably overkill — just pick the JS rule as canonical and drop
reconcile's LEFT).

**87. Scheduler's personal-draft publish skips the `feed_items`
dual-write.** **Verified:** `gateway/src/workers/scheduler.ts:167-197`
upserts into `articles` and stops — no corresponding `feed_items`
INSERT. `routes/articles/publish.ts:96-136` and
`services/publication-publisher.ts:194-250` both dual-write; the
scheduler path inlines its own article INSERT and forgot the
partner write. Scheduled personal articles don't appear in the
unified timeline until the 05:00 reconcile cron — up to 24h of
invisibility for the writer's scheduled drop. **Fix:** mirror the
dual-write from `publish.ts` inside the scheduler transaction;
since scheduler reuses its own vault-creation dance, extract a
shared `insertArticleWithFeedItem(tx, …)` helper so the two paths
don't drift again.

---

## Round-3 rejected claims (held over from §64-§87 audit)

- **feed-ingest `a`-tag split out-of-bounds on kind-5 deletion.**
  `feed-ingest-nostr.ts:290-298` — `const [kindStr, aPubkey, dTag] =
  aAddr.split(':')` followed by `kindStr ?? ''`, `!aPubkey`,
  `Number.isFinite(kind)`, and `dTag ?? ''` — all three destructured
  values are defensively handled. Not a bug.
- **RSS dual-write fails silently on feed_items error.** Both
  INSERTs wrap in `withTransaction`; a feed_items throw rolls back
  the external_items row too. `if (!rowCount) return false` at
  `feed-ingest-rss.ts:108` is the ON-CONFLICT-DO-NOTHING dedup
  exit, not an error-swallow.
- **ATProto OAuth concurrent-authorize state collision.** The
  library generates a cryptographically-random `state` per
  `authorize()` call (`@atproto/oauth-client-node` internals); the
  `INSERT … ON CONFLICT (key) DO UPDATE` in `DbStateStore.set` never
  sees a collision between concurrent flows for the same user.
- **AES-256-GCM "silent garbage on wrong key".** AEAD tag check
  catches wrong-key decrypt as an authentication failure, not a
  silent corruption. The versioned-blob ambiguity concern conflates
  GCM with CTR mode.
- **ts-prune would catch anything knip misses.** Both use the same
  AST mark-and-sweep; knip's `types` gate (promoted to default on
  2026-04-20 per §58 follow-up) covers the exact category ts-prune
  was added for. Item deleted from the §63 scope.

---

## Rejected / overstated claims (held over from both audits)

- **`/my/account-statement` has no web consumer** — *wrong*. Consumed by
  `web/src/components/account/AccountLedger.tsx:51`. The rename (§54) is
  still worth doing; the endpoint is live.
- **32 markdown files in repo root** — actual is 22. Still cluttered
  (§55), but the bigger number in the audit was wrong.
- **42 `as any` in gateway** — actual is 38 across 14 files. Substantive
  claim — 5 of them are in `traffology.ts` as auth shortcuts (§43) —
  holds.
- **`content_preview .slice(0, 200)` in one place, who-knows-what
  elsewhere** — flagged in the first audit as TODO-verify, never
  confirmed. Folded into §63.

---

## Attack order (one focused week)

**Day 1 — P0**
§7 `recordSubscriptionRead` wrap, §8 `await` the warning insert, §9
event_type migration, §10 platform fee read from config, §1 scheduler
ordering inversion, §2 webhook dedup `processed_at` column. Each
small, each as its own commit with a regression test.

**Day 2 — P0 Stripe orphans + verify-firsts**
§3 writer-payout row-first + stable key, §4 publication-split same.
§11 group-DM duplicate verify (5 minutes) → fix if confirmed.
§12 DM 402 decision (ship unblock endpoint or pull the 402 path).
§5 NIP-17 naming decision (rename vs implement).

**Day 3 — P1 mechanical**
§38-39 shared slugify/dTag, §40 move workers, §41 advisory locks const,
§42 env helper adoption, §43 traffology casts, §44 db/client shims,
§56 docker-compose header, §20 `rsa`/`rsa2` collapse, §6 `listInbox`
mute filter fix.

**Day 4 — P1 structural**
§13-18 resolver fixes (ordering, Nostr enrichment, completion signal,
dead param, well-known paths, search index), §45 transaction idiom
convergence, §46 build-for-prod Dockerfile, §19 DM send N+1 collapse.

**Day 5 — P1 feed-ingest + payments cleanup**
§22 kind-30023 naddr, §23 kind-0 race, §24-26 Nostr hygiene,
§27-28 AP cursor/cutoff, §31 Mastodon truncate, §29-30 Jetstream
DID-cap, §32-35 payment-service tightening.

**Day 6-7 — P2 deletions + refactors**
§47-51 dead code. §52 split api.ts. §54 rename files. §55 move
markdowns.

**Later**
§60 outbox. §63 round-3 audit.
