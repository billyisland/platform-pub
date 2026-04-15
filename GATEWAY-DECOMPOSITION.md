# Gateway Decomposition

## Current state

The gateway is the largest backend component in the all.haus monorepo: roughly 13,300 lines across 48 source files, including 40+ route modules, middleware, lib utilities, services, and two background workers. It is the only public-facing service, and it acts as both an API gateway and the primary application server.

Route files range from tight and focused (`tags.ts`, `bookmarks.ts`, `rss.ts`) to very substantial (`publications.ts` at 1,353 lines, `articles.ts` at 1,149, `subscriptions.ts` at 1,138). The gateway also hosts two background workers (`feed-scorer.ts`, `scheduler.ts`) that run on timers inside the HTTP process.

The gateway is currently responsible for authentication and session management, article CRUD and publishing, subscriptions and payments proxying, messaging and DMs, social features (follows, notes, votes), publications management, feed curation, RSS generation, moderation, media uploads, traffology proxying, search, exports, bookmarks, tags, and background scheduling. These responsibilities have different scaling profiles, different change frequencies, and different failure consequences.

## What to extract

### 1. Background workers → feed-ingest (partial — done 2026-04-15)

**Status:** Feed scorer extracted. Scheduler deferred.

**Done:** `gateway/src/workers/feed-scorer.ts` moved to `feed-ingest/src/tasks/feed-scores-refresh.ts` and registered as a Graphile cron task (`*/5 * * * *`). Graphile's single-firer cron semantics replace the old `pg_try_advisory_lock` gate. Gateway no longer runs scoring on a timer.

**Deferred:** `gateway/src/workers/scheduler.ts` stays in the gateway for now. It imports `services/publication-publisher`, `lib/key-custody-client`, `lib/nostr-publisher`, and `routes/drives.checkAndTriggerDriveFulfilment` — moving it would require widening `shared/` or introducing an HTTP round-trip back into the gateway. Per the guiding principle below: don't invent `platform-worker` for a single job. Extract when a second publish-domain background job gives it a companion.

### 2. Messaging → messaging-service

**What:** `messages.ts` (693 lines), `replies.ts` (438 lines), `social.ts`, `follows.ts`, and the DM-related routes.

**Why:** This is a real-time, high-write, user-to-user subsystem that has almost nothing to do with publishing or payments. It touches its own cluster of tables (`conversations`, `conversation_members`, `direct_messages`, `dm_likes`, `dm_pricing`) and its failure modes are distinct — if messaging goes down, publishing should keep working. It is also the part most likely to need WebSocket support or long-polling in future, which would make it a poor fit for the gateway's request-response Fastify process.

**How:** Create a `messaging-service` with its own Fastify instance. Have the gateway proxy to it the same way it already proxies to payment-service and key-service (injecting `x-reader-id` / `x-writer-id` headers). The messaging service gets its own Dockerfile, health check, and port, following the established pattern.

**Risk:** Medium. Requires extracting the message-related auth context and ensuring the session middleware (or header injection) works consistently. The table boundaries are clean, which helps.

**Priority:** Second, after the workers.

## What to restructure internally

### Large route files → service layer extraction

**What:** `publications.ts` (1,353 lines), `subscriptions.ts` (1,138 lines), `articles.ts` (1,149 lines), `auth.ts` (725 lines).

**Why:** These are deeply entangled with the core publishing and payment flows — they touch articles, accounts, Stripe, vault keys, the reading tab. Extracting them into separate services would mean either duplicating a lot of shared state access or building an internal API surface more complex than the current direct-database approach. But as single files they're hard to navigate and hard to test in isolation.

**How:** Factor out a proper service layer. The gateway already has `services/access.ts` and `services/publication-publisher.ts` — extend this pattern consistently. Create `services/publications.ts`, `services/subscriptions.ts`, `services/articles.ts`, and `services/auth.ts` that contain business logic and database queries. The route files become thin dispatchers: parse request, call service, return response.

This is arguably more valuable than either of the extractions above, because it makes the *next* extraction cheaper — once publications logic lives in `services/publications.ts` rather than inline in route handlers, it can be moved to a separate service later by swapping direct function calls for HTTP client calls.

**Risk:** Low. No external API changes. Purely internal restructuring.

**Priority:** Third, but ongoing. Can be done incrementally, one route file at a time.

## What to leave alone

Routes like `rss.ts`, `search.ts`, `tags.ts`, `bookmarks.ts`, `votes.ts`, `export.ts`, `media.ts`, `moderation.ts`, `gift-links.ts`, `unsubscribe.ts`, `receipts.ts`, `history.ts`, and `traffology.ts` (the proxy). These are small, focused, low-change-frequency, and tightly coupled to the article/account data model. Extracting any of these into a separate service would create operational overhead (another Dockerfile, another health check, another deployment target) without meaningful architectural benefit. They belong in the gateway.

## Sequencing

| Order | Action | Risk | Payoff |
|-------|--------|------|--------|
| 1 | Extract feed scorer to feed-ingest (done) | Low | Operational hygiene — separates job failures from API availability |
| 2 | Extract messaging-service | Medium | Domain isolation — decouples real-time messaging from publishing |
| 3 | Internal service layer refactoring | Low | Code navigability and testability; makes future extractions cheaper |

## Guiding principle

Don't extract something just because it's big. The gateway's 13,000 lines aren't a problem in themselves — the problem is when a failure in one domain cascades into another, or when a single file is doing too many things to be navigable. The publications routes are big but stable and core; messaging is smaller but operationally distinct. Size alone is not the signal.
