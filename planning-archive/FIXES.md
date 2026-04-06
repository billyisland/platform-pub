# Remaining Fixes from Codebase Audit

Critical fixes 1, 3, and 4 have been implemented. This document tracks the remaining fixes.

Bug 2 was retracted (code is correct). Bug 16 was a false positive (expired subscriptions are correctly excluded by the query).

---

## High Priority

### Fix 5: Check account status in auth middleware
**File:** `gateway/src/middleware/auth.ts`
**Problem:** `requireAuth` verifies the JWT but never checks `accounts.status`. Suspended users keep full API access for up to 7 days (JWT lifetime).
**Fix:** After `verifySession()`, query `accounts.status` and reject non-active accounts with 403. Consider caching status in a short-TTL LRU to avoid a DB hit per request, or embed status in the JWT and check on refresh.

### Fix 6: Add idempotency guard to settlement confirmation
**File:** `payment-service/src/services/settlement.ts:231-298`
**Problem:** `confirmSettlement` doesn't check if `stripe_charge_id` is already set before deducting from the tab. Duplicate Stripe webhooks double-debit the reader.
**Fix:** Add `AND stripe_charge_id IS NULL` to the settlement UPDATE, or check `stripe_charge_id` before the deduction and return early if already set.

### Fix 7: Fix DM sender visibility
**File:** `gateway/src/routes/messages.ts`
**Problem:** Messages are only inserted for recipients (`INSERT INTO direct_messages ... recipient_id`), and the GET query filters `dm.recipient_id = $2`. Senders never see their own sent messages.
**Fix:** Change the GET query WHERE clause to `dm.conversation_id = $1 AND (dm.recipient_id = $2 OR dm.sender_id = $2)`.

### Fix 8: Add security headers to nginx
**File:** `nginx.conf` (HTTPS server block)
**Problem:** Missing HSTS, X-Frame-Options, CSP, Referrer-Policy, Permissions-Policy. Only `/media/` has `nosniff`.
**Fix:** Add to the HTTPS server block:
```nginx
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss:" always;
```

### Fix 9: Add rate limiting to the gateway
**File:** `gateway/package.json`, `gateway/src/index.ts`
**Problem:** No rate limiting on any public endpoint — login, signup, search, gate-pass, voting, DMs all unprotected.
**Fix:** `npm install @fastify/rate-limit` in gateway and register globally with per-route overrides. Suggested limits:
- Login/signup: 5 req/min per IP
- Gate-pass: 20 req/min per user
- Search: 30 req/min per IP
- DM send: 10 req/min per user

### Fix 10: Add `return` to `requireAdmin`
**File:** `gateway/src/routes/moderation.ts:37`
**Problem:** After `reply.status(403).send(...)`, execution falls through to the route handler.
**Fix:** Change to `return reply.status(403).send({ error: 'Admin access required' })`.

### Fix 11: Add non-root USER to Dockerfiles
**Files:** `gateway/Dockerfile`, `payment-service/Dockerfile`, `key-service/Dockerfile`, `key-custody/Dockerfile`, `web/Dockerfile`
**Problem:** All containers run as root. Container escape = root on host.
**Fix:** Add before CMD in each Dockerfile:
```dockerfile
RUN addgroup -S app && adduser -S app -G app
USER app
```

### Fix 12: Remove internal service port bindings
**File:** `docker-compose.yml`
**Problem:** payment (3001), key-service (3002), key-custody (3004), blossom (3003) are bound to `127.0.0.1`. Any host process can bypass gateway auth.
**Fix:** Remove the `ports:` section from these four services. They communicate via Docker's internal network only.

---

## Medium Priority

### Fix 13: Add subscription lifecycle management
**Files:** `gateway/src/routes/subscriptions.ts`, new cron/timer
**Problem:** Subscriptions expire silently after 30 days. No renewal or expiry worker exists.
**Fix:** Add an `expireAndRenewSubscriptions()` function (similar to `expireOverdueDrives`) on a timer. For now, transition past-due subscriptions to 'expired'. Stripe recurring billing can come later.

### Fix 14: Sanitize or remove `renderMarkdownSync`
**File:** `web/src/lib/markdown.ts:85-108`
**Problem:** Regex-based markdown renderer has no sanitization. `[click](javascript:alert(1))` produces XSS.
**Fix:** Either (a) delete the export and migrate callers to async `renderMarkdown`, or (b) add URL protocol allowlist (`href.startsWith('http')` or `href.startsWith('/')`) to the link replacement.

### Fix 15: Escape LIKE metacharacters in search
**File:** `gateway/src/routes/search.ts:96-97`
**Problem:** `%${query}%` passes user input unescaped. Searching `%` matches all articles.
**Fix:** Add a helper:
```typescript
const escapeLike = (s: string) => s.replace(/[%_\\]/g, '\\$&')
```
Apply to the query parameter before wrapping with `%`.

### Fix 17: Wire up config cache invalidation
**File:** `payment-service/src/services/accrual.ts:19-29`
**Problem:** `AccrualService` caches platform config forever. `invalidateConfig()` exists but nothing calls it.
**Fix:** Either (a) add a TTL (e.g., reload every 5 minutes), or (b) call `invalidateConfig()` from the admin config update endpoint.

### Fix 18: Sync notification types between frontend and backend
**Files:** `web/src/lib/api.ts` (Notification type), notification list component
**Problem:** Frontend type only lists 5 notification types. Backend creates 12+. Unknown types are silently dropped.
**Fix:** Update the frontend `Notification` type union to include: `'commission_request'`, `'drive_funded'`, `'pledge_fulfilled'`, `'new_message'`, `'free_pass_granted'`, `'dm_payment_required'`, `'new_user'`. Add a fallback renderer for unrecognized types.

### Fix 19: Use `!== undefined` for drive update fields
**File:** `gateway/src/routes/drives.ts:225-227`
**Problem:** `if (data.fundingTargetPence)` uses truthiness — `0` is skipped.
**Fix:** Change to `if (data.fundingTargetPence !== undefined)` and `if (data.suggestedPricePence !== undefined)`.

### Fix 20: Add Docker health checks
**File:** `docker-compose.yml`
**Problem:** Only postgres and strfry have health checks. 7 services have none.
**Fix:** Add healthcheck blocks. Example for gateway:
```yaml
healthcheck:
  test: ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"]
  interval: 10s
  timeout: 5s
  retries: 3
```
Each service may need a `/health` endpoint added first.

### Fix 21: Guard auth hydration at router level
**File:** `web/src/components/layout/AuthProvider.tsx` or Next.js middleware
**Problem:** Children render before `fetchMe()` resolves. Protected routes that don't individually check `loading` may flash or redirect incorrectly.
**Fix:** Add a centralized guard in `AuthProvider` that renders a loading skeleton until hydration completes, or add Next.js middleware that checks the auth cookie before rendering protected routes.

### Fix 22: Add ON DELETE clauses to later migrations
**New file:** `migrations/018_add_on_delete_clauses.sql`
**Problem:** FKs in migrations 016-017 default to `NO ACTION`: `conversations.created_by`, `dm_pricing.owner_id`, `dm_pricing.target_id`, `pledge_drives.creator_id`, `pledge_drives.target_writer_id`, `pledges.pledger_id`.
**Fix:** Write a migration that drops and re-adds these FK constraints with appropriate `ON DELETE CASCADE` or `ON DELETE SET NULL`.

---

## Low Priority

### Fix 23: Extract subscription period constant
**File:** `gateway/src/routes/subscriptions.ts:74,127`
**Problem:** `30 * 24 * 60 * 60 * 1000` is a magic number in two places.
**Fix:** Extract to `const SUBSCRIPTION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000`.

### Fix 24: Add `"type": "module"` to payment-service
**File:** `payment-service/package.json`
**Problem:** Inconsistent with all other backend services.
**Fix:** Add `"type": "module"` to the package.json.

### Fix 25: Make migrations idempotent
**Files:** `migrations/009_notifications.sql`, `migrations/016_direct_messages.sql`, `migrations/017_pledge_drives.sql`
**Problem:** `CREATE TABLE` without `IF NOT EXISTS`; `CREATE TYPE` without guards.
**Fix:** Add `IF NOT EXISTS` to all CREATE TABLE statements. For CREATE TYPE, wrap in a DO block checking `pg_type`.

### Fix 26: Two-pass comment tree building
**File:** `gateway/src/routes/replies.ts:252-279`
**Problem:** Single-pass tree build fails if a child has an earlier timestamp than its parent.
**Fix:** First pass: populate the full `replyMap`. Second pass: link children to parents. This handles any ordering.

### Fix 27: Forward non-JSON upstream responses
**File:** `gateway/src/routes/articles.ts:747`
**Problem:** `res.json().catch(() => null)` swallows error details from upstream services.
**Fix:** Try `res.json()`, fall back to `res.text()`, and forward the upstream content-type header.

### Fix 28: Reduce JWT session lifetime
**File:** `shared/src/auth/session.ts:26`
**Problem:** 7-day JWT is long for a payment platform.
**Fix:** Reduce `TOKEN_LIFETIME_SECONDS` to 1-2 hours. The existing refresh-on-use at half-life keeps sessions alive for active users. This is a product decision — discuss with stakeholders.

### Fix 29: Move votes/tally to POST or reduce limit
**File:** `gateway/src/routes/votes.ts:248-294`
**Problem:** Public GET with up to 200 IDs in query string can exceed URL length limits.
**Fix:** Either switch to POST with IDs in the body, or reduce the limit to ~50 and add rate limiting.
