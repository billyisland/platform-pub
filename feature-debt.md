# Feature Debt & Plan of Attack

Consolidated from planning documents, verified against the codebase as of 2026-04-13. Completed specs live in `planning-archive/`. Documents left in the project root describe work that is still outstanding — each is referenced in the relevant section below.

Last audited: 2026-04-13. Items marked DONE were verified against the codebase in that audit.
Last worked: 2026-04-19. Completed: FIX-PROGRAMME Day 2 P0 Stripe orphans. §3 writer payout and §4 publication payout both refactored from single-transaction (Stripe-call-inside-txn → any later throw rolls back while transfers stay live) into three-phase reserve→Stripe→complete with stable idempotency keys (`payout-${payoutId}` and `pub-split-${payoutId}-${accountId}`). New `resumePendingWriterPayouts` and `resumePendingPublicationPayouts` run at the top of each cycle so a mid-flight crash is retried idempotently on the next run. §4 subsumes §33 (dead "mark completed" block gone) and as a side-effect finally gives KYC-waiting splits a retry path — previously they sat pending forever. No migrations; schema already supported nullable `stripe_transfer_id` + `'pending'` status on both `writer_payouts` and `publication_payout_splits`.
Previously: 2026-04-19 earlier. Completed: FIX-PROGRAMME Day 1 P0 — §1 (scheduler vault ordering), §2 (Stripe webhook dedup via nullable `processed_at`, migration 071), §7 (`recordSubscriptionRead` wrapped in `withTransaction`), §8 (await the expiry-warning insert), §9 (dedicated `expiry_warning_sent` event_type, migration 072), §10 (subscription charge reads `platformFeeBps` from config, not hardcoded 0.08).
Previously: 2026-04-18. Completed: Redesign audit-and-fix pass against `ALLHAUS-REDESIGN-SPEC.md`. Seven undocumented deviations closed: `ExternalCard` title changed from italic Literata to roman, and content branched so RSS-like items (with title) render a Literata 14.5px grey-600 summary while Bluesky/Mastodon-like items (no title) render a Jost 15px black body matching `NoteCard` — preserves italic-Literata as the native-article signal per §4; `ArticleCard` standard-tier excerpt bumped from 15px → 15.5px to match spec §4a; six grey-100 zone-rule borders in `ComposeOverlay` and two in `ArticleComposePanel` raised to grey-200 per spec §3 ("divided into three zones by internal 4px grey-200 rules"); `PlayscriptReply` action row switched from `opacity: 0 / pointer-events: none` to conditional mount (`showActions && ...`) so the entry's vertical rhythm collapses when actions are hidden — matches the spec's reveal semantics rather than reserving layout space; migration 070 harmonises `articles_derive_size_tier()` with the 068 backfill (NULL `word_count` → `standard`, not `brief`); spec §2 line 117 corrected from "crimson ∀ mark at 14px" to "white" to match §1 and the shipped `Nav.tsx`.
Previously: 2026-04-18. Completed: Redesign Step 6 (end-of-feed / zero / filtered-empty / error states) per `ALLHAUS-REDESIGN-SPEC.md` §2 + §6. `FeedView.tsx` gains four local state components: `EndOfFeed` (mono-caps `END OF FEED`, 48px crimson under-rule, `SUBSCRIBE TO MORE →` link — scrolls to top and focuses the subscribe input, which now carries `id="feed-subscribe-input"`); `ZeroState` (Literata italic 32px `"Nothing here yet — which is fine."`, Jost 15px grey-600 body with underlined `above` link, mono-caps `TRY: A BLUESKY HANDLE · AN RSS URL · AN NPUB · A PUBLICATION NAME` ribbon); `FilteredEmptyState` (mono-caps `NO ITEMS MATCH THIS FILTER` + `CLEAR FILTER` — fired when `reach === 'following'` and the feed returns zero items, reverts to `explore`); `FeedErrorState` (`"Couldn't load the feed."` + `RETRY` at 33vh; the secondary `"The gateway may be down. This isn't a sync issue on your end."` line appears after ≥3 failures in 60s, tracked via `failureTimestampsRef`). All copy matches the spec verbatim. No filter-bar dependency — the filtered state already functions against the latent `reach` state.
Previously: 2026-04-18. Completed: Redesign Step 5 (compose overlay article mode) per `ALLHAUS-REDESIGN-SPEC.md` §3 + §6. New `ArticleComposePanel.tsx` mounts inside `ComposeOverlay` when `mode === 'article'`; owns its own Tiptap instance with the same extensions as the full editor (StarterKit, Markdown, Image, ImageUpload, EmbedNode, PaywallGateNode, Placeholder, CharacterCount). Top zone: title (Literata 22px italic) + `PUBLISH AS: …` selector from `publications.myMemberships()`. Inline toolbar. Body styled via new `.article-compose-body` CSS class (Literata 17px / 1.8). Paywall gate toggle with price input on insert. Controls zone: autosave timestamp, `OPEN IN FULL EDITOR ↗`, `SCHEDULE` (inline datetime picker), crimson Publish (`btn-accent`). Autosaves to the drafts table via the existing `createAutoSaver` (3s debounce); "Open in full editor" flushes the draft and navigates to `/write?draft=<id>[&pub=<slug>]` so the full editor hydrates with the same state. `stores/compose.ts` gains `'article'` mode, `openArticle({ draftId?, publicationSlug? })`, and `setMode(mode)` for mid-compose escalation. The previous broken `/write/new` escape link is now a `Write an article →` mode switch. Desktop overlay widens from 640→760px. V1 defers dek/tags/email-toggle/comments-toggle/show-on-writer-profile/FLOWING-CUSTOM to the full editor.
Previously: 2026-04-18. Completed: Redesign Step 4 (playscript thread treatment) per `ALLHAUS-REDESIGN-SPEC.md` §4 "Thread rendering". `ReplyItem.tsx` deleted and replaced with `PlayscriptReply.tsx` + `PlayscriptThread.tsx`. `ReplySection.tsx` flattens the nested reply tree into a chronological `PlayscriptEntry[]`, setting `replyingTo` only when the parent isn't the immediately-previous entry (drives the `→ NAME:` arrow for non-adjacent parents). Gateway `GET /replies/:targetEventId` now joins `trust_layer1` for author `pipStatus` and emits `parentCommentId` on each node. Card shape: 32px left step-in on the thread container, 32px vertical rhythm between entries, no borders or hairlines. Each entry: mono-caps 11px speaker line (pip · bold Jost name · colon, or `YOU:` with no pip for self), Jost 14.5px/1.55 dialogue line, interactive vote controls pinned top-right, action row (time · REPLY · DELETE · REPORT) reveals on hover/focus with a `#fafaf7` tint. Pagination: first 10 entries + `SHOW N MORE REPLIES`. Nesting depth erased — a reply to a reply to a reply is three flat entries.
Previously: 2026-04-18 earlier. Completed: Redesign Step 3¾ (reading-history resumption) per `ALLHAUS-REDESIGN-SPEC.md` §4 + §6. Migration 069 (`reading_positions` table keyed `(user_id, article_id)` + `always_open_articles_at_top` preference column on accounts). Gateway routes: `PUT /reading-positions/:nostrEventId` (upsert), `GET /reading-positions/:nostrEventId`, `GET/PUT /me/reading-preferences`. Client hook `useReadingPosition` debounces snapshots on scroll (~500ms) and flushes on `pagehide` / `visibilitychange` via `fetch keepalive`; restore skips the 10% grace zone, the "scrolled to foot" tail, anchored URLs, and the always-open-at-top preference. Bookmark button retained — §6 note: no window-of-no-mechanism risk while both coexist. Settings page gains a "Reading preferences" section.
Previously: 2026-04-18. Completed: Redesign Step 3½ (article tiers — lead/standard/brief) per `ALLHAUS-REDESIGN-SPEC.md` §4a. Migration 068 (`size_tier` column + BEFORE INSERT trigger that derives from word_count while preserving editorial overrides). Backfill: <1000 → brief, 1000–3000 → standard, ≥3000 → lead. Gateway feed route emits `sizeTier`. `ArticleCard` branches headline (30/22/20px) and skips excerpt+tags for briefs; new `twoUp` prop shrinks byline/action to 10.5px and drops Quote/Bookmark/Share. `FeedView.layoutBlocks()` pairs adjacent briefs two-up (40px gutter) with a 72px zone-break before each contiguous run.
Previously: 2026-04-17. Completed: Redesign Steps 1–3 (the swap, compose overlay, card chassis refactor) per `ALLHAUS-REDESIGN-SPEC.md`.
Previously: 2026-04-17. Completed: Trust graph Build Phase 4 (epoch aggregation and decay) — migration 067 (trust_epochs table, vouch decay tracking columns), pure library functions for attestor weighting (Phase A formula: age × payment × readership × activity) and aggregation (freshness decay, graduated small-scale protection, normalised scoring), trust_epoch_aggregate cron task (quarterly full epochs + Mon/Thu mop-ups, small-subject rule, threshold gate, dry-run mode, monitoring logs), 42 unit tests, gateway trust endpoint updated to prefer epoch scores over live counts, frontend dimension bars updated to use real scores. See `ALLHAUS-OMNIBUS.md` §II.8 + Build Phase 4.
Previously: 2026-04-17. Completed: Trust graph Build Phase 2 (vouching CRUD) — migration 066 (vouches + trust_profiles tables), POST /vouches (upsert with dimension/value/visibility), DELETE /vouches/:id (soft-delete withdrawal), GET /trust/:userId extended with Layer 2 dimension scores + public endorsements + Layer 4 relational data + viewer's existing vouches, GET /my/vouches for own vouch list. Frontend: TrustProfile component (dimension bars, endorsements, "your network says"), VouchModal (dimension checkboxes, visibility radio, aggregate disclaimer), vouch button on writer profiles, VouchList withdrawal UI on /network?tab=vouches. See `ALLHAUS-OMNIBUS.md`.
Previously: 2026-04-17. Completed: Trust graph Build Phase 1 (Layer 1 enrichment) — migration 065, trust_layer1_refresh cron, GET /trust/:userId, pip rendering on all feed cards. See `ALLHAUS-OMNIBUS.md`.
Previously: 2026-04-15. Completed: Gateway decomposition — service-layer extraction for `routes/messages.ts`. 693-line route file split into `routes/messages.ts` (202 lines, thin dispatchers) + `services/messages.ts` (563 lines, business logic). `ServiceResult<T>` discriminated union for HTTP error mapping without throws. All 13 DM endpoints covered (conversations, messages, likes, read-state, decrypt batch, pricing). Per `GATEWAY-DECOMPOSITION.md`, this hedges the eventual messaging-service extraction — the cutover becomes a mechanical import→HTTP-client swap rather than a combined factor+extract. `replies.ts` deliberately left in the gateway (article/note threading, not DMs). Build + 52 tests green.
Previously: 2026-04-14. Universal Feed audit triage pass 2 — all remaining items from `universal-feed-audit.md` landed. Security: S1 (DNS-rebinding TOCTOU closed — undici Agent with `connect.lookup` hook pins the validated IP through the socket layer), S4 (`GET /resolve/:requestId` now binds results to the initiating session). Correctness: K1 (Nostr kind 5 deletions match on raw event id via `interaction_data->>'id'`, not recomputed nevent), K2 (RSS sorts by publishedAt DESC before `maxItems` slice so recent content wins), K3 (Bluesky truncation appends `/{username}` all.haus link within the 300-grapheme budget), K4 (feed poll filters atproto rows when Jetstream is healthy), K5 (resolver regexes accept `+` addressing and multi-label TLDs), K6 (`outbound_token_refresh` skips rows with no session). Design: D3 (migration 061 — `resolver_async_results` table + 5m prune cron replaces per-replica Map), D4 (protocol-specific OAuth state cookies), D5 (`requireAuth` on Bluesky callback), D6 (versioned ciphertext with multi-key decryption for rollover). Minors: Nostr `last_error` truncated to 1000 chars, resolver ILIKE special chars escaped, `enqueueCrossPost`/`enqueueNostrOutbound` INSERT + add_job wrapped in `withTransaction`.
Previous: 2026-04-14 earlier — Universal Feed audit triage pass 1 — C1 (explore-feed score ordering preserved, new-user cards interleaved), C2 (Jetstream leader-elected via `pg_try_advisory_lock`), C3 (RSS `fetch_interval_seconds` resets on recovery), C4 (Mastodon quote appends source URL), S2/S3/S5/S6 (Nostr WS SSRF, future-timestamp rejection, subscribe input validation), partial S1 (IP range list extended), D1 (migration 060 `DbStateStore`), D2 (`clientPromise` cache clears on rejection).
Previously: 2026-04-14 earlier — Universal Feed Phase 4 — Mastodon ingestion (ActivityPub outbox polling + WebFinger resolution).
Previously: 2026-04-14 earlier — Universal Feed Phase 3 (Bluesky via Jetstream). 2026-04-13 (v5.35.0) — Universal Feed Phase 1 (RSS) + Phase 2 (feed_items unified timeline, external Nostr).

---

## How this is organised

1. **Bugs & fixes** — things that are broken or dangerous right now
2. **Incomplete features** — half-built work from executed specs
3. **New features** — unbuilt features from executed specs, ready to build
4. **Strategic initiatives** — large-scope work with its own spec document still in the project root
5. **Missing table-stakes UI** — features any user would expect but that don't exist yet

---

## 1. Bugs & Fixes

### DONE — verified fixed in codebase audit 2026-04-06

All high-priority bugs have been resolved:

- ~~DM sender visibility~~ — WHERE clause includes `OR dm.sender_id = $2`
- ~~requireAdmin missing return~~ — `return reply.status(403)...` present
- ~~Auth middleware ignores account status~~ — queries `accounts.status`, rejects non-active
- ~~Rate limiting~~ — `@fastify/rate-limit ^8.1.0` installed with per-route config
- ~~Security headers~~ — HSTS, X-Frame-Options, CSP, Referrer-Policy all in nginx.conf
- ~~Non-root Docker containers~~ — all Dockerfiles have `addgroup/adduser` + `USER app`
- ~~Remove internal service port bindings~~ — only postgres, strfry, gateway, web, nginx expose ports
- ~~renderMarkdownSync XSS~~ — protocol allowlist (https, /, #), strips disallowed
- ~~LIKE metacharacters unescaped~~ — `escapeLike()` escapes `%`, `_`, `\`
- ~~Config cache never invalidated~~ — 5-minute TTL + `invalidateConfig()` method
- ~~Notification type mismatch~~ — **resolved in this session:** phantom types `dm_payment_required` and `new_user` removed from frontend union (backend never creates them). Fallback renderer covers future types. Notification centre redesigned as permanent log (v5.11.0).
- ~~Drive update truthiness bug~~ — uses `!== undefined`; Zod `.min(1)` rejects zero anyway
- ~~Auth hydration race~~ — every protected page has `if (loading || !user) return <skeleton>` guard
- ~~Article price upper bound~~ — `.max(999999)` on pricePence validation
- ~~Missing NODE_ENV=production~~ — all Dockerfiles have `ENV NODE_ENV=production`
- ~~Missing .dockerignore~~ — root `.dockerignore` exists
- ~~Docker health checks~~ — all 9 services have healthcheck blocks
- ~~Missing ON DELETE clauses~~ — fixed by migrations 018 + 021
- ~~Session storage not cleared on logout~~ — clears all `unlocked:*` keys
- ~~Dependency version conflicts~~ — pg `^8.20.0` and dotenv `^17.3.1` aligned everywhere

### Still outstanding

*(None — remaining items moved to Infrastructure backlog below.)*

### Moved to Infrastructure backlog

- ~~~23 instances of `any` across the frontend~~ — moved to infrastructure backlog (not a bug, incremental cleanup)
- ~~No CI/CD~~ — moved to infrastructure backlog
- ~~TypeScript target mismatch~~ — moved to infrastructure backlog (cosmetic, no runtime impact)
- ~~Accessibility gaps~~ — **resolved:** vote buttons already had aria-labels; paywall indicator uses price text (not colour-only); dropdown keyboard nav (Escape-to-close, aria-expanded, role="menu") added to AvatarDropdown and NotificationBell.
- ~~Reduce JWT session lifetime~~ — **fixed:** reduced from 7 days to 2 hours with 1-hour refresh-on-use half-life. Active users stay logged in; idle sessions expire in 2 hours.

---

## 2. Incomplete Features

### DONE — verified complete in codebase audit 2026-04-06

- ~~Reader subscription management~~ — `SubscriptionsSection.tsx` with cancel controls, fully wired into account page
- ~~Reader tab overview~~ — `BalanceHeader.tsx` shows free allowance remaining, fully wired
- ~~Export modal polish~~ — uses `Set<ExportType>` (not single boolean), writer guard on backend, per-type error messages
- ~~Subscription price in settings~~ — by design: dashboard is the writer control room, `/settings` is reader-focused

### Still outstanding — backend exists, no UI

These endpoints are fully wired but have no way to trigger them from the frontend. Audited 2026-04-13.

~~Delete / archive publication~~ — **done (v5.31.0):** Danger zone in PublicationSettingsTab with archive (confirm dialog), transfer ownership (modal with EiC member selector), and delete (type-to-confirm modal matching publication name). Owner-only visibility.

~~Transfer publication ownership~~ — **done (v5.31.0):** Modal with radio-button selector for eligible Editor-in-Chief members. Redirects to personal dashboard after transfer.

~~Reading history page~~ — **done (v5.33.0):** ReadingHistory component on /account page. Paginated list showing article title (linked), writer avatar/name, date read, and Free/Paid label. Uses existing `GET /my/reading-history` endpoint.

~~Subscriber list for writers~~ — **done (v5.30.0):** SubscribersTab component with summary stats (active count, est. MRR, new this month) and full subscriber table. Conditional tab in personal dashboard (writer-only). Uses existing `GET /subscribers` endpoint.

~~Edit publication member role~~ — **done (v5.31.0):** Inline "Change role" action in MembersTab. Clicking replaces role cell with select dropdown + Save/Cancel. Uses existing PATCH endpoint.

~~Accept / decline commission~~ — **done (v5.33.0):** New `GET /my/commissions` endpoint. CommissionsTab in dashboard (writer-only) with pending/accepted/completed sections. Accept button and Decline with confirm pattern.

~~Pin drive to profile~~ — **already existed:** DriveCard had Pin/Unpin toggle calling `POST /drives/:id/pin`. Verified working.

~~Edit existing drive~~ — **done (v5.33.0):** Inline edit mode on DriveCard — Edit button swaps card to form with title, description, target amount fields. Uses existing `PUT /drives/:id` endpoint.

**Admin direct suspend** — `POST /admin/suspend/:accountId` suspends an account outside the report flow. Admin reports page has resolve/reject, but no standalone suspend action.

~~Unpublish personal article~~ — **done (v5.29.0):** `POST /articles/:id/unpublish` endpoint + Unpublish button in personal Articles tab with confirm dialog and inline "Moved to drafts" message.

### Previously outstanding — now done

~~Subscription offers system~~ — **done (v5.13.0):** migration 037 creates `subscription_offers` table with `code`/`grant` modes. `POST /subscriptions/:writerId` accepts optional `offerCode`, validates and applies discount. `offer_id` and `offer_periods_remaining` tracked on subscriptions; renewal job decrements and reverts to standard price when offer period elapses. Dashboard Offers tab with create/list/revoke. Public redeem page at `/subscribe/:code`.

~~Gift link frontend~~ — **done:** dashboard GiftLinksPanel (create/list/revoke per article in Articles tab) + "Gift link" option in ShareButton dropdown.

~~DM pricing / anti-spam settings~~ — **done:** GET/PUT `/settings/dm-pricing` + per-user override endpoints. Moved from dashboard settings tab to `/social` page (v5.14.0 settings rationalisation). **Note (2026-04-19):** pricing config persists, but the send-side 402 enforcement branch was pulled in FIX-PROGRAMME §12 because no endpoint existed to take payment and unblock the send. DMs are effectively free until a charge-and-unblock endpoint is built — the stored prices will start enforcing again the day that ships.

~~Commission social features~~ — **done:** Commission button in DM thread header opens CommissionForm modal. Migration 036 adds `parent_conversation_id` to `pledge_drives`. Backend and API client pass conversation context through.

---

## 3. New Features (unbuilt, from executed specs)

All items below are entirely unbuilt — no migrations, routes, or components found.

### ~~Bookmarks / save for later~~

**Done (v5.29.0):** Migration 047 (bookmarks table), gateway routes (POST/DELETE by Nostr event ID, GET list, GET batch IDs), BookmarkButton component with optimistic update, /bookmarks page, feed integration (batch bookmark ID loading, isBookmarked prop on ArticleCard), avatar dropdown link.

### ~~Hashtags / topics / tags~~

**Done (v5.29.0):** Migration 048 (tags + article_tags tables), gateway tag routes (autocomplete search, browse by tag, get/set article tags), TagInput component in editor (pill-style with autocomplete dropdown, 5 tag max), tag display on ArticleCard (linked pills below excerpt), /tag/[tag] browse page, tags saved through both personal and publication publish flows, tags loaded when editing existing articles, feed endpoint includes tags via correlated subquery.

### ~~Writer analytics~~

**Done (v5.28.0 — Traffology Phase 1):** Complete analytics system with page tracking script, ingest service, hourly/daily/weekly aggregation, source resolution, observation generation, feed UI, piece detail with provenance bars, and overview with baseline stats. See `TRAFFOLOGY-BUILD-STATUS.md` and `TRAFFOLOGY-MASTER-ADR-2.md`.

### Reposts / reshares

Requires: migration (reposts table), gateway routes, Nostr kind 6 event publishing, RepostButton component, feed integration with "Reposted by" labels. Needs feed algorithm to be meaningful.
*(Source: FEATURES.md feature 8)*

### Email-on-publish

Requires: migration (email_on_new_article boolean on accounts), send logic in article publish flow, email template, settings toggle.
*(Source: FEATURES.md feature 9)*

### Subscription improvements (Phase 2)

Phase 1 is done (auto-renewal, annual pricing, subscribe at paywall, spend-threshold nudge, comp subscriptions). Remaining from Phase 2:
- **Free trials** — writer-configurable 7/30-day trial period
- **Gift subscriptions** — "buy a subscription for someone"
- **Welcome email** — configurable email on subscribe
- **Subscriber import/export** — CSV for migrating to/from Substack
- **Subscriber analytics** — growth, churn, MRR trend
- **Custom subscribe landing page** — `/username/subscribe`
*(Source: SUBSCRIPTIONS-GAP-ANALYSIS.md)*

---

## 4. Strategic Initiatives

### DONE

**Feed algorithm Phase 1** — fully implemented. Migration 035 (`feed_scores` table), background scoring worker (`feed-ingest/src/tasks/feed-scores-refresh.ts`, Graphile cron `*/5 * * * *`), `GET /feed` with `reach` parameter (following/explore), UI reach selector in `FeedView.tsx`. Spec archived: `planning-archive/FEED-ALGORITHM.md`.

**Resilience & performance** — complete. Article/profile pages are Server Components, fonts self-hosted, NDK removed from client bundle, shared Avatar component, print stylesheet, error boundaries. Spec archived: `planning-archive/RESILIENCE.md`.

**Settings rationalisation** — done (v5.14.0), restructured again (v5.34.0). Six pages: Profile (public identity), Settings (email, payment, notifications, export, danger zone), Ledger (balance, earnings, subscriptions, pledges), Library (bookmarks, reading history), Network (following, followers, blocked, muted, feed dial, DM fees), Dashboard (articles+drafts, subscribers, proposals, pricing). Old URLs (/account, /bookmarks, /following, /social, /followers, /history, /reading-history) redirect to new locations. Spec archived: `planning-archive/SETTINGS-RATIONALISATION.md`.

**Publications Phases 1–3 + Phase 5** — done (v5.18.0–v5.20.0). Schema, CMS pipeline, reader surface, subscriptions/follows, RSS, search, feed integration, revenue (rate card, payroll, earnings).

### Still outstanding

**Codebase audit — `AUDIT-REPORT.md`**

34-item audit from 7 April 2026. Most critical/high items fixed. Still outstanding:
- #6: `publications.ts` PATCH uses raw JS keys as SQL column names (fragile, no mapping)
- #12: `sendError` helper in `gateway/src/lib/errors.ts` is dead code (never imported)
- #14: Stale doc references in CLAUDE.md to FEATURES.md and DESIGN-BRIEF.md (moved to archive, refs not updated)
- Design issues #19 (inconsistent error shapes), #20 (pervasive `as any`), #21 (`requirePublicationPermission()` with no args), #22–23 (background workers in gateway process), #24 (no soft-delete for notes), #25–27 (naming inconsistencies)

**Code quality hardening — `CODE-QUALITY.md`**

Reference catalogue of tooling tiers. Nothing built yet. Priority items:
- Tier 1a: CI pipeline (GitHub Actions with tsc + vitest)
- Tier 1b: Backend ESLint (promise-safety rules)
- All other tiers deferred until second contributor or post-launch

**Traffology Phases 2–4 — `TRAFFOLOGY-MASTER-ADR-2.md`**

Phase 1 complete (build status archived: `planning-archive/TRAFFOLOGY-BUILD-STATUS.md`). Remaining phases:
- Phase 2: Nostr monitor service (relay polling for reposts/reactions/quotes)
- Phase 3: Outbound URL search (Bluesky, Reddit, HN, Mastodon APIs) + pattern observations
- Phase 4: Publication editor view

**Frontend audit — `all-haus-frontend-audit.md`**

12-item ranked audit. Outstanding items:
- ~~#1: Open Graph / social sharing metadata~~ — **done (v5.32.0):** OG + Twitter Card tags on all public pages
- #2: Email / newsletter delivery (no email-on-publish — critical for writer retention)
- #3: Landing page (minimal — no social proof, no screenshots, no tab model explanation)
- #5: Publication homepage templates (wireframe-quality, no visual customisation)
- #6: Writer onboarding flow (no post-signup wizard)
- #7: CSP header blocking external images
- #8: Import tooling (no Substack/Ghost/WordPress import)
- #9: Frontend test coverage (zero tests in web/)
- ~~#10: Dashboard architecture (single ~530-line component)~~ — **done (v5.34.0):** reduced from 7 to 4 tabs, ProposalsTab extracted to own component, drafts merged into ArticlesTab
- #11: Dark mode
- Item #4 (writer analytics) resolved by Traffology Phase 1

**Owner dashboard — `OWNER-DASHBOARD-SPEC.md`**

Entirely unbuilt. Admin area has only the reports page. Spec covers:
- Overview (money pipeline visibility + trigger buttons)
- Users (account metrics, KYC-incomplete writers, conversion funnel)
- Content (publishing activity, system health)
- Config (platform_config editor)
- Regulatory (UK tax thresholds, VAT approach warning, custodial exposure)

**Subscriptions Phase 2 — `SUBSCRIPTIONS-GAP-ANALYSIS.md`**

Phase 1 complete (auto-renewal, annual pricing, subscribe at paywall, comp subscriptions, offers system). Phase 2 outstanding:
- Free trials (writer-configurable 7/30-day)
- Gift subscriptions ("buy for someone")
- Welcome email on subscribe
- Subscriber import/export (CSV)
- Subscriber analytics (growth, churn, MRR trend)
- Custom subscribe landing page (`/username/subscribe`)

**Publications Phase 4 — `PUBLICATIONS-SPEC.md`**

Theming and custom domains, deferred:
- Wildcard subdomain routing + custom domain DNS verification + TLS
- Theme settings UI + custom CSS editor
- Per-publication favicon

**Bucket categorisation system — `platform-bucket-system-design.md`**

A generic system for user-defined, non-overlapping categories with behavioural rules. Conceptual — no implementation plan yet.

**Currency strategy — `platform-pub-currency-strategy.md`**

Multi-currency support. Option 2 (launch with GBP, display-only conversion) recommended. Entirely unbuilt.

**Universal Feed Phase 5 — `UNIVERSAL-FEED-ADR.md`**

Phases 1–5 complete. Phase 5A (Mastodon outbound) + Phase 5B (cross-post UI, Nostr queue migration, token refresh, Bluesky OAuth outbound) both shipped.

Shipped in Phase 5A:
- Migration 057 (`linked_accounts`, `outbound_posts`, `oauth_app_registrations`)
- `shared/src/lib/crypto.ts` (AES-256-GCM credential encryption via `LINKED_ACCOUNT_KEY_HEX`)
- Gateway `/api/v1/linked-accounts/*` (list/remove/update, Mastodon OAuth start + callback with dynamic client registration)
- Gateway `enqueueCrossPost` helper called from `POST /notes` when `crossPost` payload present
- feed-ingest `outbound_cross_post` task with `activitypub-outbound` adapter (Idempotency-Key, `/api/v2/search?resolve=true` for federated reply targets, exponential backoff retries)
- `LinkedAccountsPanel` on `/settings` with connect/disconnect + per-account `cross_post_default` toggle

Shipped in Phase 5B:
- Migration 058 (`outbound_posts.linked_account_id` nullable + `signed_event` jsonb) so external Nostr outbound can ride the same queue
- Migration 059 (`atproto_oauth_sessions` — DB-backed `NodeSavedSessionStore` for `@atproto/oauth-client-node`, AES-256-GCM encrypted)
- Cross-post toggle in `ExternalCard` reply/quote composer, hidden when no linked account for the item's protocol; `useLinkedAccounts` module-level cache
- External Nostr outbound moved out of inline `publishToExternalRelays` in `notes.ts` into `enqueueNostrOutbound` → `outbound_cross_post` job → `nostr-outbound.ts` adapter (publishes to source relays from `external_sources.relay_urls`)
- `outbound_token_refresh` cron (every 30m) — atproto branch calls `client.restore(did, 'auto')` once a week on dormant accounts; credentials_enc-based branch is a stub (Mastodon tokens don't expire)
- `shared/src/lib/atproto-oauth.ts` — singleton `NodeOAuthClient` factory (confidential client, `private_key_jwt`, PKCE + DPoP + PAR); loopback client_id fallback for local dev, `ATPROTO_CLIENT_BASE_URL` + `ATPROTO_PRIVATE_JWK` for prod
- Gateway `/.well-known/oauth-client-metadata.json` + `/.well-known/jwks.json` (nginx-routed to gateway), `POST /linked-accounts/bluesky` (handle → authorize URL), `GET /linked-accounts/bluesky/callback`
- feed-ingest `atproto-outbound.ts` adapter — DPoP-bound `com.atproto.repo.createRecord` via `OAuthSession.fetchHandler`; 300-grapheme truncation via `Intl.Segmenter`; reply strong-refs (root + parent from `interaction_data`) and `app.bsky.embed.record` quote refs
- Bluesky handle input in `LinkedAccountsPanel`

**Trust Graph — `ALLHAUS-OMNIBUS.md`**

Eight build phases specified in the omnibus. Spec covers trust graph (Layer 1 automatic signals, Layer 2 attestations, Layer 3 graph analysis, Layer 4 relational presentation) and Phase A/B anonymity strategy. Full spec in `ALLHAUS-OMNIBUS.md` (Books I, II, IV). Book III (workspace specification) was removed — the panel-based workspace was retired in favour of the single-surface model in `REDESIGN-SCOPE.md`.

Build Phase 1 (Layer 1 enrichment) — **DONE (2026-04-17):**
- Migration 065 (`trust_layer1` table — per-user precomputed signals + pip_status)
- `feed-ingest/src/tasks/trust-layer1-refresh.ts` — daily cron (01:00 UTC) computing signals from accounts, articles, read_events, stripe status
- `GET /api/v1/trust/:userId` — gateway endpoint returning Layer 1 signals
- Trust pip (5px circle) rendering on all feed cards (ArticleCard, NoteCard, ExternalCard)
- `PipStatus` type (`known`/`partial`/`unknown`) added to feed item types
- `.trust-pip` CSS class in globals.css
- Thresholds: known = >1yr + >50 paying readers + Stripe KYC; partial = >90d + any readers or articles; unknown = everything else
- NIP-05 verification defaults false (no NIP-05 table yet — wire up when that ships)

Build Phase 2 (vouching CRUD) — **DONE (2026-04-17):**
- Migration 066 (`vouches` + `trust_profiles` tables). Vouches: attestor/subject/dimension unique, CHECK constraints (no self-vouch, contests must be aggregate)
- `POST /api/v1/vouches` — upsert vouch (one per attestor/subject/dimension)
- `DELETE /api/v1/vouches/:id` — withdraw (soft-delete via withdrawn_at, attestor-only)
- `GET /api/v1/my/vouches` — list of authenticated user's active vouches
- `GET /api/v1/trust/:userId` extended with Layer 2 dimension scores, public endorsements, Layer 4 relational data (viewer's followed/subscribed intersected with public endorsements), viewer's existing vouches
- TrustProfile component (dimension bars, endorsements, Layer 4 "your network says")
- VouchModal (dimension checkboxes, visibility radio, aggregate disclaimer)
- Vouch button on writer profiles, VouchList on /network?tab=vouches with withdrawal

Build Phase 3 (reader-side product work) — **superseded by `REDESIGN-SCOPE.md` + `ALLHAUS-REDESIGN-SPEC.md`:**
- The four-panel workspace originally specified here was retired in favour of a single-surface product model
- Frontend work is now `REDESIGN-SCOPE.md` Phase A — ten incremental changes to the existing codebase
- `ALLHAUS-REDESIGN-SPEC.md` specifies the four core surfaces: topbar, feed, compose overlay, card family
- Redesign Steps 1–3 shipped (2026-04-17): the swap, compose overlay (note mode), card chassis refactor
- Redesign Step 3½ shipped (2026-04-18): article tiers (lead/standard/brief) with two-up brief pairing and 72px zone-break before contiguous brief runs
- Redesign Steps 3¾–5 shipped (2026-04-18): reading-history resumption, playscript thread rendering, compose overlay article mode
- Remaining from the spec: end-of-feed/zero/error states (Step 6), focus-preference nav filtering, reading-history surface, mobile compose gestures, filter bar, dark mode

Build Phase 4 (epoch aggregation and decay) — **DONE (2026-04-17):**
- Migration 067 (`trust_epochs` table for audit trail, `last_reaffirmed_at` + `epochs_since_reaffirm` columns on vouches)
- `feed-ingest/src/lib/trust-weighting.ts` — Phase A attestor weight formula: `age × payment × readership × activity` (caps: 365d, 50 readers, 10 articles, verified payment)
- `feed-ingest/src/lib/trust-aggregation.ts` — freshness decay (6-epoch table), graduated small-scale protection (paused 1–3, quarter 4–6, half 7–9, full 10+), normalised [0,1] scoring
- `feed-ingest/src/tasks/trust-epoch-aggregate.ts` — quarterly full epochs (increment decay, score all subjects) + Mon/Thu mop-ups (small-subject rule: <10 always; threshold gate: ≥5 changes since last run). Dry-run mode (`TRUST_DRY_RUN=1`). Monitoring: profiles recomputed, largest delta, anomaly count
- 42 unit tests (trust-weighting + trust-aggregation)
- Gateway: `GET /trust/:userId` prefers epoch scores from `trust_profiles`, falls back to live vouch counts only pre-first-epoch
- Frontend: `TrustProfile` dimension bars use real epoch scores when available, count-based proxy as fallback
- Vouch upsert resets decay counters (`epochs_since_reaffirm = 0`, `last_reaffirmed_at = now()`) on reaffirmation

Build Phase 5 (graph analysis hardening) — outstanding:
- Sybil detection, diversity weighting, cluster discounting (Layer 3)
- Weak at small scale — meaningful once graph densifies past ~500 attestors

Build Phase 6 (anonymity Phase B) — future, gated on scale:
- Standalone attestation-service (port 3005, separate Docker network, separate DB user)
- Blind-signature registration (RSA, RFC 9474), NIP-44 encrypted attestation submission
- Client-side anonymous Nostr key generation + IndexedDB storage + BIP-39 seed phrase
- Credibility brackets, periodic re-keying, week-long prompt batching with jitter
- private_graph PostgreSQL schema

Build Phase 7 (mobile responsive) — **superseded by `REDESIGN-SCOPE.md`:**
- Single-column responsive view on narrow viewports, not a panel-swipe workspace
- Compose surface on mobile needs its own design pass (see `REDESIGN-SCOPE.md` Q7)

Build Phase 8 (external content rendering) — future, gated on legal review:
- Server-side readability extraction (Mozilla Readability / Mercury Parser)
- Per-user cache with short TTL, exclusion list, robots.txt respect
- DMCA response process needed before shipping
- Link-out fallback card for external content works without readability extraction

Known gaps (identified during earlier build phases, some now resolved by `REDESIGN-SCOPE.md`):
- ~~Transition path from current layout to workspace~~ — dissolved (no workspace to transition to)
- Layer 4 "valued set" includes "pin as sources" (localStorage) and "quote-post approvingly" (undefined signal) — hand-waved
- Layer 1 signals for external authors (follower count, account age) not stored in external_sources/external_items — feed-ingest adapters would need to persist these
- ~~Current nav features not accounted for in spec's three-tab topbar~~ — dissolved (avatar dropdown keeps existing nav)
- ~~Dual rendering for article page (standalone + panel-embedded)~~ — dissolved (articles stay on their own route)

**UI prototype — `provenance-ikb.jsx`**

Design prototype for Traffology piece view with IKB op-art bars. Kept as reference; the production implementation is in `web/src/app/traffology/`.

---

## 5. Missing Table-Stakes UI

Features any user would reasonably expect given the platform's existing capabilities. Neither backend nor frontend exists for these. Audited 2026-04-13.

### Account lifecycle

~~Account deletion / deactivation~~ — **done (v5.30.0):** Migration 049, `POST /auth/deactivate` (reversible) + `POST /auth/delete-account` (cancels subs, soft-deletes articles with kind-5 events, hard-deletes account). DangerZone component on /account page with confirm dialog (deactivate) and type-to-confirm modal (delete).

~~Change email address~~ — **done (v5.30.0):** `POST /auth/change-email` stores pending email + sends verification link, `POST /auth/verify-email-change` swaps email on confirmation. EmailChange component on /account page with inline editing pattern.

~~Change username~~ — **done (v5.30.0):** `POST /auth/change-username` with format validation, availability check, 30-day cooldown, 90-day redirect from old username. `GET /auth/check-username/:username` for debounced availability. UsernameChange component on /profile page replaces read-only display.

### Publication management

~~Publication logo / avatar upload~~ — **done (v5.31.0):** Image upload in PublicationSettingsTab above name field. Reuses profile avatar upload pattern with uploadImage + pubApi.update for logo_blossom_url. Upload/remove controls.

~~Publication layout template picker~~ — **done (v5.31.0):** Migration 050 adds `homepage_layout` column. 3-card picker (blog/magazine/minimal) with wireframe illustrations in PublicationSettingsTab. Saves immediately on click. Gateway updated to include homepage_layout in all publication queries.

~~Publication delete safeguards~~ — **done (v5.31.0):** Danger zone in PublicationSettingsTab with archive (confirm), transfer ownership (EiC modal), and delete (type-to-confirm). Covered by the archive/delete feature above.

~~Leave publication~~ — **done (v5.31.0):** `POST /publications/:id/leave` endpoint (self-remove, non-owner only, notifies managers). "Leave this publication" text link in MembersTab for non-owner members. Confirm dialog, redirects to personal dashboard.

### Reader & subscriber experience

~~Cancel subscription button~~ — **already existed:** SubscriptionsSection had Cancel button with `handleCancel` calling `DELETE /subscriptions/:writerId`. Verified working.

~~Notification preferences~~ — **done (v5.29.0):** Migration 046 (notification_preferences table), GET/PUT endpoints for 7 categories, NotificationPreferences component on /social page with On/Off toggles using FeedDial pattern, saves immediately on click.

~~Publication follow button on pub pages~~ — **done (v5.29.0):** PubFollowButton component with Follow/Following/Unfollow states (hover to reveal Unfollow), auth redirect for logged-out users, wired into publication homepage masthead.

### Writer tools

**Subscriber / follower dashboard metrics** — writers see earnings but have no view of subscriber growth, churn, or follower trends over time. `GET /subscribers` returns the raw list but there's no dashboard visualisation.

~~Note deletion from profile~~ — **already existed:** NoteCard has Delete button with confirm pattern, SocialTab passes `onDeleted` callback. Verified working.

### Social & safety

**Session management** — `POST /auth/logout` invalidates all sessions. There's no way to see active sessions or revoke a specific one (e.g. left logged in on a shared machine).

**Conversation management** — no way to leave, archive, mute, or delete a message conversation.

**Report feedback to reporter** — users can submit reports and admins can resolve them, but the reporter is never notified of the outcome.

### Discovery & distribution

~~RSS discovery links~~ — **done (v5.30.0):** `generateMetadata` with `<link rel="alternate" type="application/rss+xml">` on writer profile and publication homepage. Visible "RSS" text links in writer stats line and pub masthead.

---

## Suggested attack order

### Completed (v5.12.0 session, 2026-04-06)

- ~~Gift link frontend polish~~ — dashboard GiftLinksPanel + ShareButton integration
- ~~Commission social features~~ — commission from DM threads, migration 036
- ~~DM pricing configuration~~ — API endpoints + dashboard settings UI
- ~~JWT lifetime reduction~~ — 2-hour lifetime with 1-hour refresh

### Completed (v5.13.0 session, 2026-04-06)

- ~~Subscription offers system~~ — migration 037, backend routes, dashboard Offers tab, redeem page, offer-aware renewal
- ~~Editor bug fixes~~ — stale closure in auto-save, price auto-suggestion overwrite, grey-card styling refresh

### Completed (v5.14.0 session, 2026-04-06)

- ~~Settings rationalisation~~ — Profile absorbs payment/Stripe/export, Account gains free reads toggle, new Social page (feed dial, blocks/mutes, DM fees), dashboard tab settings→pricing, `/settings` and `/history` replaced with redirects, new block/mute CRUD APIs, nav updated

### Completed (v5.16.0 session, 2026-04-06)

- ~~Inline subscription management on Following/Followers tabs~~ — Following tab (own profile): unfollow button + subscribe/unsubscribe/resubscribe per writer, confirmation modal with period-end date. Followers tab (own profile): "Subscriber" badge. Backend enriched following response with `subscriptionPricePence`/`hasPaywalledArticle`, followers response with `subscriptionStatus` (owner-only).
- ~~Editor hairline cleanup~~ — title + standfirst wrapped in single grey card, toolbar changed to white, inter-field gaps removed
- ~~Missing API client methods~~ — `social.block()` and `social.mute()` POST wrappers added to match backend endpoints

### Completed (v5.18.0–v5.19.0 sessions, 2026-04-06)

- ~~Publications Phases 1–3~~ — schema, core model, key-custody signerType, member management, CMS pipeline, server-side publishing, editor integration, dashboard context switcher, invite page, reader surface (homepage/about/masthead/subscribe/archive/article pages), publication subscriptions/follows, RSS, search, feed integration, article page publication awareness, writer profile filtering.

### Completed (v5.20.0 session, 2026-04-06)

- ~~Publications Phase 5 (revenue)~~ — rate card routes, payroll routes (standing + per-article), publication payout worker, earnings routes, RateCardTab + PayrollTab + PublicationEarningsTab dashboard components, `can_manage_finances` gating throughout

### Completed (v5.29.0 session, 2026-04-13)

- ~~Unpublish personal article~~ — `POST /articles/:id/unpublish` endpoint + dashboard Unpublish button
- ~~Publication follow button~~ — PubFollowButton component on publication homepage masthead
- ~~Notification preferences~~ — migration 046, GET/PUT endpoints, NotificationPreferences on /social page
- ~~Bookmarks~~ — migration 047, full gateway routes, BookmarkButton, /bookmarks page, feed integration
- ~~Tags/topics~~ — migration 048, full gateway routes, TagInput in editor, TagDisplay on cards, /tag/[tag] page

### Completed (v5.30.0 session, 2026-04-13)

- ~~Subscriber list~~ — SubscribersTab with summary stats + table, conditional writer-only dashboard tab
- ~~Account deletion / deactivation~~ — migration 049, deactivate + delete routes, DangerZone component with type-to-confirm modal
- ~~Change email~~ — change-email + verify-email-change routes, EmailChange component on /account
- ~~Change username~~ — change-username + check-username routes, UsernameChange component on /profile with debounced availability + 30-day cooldown
- ~~RSS discovery links~~ — generateMetadata with RSS alternate link + visible RSS links on writer profile and pub homepage

### Completed (v5.31.0 session, 2026-04-13)

- ~~Delete / archive publication~~ — danger zone in pub settings: archive (confirm), transfer ownership (EiC modal), delete (type-to-confirm)
- ~~Transfer publication ownership~~ — modal with eligible EiC member selector
- ~~Edit member role~~ — inline dropdown in MembersTab with Save/Cancel
- ~~Publication logo upload~~ — image upload in pub settings (reuses profile avatar pattern)
- ~~Layout template picker~~ — migration 050, 3-card grid in pub settings (blog/magazine/minimal), saves immediately
- ~~Leave publication~~ — POST /publications/:id/leave endpoint + text link in MembersTab for non-owner members

### Completed (v5.32.0 session, 2026-04-13)

- ~~OG metadata~~ — Open Graph + Twitter Card tags on all public pages: root layout (fallback defaults + metadataBase), homepage, about (split to server component), writer profiles (avatar image, bio description), publication homepage/about/masthead, tag browse (split to server component). Article pages already had OG tags. Fixed publication page snake_case field name for logo URL.

### Completed (v5.33.0 session, 2026-04-13)

- ~~Reading history~~ — ReadingHistory component on /account page with paginated article list (title, writer, date, Free/Paid label)
- ~~Accept/decline commission~~ — `GET /my/commissions` endpoint, CommissionsTab in dashboard (writer-only), Accept + Decline with confirm
- ~~Edit existing drive~~ — inline edit mode on DriveCard (title, description, target amount), uses existing PUT endpoint
- ~~Cancel subscription button~~ — verified already existed in SubscriptionsSection
- ~~Note deletion from profile~~ — verified already existed in NoteCard
- ~~Pin drive to profile~~ — verified already existed in DriveCard

### Completed (v5.34.0 session, 2026-04-13)

- **Page restructure** — `/account` → `/ledger` (financial ledger), `/settings` (email, payment, notifications, export, danger zone), `/library` (bookmarks + reading history tabs), `/network` (following, followers, blocked, muted + feed dial + DM fees). `/profile` slimmed to public identity only. Old URLs redirect to new locations.
- **Dashboard consolidation** — 7 tabs → 4 (Articles, Subscribers, Proposals, Pricing). Drafts merged into Articles tab as unified content list. Commissions + Pledge drives + Offers consolidated into single Proposals tab with filter bar. Backwards-compatible tab aliases for deep-linked URLs.
- **Article scheduling** — migration 051 (`scheduled_at` column on `article_drafts`). Gateway schedule/unschedule endpoints. Background scheduler worker (60s poll, advisory lock, `FOR UPDATE SKIP LOCKED`). Full pipeline: publication articles via `publishToPublication()`, personal articles via key-custody signing + vault encryption for paywalled. Dashboard schedule/reschedule/unschedule actions with datetime picker. Editor "Schedule" button alongside Publish.
- **Editor layout cleanup** — tags and publication selector moved from above editor to below content area.

### Completed (v5.35.0 session, 2026-04-13)

- **Universal Feed Phase 1** — RSS ingestion + universal resolver + external items in feed. Migration 052 (external_sources, external_subscriptions, external_items). New `feed-ingest` Graphile Worker service (poll, RSS fetch, prune, metadata refresh). Universal resolver (`gateway/src/lib/resolver.ts`) with URL/RSS discovery, npub/nprofile, NIP-05, platform username, free-text search. Feed route extended to three-stream merge (articles + notes + external items with daily cap). ExternalCard component with provenance badges. SubscribeInput omnivorous input. `/subscriptions` management page. Publication invite migrated from email-only to resolver-backed. SSRF-hardened HTTP client in shared/. See `UNIVERSAL-FEED-ADR.md` for full spec (Phases 2–5 outstanding).

### Completed (session, 2026-04-15)

- **Gateway decomposition — messages service layer** — `routes/messages.ts` refactored from 693 lines into `routes/messages.ts` (202 lines, thin dispatchers) + `services/messages.ts` (563 lines, business logic). `ServiceResult<T>` discriminated union returns `{ ok, status, error }` so route handlers map errors to HTTP statuses without throws. All 13 DM endpoints covered; `ServiceResult`/`loadConversationMessages`/`sendMessage`/`decryptBatch` types exported for future reuse. Per `GATEWAY-DECOMPOSITION.md`, this is step 2 (service-layer refactor) ahead of step 3 (cross-process extraction) — de-risks the eventual messaging-service cutover. Also extracted feed scorer to feed-ingest Graphile cron (commit `d82833e`).

### Completed (v5.36.0 session, 2026-04-14)

- **Universal Feed Phase 2** — `feed_items` unified timeline table + external Nostr ingestion. Migrations 053–054 (feed_items table + backfill from articles/notes/external_items). Feed route rewritten from three-stream merge to single-table query with LEFT JOINs. Transactional dual-write paths in all article/note/external item creation flows. Feed scorer updated to write `feed_items.score` directly. Article soft-delete and unpublish set `feed_items.deleted_at`. New `feed_ingest_nostr` task for external Nostr relay ingestion (kinds 1, 30023, kind 5 deletions). Poll task routes `nostr_external` sources with relay-hostname rate limiting. `publishToExternalRelays()` helper for outbound Nostr replies. Daily `feed_items_reconcile` (05:00 UTC) and `feed_items_author_refresh` (04:00 UTC) cron jobs. POST /notes accepts optional `signedEvent` for outbound relay publishing. See `UNIVERSAL-FEED-ADR.md` (Phases 3–5 outstanding).

### Completed (2026-04-17)

- **Trust graph Build Phase 1 (Layer 1 enrichment)** — migration 065 (`trust_layer1` table), `trust-layer1-refresh` daily cron in feed-ingest, `GET /api/v1/trust/:userId` gateway endpoint, trust pip (5px circle, three-state: known/partial/unknown) on ArticleCard, NoteCard, ExternalCard. `PipStatus` type in `ndk.ts`, `.trust-pip` CSS class. `pipStatus` flows through feed API → FeedView mapping → card components. NIP-05 verification stubbed (no table yet). See `ALLHAUS-OMNIBUS.md` Build Phase 1.
- **Trust graph Build Phase 2 (vouching CRUD)** — migration 066 (`vouches` + `trust_profiles` tables with CHECK constraints). Gateway: `POST /vouches` (upsert per attestor/subject/dimension), `DELETE /vouches/:id` (soft-delete withdrawal), `GET /my/vouches` (own vouch list), `GET /trust/:userId` extended with Layer 2 dimension scores, public endorsements with attestor profiles, Layer 4 relational data (viewer's network intersection), viewer's existing vouches. Frontend: `TrustProfile` component (dimension bars, endorsements, "your network says"), `VouchModal` (dimension checkboxes, visibility radio, aggregate disclaimer), vouch button on writer profile action bar, `VouchList` on `/network?tab=vouches` with withdrawal. See `ALLHAUS-OMNIBUS.md` Build Phase 2.
- **Trust graph Build Phase 4 (epoch aggregation and decay)** — migration 067 (`trust_epochs` + vouch decay columns). Pure library functions: attestor weighting (Phase A formula), aggregation (freshness, decay, scoring). Cron task: quarterly full epochs + Mon/Thu mop-ups with small-subject rule and threshold gate. Dry-run mode. 42 unit tests. Gateway prefers epoch scores; frontend dimension bars use real scores. See `ALLHAUS-OMNIBUS.md` §II.8 + Build Phase 4.

### Completed (2026-04-17, redesign steps 1–3)

- **Redesign Step 1 (the swap)** — Nav reduced from `Feed | Write | Dashboard | Network` to `Feed | Dashboard`. `COMPOSE ⌘K` button added to topbar (text on desktop, ∀ mark on mobile). Global `⌘K`/`Ctrl+K` hotkey opens compose overlay. Canvas mode ∀ mark changed from white to crimson. Sticky NoteComposer in FeedView replaced with sticky SubscribeInput (transparent bg, slab-rule border, shorter placeholder). See `ALLHAUS-REDESIGN-SPEC.md` §1–2.
- **Redesign Step 2 (compose overlay, note mode)** — New `ComposeOverlay` component mounted globally in layout. Three-zone slab: top zone (mode label or reply preview), editing zone (auto-grow textarea, Jost 16px), controls zone (image upload, cross-post pills per linked account, character counter, Post button). Reply mode with pinned quote preview. Double-escape dismiss with confirmation. Mobile full-screen sheet variant. Zustand store (`stores/compose.ts`) coordinates overlay state. QuoteSelector and WriterActivity updated to use overlay instead of inline NoteComposer modals. See `ALLHAUS-REDESIGN-SPEC.md` §3.
- **Redesign Step 3 (card chassis refactor)** — All three feed card types unified around shared visual grammar: 4px left bar (black for native, crimson for paid, grey-300 for external), mono-caps 11px byline row (TrustPip · Author · Timestamp), mono-caps action row. NoteCard: avatar removed, byline changed from sans 14px to mono-caps 11px, left bar added, Reply routes through overlay. ExternalCard: avatar removed, byline unified, provenance badge moved into byline row (grey-400, was crimson), inline ExternalReplyComposer removed, Reply routes through overlay. ArticleCard: bar narrowed 6px→4px, padding 28px→24px, Reply button added. Feed vertical rhythm unified to 40px gap via `space-y-[40px]`. See `ALLHAUS-REDESIGN-SPEC.md` §4.

### Later: strategic work

5. ~~OG metadata~~ — **done (v5.32.0):** Open Graph + Twitter Card tags on all public pages (root layout defaults, homepage, about, writer profiles, publication homepage/about/masthead, tag browse). Article pages already had OG tags.
6. **Owner dashboard** — entirely unbuilt, see `OWNER-DASHBOARD-SPEC.md`
7. Subscription Phase 2 — free trials, gift subs, welcome email, import/export, analytics, custom landing page (see `SUBSCRIPTIONS-GAP-ANALYSIS.md`)
8. Currency strategy — see `platform-pub-currency-strategy.md`
9. Reposts (needs feed algorithm to be meaningful)
10. Bucket system — see `platform-bucket-system-design.md`
11. Publications Phase 4 (theming/custom domains) — see `PUBLICATIONS-SPEC.md` §10 Phase 4
12. CI/CD + backend linting — see `CODE-QUALITY.md`
13. Audit report remaining items — see `AUDIT-REPORT.md`

### Completed (v5.28.0 session, 2026-04-12)

- ~~Writer analytics~~ — Traffology Phase 1: page tracking, ingest service, aggregation pipeline, source resolution, observation engine, feed UI, piece detail, overview
- ~~Stripe idempotency keys~~ — all mutating Stripe calls (paymentIntents.create, transfers.create) now include idempotencyKey
- ~~Webhook event deduplication~~ — stripe_webhook_events table prevents reprocessing
- ~~oEmbed fetch timeout~~ — 5-second AbortSignal.timeout added
- ~~Template HTML escaping~~ — all Traffology template values escaped
- ~~Key service pubkey validation~~ — 64-char hex format check
- ~~subscription_events FK fix~~ — ON DELETE CASCADE added via migration 041
- ~~schema.sql sync~~ — all ON DELETE clauses from migrations 018/021/041 applied

### Infrastructure (fit in as time allows)

- CI/CD pipeline
- Standardise gateway error response shapes — 222 error responses across 24 route files use 4 different shapes (`{ error: string }`, `{ error: { code, message } }`, `{ error: ZodFlattenedError }`, `{ error: string, message: string }`). `gateway/src/lib/errors.ts` has an unused `sendError` helper ready to adopt. Mechanical refactor, no runtime bugs.
- TypeScript strictness (eliminate remaining ~23 `any` instances)
- Accessibility pass
- TypeScript target alignment
- **Session invalidation on logout** — JWTs remain valid for 30 days after logout (cookie is cleared client-side, but the token itself works until natural expiry). Requires a server-side token blacklist table checked in `requireAuth`, or migrating to shorter-lived tokens with a refresh token pattern. Flagged in v5.28.0 audit.
- **CSP nonce middleware** — `nginx.conf` CSP uses `'unsafe-inline'` for `script-src`, which undermines XSS protection. Removing it requires Next.js middleware to generate per-request nonces and inject them into both the CSP header and inline `<script>` tags. Needs careful testing to avoid breaking hydration. Flagged in v5.28.0 audit.
