# Codebase Audit — 2026-04-05

Systematic review of bugs, gaps, dead wood, and organisational issues across all services.

---

## Summary

| Category | Critical | High | Medium | Low |
|---|---|---|---|---|
| Bugs & logic errors | 0 | 2 | 3 | 2 |
| Gaps & missing validation | 1 | 2 | 4 | 1 |
| Dead wood | 0 | 0 | 2 | 3 |
| Organisation | 0 | 0 | 3 | 2 |
| **Total** | **1** | **4** | **12** | **8** |

---

## Critical

### 1. `schema.sql` pre-seed missing migrations 026-032

**File:** `schema.sql:869-895`

The `_migrations` pre-seed only lists 001-025, but 32 migrations exist. A fresh deployment using `schema.sql` (e.g. `docker compose up` on a clean volume) will create the schema from the compiled DDL but then the migration runner will try to re-apply 026-032 on next service start, potentially causing conflicts or duplicate table/column errors.

**Missing:**
- 026_article_profile_pins
- 027_subscription_visibility
- 028_subscription_nudge
- 029_gift_links
- 030_commissions_expansion
- 031_fix_media_urls_domain
- 032_dm_likes

**Fix:** Append the 7 missing filenames to the `INSERT INTO _migrations` statement, and ensure the compiled DDL above them includes the actual schema changes from those migrations.

---

## High

### 2. Background workers run without distributed locking

**File:** `gateway/src/index.ts:183-200`

`expireAndRenewSubscriptions()` and `expireOverdueDrives()` fire on a 1-hour `setInterval`. If the gateway is horizontally scaled (multiple containers), every instance runs these concurrently. Subscription renewals could be charged twice; drives could be expired and re-expired.

```typescript
setInterval(() => {
  expireAndRenewSubscriptions().catch(...)
  expireOverdueDrives().catch(...)
}, WORKER_INTERVAL_MS)
```

**Fix:** Use PostgreSQL advisory locks (`pg_try_advisory_lock`) at the start of each worker, or move these to a dedicated single-instance worker/cron job.

---

### 3. `READER_HASH_KEY` only warns at startup — fails at request time

**File:** `gateway/src/routes/articles.ts:28-31, 452-454`

The key is checked with `logger.warn` at module load but not enforced. The gate-pass endpoint returns 500 when it's actually needed. Every other critical env var uses `requireEnv()`.

```typescript
const READER_HASH_KEY = process.env.READER_HASH_KEY
if (!READER_HASH_KEY) {
  logger.warn('READER_HASH_KEY is not set — gate-pass will fail...')
}
```

**Fix:** Change to `const READER_HASH_KEY = requireEnv('READER_HASH_KEY')` so the gateway fails fast on startup.

---

### 4. `STRIPE_SECRET_KEY` not validated at gateway startup

**File:** `gateway/src/routes/auth.ts:25`

Uses non-null assertion (`!`) without startup validation. If the env var is missing, the service starts but every Stripe operation (Connect onboarding, SetupIntent creation) fails at request time.

```typescript
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { ... })
```

**Fix:** Add `const STRIPE_SECRET_KEY = requireEnv('STRIPE_SECRET_KEY')` at module level.

---

### 5. Service URL localhost fallbacks in gateway

**File:** `gateway/src/routes/articles.ts:26-27`

```typescript
const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL ?? 'http://localhost:3002'
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:3001'
```

If these env vars are omitted in production, the gateway silently proxies to localhost instead of the Docker service names, causing silent failures. Other critical env vars use `requireEnv()`.

**Fix:** Use `requireEnv()` for these as well, or at minimum log a clear warning.

---

## Medium

### 6. `confirmPayout` lacks idempotency guard

**File:** `payment-service/src/services/payout.ts:311-320`

The `transfer.paid` webhook handler unconditionally updates the payout row. If Stripe retries the webhook, `completed_at` is overwritten. Not dangerous (status stays `completed`), but it's inconsistent with the careful idempotency in `confirmSettlement`.

```typescript
async confirmPayout(stripeTransferId: string): Promise<void> {
  await pool.query(
    `UPDATE writer_payouts
     SET status = 'completed', completed_at = now()
     WHERE stripe_transfer_id = $1`,
    [stripeTransferId]
  )
}
```

**Fix:** Add `AND status != 'completed'` to the WHERE clause.

---

### 7. Empty `chargeId` can poison settlement records

**File:** `payment-service/src/routes/webhook.ts:76-84`

If `latest_charge` is null on a PaymentIntent, `chargeId` falls back to empty string. The settlement gets marked with `stripe_charge_id = ''`, which passes the idempotency guard (not NULL) and prevents the real charge from being recorded on retry.

**Fix:** Throw if `chargeId` is falsy before calling `confirmSettlement`.

---

### 8. Vault key decryption has no error handling for key rotation

**File:** `key-service/src/services/vault.ts:61`

When reusing an existing vault key, `decryptContentKey()` is called without a try/catch. If `KMS_MASTER_KEY_HEX` has been rotated since the key was encrypted, this throws an unhandled error and crashes the request with a generic 500.

**Fix:** Catch decryption errors and return a specific error code (e.g. `VAULT_KEY_DECRYPT_FAILED`) so the caller can diagnose key rotation issues.

---

### 9. Weak validation on `readerPubkey` and `readerPubkeyHash`

**File:** `payment-service/src/routes/payment.ts:25-26`

```typescript
readerPubkey: z.string().min(1),
readerPubkeyHash: z.string(),
```

Nostr pubkeys must be 64-character hex strings. These fields end up in portable receipt events — accepting arbitrary strings creates malformed Nostr events.

**Fix:** `z.string().regex(/^[0-9a-f]{64}$/)` for both fields.

---

### 10. `useWriterName` hook — setState after unmount

**File:** `web/src/hooks/useWriterName.ts:37-42`

The `.then()` handler calls `setInfo()` without checking whether the component is still mounted. In React 18 strict mode this triggers warnings; in fast navigation scenarios it can cause stale data.

```typescript
pending.get(pubkey)!.then((result) => {
  if (result) {
    cache.set(pubkey, result)
    setInfo(result)  // component may be unmounted
  }
})
```

**Fix:** Track mounted state via the effect cleanup return, or use an AbortController pattern.

---

### 11. `pk_test_placeholder` Stripe key fallback

**File:** `web/src/components/payment/CardSetup.tsx:27`

```typescript
process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? 'pk_test_placeholder'
```

If the env var is missing at build time, Stripe Elements silently initialises with a non-functional key. Card setup appears to work but all operations fail.

**Fix:** Throw at build time or render an error state if the key is missing.

---

### 12. 19 silent `.catch(() => {})` swallowing errors

**Files:** Across gateway and web — `subscriptions.ts`, `comments.ts`, `replies.ts`, `VoteControls.tsx`, `ArticleReader.tsx`, `NoteCard.tsx`, `NotificationBell.tsx`, etc.

Fire-and-forget patterns silently discard errors. Notification inserts, vote tallies, mark-read calls, and relay publishes all fail invisibly. This makes production debugging very difficult.

**Fix:** At minimum `.catch(err => logger.warn(...))` on the backend, `console.error` on the frontend. Better: use a background job queue for non-critical async work on the backend.

---

### 13. Overly large `ArticleReader` component (380 lines)

**File:** `web/src/components/article/ArticleReader.tsx`

Handles paywall gate logic, quote selection UI, gift link generation, subscription state, decryption flow, and reply rendering in a single component. Hard to test and reason about.

**Fix:** Extract `PaywallGateContainer`, `QuoteSelector`, and `GiftLinkSection` as separate components.

---

### 14. Duplicated publish-then-index pattern

**Files:** `web/src/lib/publishNote.ts`, `web/src/lib/comments.ts`, `web/src/lib/replies.ts`

All three implement the same sign -> publish -> index pattern with nearly identical code. Changes to the signing or publishing flow need to be updated in three places.

**Fix:** Extract a shared `signPublishAndIndex()` helper.

---

### 15. Payment service routes lack defence-in-depth auth

**File:** `payment-service/src/routes/payment.ts:42, 72`

`/gate-pass` and `/card-connected` have no `X-Internal-Token` check, unlike `/payout-cycle` and `/settlement-check/monthly`. The comment says "Auth is handled at the gateway; these routes trust the caller" and Docker network isolation prevents public access. But if the network boundary is ever weakened (e.g. service mesh misconfiguration), these endpoints are unprotected.

**Fix:** Add the same `X-Internal-Token` check that the other internal routes use.

---

### 16. Inconsistent error response format across routes

**Files:** Multiple across gateway

Some routes return `{ error: 'string' }`, others `{ error: 'snake_case_code' }`, others detailed objects. The frontend has to guess the shape.

Examples:
- `auth.ts:55` — `{ error: 'Signup failed' }`
- `articles.ts:551` — `{ error: 'Internal error' }`
- `moderation.ts:200` — `{ error: 'Admin access required' }`

**Fix:** Standardise on `{ error: { code: string, message: string } }` or similar.

---

### 17. FeedView shows blank screen on fetch failure

**File:** `web/src/components/feed/FeedView.tsx:99`

Feed fetch catches errors with `console.error` but renders nothing. Users see an empty screen with no indication of what went wrong.

**Fix:** Add error state and a retry button.

---

## Low

### 18. `stripe` is a dead dependency in `shared/package.json`

**File:** `shared/package.json:19`

`"stripe": "^14.0.0"` is declared but never imported anywhere in `shared/src/`. Each service that uses Stripe has its own dependency.

**Fix:** Remove from `shared/package.json`.

---

### 19. Exported `logger` in `key-custody-client.ts` never imported

**File:** `gateway/src/lib/key-custody-client.ts:75`

```typescript
export { logger }
```

No file in the gateway imports this re-export.

**Fix:** Remove the export.

---

### 20. Unused `onCommission` prop in `ReplyItem`

**File:** `web/src/components/replies/ReplyItem.tsx:34`

Prop is declared in the interface but never called in the component body.

**Fix:** Remove the prop or implement the handler.

---

### 21. `shared/src/db/client.ts` pool error handler is a no-op

**File:** `shared/src/db/client.ts:29-31`

```typescript
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database pool error')
})
```

Logs the error but takes no recovery action. A broken pool connection will cause all subsequent queries to hang or fail.

**Fix:** Call `process.exit(1)` to let Docker/orchestrator restart the service.

---

### 22. Hardcoded admin list

**File:** `gateway/src/routes/moderation.ts:23-25`

Admin access is checked against a comma-separated env var. Works for now but doesn't scale and requires a redeploy to change.

**Fix:** Move admin account IDs to `platform_config` table.

---

### 23. Drive deadline can be set to the past

**File:** `gateway/src/routes/drives.ts:230`

When updating a pledge drive, the deadline is not validated to be in the future.

**Fix:** Add `z.string().datetime().refine(d => new Date(d) > new Date())` or equivalent.

---

### 24. Missing content length limits on DM content

**File:** `gateway/src/routes/messages.ts`

DM content is validated with `z.string().min(1)` but no max length. An attacker could send extremely large messages.

**Fix:** Add `.max()` matching whatever the UI allows.

---

### 25. Magic number: 30-day settlement fallback

**File:** `payment-service/src/services/settlement.ts:96`

```typescript
const thirtyDays = 30 * 24 * 60 * 60 * 1000
```

Should come from `platform_config` for consistency with other tunable parameters.

---

## Not issues (false positives from initial scan)

- **.env files committed to git** — `.gitignore` correctly excludes them; `git ls-files` confirms none are tracked.
- **`/articles/by-event` endpoint missing** — It exists at `gateway/src/routes/articles.ts:248`.
- **Settlement TOCTOU race in `confirmSettlement`** — The SELECT at line 254 is an optimisation only; the real guard is the atomic `UPDATE ... WHERE stripe_charge_id IS NULL` at line 264, inside a transaction. Safe as written.

---

## Architecture notes (not bugs, just observations)

1. **Single Postgres, no read replicas.** All services share one database. Fine at current scale but will need connection pooling (PgBouncer) and read replicas as traffic grows.

2. **No structured background job system.** Cron-style `setInterval` workers in the gateway process. Works for single-instance but blocks horizontal scaling (see issue #2). Consider BullMQ or pg-boss.

3. **No distributed tracing.** Individual service logs exist (pino) but there's no request-level correlation ID across gateway -> payment-service -> key-service. Makes cross-service debugging hard.

4. **Blossom container is running but unused.** The `docker-compose.yml` includes a Blossom media server, but media upload/serving goes through the gateway + nginx. Either remove it or wire it up.
