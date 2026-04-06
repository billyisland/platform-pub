# Feature Debt & Plan of Attack

Consolidated from 19 planning documents, verified against the codebase as of 2026-04-06. The archived specs live in `planning-archive/`. Documents left in the project root are strategic specs that are still entirely ahead of us.

---

## How this is organised

1. **Bugs & fixes** — things that are broken or dangerous right now
2. **Incomplete features** — half-built work from executed specs
3. **New features** — unbuilt features from executed specs, ready to build
4. **Strategic initiatives** — large-scope work with its own spec document still in the project root

---

## 1. Bugs & Fixes

### High priority

**DM sender visibility** — Senders can't see their own sent messages. The GET query filters by `recipient_id` only; it should include `sender_id` too.
`gateway/src/routes/messages.ts` — change WHERE clause to include `OR dm.sender_id = $2`.
*(Source: FIXES.md #7)*

**`requireAdmin` missing return** — After `reply.status(403).send(...)`, execution falls through to the route handler.
`gateway/src/routes/moderation.ts:37` — add `return` before `reply.status(403)`.
*(Source: FIXES.md #10)*

**Auth middleware ignores account status** — `requireAuth` verifies the JWT but never checks `accounts.status`. Suspended users keep full API access for the JWT lifetime (7 days).
`gateway/src/middleware/auth.ts` — after `verifySession()`, query `accounts.status` and reject non-active accounts with 403.
*(Source: FIXES.md #5)*

**Rate limiting** — No rate limiting on any public endpoint (login, signup, search, gate-pass, voting, DMs).
Install `@fastify/rate-limit` in gateway and register globally with per-route overrides.
*(Source: FIXES.md #9)*

**Security headers missing** — HSTS, X-Frame-Options, CSP, Referrer-Policy, Permissions-Policy not set in nginx.
`nginx.conf` — add the full set of security headers to the HTTPS server block.
*(Source: FIXES.md #8)*

**Non-root Docker containers** — All containers run as root.
Add `RUN addgroup -S app && adduser -S app -G app` + `USER app` to each Dockerfile.
*(Source: FIXES.md #11)*

**Remove internal service port bindings** — payment-service, key-service, key-custody, blossom are bound to 127.0.0.1 in docker-compose. Any host process can bypass gateway auth.
Remove `ports:` from these four services.
*(Source: FIXES.md #12)*

### Medium priority

**`renderMarkdownSync` XSS** — Regex-based markdown renderer has no sanitization. `[click](javascript:alert(1))` produces XSS.
`web/src/lib/markdown.ts` — add URL protocol allowlist or migrate callers to async `renderMarkdown`.
*(Source: FIXES.md #14)*

**LIKE metacharacters unescaped in search** — Searching `%` matches all articles.
`gateway/src/routes/search.ts` — escape `%`, `_`, `\` before wrapping with `%`.
*(Source: FIXES.md #15)*

**Config cache never invalidated** — `AccrualService` caches platform config forever.
`payment-service/src/services/accrual.ts` — add a TTL or call `invalidateConfig()` from admin config update.
*(Source: FIXES.md #17)*

**Notification type mismatch** — Frontend only lists 5 notification types; backend creates 12+. Unknown types are silently dropped.
`web/src/lib/api.ts` — update the Notification type union and add a fallback renderer.
*(Source: FIXES.md #18)*

**Drive update truthiness bug** — `if (data.fundingTargetPence)` skips zero values.
`gateway/src/routes/drives.ts:225-227` — change to `!== undefined`.
*(Source: FIXES.md #19)*

**Auth hydration race** — Protected routes render before `fetchMe()` resolves.
`web/src/components/layout/AuthProvider.tsx` — add a loading guard.
*(Source: FIXES.md #21)*

**No upper bound on article price** — `pricePence: z.number().int().min(0)` has no `.max()`.
`gateway/src/routes/articles.ts` — add `.max(999999)`.
*(Source: FIXES-REMAINING.md #2)*

**Missing NODE_ENV=production** in `web/Dockerfile`, `payment-service/Dockerfile`, `key-service/Dockerfile`.
*(Source: FIXES-REMAINING.md #4)*

**Missing .dockerignore** — every build sends `node_modules`, `.git`, `.next` as context.
*(Source: FIXES-REMAINING.md #5)*

**Docker health checks** — Only postgres and strfry have them; 7 services have none.
Add healthcheck blocks + `/health` endpoints where needed.
*(Source: FIXES.md #20)*

**Missing ON DELETE clauses** — FKs in migrations 016-017 default to NO ACTION.
Write a migration adding appropriate CASCADE/SET NULL.
*(Source: FIXES.md #22)*

### Low priority

**33 instances of `any` across the frontend** — replace incrementally, starting with api.ts and composable types.
*(Source: FIXES-REMAINING.md #10)*

**No CI/CD** — add lint + typecheck + test on PR, build validation on merge.
*(Source: FIXES-REMAINING.md #15)*

**Session storage not cleared on logout** — `unlocked:*` keys persist across users on shared devices.
*(Source: FIXES-REMAINING.md #16)*

**Dependency version conflicts** — pg (8.20.0 vs 8.11.0), dotenv (17.3.1 vs 16.4.0) across services.
*(Source: FIXES-REMAINING.md #6)*

**TypeScript target mismatch** — web uses ES2017, backend uses ES2022.
*(Source: FIXES-REMAINING.md #12)*

**Accessibility gaps** — vote buttons lack aria-labels, paywall indicator is colour-only, dropdowns lack keyboard nav.
*(Source: FIXES-REMAINING.md #13)*

**Reduce JWT session lifetime** — 7-day JWT is long for a payment platform. Consider 1-2 hours with refresh-on-use.
*(Source: FIXES.md #28)*

---

## 2. Incomplete Features

These are features where the backend or spec work is done but the frontend or integration is missing.

### Free pass management UI

Backend exists (3 endpoints). No writer-facing UI to grant, view, or revoke free passes on their articles.
Build: inline panel in dashboard Articles tab per-article overflow menu, plus a "Gift" action on own articles in reader view.
*(Source: FRONTEND-GAPS.md #3, UI-DECISIONS-2026-04-03.md #10)*

### Gift links (capped shareable URLs)

Schema and migration exist (029_gift_links). Backend endpoints exist. No frontend for creating or managing gift links.
Build: "Create gift link" in article Share dropdown (author only), redemption limit modal, dashboard list with stats.
*(Source: UI-DECISIONS-2026-04-03.md #11)*

### Subscription price in settings page

The dashboard Settings tab has it, but `/settings` page doesn't mention subscriptions at all. Writers could miss it.
Consider: either add a link from settings to dashboard pricing, or note this is by design (dashboard is the writer's control room).

### Reader subscription management page

`GET /subscriptions/mine` works. The Account page may show subscriptions, but there's no dedicated "my subscriptions" surface. The Account page's SubscriptionsSection should cover this — verify it's wired up and shows cancel controls.

### DM pricing / anti-spam settings

Schema (`dm_pricing`) and enforcement logic exist. No API endpoint to configure it and no frontend settings. Currently DM pricing is a future feature with no user-facing way to set it.
*(Source: FRONTEND-GAPS.md #10)*

### Reader tab overview

`GET /my/tab` exists. The Account page's BalanceHeader should show free allowance remaining — verify it's wired up.

### Export modal polish

ExportModal exists and is in both desktop and mobile nav. Remaining issues from EXPORT-FIX.md:
- Modal may lock after first download (single `done` boolean)
- No writer guard on the backend export endpoint
- Poor error feedback (generic alert)

### Commission visibility and social features

Backend for commissions exists (drives with `origin = 'commission'`). The UI-DECISIONS spec called for:
- Commission button on author profiles (schema column `show_commission_button` exists)
- Commission from conversation threads
- Commission cards as quotable social objects in feeds
- Pledge button on ProfileDriveCard
None of the social/profile commission UI is built yet. The dashboard drives tab handles basic CRUD.
*(Source: UI-DECISIONS-2026-04-03.md #12)*

---

## 3. New Features (unbuilt, from executed specs)

### Bookmarks / save for later

No implementation exists. Requires: migration (bookmarks table), gateway routes (toggle, list, batch check), BookmarkButton component, /bookmarks page, feed integration.
*(Source: FEATURES.md feature 5)*

### Hashtags / topics / tags

No implementation exists. Requires: migration (article_tags table), editor tag input, gateway tag routes, tag browse page (/tag/:tag), tag display on cards and articles.
*(Source: FEATURES.md feature 6)*

### Writer analytics

No implementation exists. Requires: gateway analytics endpoint joining read_events, vote_tallies, comments, and revenue; dashboard Analytics tab with a sortable table.
*(Source: FEATURES.md feature 7)*

### Reposts / reshares

No implementation exists. Requires: migration (reposts table), gateway routes, Nostr kind 6 event publishing, RepostButton component, feed integration with "Reposted by" labels.
*(Source: FEATURES.md feature 8)*

### Email-on-publish

No implementation exists. Requires: migration (email_on_new_article boolean on accounts), send logic in article publish flow, email template, settings toggle.
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

## 4. Strategic Initiatives (spec documents still in project root)

These are substantial pieces of work with their own spec documents. They haven't been started.

### Feed algorithm — `FEED-ALGORITHM.md`

A graduated feed system with four reach modes (following, following+, extended, explore). Requires a `feed_scores` table, a background scoring worker, a new `GET /api/feed` endpoint with `reach` parameter, and a UI reach selector. Phase 1 is `following` (already built) + `explore`. The existing "For You" feed is placeholder; this would make it real.

### Resilience & performance — `RESILIENCE.md`

Making canvas-mode pages (article reader, writer profiles) server-rendered HTML that works without JavaScript. Major items: convert article/profile pages to Server Components, reduce to one custom font (Literata) + system fonts, remove NDK from client bundle, add print stylesheet, image discipline with shared Avatar component. Prep work is done (editor lazy-loaded, API calls centralised, error boundaries added, shared formatting utilities extracted).

### Settings rationalisation — `SETTINGS-RATIONALISATION.md`

Replace the current overlapping settings surfaces with four clearly scoped hubs: Profile ("who am I"), Account ("what have I spent"), Social ("how do I experience others" — new page with feed dial, blocks/mutes list, DM fee settings), and Pricing (dashboard tab rename from "settings"). Would delete `/settings` and `/history` pages.

### Bucket categorisation system — `platform-bucket-system-design.md`

A generic system for user-defined, non-overlapping categories with behavioural rules. Would unify DM policy, feed curation, publication roles, comment moderation, notification routing, and reader tiers under one reusable component. Conceptual — no implementation plan yet.

### Currency strategy — `platform-pub-currency-strategy.md`

Multi-currency support. Option 2 (launch with GBP, display-only conversion) is recommended. Requires: `display_currency` on accounts, exchange rate endpoint, frontend display conversion with `≈` prefix, settings dropdown. Option 3 (GBP/USD/EUR settlement currencies) is a post-launch upgrade.

---

## Suggested attack order

### Now: fix what's broken

1. DM sender visibility (one-line WHERE clause fix)
2. `requireAdmin` missing return (one line)
3. Rate limiting (install + register)
4. Security headers (nginx config)
5. XSS in renderMarkdownSync
6. LIKE metacharacter escaping
7. Article price upper bound
8. Auth hydration race

### Next: complete half-built work

8. Free pass management UI (dashboard + reader view)
9. Gift link frontend (share dropdown + dashboard)
10. Export modal polish (done state, error handling)
11. Commission profile/social UI

### Then: build missing features by impact

12. Writer analytics (writers need numbers to stay)
13. Email-on-publish (inbox is the feed — critical for retention)
14. Tags/topics (discoverability)
15. Bookmarks (reader engagement)
16. Feed algorithm Phase 1 — see `FEED-ALGORITHM.md`

### Later: strategic work

17. Subscription Phase 2 (free trials, gifts, import/export)
18. Resilience/SSR — see `RESILIENCE.md`
19. Settings rationalisation — see `SETTINGS-RATIONALISATION.md`
20. Currency strategy — see `platform-pub-currency-strategy.md`
21. Reposts (needs feed algorithm to be meaningful)
22. Bucket system — see `platform-bucket-system-design.md`

### Infrastructure (fit in as time allows)

- Docker: non-root users, .dockerignore, NODE_ENV, health checks, remove internal port bindings
- CI/CD pipeline
- Dependency version alignment
- TypeScript strictness (eliminate `any`)
- Accessibility pass
- JWT lifetime reduction
