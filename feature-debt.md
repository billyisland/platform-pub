# Feature Debt & Plan of Attack

Consolidated from 19 planning documents, verified against the codebase as of 2026-04-06. The archived specs live in `planning-archive/`. Documents left in the project root are strategic specs that are still entirely ahead of us.

Last audited: 2026-04-06. Items marked DONE were verified against the codebase in that audit.
Last worked: 2026-04-06 (v5.20.0 session). Completed: Publications Phase 5 (revenue — rate card routes, payroll routes with standing shares and per-article overrides, publication payout worker integrated into daily cycle, earnings dashboard, three new dashboard tabs: RateCardTab, PayrollTab, PublicationEarningsTab). Next up: Writer analytics or email-on-publish.

---

## How this is organised

1. **Bugs & fixes** — things that are broken or dangerous right now
2. **Incomplete features** — half-built work from executed specs
3. **New features** — unbuilt features from executed specs, ready to build
4. **Strategic initiatives** — large-scope work with its own spec document still in the project root

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

### Still outstanding

~~Subscription offers system~~ — **done (v5.13.0):** migration 037 creates `subscription_offers` table with `code`/`grant` modes. `POST /subscriptions/:writerId` accepts optional `offerCode`, validates and applies discount. `offer_id` and `offer_periods_remaining` tracked on subscriptions; renewal job decrements and reverts to standard price when offer period elapses. Dashboard Offers tab with create/list/revoke. Public redeem page at `/subscribe/:code`.

~~Gift link frontend~~ — **done:** dashboard GiftLinksPanel (create/list/revoke per article in Articles tab) + "Gift link" option in ShareButton dropdown.

~~DM pricing / anti-spam settings~~ — **done:** GET/PUT `/settings/dm-pricing` + per-user override endpoints. Moved from dashboard settings tab to `/social` page (v5.14.0 settings rationalisation).

~~Commission social features~~ — **done:** Commission button in DM thread header opens CommissionForm modal. Migration 036 adds `parent_conversation_id` to `pledge_drives`. Backend and API client pass conversation context through.

---

## 3. New Features (unbuilt, from executed specs)

All items below are entirely unbuilt — no migrations, routes, or components found.

### Bookmarks / save for later

Requires: migration (bookmarks table), gateway routes (toggle, list, batch check), BookmarkButton component, /bookmarks page, feed integration.
*(Source: FEATURES.md feature 5)*

### Hashtags / topics / tags

Requires: migration (article_tags table), editor tag input, gateway tag routes, tag browse page (/tag/:tag), tag display on cards and articles.
*(Source: FEATURES.md feature 6)*

### Writer analytics

Requires: gateway analytics endpoint joining read_events, vote_tallies, comments, and revenue; dashboard Analytics tab with a sortable table.
*(Source: FEATURES.md feature 7)*

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

**Feed algorithm Phase 1** — fully implemented. Migration 035 (`feed_scores` table), background scoring worker (`feed-scorer.ts`), `GET /feed` with `reach` parameter (following/explore), UI reach selector in `FeedView.tsx`.

**Resilience & performance** — substantially done. Article/profile pages are Server Components, NDK removed from client bundle, print stylesheet exists, shared Avatar component exists.

### Still outstanding

~~Settings rationalisation — `SETTINGS-RATIONALISATION.md`~~ — **done (v5.14.0):** Four hubs implemented: Profile (identity + payment + export), Account (ledger with free reads toggle), Social (new page: feed dial, blocks/mutes lists, DM fees), Pricing (dashboard tab renamed). `/settings` and `/history` replaced with redirects. New backend block/mute CRUD routes. Nav updated.

**Bucket categorisation system — `platform-bucket-system-design.md`**

A generic system for user-defined, non-overlapping categories with behavioural rules. Conceptual — no implementation plan yet. Not discussed yet.

**Currency strategy — `platform-pub-currency-strategy.md`**

Multi-currency support. Option 2 (launch with GBP, display-only conversion) is recommended. Not discussed yet.

**Publications — `PUBLICATIONS-SPEC.md`**

Multi-writer federated publications with shared identity, editorial pipeline, and revenue pooling.

**Phases 1–3 DONE (v5.18.0–v5.19.0):**
- Phase 1: Schema (migration 038), key-custody signerType, publication auth middleware, CRUD routes, member management, access check extension, API client namespace.
- Phase 2: Server-side publishing pipeline, CMS routes (submit/list/edit/delete/publish/unpublish), signing route publication support, draft association, editor publication selector + cross-post checkbox, dashboard context switcher + publication tabs (Articles, Members, Settings), invite acceptance page.
- Phase 3: Public reader routes (profile, articles, masthead), publication subscriptions + follows, RSS feed, search integration, feed integration (following + scoring), publication reader pages (homepage with blog/magazine/minimal layouts, about, masthead, subscribe, archive, article-under-publication), article page publication awareness ("By Author in Publication" byline), writer profile publication filtering.

**Phase 4 DEFERRED (theming and custom domains):**
- Wildcard subdomain routing (nginx `*.all.haus` + Next.js middleware rewrite)
- Custom domain DNS TXT verification flow + TLS provisioning (lua-resty-auto-ssl or Caddy)
- Theme settings UI (colour picker, font selector, layout mode switcher)
- Custom CSS editor with live preview + server-side sanitiser (`scopeCSS`)
- Per-publication favicon from logo

**Phase 5 DONE (v5.20.0):**
- Rate card routes (GET/PATCH `/publications/:id/rate-card`) — subscription pricing, annual discount, default article price; `can_manage_finances` gated
- Payroll routes (GET/PATCH `/publications/:id/payroll`, PATCH `.../article/:articleId`) — standing revenue shares with 10,000 bps cap, per-article overrides (revenue % or flat fee), upsert semantics
- Publication payout worker — `runPublicationPayoutCycle()` in PayoutService, called after individual writer cycle; handles flat fees first, then article revenue shares, then standing shares; Stripe Connect transfers; pending status for members without KYC
- Earnings routes (GET `/publications/:id/earnings`) — summary totals (gross/net/pending/paid), per-article breakdown, payout history with splits; uses config-loaded platform fee
- Revenue UI tabs: `RateCardTab.tsx` (pricing form), `PayrollTab.tsx` (standing share editor with visual bar + per-article overrides table), `PublicationEarningsTab.tsx` (summary cards, article revenue table, payout history); tabs gated on `can_manage_finances` in dashboard

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

### Next up

1. **Writer analytics** — writers need numbers to stay. Gateway endpoint joining read_events, votes, comments, revenue; dashboard Analytics tab.
2. **Email-on-publish** — inbox is the feed, critical for retention. Migration + send logic + settings toggle.
3. **Tags/topics** — discoverability. Migration, editor input, browse page, card display.
4. **Bookmarks** — reader engagement. Migration, routes, button, /bookmarks page.

### Later: strategic work

6. Subscription Phase 2 — now partially covered by offers system; remaining: welcome email, subscriber import/export, subscriber analytics, custom subscribe landing page
7. Currency strategy — see `platform-pub-currency-strategy.md`
8. Reposts (needs feed algorithm to be meaningful)
9. Bucket system — see `platform-bucket-system-design.md`
10. Publications Phase 4 (theming/custom domains) — see `PUBLICATIONS-SPEC.md` §10 Phase 4

### Infrastructure (fit in as time allows)

- CI/CD pipeline
- Standardise gateway error response shapes — 222 error responses across 24 route files use 4 different shapes (`{ error: string }`, `{ error: { code, message } }`, `{ error: ZodFlattenedError }`, `{ error: string, message: string }`). `gateway/src/lib/errors.ts` has an unused `sendError` helper ready to adopt. Mechanical refactor, no runtime bugs.
- TypeScript strictness (eliminate remaining ~23 `any` instances)
- Accessibility pass
- TypeScript target alignment
