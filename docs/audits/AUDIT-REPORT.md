# Codebase Audit Report

**Date:** 7 April 2026
**Scope:** Full codebase — gateway, web, payment-service, key-service, key-custody, shared, schema, migrations, infrastructure

Findings are grouped by severity, then by category.

---

## CRITICAL BUGS

### 1. Wrong column name crashes legacy feed endpoints

**Files:** `gateway/src/routes/notes.ts:397`, `gateway/src/routes/notes.ts:412`

The `/feed/following` endpoint in `notes.ts` queries `SELECT writer_id FROM follows` — but the `follows` table has no `writer_id` column. The correct column is `followee_id`. This will produce a PostgreSQL error on every request.

The correct endpoint in `feed.ts` uses the right column (`followee_id`). The `notes.ts` endpoints are legacy duplicates that should be removed entirely (see Dead Code section below).

```sql
-- BROKEN (notes.ts:397)
a.writer_id IN (SELECT writer_id FROM follows WHERE follower_id = $1)

-- CORRECT (feed.ts:125)
a.writer_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
```

---

### 2. Gate-pass doesn't pass `publicationId` — publication subscribers get charged

**Files:** `gateway/src/routes/articles.ts:375-396`, `gateway/src/services/access.ts:23-28`

The gate-pass handler queries the article but **does not SELECT `publication_id`**, and therefore cannot pass it to `checkArticleAccess()`:

```typescript
// articles.ts:396 — publicationId is never passed
const access = await checkArticleAccess(readerId, article.id, article.writer_id)
```

`checkArticleAccess` has two publication-specific checks gated on `publicationId` being non-null:
- **Publication members** should read their publication's content free (line 36-45)
- **Publication subscribers** should read via their subscription (line 59-72)

Because `publicationId` is always `undefined`, both checks are skipped. Publication members and subscribers will be **incorrectly charged** for reading their own publication's paywalled articles.

**Fix:** Add `publication_id` to the article query SELECT and pass it as the 4th argument.

---

### 3. Missing ON DELETE clauses — account deletion will crash

**File:** `schema.sql` (multiple locations)

Many foreign keys lack ON DELETE behaviour. Attempting to delete an account will hit FK constraint violations. Affected tables:

| Table | Column | Missing clause |
|---|---|---|
| `vote_charges` | `voter_id`, `recipient_id`, `vote_id` | No ON DELETE at all |
| `article_unlocks` | `reader_id`, `article_id`, `subscription_id` | No ON DELETE at all |
| `subscription_events` | `reader_id`, `writer_id` | No ON DELETE at all |
| `subscriptions` | `writer_id` | No ON DELETE at all |
| `conversations` | `created_by` | No ON DELETE at all |
| `publication_payouts` | `publication_id` | No ON DELETE at all |

Migration 021 (`021_missing_on_delete_clauses.sql`) was supposed to fix these, but `schema.sql` (loaded on first boot via Docker `initdb.d`) was never updated to reflect the fix. Fresh database instances created from `schema.sql` will have the broken constraints.

---

## BUGS

### 4. Legacy feed endpoints skip block/mute filtering

**File:** `gateway/src/routes/notes.ts:280-374`

`/feed/global` returns articles, notes, and new users without any block or mute filtering. A user who has blocked or muted someone will still see their content in this feed. The proper `feed.ts` endpoints apply `BLOCK_FILTER` and `MUTE_FILTER` subqueries.

---

### 5. `READER_HASH_KEY` checked too late in gate-pass flow

**File:** `gateway/src/routes/articles.ts:466-469`

`READER_HASH_KEY` is loaded via `requireEnv()` at module-level (line 29), which throws on startup if missing. But line 466 has a redundant runtime check that returns a 500 with the message `"Server misconfiguration: READER_HASH_KEY not set"`. This dead check leaks internal configuration details in the error response. Since `requireEnv` already guarantees it's set, the runtime check is both unreachable and a potential information leak.

---

### 6. `publications.ts` PATCH uses raw JS keys as SQL column names

**File:** `gateway/src/routes/publications.ts:193-196`

```typescript
for (const [key, value] of Object.entries(data)) {
  if (value !== undefined) {
    setClauses.push(`${key} = $${idx}`)  // key is a JS property name
```

The JS keys from the Zod schema (e.g., `logo_blossom_url`) happen to match the DB column names, but this is fragile. If anyone adds a camelCase field to the Zod schema, it would generate invalid SQL like `SET logoBlossomUrl = $1`. The article edit endpoint at line 720-728 does this correctly with an explicit `fields` mapping. The PATCH publication members endpoint at line 418-436 also uses a proper mapping.

---

### 7. Missing `updated_at` on publication PATCH

**File:** `gateway/src/routes/publications.ts:207`

```sql
UPDATE publications SET ${setClauses.join(', ')} WHERE id = $${idx}
```

Does not set `updated_at = now()`. Every other UPDATE in the codebase sets `updated_at`. The `publications` table has an `updated_at` column (schema.sql:982).

---

### 8. Publication article soft-delete missing kind 5 deletion event

**File:** `gateway/src/routes/publications.ts:759-764`

When a publication article is deleted via `DELETE /publications/:id/articles/:articleId`, the handler only sets `deleted_at` in the DB. It does **not** publish a Nostr kind 5 deletion event to the relay. Compare with the personal article delete handler (`articles.ts:772-787`) which does publish the deletion event. This means deleted publication articles will linger on the relay and in clients that rely on relay data.

---

### 9. `accrual.ts` helper functions have misleading null-guard

**File:** `payment-service/src/services/accrual.ts:272-290`

```typescript
if (!rows[0]?.nostr_event_id) {  // if rows is empty, rows[0] is undefined
  throw new Error(...)            // this works — but the Error message is misleading
}
return rows[0].nostr_event_id     // safe because of the guard above
```

The code is technically safe (the guard catches both empty rows and null values), but the guard relies on `undefined?.nostr_event_id` returning `undefined` (falsy). A clearer pattern is `if (rows.length === 0)` first.

---

## DEAD CODE & FOSSILS

### 10. Entire comment system is dead code

**Gateway:** `gateway/src/routes/comments.ts` — `commentRoutes` is **never imported or registered** in `gateway/src/index.ts`. The gateway only registers `replyRoutes` from `replies.ts`.

**Frontend:** `web/src/components/comments/CommentSection.tsx`, `CommentComposer.tsx`, `CommentItem.tsx` and `web/src/lib/comments.ts` — these components post to `/api/v1/comments/*` which doesn't exist on the gateway (404). They are never imported by any page or component.

The reply system (`replies.ts`, `web/src/components/replies/`) is the live implementation. The comment files are fossils from before a rename. They should be deleted.

**Files to remove:**
- `gateway/src/routes/comments.ts`
- `web/src/components/comments/CommentSection.tsx`
- `web/src/components/comments/CommentComposer.tsx`
- `web/src/components/comments/CommentItem.tsx`
- `web/src/lib/comments.ts`

---

### 11. Legacy feed endpoints in `notes.ts` duplicate `feed.ts`

**File:** `gateway/src/routes/notes.ts:274-461`

Two endpoints — `GET /feed/global` and `GET /feed/following` — duplicate the functionality of the proper `GET /feed` endpoint in `feed.ts`. Differences:

| | `notes.ts` (legacy) | `feed.ts` (current) |
|---|---|---|
| Block/mute filtering | Missing | Applied |
| Pagination/cursor | None (hardcoded LIMIT 30) | Cursor-based |
| Column name | Uses wrong `writer_id` (crashes) | Uses correct `followee_id` |
| Publication follows | Not included | Included |
| Registered | Yes (in `noteRoutes`) | Yes (in `feedRoutes`) |

The web client's `api.ts` still has `feed.global()` and `feed.following()` wrappers (lines 286-290) marked as "Legacy endpoints (kept for backwards compat during migration)" — but `FeedView.tsx` only calls `feedApi.get(reach)`, so the legacy wrappers are also unused.

---

### 12. `sendError` helper is never used

**File:** `gateway/src/lib/errors.ts`

Defines a standardised error response helper `sendError(reply, status, code, message)` that returns `{ error: { code, message } }`. It is never imported or called anywhere in the codebase. All routes use raw `reply.status(X).send({ error: '...' })` with inconsistent shapes — some send `{ error: string }`, others send `{ error: { code, message } }`, and Zod errors send `{ error: ZodFlattenedError }`.

---

### 13. `feed.featured` API endpoint doesn't exist

**File:** `web/src/lib/api.ts:292-293`

```typescript
featured: () => request<{ articles: any[] }>('/feed/featured'),
```

No `/feed/featured` route exists anywhere in the gateway. This will 404 if called. No component in the web app currently calls it, so it's dead API client code.

---

### 14. Stale doc references

**File:** `CLAUDE.md:42`

> FEATURES.md — feature specs and implementation tier order

`FEATURES.md` does not exist in the repository. Neither does `DESIGN-BRIEF.md` (also referenced at line 44). These docs have been removed but the references remain.

---

## REDUNDANCY & DUPLICATION

### 15. Three parallel feed implementations

The codebase has three separate feed implementations that should be consolidated:

1. **`gateway/src/routes/feed.ts`** — The proper implementation with reach dial, block/mute filtering, cursor pagination, and publication follows. Used by the frontend.
2. **`gateway/src/routes/notes.ts:274-461`** — Legacy duplicate with bugs (wrong column name, no block/mute filtering). Dead code.
3. **`gateway/src/routes/notes.ts:280`** also includes `new_user` items in the global feed, which `feed.ts` does not. If new-user items in the feed are wanted, they should be added to `feed.ts`, not maintained in the legacy endpoint.

---

### 16. Duplicated article/note-to-item mapping

**Files:** `gateway/src/routes/feed.ts:41-74`, `gateway/src/routes/notes.ts:320-370`

Both files contain nearly identical mapping logic to convert DB rows to feed item objects. `feed.ts` extracts this into `articleToItem()` and `noteToItem()` helper functions. `notes.ts` has the same logic inline in loops. If the legacy endpoints are kept (they shouldn't be), the helpers from `feed.ts` should be reused.

---

### 17. Duplicated DB client setup across services

**Files:** `shared/src/db/client.ts`, `payment-service/src/db/client.ts`, `key-service/src/db/client.ts`, `key-custody/src/db/client.ts`

Each backend service has its own DB client module. The payment, key, and key-custody services duplicate the pool setup, `withTransaction` helper, and `loadConfig` function from shared. All four have slightly different implementations. A single shared module would reduce the surface area for inconsistencies.

---

### 18. Duplicated logger setup across services

**Files:** `shared/src/lib/logger.ts`, `payment-service/src/lib/logger.ts`, `key-service/src/lib/logger.ts`, `key-custody/src/lib/logger.ts`

Four copies of the pino logger setup. Each has slightly different configuration. This should be consolidated into the shared package.

---

## DESIGN ISSUES

### 19. Inconsistent error response shapes

The gateway sends errors in at least four different shapes:

```typescript
// Shape 1: plain string (most routes)
{ error: 'Article not found' }

// Shape 2: structured (defined in errors.ts but never used)
{ error: { code: 'not_found', message: 'Article not found' } }

// Shape 3: Zod validation errors
{ error: { fieldErrors: {...}, formErrors: [...] } }

// Shape 4: mixed (subscription routes, articles)
{ error: 'payment_required', message: 'Payment required.' }
```

The web client's `ApiError` class treats the response body as opaque `any`. A consistent error contract would make client-side error handling more reliable.

---

### 20. Pervasive `as any` casts defeat TypeScript

25+ instances of `as any` across the codebase, concentrated in:

- `gateway/src/routes/publications.ts` — 6 instances for query params and object access
- `gateway/src/routes/articles.ts` — 5 instances for JSON responses from internal services
- `gateway/src/routes/messages.ts` — 1 instance for relay publishing
- `gateway/src/routes/drives.ts` — 2 instances for relay publishing
- `gateway/src/middleware/publication-auth.ts` — 2 instances for params and permission check
- `shared/src/lib/logger.ts` — 1 instance for pino constructor

The most dangerous pattern is `await res.json() as any` on responses from the key service and payment service — there's no type validation on the response shape.

---

### 21. `requirePublicationPermission()` with no arguments silently permits all members

**File:** `gateway/src/routes/publications.ts:621, 669`

```typescript
{ preHandler: [requireAuth, requirePublicationPermission()] }
```

When called with no arguments, `requiredPermissions` is an empty array, so the permission loop doesn't execute. Any member — including a contributor with no permissions — passes the middleware. This is used on the CMS article list and article submit endpoints. The submit handler does check `member.can_publish` internally, but the intent is unclear. Either pass the required permission explicitly or add a comment explaining the design.

---

### 22. Background workers embedded in the gateway process

**File:** `gateway/src/index.ts:200-252`

Three background workers (subscription expiry, drive expiry, feed score refresh) run as `setInterval` timers inside the gateway process. This couples long-running background work to the request-serving process. If the gateway restarts, the workers restart too. If a worker hangs or leaks memory, it takes down the gateway.

The advisory lock mechanism (lines 208-226) is good for preventing duplicate execution when horizontally scaled, but the workers should eventually be separate processes or a job queue.

---

### 23. Payout worker uses `setTimeout` chains instead of a scheduler

**File:** `payment-service/src/workers/payout.ts:27-52`

The daily payout worker uses recursive `setTimeout` calls to schedule the next run. This is fragile — if the process restarts between runs, the schedule is lost and the payout won't run until the next process start. A proper scheduler (cron, pg_cron, or a job queue) would be more reliable for a payment-critical operation.

---

### 24. No soft-delete for notes

**File:** `gateway/src/routes/notes.ts:156-160`

Notes are hard-deleted (`DELETE FROM notes`) while articles are soft-deleted (`SET deleted_at = now()`). This inconsistency means:
- Deleted notes can't be recovered
- There's no audit trail of deleted notes
- Comments referencing deleted notes lose their context permanently
- Feed engagement records referencing the deleted note's event ID become orphaned

---

## INCONSISTENCIES

### 25. `comments_enabled` column used for replies

Throughout the codebase, the DB column is `comments_enabled` but the UI and route names refer to "replies":
- Route: `PATCH /articles/:id/replies` → updates `comments_enabled`
- Route: `PATCH /notes/:id/replies` → updates `comments_enabled`
- API response: sends `repliesEnabled` mapped from `comments_enabled`
- Article PATCH schema: has both `repliesEnabled` and `commentsEnabled` for backwards compat

This naming mismatch between DB and API layers is confusing. It's a fossil from when the feature was called "comments" before being renamed to "replies".

---

### 26. Follows table column inconsistency

The `follows` table uses `follower_id` and `followee_id`, but the notes.ts legacy feed queries use `writer_id` (which doesn't exist). The main `feed.ts` uses the correct column names. This suggests the legacy code was written by pattern-matching against a different schema version.

---

### 27. Subscription period calculation uses 30 days instead of calendar months

**Files:** `gateway/src/routes/subscriptions.ts:131-132, 191-192`

```typescript
const periodDays = period === 'annual' ? 365 : 30
const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000)
```

Monthly subscriptions last exactly 30 days, not one calendar month. This means a subscription started on January 1st expires on January 31st, not February 1st. Over 12 months, readers get 12 x 30 = 360 days instead of 365. Annual subscriptions use 365 days, not accounting for leap years. This is a design decision that should be documented or changed to use proper calendar month arithmetic.

---

## CLUTTER & DOCUMENTATION DEBT

### 28. Excessive planning documents in the repo root

The repository root contains 9 planning/spec documents totalling ~270KB:

- `DEPLOYMENT.md` (67KB) — deployment guide
- `docs/adr/PUBLICATIONS-SPEC.md` (46KB) — feature spec
- `docs/adr/OWNER-DASHBOARD-SPEC.md` (27KB) — feature spec
- `docs/audits/SUBSCRIPTIONS-GAP-ANALYSIS.md` (18KB) — analysis doc
- `RESILIENCE.md` (21KB) — resilience spec
- `FEED-ALGORITHM.md` (13KB) — feed design
- `SETTINGS-RATIONALISATION.md` (11KB) — settings plan
- `docs/adr/platform-pub-currency-strategy.md` (8KB) — currency strategy
- `docs/adr/platform-bucket-system-design.md` (8KB) — bucket system design
- `feature-debt.md` (15KB) — feature debt tracking

Plus a `planning-archive/` directory. These are valuable as historical context but cluttering the repo root. They should be moved to `docs/planning/` or similar. The specs that are now implemented should be archived — leaving them in the root suggests they're still actionable.

---

### 29. `blossom` service declared but not in the upload path

**File:** `docker-compose.yml:207`

The Blossom service is declared in docker-compose with a comment "Not currently in the upload path — gateway writes directly to media_data". It's kept for "future federation/BUD-02 support". This is a running container that serves no purpose. It should be commented out or removed until needed.

---

### 30. `.env` file tracked in git

**File:** `.env` (root)

The `.env` file is tracked in git (not in `.gitignore`). It currently only contains `POSTGRES_PASSWORD`, but `.env` files should never be committed. The `.gitignore` lists `*/env` but not `.env` at the root level — the pattern needs a leading dot.

---

## MINOR / LOW-PRIORITY

### 31. `v1_6.ts` builds enormous SQL with string interpolation of `feeBps`

**File:** `gateway/src/routes/v1_6.ts:147, 268`

`feeBps` is read from `platform_config` (an integer), then interpolated directly into SQL strings: `` `re.amount_pence * ${feeBps} / 10000` ``. This is safe because `feeBps` comes from the DB (not user input) and is always an integer, but it bypasses parameterised queries. Use `$N` parameters instead for consistency and defence in depth.

---

### 32. No index on `subscription_nudge_log.publication_id`

**File:** `schema.sql:366`

The `subscription_nudge_log` table has a `publication_id` column (added in migration 038) but no index on it. If publication-level nudge queries are added, they'll need a sequential scan. The primary key is `(reader_id, writer_id, month)` which doesn't cover publication lookups.

---

### 33. `read_events` composite index may not cover common query patterns

**File:** `schema.sql`, migration 022

The composite index `idx_read_events_composite` (from migration 022) is referenced in the migration but I couldn't verify its exact columns. The most common query pattern is `WHERE reader_id = $1 AND writer_id = $2 AND read_at >= date_trunc('month', now())` (used in the article reader spend check, `articles.ts:202-208`). Ensure the composite index covers this pattern.

---

### 34. Stripe API version pinned to 2023-10-16

**Files:** `payment-service/src/services/settlement.ts:30`, `payment-service/src/services/payout.ts:26`, `gateway/src/routes/auth.ts:27`

The Stripe API version is hardcoded across three files. Should be a shared constant. Also, `2023-10-16` is over two years old — Stripe regularly deprecates old API versions. Consider upgrading and centralising the version string.

---

## SUMMARY

| Severity | Count |
|---|---|
| Critical bugs | 3 |
| Bugs | 6 |
| Dead code / fossils | 5 |
| Redundancy / duplication | 4 |
| Design issues | 6 |
| Inconsistencies | 3 |
| Clutter / docs | 3 |
| Minor | 4 |
| **Total** | **34** |

### Top priority fixes (in order):
1. **#2** — Gate-pass publication access bug (subscribers being charged)
2. **#3** — Update `schema.sql` with missing ON DELETE clauses
3. **#10 + #11** — Delete dead comment system and legacy feed endpoints
4. **#1** — Delete or fix the `notes.ts` feed endpoints (already covered by #11)
5. **#8** — Add kind 5 deletion event for publication article deletes
6. **#7** — Add `updated_at = now()` to publication PATCH
7. **#19** — Standardise error response shapes
