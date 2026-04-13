# Feature Debt & Plan of Attack

Consolidated from planning documents, verified against the codebase as of 2026-04-13. Completed specs live in `planning-archive/`. Documents left in the project root describe work that is still outstanding — each is referenced in the relevant section below.

Last audited: 2026-04-13. Items marked DONE were verified against the codebase in that audit.
Last worked: 2026-04-13 (v5.29.0 session). Completed: UI Design Spec Batch 1 — unpublish article, publication follow button, notification preferences, bookmarks (full stack), tags/topics (full stack). Next up: Batch 2 (subscriber list, account deletion, change email/username, RSS discovery).

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

**Delete / archive publication** — `DELETE /publications/:id` archives a publication (owner only). No delete button in PublicationSettingsTab or anywhere else. Needs confirmation dialog with safeguards for content, members, and subscribers.

**Transfer publication ownership** — `POST /publications/:id/transfer-ownership` exists, API client wired. No UI to invoke it. Needs a settings panel with member selector and confirmation flow.

**Reading history page** — `GET /my/reading-history` returns deduplicated previously-read articles. API client exists (`api.readingHistory.list`). No page or component renders it.

**Subscriber list for writers** — `GET /subscribers` returns a writer's paying subscribers. No subscribers tab in dashboard — writers cannot see who subscribes to them.

**Edit publication member role** — `PATCH /publications/:id/members/:memberId` updates role and permissions. MembersTab shows invite and remove, but no way to change an existing member's role.

**Accept / decline commission** — `POST /drives/:id/accept` and `POST /drives/:id/decline` let the target writer respond to a commission drive. No UI for this — commission requests land in notifications but the writer has no accept/decline controls.

**Pin drive to profile** — `POST /drives/:id/pin` toggles a drive's visibility on the writer's public profile. API client exists, no pin toggle in DrivesTab or profile.

**Edit existing drive** — `PUT /drives/:id` updates a live pledge drive. DrivesTab has a create form but no edit form for existing drives.

**Admin direct suspend** — `POST /admin/suspend/:accountId` suspends an account outside the report flow. Admin reports page has resolve/reject, but no standalone suspend action.

~~Unpublish personal article~~ — **done (v5.29.0):** `POST /articles/:id/unpublish` endpoint + Unpublish button in personal Articles tab with confirm dialog and inline "Moved to drafts" message.

### Previously outstanding — now done

~~Subscription offers system~~ — **done (v5.13.0):** migration 037 creates `subscription_offers` table with `code`/`grant` modes. `POST /subscriptions/:writerId` accepts optional `offerCode`, validates and applies discount. `offer_id` and `offer_periods_remaining` tracked on subscriptions; renewal job decrements and reverts to standard price when offer period elapses. Dashboard Offers tab with create/list/revoke. Public redeem page at `/subscribe/:code`.

~~Gift link frontend~~ — **done:** dashboard GiftLinksPanel (create/list/revoke per article in Articles tab) + "Gift link" option in ShareButton dropdown.

~~DM pricing / anti-spam settings~~ — **done:** GET/PUT `/settings/dm-pricing` + per-user override endpoints. Moved from dashboard settings tab to `/social` page (v5.14.0 settings rationalisation).

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

**Feed algorithm Phase 1** — fully implemented. Migration 035 (`feed_scores` table), background scoring worker (`feed-scorer.ts`), `GET /feed` with `reach` parameter (following/explore), UI reach selector in `FeedView.tsx`. Spec archived: `planning-archive/FEED-ALGORITHM.md`.

**Resilience & performance** — complete. Article/profile pages are Server Components, fonts self-hosted, NDK removed from client bundle, shared Avatar component, print stylesheet, error boundaries. Spec archived: `planning-archive/RESILIENCE.md`.

**Settings rationalisation** — done (v5.14.0). Four hubs: Profile, Account, Social, Pricing. `/settings` and `/history` replaced with redirects. Spec archived: `planning-archive/SETTINGS-RATIONALISATION.md`.

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
- #1: Open Graph / social sharing metadata (no OG tags on article pages — critical for growth)
- #2: Email / newsletter delivery (no email-on-publish — critical for writer retention)
- #3: Landing page (minimal — no social proof, no screenshots, no tab model explanation)
- #5: Publication homepage templates (wireframe-quality, no visual customisation)
- #6: Writer onboarding flow (no post-signup wizard)
- #7: CSP header blocking external images
- #8: Import tooling (no Substack/Ghost/WordPress import)
- #9: Frontend test coverage (zero tests in web/)
- #10: Dashboard architecture (single ~530-line component)
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

**UI prototype — `provenance-ikb.jsx`**

Design prototype for Traffology piece view with IKB op-art bars. Kept as reference; the production implementation is in `web/src/app/traffology/`.

---

## 5. Missing Table-Stakes UI

Features any user would reasonably expect given the platform's existing capabilities. Neither backend nor frontend exists for these. Audited 2026-04-13.

### Account lifecycle

**Account deletion / deactivation** — no way to close an account. Requires: Stripe cleanup (cancel subs, settle tab), Nostr event tombstoning (kind 5 for all authored events), content orphaning policy (delete vs. anonymise), confirmation flow with re-auth. GDPR relevance if the platform ever has EU users.

**Change email address** — profile page edits display name and bio, but email is immutable after signup. Requires: verification flow (send link to new email, confirm), update across sessions, re-auth gate.

**Change username** — username is read-only on the profile page. Requires: uniqueness check, URL redirect from old username, cooldown period to prevent abuse, Nostr profile event update.

### Publication management

**Publication logo / avatar upload** — publications have a `logo_url` column (rendered on masthead, invite page, pub nav), but PublicationSettingsTab has no image upload — only name, tagline, and about.

**Publication layout template picker** — pub homepage renders three templates (blog, magazine, minimal) but there's no settings UI to choose between them. The `layout_template` column exists but is never set from the frontend.

**Publication delete safeguards** — even once the archive button exists (section 2), there's no flow for what happens to content, members, and subscribers. Needs: archive vs. hard-delete choice, content migration/export, subscriber notification, grace period.

**Leave publication** — a member can be removed by the owner, but there's no "leave" button for a member to voluntarily exit a publication they belong to.

### Reader & subscriber experience

**Cancel subscription button** — `DELETE /subscriptions/:writerId` exists on the backend and `SubscriptionsSection` lists active subs, but there's no cancel button rendered in the list.

~~Notification preferences~~ — **done (v5.29.0):** Migration 046 (notification_preferences table), GET/PUT endpoints for 7 categories, NotificationPreferences component on /social page with On/Off toggles using FeedDial pattern, saves immediately on click.

~~Publication follow button on pub pages~~ — **done (v5.29.0):** PubFollowButton component with Follow/Following/Unfollow states (hover to reveal Unfollow), auth redirect for logged-out users, wired into publication homepage masthead.

### Writer tools

**Subscriber / follower dashboard metrics** — writers see earnings but have no view of subscriber growth, churn, or follower trends over time. `GET /subscribers` returns the raw list but there's no dashboard visualisation.

**Note deletion from profile** — `DELETE /notes/:nostrEventId` works on the backend, but the WriterActivity Notes tab has no delete action on individual notes.

### Social & safety

**Session management** — `POST /auth/logout` invalidates all sessions. There's no way to see active sessions or revoke a specific one (e.g. left logged in on a shared machine).

**Conversation management** — no way to leave, archive, mute, or delete a message conversation.

**Report feedback to reporter** — users can submit reports and admins can resolve them, but the reporter is never notified of the outcome.

### Discovery & distribution

**RSS discovery links** — three RSS endpoints exist (`/rss/:username`, `/api/v1/pub/:slug/rss`, `/rss`) but there are no visible RSS icons or `<link rel="alternate">` tags on any profile or publication page.

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

### Next up

1. **Subscriber list for writers** — new Subscribers dashboard tab with summary stats and table
2. **Account deletion / deactivation** — regulatory necessity, Stripe cleanup, Nostr tombstoning
3. **Change email address** — verification flow with magic link to new email
4. **Change username** — availability check, old URL redirect, cooldown
5. **RSS discovery links** — visible links + `<link rel="alternate">` tags on profile/pub pages

### Later: strategic work

5. **OG metadata** — article pages need Open Graph tags for social sharing (see `all-haus-frontend-audit.md` #1)
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
