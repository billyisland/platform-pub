# Feature Debt & Plan of Attack

Consolidated from 19 planning documents, verified against the codebase as of 2026-04-06. The archived specs live in `planning-archive/`. Documents left in the project root are strategic specs that are still entirely ahead of us.

Last audited: 2026-04-06. Items marked DONE were verified against the codebase in that audit.
Last worked: 2026-04-06 (v5.12.0 session). Completed: gift link polish, DM commissions, DM pricing config, JWT hardening. Next up: subscription offers system (#3 in attack order).

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

**~23 instances of `any` across the frontend** — down from 33. Replace incrementally, starting with api.ts and composable types.
*(Source: FIXES-REMAINING.md #10)*

**No CI/CD** — no `.github/` directory exists. Add lint + typecheck + test on PR, build validation on merge.
*(Source: FIXES-REMAINING.md #15)*

**TypeScript target mismatch** — web uses ES2017, backend uses ES2022. Not discussed yet.
*(Source: FIXES-REMAINING.md #12)*

**Accessibility gaps** — vote buttons lack aria-labels, paywall indicator is colour-only, dropdowns lack keyboard nav. Not discussed yet.
*(Source: FIXES-REMAINING.md #13)*

~~Reduce JWT session lifetime~~ — **fixed:** reduced from 7 days to 2 hours with 1-hour refresh-on-use half-life. Active users stay logged in; idle sessions expire in 2 hours.

---

## 2. Incomplete Features

### DONE — verified complete in codebase audit 2026-04-06

- ~~Reader subscription management~~ — `SubscriptionsSection.tsx` with cancel controls, fully wired into account page
- ~~Reader tab overview~~ — `BalanceHeader.tsx` shows free allowance remaining, fully wired
- ~~Export modal polish~~ — uses `Set<ExportType>` (not single boolean), writer guard on backend, per-type error messages
- ~~Subscription price in settings~~ — by design: dashboard is the writer control room, `/settings` is reader-focused

### Still outstanding

**Subscription offers system** — Replaces the original "free pass" concept. Decided 2026-04-06: article unlocks are permanent by nature and gift links already cover sharing individual articles, so the actual gap is flexible subscription pricing offers. Design: a single `subscription_offers` table with two modes — `code` (shareable link, anyone redeems) and `grant` (assigned to a specific reader). Fields: `writer_id`, `label`, `mode`, `discount_pct` (0–100), `duration_months` (null = permanent), `code` (unique slug for code mode), `recipient_id` (for grant mode), `max_redemptions`, `redemption_count`, `expires_at`. Covers all cases: discounted first month for everyone, free/cheap subs gifted to specific readers, permanent comp subs. Dashboard UI: "Offers" tab with "New offer code" and "Gift subscription" actions, plus a table of active/expired offers. Subscription renewal logic checks whether the offer period has elapsed and reverts to standard rate. All parameters freely configurable by the writer. Not started.

~~Gift link frontend~~ — **done:** dashboard GiftLinksPanel (create/list/revoke per article in Articles tab) + "Gift link" option in ShareButton dropdown.

~~DM pricing / anti-spam settings~~ — **done:** GET/PUT `/settings/dm-pricing` + per-user override endpoints. Dashboard settings tab has default rate form + collapsible per-user overrides section with username search.

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

**Settings rationalisation — `SETTINGS-RATIONALISATION.md`**

Replace the current overlapping settings surfaces with four clearly scoped hubs: Profile ("who am I"), Account ("what have I spent"), Social ("how do I experience others" — new page with feed dial, blocks/mutes list, DM fee settings), and Pricing (dashboard tab rename from "settings"). Would delete `/settings` and `/history` pages. Not started — `/settings` still exists, no Social page, dashboard tab still labelled "settings". Not discussed yet.

**Bucket categorisation system — `platform-bucket-system-design.md`**

A generic system for user-defined, non-overlapping categories with behavioural rules. Conceptual — no implementation plan yet. Not discussed yet.

**Currency strategy — `platform-pub-currency-strategy.md`**

Multi-currency support. Option 2 (launch with GBP, display-only conversion) is recommended. Not discussed yet.

---

## Suggested attack order

### Completed (v5.12.0 session, 2026-04-06)

- ~~Gift link frontend polish~~ — dashboard GiftLinksPanel + ShareButton integration
- ~~Commission social features~~ — commission from DM threads, migration 036
- ~~DM pricing configuration~~ — API endpoints + dashboard settings UI
- ~~JWT lifetime reduction~~ — 2-hour lifetime with 1-hour refresh

### Next up

1. **Subscription offers system** (full build — schema, backend, dashboard Offers tab). Design agreed: single `subscription_offers` table, two modes (`code`/`grant`), writer-configurable discount_pct + duration_months + max_redemptions. See §2 "Incomplete Features" for full spec.
2. **Writer analytics** — writers need numbers to stay. Gateway endpoint joining read_events, votes, comments, revenue; dashboard Analytics tab.
3. **Email-on-publish** — inbox is the feed, critical for retention. Migration + send logic + settings toggle.
4. **Tags/topics** — discoverability. Migration, editor input, browse page, card display.
5. **Bookmarks** — reader engagement. Migration, routes, button, /bookmarks page.

### Later: strategic work

6. Subscription Phase 2 — now partially covered by offers system; remaining: welcome email, subscriber import/export, subscriber analytics, custom subscribe landing page
7. Settings rationalisation — see `SETTINGS-RATIONALISATION.md`
8. Currency strategy — see `platform-pub-currency-strategy.md`
9. Reposts (needs feed algorithm to be meaningful)
10. Bucket system — see `platform-bucket-system-design.md`

### Infrastructure (fit in as time allows)

- CI/CD pipeline
- TypeScript strictness (eliminate remaining ~23 `any` instances)
- Accessibility pass
- TypeScript target alignment
