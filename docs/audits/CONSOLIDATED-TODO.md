# platform-pub — Consolidated To-Do (the canonical work queue)

**This file is the single forward-looking work queue.** `docs/audits/FIX-PROGRAMME.md` is the work log (what shipped, with validation records); this file is what's next. When work ships: log it in FIX-PROGRAMME, delete or amend the item here. `feature-debt.md` — which previously carried both roles — was retired to `planning-archive/feature-debt.md` on 2026-07-07 (its work-log entries duplicated FIX-PROGRAMME; its open items are absorbed below; everything else was DONE-graveyard).

Compiled 2026-07-06 from every non-archived doc at `22419d0`. **Re-verified and updated 2026-07-07 against `2ccfa35`** — the same-day Wave-2 (F9/F5/F4/F10/F14 + Wave 5, migrations 142–144) and Wave-3 (migrations 146–147) economy remediation, migration 145, and the external-author-history ship (migration 148) landed in between and resolved most of the original §1. Every remaining claim below was re-verified in source (file:line where it matters), not just against the docs. **Updated 2026-07-09 with §0** — findings from the four-agent audit of the July 7–8 commits (`3b2d51d`…`515a13b`) — **and §0b**, the resolver & source-input audit (`RESOLVER-SOURCE-INPUT-AUDIT-2026-07-09.md`).

Organised by domain, priority-ordered within each. Source doc cited per item. §10 lists what's deliberately parked so it doesn't leak back into the working list.

---

## 0. 2026-07-09 commit audit — July 7–8 ships

Four-agent adversarial review of commits `3b2d51d`…`515a13b` (external-author-history Phases 1–4, paywall hardening, draft dedup + migration 149, Blossom cutover, Stripe webhook route). The paywall commit (`339b43e`) and the external-author-history cluster verified **clean** — money paths, validator lockstep, Step-1b ordering, promotion/shadow-source/job-key/SSRF/relay-free invariants all hold. **Items 1–7 (3 HIGH, 2 MEDIUM, 2 LOW) all FIXED 2026-07-09 — see the FIX-PROGRAMME 2026-07-09 entry** (nginx `/media/` locked to hash-shaped GET/HEAD; `scheduled_at IS NULL` on the draft guess; drive fulfilment moved into the index txn + onto the final index call only; scheduler fulfilment failures now block the draft delete; cleanup-script `published_at IS NOT NULL` predicate; paywalled publish email deferred to step 5 via `emailAsNew`; Blossom rollback docs corrected). The nginx fix needs the prod force-recreate (see §11). Remaining:

1. **Cosmetic tail (batch with §7):** atproto/AP promotion overwrites a hydrated `feed_items.author_name` with the null fallback pre-enrichment (`feed-ingest/src/lib/atproto-ingest.ts:129-141`; byline unaffected — reads `external_items` first — and enrichment self-heals); unguarded `post.record?.reply?.parent.uri` aborts one hydration pass on a malformed AppView entry (`gateway/src/lib/author-timeline-hydration.ts:274`); `stampGuard` evicts oldest-inserted, not expired-first (`author-timeline-hydration.ts:84-90`); `autoSaver.cancel()` clears only the debounce timer — the editor stays typeable during the multi-second publish, so a mid-publish keystroke can re-arm an autosave that lands after the draft delete and re-mints an orphan (narrow window, same bug class d34f9c0 fixes); the approve path never disposes of the kept in-review draft (draft+article shadow persists for approved submissions — decide scope or fix); stale "source_item_uri bakes in relay_urls" comment in `feed-ingest/src/lib/nostr-ingest.ts` (~378, false since migration 101); `PaywallGate` copy conservatively wrong iff `FREE_ALLOWANCE_FLOOR_PENCE` ≠ 0 (default correct); PATCH `/articles/:id` (`gateway/src/routes/articles/manage.ts:103`) still returns a raw `flatten()` as `error` (part of the §7.17/§8.9 error-shape batch).

## 0b. 2026-07-09 resolver & source-input audit

Three-agent audit of the universal resolver, the §V.5.8 discovery-fallback suggestion feature, the identity-input surfaces, and the `addSource` → feed-ingest path. **Full findings + fix shapes: `docs/audits/RESOLVER-SOURCE-INPUT-AUDIT-2026-07-09.md`** (also records what was verified sound — SSRF, fail-soft isolation, classification, async plumbing — so it needn't be re-audited). Headline: discovery branches 1–3 (catalog/Bluesky/NIP-50) shipped end-to-end with all guardrails intact; branch 4 (web-search bridge) unbuilt; catalog is 11 entries. Open items, in the doc's attack order:

1. **F2 (HIGH):** atproto backfill outer catch is a silent no-op — no error accounting/deactivation (`feed-ingest/src/tasks/feed-ingest-atproto-backfill.ts:279-284`; nostr backfill is the model) — and subscribe-time ingest jobs are `max_attempts := 1` with no poll fallback for atproto while Jetstream is healthy.
2. **F3 (MEDIUM):** match `confidence` (exact/probable/speculative) is computed and carried to the client but never rendered — speculative discovery guesses look identical to exact hits in the FeedComposer/VesselBar dropdowns.
3. **F4 (MEDIUM):** omnivorous-input rule violations — DM new-conversation (`MessagesInbox.tsx:168-186`) and DM fee override (`DmFeeSettings.tsx:99-113`) are username-only `/v1/search` + `results[0]`; publication invite (`MembersTab.tsx:42-85`) uses the resolver but with a hand-rolled debounce carrying a stale-match race. Move all three onto `useResolverInput`.
4. **F1 (HIGH, larger):** `addSource` validates syntax only (`sources.ts:344-364`) — a well-formed dead URL/DID/pubkey gets 201 + a live subscription; the resolver's verification is frontend convention, not enforced; malformed vs unresolvable both 404 "Source target not found".
5. **F5 (batch):** resolver spec drift — no native-URL short-circuit, no njump re-entry, no generic AP actor probe on arbitrary URLs, no per-context priority ordering, regex-over-HTML `extractFeedLink` missing JSON Feed autodiscovery.
6. **F6 (product call):** deactivated sources go silent with no user signal or re-verification path. (F7 discovery-reach is **decided** — see next item.)
7. ~~**F8:** resolver orchestration/network-path tests are zero~~ — **DONE 2026-07-10** (discovery-expansion Phase 0: `gateway/tests/resolver-orchestration.test.ts`, 15 tests + `nostr-search.ts` extraction + `safeChain` structural chain isolation; FIX-PROGRAMME 2026-07-10). The §8.5 `resolver.ts` decomposition now has its safety net.
8. **Discovery expansion (design accepted 2026-07-10; Phases 0+1 SHIPPED 2026-07-10): `docs/adr/RESOLVER-DISCOVERY-ADR.md`.** Phase 1 (known-world pg_trgm index over `external_authors`/`external_sources`, migration 150, `searchKnownWorld` in Phase A) shipped — see FIX-PROGRAMME 2026-07-10. Remaining phases: 2 = `activitypub_discovery` (unauthenticated Mastodon `/api/v2/search`, behind a FASP-ready provider interface; incl. the decided §5.2 addSource acct→webfinger amendment, a down-payment on F1); 3 = bridge-aware merge (helpers → `shared/`) + confidence-tier ordering/rendering — **discharges F3 and F5.4 above**; 4 = generated catalog (Wikidata/OPML, ~300–500 probed entries) — **discharges F7**. Branch 4 web-search bridge stays deferred behind `DISCOVERY_WEBSEARCH_ENABLED`; Feedly ruled out (API ToS).

## 1. Money & payments (highest stakes)

Waves 1–3 of the 2026-07-05 logic-economy audit all shipped (migrations 139–147): F9 paid voting removed (free, one-vote cap), F4 payout-completion-off-create + `transfer.reversed` (incl. partial reversals), F5 full publication-aware chargeback (per-split prorated reversals), F10 fixed share-of-revenue splits with cumulative clamp, F14 allowance split persisted, Wave-5 hardening (periodic `resumePendingSettlements`, calendar renewal in the expiry worker, pairing comment), plus the Wave-3 subscription collection gate. The F3 tribute chargeback residual also closed (claimed-but-unpaid accruals now reversed, `chargeback.ts:38-53`). What remains:

1. **F4 residual — live-Stripe premise check.** The `transfer.paid`/`transfer.failed` branches are kept as guarded no-ops pending verification against live Stripe (test-mode platform→connected transfer) that they genuinely never fire; then delete them. Owner decision, one session with real keys. → logic-economy Wave 3; FIX-PROGRAMME 2026-07-06 Wave-2 entry.
2. **Publication-split transfer re-pay.** A split that fails at create time (terminal Stripe rejection in `processPublicationSplits` — now the *only* way a split reaches `failed`) is marked and visible, but auto re-pay is not wired: the stable idempotency key `pub-split-${payoutId}-${accountId}` would dedupe a retry to the failed transfer, so a correct retry must mint a fresh split row. Until then: manual transfer. (Writer/tribute transfers already auto-re-pay via fresh payout rows.) `payment-service/src/services/payout.ts:2209-2237`.
3. **F1 residual — publication-subscription distribution.** A publication sub collects the reader leg (tab debit + `subscription_charge`) but posts no earning ledger entry (the emit is gated `if (writerId)`, `gateway/src/routes/subscriptions/shared.ts:24-26,108-121`) and nothing pays it out — the writer cycle's sub CTE excludes `publication_id IS NOT NULL` and `runPublicationPayoutCycle` sums only `read_events`. → logic-economy implementation status.
4. **Cardholder re-auth prompt + Stripe S2 live test.** `cardActionRequiredAt` is set by settlement declines and exposed on `GET /my/tab` (`gateway/src/routes/my-account.ts:54`), but zero web UI consumes it. Plus the live browser test of SetupIntent card-attach incl. 3DS (`4000002500003155`) — needs real keys. → `STRIPE-INTEGRATION-AUDIT-2026-06-25.md`.
5. **Calendar-arithmetic residuals.** The expiry worker now advances by UTC calendar months/years, but (a) the subscribe/re-activate path (`gateway/src/routes/subscriptions/writer.ts:151`) and the comp path (`subscribers.ts:124`) still add fixed 30/365-day ms; (b) the month-end anchor walks (Jan 31 → Mar 3 compounds — the renewal date should anchor to the original subscribe day). → Wave-3 P2 tail (FIX-PROGRAMME 2026-07-06).
6. **`convertProvisionalReads` zero-rows early-return** leaves `article_unlocks.is_provisional` stuck TRUE — inert today, bites when the promised provisional-unlock GC ships. → Wave-3 P2 tail.
7. **Subscription catch-up multi-charge** after worker downtime — one charge per missed period per hourly tick rather than advancing to the next future boundary once. Narrowed by Wave 3 (card-less renewals now expire), so it only affects card-ful readers; still a carried product call. → `SUBSCRIPTIONS-GAP-ANALYSIS.md`.
8. **Connect-KYC follow-ups:** (a) DB integration test for `reconcileConnectKyc`'s six-`EXISTS` candidate SQL (needs a DB-fixture idiom the repo lacks); (b) `pg_advisory_lock` around the sweep if payment-service ever runs >1 replica; (c) **reverse flip** — `stripe_connect_kyc_complete` is never set back to FALSE when Stripe later disables an account (low risk: `transfers.create` fails loudly at payout time). → FIX-PROGRAMME 2026-06-24 entry.
9. **Ledger residue:** publication-distribution reads still reconciliation-only (the one un-cut-over read model); set-based ledger INSERTs still deferred (conflicts with the adjacency guard's per-file `recordLedger()` count); **`scripts/reconcile-ledger.sql` is now UNBLOCKED** — the dev DB was repaired 2026-07-06 and is migrated through 148, so the real reconciliation run can finally happen. → `WRITER-SIDE-LEDGER-CUTOVER.md`, code-economy §0.
10. **Gift-subscription grant mode is modeled but unredeemable.** The code-offer path ships end-to-end (migration 037, create/lookup/redeem at `web/src/app/subscribe/[code]`, apply with validation), but grant-mode offers are created with `code = NULL` and both the redeem lookup and apply path are code-keyed — a grant offer has no URL and no wired redemption. The functional gift mechanism is the comp endpoint (`subscriptions/subscribers.ts:95-168`). Decide: wire a grant redemption path, or delete grant mode. (This resolves the old "verify gift subs shipped" item — answer: partially.)
11. **Publication paywall vault pipeline** (hard-blocked 2026-07-07). The publication publish/approve pipeline never had a vault step — it silently discarded the paywall body (`fullContent` used only for word count) and would have charged readers for content that was never stored, so paywalled publication submissions are now refused (`PublicationPaywallUnsupportedError`, 400 `publication_paywall_unsupported`; the editor pre-blocks the combination; the scheduler un-schedules such drafts back to plain drafts). To unblock: give `publishToPublication` + `approveAndPublishArticle` the vault call the personal scheduler pipeline already has (`scheduler.ts::createVault` shape: index → vault against the anchor event id → payload-tagged v2 is the only relay event), decide who owns the vault ownership check for publication-signed events (key-service verifies `articles.writer_id` via `x-writer-id`; publication articles are signed by the *publication* key, so the check needs a publication-member path), then delete the blocks in `publication-publisher.ts`/`cms.ts` + the editor guard in `web/src/lib/publish-validation.ts` together. Alternatively decide publications stay free-only and record that in the publications ADR. → FIX-PROGRAMME 2026-07-07 paywall entry; CLAUDE.md "Paywall deliverability before charge".

## 2. Decisions & gates (nothing else moves until these are called)

1. **`TRIBUTES_ENABLED` flip** — all five phases code-complete and dark; the F3 chargeback residual that used to co-gate it closed 2026-07-06. Now gated **solely** on the compliance owner signing memo residual #1 (platform-wide Stripe-PI baseline). → `UPSTREAM-EDGES-ADR.md`.
2. **`/author` + `/source` SSR** — blocked on a privacy/product call: converting the endpoints to `optionalAuth` publicly exposes author post-logs / follower counts / source item lists to anonymous crawlers. Benefit marginal (logged-in visitors get the overlay redirect anyway). Verified still `requireAuth`. → `allhaus-performance-audit.md` Outstanding #1.
3. **Concierge Phase 4 (custodial atproto)** — gated on §8.2 ratification (rotation-key custody split, durability targets) + W0 infra. Deliberately parked; only worth it for the branded `username.all.haus` handle. → `NETWORK-CONCIERGE-ADR.md` §13.
4. **Trust Phase B (dual-graph anonymity)** — gated on >1k attestors. Parked. → `ALLHAUS-OMNIBUS.md`.

## 3. Launch-blocking product gaps

1. **Owner dashboard** — entirely unbuilt (`web/src/app/admin/page.tsx` redirects straight to `/admin/reports`, the only admin page; no gateway operator route). Operator money-pipeline visibility (revenue, payouts, subscribers, tab balances, config editor, regulatory panel) before taking real money. Cheap to back with the shipped ledger `SUM()` views. → `OWNER-DASHBOARD-SPEC.md`.
2. **Landing page** — `web/src/app/page.tsx` is 55 lines (verified): one hero, no tab-model explainer, screenshots, social proof, or example articles. → frontend audit #3.
3. **Writer onboarding flow** — no post-signup wizard (profile → first article → pricing). Related: the first-login ceremony is commented out behind `// TODO: re-enable / refine entrance animation` (`WorkspaceView.tsx:885-893`). → frontend audit #6.
4. **Publication homepage templates** — wireframe-quality; the "publishing house" pitch needs a magazine layout that looks like one. → frontend audit #5.
5. **Import tooling** — Substack CSV/ZIP → NIP-23 importer (Ghost/WordPress later). Launch-cohort switching cost. → frontend audit #8.

## 4. Subscriptions Phase 2

From `SUBSCRIPTIONS-GAP-ANALYSIS.md`; Phase 1 complete. More valuable now that F1 made subscription money real and Wave 3 made it collectible.

1. Free trials (writer-configurable 7/30-day).
2. Welcome-on-subscribe email (cheap — plumbing exists).
3. Subscriber analytics trends (growth/churn/MRR — data already there; also the "subscriber/follower dashboard metrics" table-stakes item).
4. Subscriber CSV import/export.
5. Custom `/username/subscribe` landing page.

(Gift subscriptions: see §1.10 — grant mode exists but is unredeemable; that's now a decided-scope item, not a verify.)

## 5. Trust & safety / messaging table-stakes

Carried from the retired feature-debt §5 (not re-verified this pass; last audited 2026-06-20):

1. Report → reporter outcome feedback (small).
2. DM conversation management: leave / archive / mute / delete.
3. DM charge-and-unblock 402 enforcement — pricing config persists but is inert; DMs are effectively free until a charge-and-unblock endpoint ships.
4. Session-management UI — `sessions_invalidated_at` gives all-devices logout only; no per-session view/revoke.
5. Admin direct-suspend UI (`POST /admin/suspend/:accountId` exists, no frontend trigger).

## 6. Slice-8 dedup cluster (one design pass, not piecemeal)

Deliberately deferred to a single session because the three knobs compose. Dedup suppresses content — a false-positive merge silently hides a different person's posts.

1. `domain_match` auto-merges distinct people sharing a website/custom domain — require a second independent signal or down-weight `website`. (MEDIUM)
2. Migration-123 200-char fingerprint collision — two distinct long posts sharing a boilerplate head false-merge; raise the length floor or full-text hash. (MEDIUM)
3. `confidence` recorded but never consulted by suppression — a 0.6 auto link hides content as hard as a 1.0 user assertion; make it a real dial. (MEDIUM)
4. Deferred detectors/features: `cross_link` bio-parse detector (needs cached bio metadata first); quorum promotion (explicitly don't-build-v1); route-layer Vitest suite; `EXPLAIN ANALYZE` the dedup CTE against a seeded large feed (fold in with §8.4's #15). → `SLICE-8-IDENTITY-LINKING-PLAN.md`.

## 7. Cleanup cluster (cheap, batchable — one afternoon-scale pass)

All re-verified in source 2026-07-07 unless marked. (The stale ForallMenu z-50 comment from the old list is RESOLVED — removed by the ∀-mark work.)

1. Composer dead chip/`messagesApi` machinery (D7) — `web/src/components/workspace/Composer.tsx:98` `const [chips] = useState<ToChip[]>([])` has no setter, so the private-send branch (251-257) is unreachable.
2. Orphaned `web/src/components/workspace/ParentContextTile.tsx` (C4, zero imports) + unused `PostCard` `header` prop (`PostCard.tsx:70`) + its stale header-slot comment (`:68`) + dead `reply_group` type (`web/src/lib/ndk.ts:163`).
3. `expandedByFeed` key leak on feed delete/merge (C5) — `WorkspaceView.tsx` `onDeleted` (~1424) and `handleMergeConfirm` (~375) clean layout but never the `expandedByFeed[feedId]` key.
4. Stale `reply_to_author` never re-NULLed when the parent is deleted/unresolvable (D10 — data correctness); `feed-items-author-refresh.ts` only ever writes non-null names.
5. njump.me permalink for external-Nostr quotes (C3) — **narrowed**: `QuotedEmbed` now renders links from `originWebUrl`, so the only gap is `web/src/lib/post/origin-url.ts:14-15` returning `null` for nostr event-id URIs.
6. `FeedComposer` account source row (D8) — renders a raw `<Link>` + `openProfileHref`/`isModifiedClick` (`FeedComposer.tsx:1218`), which is CLAUDE.md's sanctioned fallback pattern; decide close-as-compliant or swap to `<ProfileLink>`.
7. Per-host enqueue throttle: add a skipped-due-to-host log (D9 — full relocation is Tranche C).
8. Restore the five lint suppressions dropped as stray `{ }` JSX (C2 — will error when `next lint` is wired).
9. B2 — infinite-scroll duplicate-fetch race: `WorkspaceView.tsx:449/457` guards on vessel-state `loadingMore` set via `setVessels` — replace with a synchronous ref latch.
10. Inline `<video>` missing `referrerPolicy="no-referrer"` (D12) — `PostMedia.tsx:282-299` (the poster `<img>` has it; the `<video>` doesn't).
11. D11 comment (`signAndEnqueue` signs outside the enqueue txn — flag, no fix); D13 overlay history/scroll-lock edge cases (unreachable today); D14 feed-batching test coverage. Absorbed from the retired feature-debt: cross-overlay supersede (reader→profile) can orphan a history entry so Back lands on a stale URL (pre-existing); migrations 122/123 carry non-idempotent bare statements (low risk under the run-once guard).
12. Migrate runner `CONCURRENTLY` guard matches comments and runs multi-statement files in one query (C1 — latent; `shared/src/db/migrate.ts:143` — confirmed untouched by the 2026-07-06 hardening, which fixed sort/checksums only).
13. **Bluesky changed handles never refresh** — the enrichment self-heal fires only on NULL handles, so a renamed account keeps its old `@handle` forever. → Wave-3 P2 tail.
14. Nits carried from the 2026-06-13 audit: native note-replies hard-dropped regardless of per-source `exclude_replies` (pre-existing); profile self-delete dropped (documented scope cut); `TagBrowser` not on `PageShell` (verified); pre-existing `collision.test.ts` flake ("pushes upward…").
15. Feed-card chassis: byline/dialogue pinned at `text-[11px]`/`text-[14.5px]` px — migrate to rem tokens so the global type-size control scales cards; amend the chassis spec in CLAUDE.md.
16. Pre-existing hairline debt (PipPanel/NewFeedPrompt 1px borders, globals.css comment hit) — burn down opportunistically per the no-new-hairlines rule.
17. `AUDIT-REPORT.md` residue: publications PATCH interpolates Zod-parsed keys as SQL column names (#6 — verified, `gateway/src/routes/publications/core.ts:134-149`; injection-bounded by the schema but fragile); stale CLAUDE.md doc refs (#14); inconsistent error shapes (#19 — see §8.8; note the `sendError` helper was **deleted** in the Day-6 P2 pass, so this now needs a fresh helper); pervasive `as any` (#20, ~23 in web); `requirePublicationPermission()` no-args (#21) and no note soft-delete (#24) — both carried unverified; naming (#25–27; `platform-pub`/`platformpub` vs all.haus in compose/package/credentials).

## 8. Performance, scaling & infrastructure

1. **Infra (operator, no repo change):** CDN in front (single biggest felt-speed lever); Brotli only after switching off stock `nginx:alpine`; Postgres tuning / own box; measure first (Lighthouse + WebPageTest, two regions, `/reader`). → `allhaus-performance-audit.md`.
2. `output: 'standalone'` + matching Dockerfile change (verified still absent from `next.config.js`). → perf audit #7.
3. Short-TTL gateway cache for hot public reads (article-by-dTag, author profile) — after the CDN lands. → perf audit.
4. **Feed-ingest Tranche C** (deferred until metrics demand — trigger: feed p95 tracking total `repost_edges` size): per-host politeness relocation into the fetch task then drop the per-tick cap; Jetstream firehose sharding past ~200 subs; two-phase paginated read or materialised per-reader candidate pool (the largest single item); `EXPLAIN ANALYZE` the scored CTE against a seeded large dataset (#15). → `FEED-INGEST-HYDRATION-PLAN.md`.
5. Split `payout.ts` (now **2,378** lines after the Wave-2/3 work, up from 1,983; four concerns) — the money-path changes above should land first so refactor and behaviour change don't tangle. Also on the decomposition list: `WorkspaceView.tsx` (1,562), `FeedComposer.tsx` (1,426), `UpstreamEdges.tsx` (1,300), `resolver.ts` (1,496). → code-economy §3/§6.6.
6. Extend `knip` to gateway/web — the triage pass is the real work (it's a CI job; config-first turns CI red). → code-economy §6.6.
7. Gateway decomposition: scheduler extraction deferred; full service extraction (messages → messaging-service) hedged but not started. → `GATEWAY-DECOMPOSITION.md`.
8. `000_base.sql` genesis extraction (item 1b) + `platform_config` seed rows in `schema.sql` (fresh prod boots run every operator-tunable key on code defaults). Deliberately deferred; the drift guard's residual column-level blind spot closes with it. → `ARCHITECTURE-AUDIT-IMPLEMENTATION-PLAN-2026-06-15.md`; AUDIT-BACKLOG B1/D1.
9. Standardise gateway error response shapes (4 shapes across 24 files; needs a new helper — see §7.17). CSP nonce middleware (removes `'unsafe-inline'` from `script-src`; careful with hydration). Accessibility pass. TS target alignment.
10. Cross-post outbound worker lacks `FOR UPDATE SKIP LOCKED` + deliver-then-mark-sent → crash can redeliver (no atproto/nostr idempotency key). Pre-existing, carried by the retry-helper extraction.
11. CSP `connect-src`/`media-src` widened to blanket `https:` for hls.js — tighten to a video-CDN allowlist if the origin set is bounded.

## 9. Features (specified, unbuilt)

1. **Reposts** — native kind-6 publishing; inbound + outbound infra exists, "Reposted by" label threaded but unrendered, no RepostButton on the Post path (verified: no component, no publish route).
2. **Email-on-publish Phases 2–4** — Phase 1 (send-on-publish) live; digests/scheduling/analytics phases unbuilt (14 requirements). → `EMAIL-ON-PUBLISH-SPEC.md` via ADR-CONFORMANCE.
3. **Publications Phase 4** — theming, custom domains (wildcard subdomains, DNS verification + TLS, custom CSS, per-pub favicon). → `PUBLICATIONS-SPEC.md`.
4. **`pub_payout_completed` notification** — spec'd, never emitted. → ADR-CONFORMANCE.
5. **Currency strategy** — Option 2 (GBP + display-only conversion) recommended, unbuilt. → `planning-archive/platform-pub-currency-strategy.md` (still cited live).
6. **Bucket system** — conceptual only. → `platform-bucket-system-design.md`.
7. **Frontend test coverage** — 6 test files exist; the unlock flow, gate state machine, and publish flow still untested. → frontend audit #9.
8. **Deferred greenfield from UNIVERSAL-POST** — `POST /post/:postId/react` external scoresheet (external repost/save stay quiet placeholders). → UNIVERSAL-POST-ADR §9/§10.
9. **Follow via email sources** — `addSource` can't take email, so email newsletters have no Follow affordance; and adding a source via Follow doesn't force an immediate feed refresh.
10. **Tribute chains publication×tribute composition (D1 revisit)** and chain-privacy refinement — deferred within the upstream-edges work. → UPSTREAM-EDGES-BUILD-PLAN.
11. **Free colour wheel per feed** + per-scheme accent token (its own ADR). → FEED-SCHEME-REFRESH §V.

## 10. Deliberately parked (not pickup work — listed to keep it out of the queue)

- **Trust graph** (behind `TRUST_SYSTEM_ENABLED`; Phases 5–6 gated on scale) and the dormant PipPanel/PipTrigger. Known spec gaps parked with it: Layer 4 "valued set" signals hand-waved; Layer 1 signals for external authors not persisted by adapters.
- **Traffology** (containers down, beacon off; Phases 2–4 with it).
- **Network-concierge Phase 4** (see §2.3).
- **Content spine / federation** (item 2 Plan C) — deferred to the self-host effort with the genesis migration.
- **Feed-ingest Slices 4–7**: Telegram (demand-gated), Farcaster + Matrix (infrastructure-gated), AP inbox (posture-gated).
- **Preset themes** (`ThemeSection` parked, operator PalettePanel retained).
- **Omnibus Phase 8** external-content rendering legal review (the `/extract` reader exists; the DMCA process item stands if that surface widens).

## 11. Verification debt (work is done, proof isn't)

- **§0 commit-audit fixes runtime verification + prod deploy residue** (shipped 2026-07-09, NOT runtime-verified — needs `docker compose build web gateway && up -d` + on prod `docker compose up -d --force-recreate nginx`, the bind-mount inode gotcha): (a) `PUT https://all.haus/media/upload` → 404/405, existing `/media/<sha>.webp` still 200 `image/webp`, `DELETE /media/<sha>.webp` → 403; (b) schedule article A, start new article B → B's first autosave creates a fresh draft row, A's scheduled draft untouched; (c) publish a drive-linked paywalled draft → drive matches only after v2 lands, one subscriber email, sent after the vault sealed; (d) publish a drive-linked free article normally → drive fulfils as before. `nginx -t` passed in a throwaway container 2026-07-09; gateway tsc/tests + web `next build` green. → FIX-PROGRAMME 2026-07-09 entry.
- **F4 premise check against live Stripe** before deleting the guarded no-op webhook branches. → §1.1.
- **Live Stripe browser test: S2 card attach incl. 3DS** (needs real keys). → §1.4.
- **Paywall publish/unlock runtime verification + prod cleanup** (shipped 2026-07-07 `339b43e`, NOT runtime-verified — needs container rebuild/restart): (a) publish a short (<700-word) paywalled article without touching the price field → blocked in the editor with the "at least £0.01" message, not a 400; (b) publish a priced paywalled article → only the payload-tagged v2 on the relay, unlock works; (c) unlock with a card-less account inside/over the £5 float → allowance copy honest, over-float shows add-card CTA, retry after a failure still shows an error message; (d) gate-pass against a vaultless paywalled row → 409 `article_misconfigured`, no charge. **Prod cleanup after deploy**: sweep `SELECT a.id, a.title FROM articles a LEFT JOIN vault_keys vk ON vk.article_id = a.id WHERE a.access_mode='paywalled' AND vk.id IS NULL AND a.deleted_at IS NULL`, unpublish hits, check `read_events` for charges against them (reverse if any), have the test writer re-publish from their draft. → FIX-PROGRAMME 2026-07-07 paywall entry.
- **Duplicate-draft-after-publish runtime verification + prod cleanup** (shipped 2026-07-08, migration 149, NOT runtime-verified — needs `docker compose build web && up -d web` + gateway restart): (a) draft a new article, let autosave fire, click "Save draft" during the debounce → exactly one `article_drafts` row; (b) schedule it, let the scheduler publish → the draft is gone and only the article remains in the dashboard; (c) publish a draft with the button → its draft row is deleted too; (d) reopen an older draft while a newer untagged one exists → autosave writes into the reopened row, not the newest. **Prod cleanup after deploy** (pre-existing orphans the fix does not retroactively remove): run `scripts/cleanup-orphaned-drafts.sql` (in-review-submission predicate fixed 2026-07-09 — Tier 1 now requires `published_at IS NOT NULL`) — dry-run by default (reports untagged/unscheduled drafts shadowing a live same-title article, tiered by confidence), and deletes only the Tier 1 exact-content-match set when re-run with `-v apply=true`. Tier 2 (title-only) and drive-linked candidates are reported for manual review, never auto-deleted. → FIX-PROGRAMME 2026-07-08 entry.
- **External-author-history runtime verification** (shipped 2026-07-07, NOT runtime-verified — needs a user container restart): the ADR §7 manual verifies — unfollowed-author profile hydrates in ~3s; Nostr subscribe pulls week-deep history + write relays onto `relay_urls`; later subscribe of a hydrated author reactivates the shadow row and promotes its rows. → `EXTERNAL-AUTHOR-HISTORY-ADR.md`.
- Mobile workspace: full device verification (swipe/axis-lock/pip precedence, drag-to-rank, hide→renumber, density cross-device, resume-by-id). Note the pip-order `.reverse()` was removed 2026-07-06 (it inverted its own stated intent), so verify pip order = Feed 1 leftmost. → MOBILE-LAYOUT-ADR §X.
- A standing pile of "NOT browser-verified (needs `docker compose build web && up -d web`)" items across FIX-PROGRAMME entries — worth one consolidated smoke session rather than per-item.
- `scripts/reconcile-ledger.sql` real run — **now unblocked** (see §1.9).
- `/thread` external N+1 walk: needs real thread fixtures or a parity harness before the recursive-CTE rewrite is safe — the rewrite itself stays documented debt.

---

## Suggested attack order

0. ~~§0 commit-audit HIGHs + MEDIUMs~~ — **done 2026-07-09** (all seven items; only the cosmetic tail remains, batched with §7). Deploy residue: prod nginx force-recreate + the §11 runtime verifies.
1. **F4 live check + pub-split re-pay + card re-auth prompt** (§1.1/§1.2/§1.4 — one Stripe-correctness session with real keys; closes the last reader-facing money loop).
2. **Publication-subscription distribution** (§1.3 — the one remaining hole in the subscription money model).
3. **Owner dashboard** (§3.1 — before real money; the ledger views make it cheap now).
4. **Small-money batch** (§1.5–§1.6 calendar + provisional-reads; §1.9 reconcile-ledger run; §1.10 grant-mode decision).
5. **Cleanup cluster** (§7) as a palate-cleanser batch; **Slice-8 dedup design session** (§6) separately.
6. **Landing page + onboarding + subscriptions Phase 2** (the launch-cohort conversion set).
7. Everything in §8 by measurement, not vibes — CDN + measurement first.
