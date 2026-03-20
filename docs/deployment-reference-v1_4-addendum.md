# platform.pub — Deployment Reference v1.4 Addendum

**Updated:** 15 March 2026

This document covers changes in v1.4. Append to or read alongside the v1.3 deployment reference.

---

## Changes in v1.4 (15 March 2026)

### 1.4.1 Publish pipeline fix — vault article ID sequencing

The publishing pipeline called the key service's vault endpoint with `articleId: ''` (empty string) because the article had not yet been indexed in the platform database at the point the vault was created. The vault_keys table's `article_id` column is a NOT NULL foreign key to articles — this would cause a constraint violation on any paywalled publish.

**Fix:** The pipeline now indexes the article first (getting the UUID back from `POST /articles`), then calls the vault endpoint with the real article UUID, then upserts the article index row again with the `vaultEventId`. The vault key's article ownership check now works because the articles row exists before the vault call arrives.

**File:** `web/src/lib/publish.ts` — rewritten. The pipeline order is now:
1. Sign and publish the NIP-23 event to the relay
2. Index the article in the platform DB → receive `articleId` UUID
3. Call vault endpoint with real `articleId` → encrypt body, store key
4. Upsert article index with `vaultEventId`

### 1.4.2 Price suggestion alignment with ADR

The editor's `suggestPrice()` function used price brackets that did not match the ADR §II.2 pricing table. Articles under 500 words were priced at 50p (ADR says free below ~700 words), and the top bracket was £3.00 (ADR says £2.00 with a soft cap at £3.00).

**Fix:** Price brackets now match the ADR table exactly. Articles under ~700 words default to free. The paywall checkbox auto-unchecks for short articles unless the writer has manually toggled it.

**File:** `web/src/components/editor/ArticleEditor.tsx` — `suggestPrice()` rewritten, auto-paywall toggle added.

### 1.4.3 Draft saving

The "Save draft" button in the editor was a dead `<button>` with no click handler. Auto-save was not implemented.

**Fix:** Drafts are now saved to the `article_drafts` table via a new `POST /drafts` gateway endpoint. Auto-save fires 3 seconds after the last edit. Manual "Save draft" button works. Draft status ("Saved" / "Save failed") is shown next to the button.

**New files:**
- `web/src/lib/drafts.ts` — client-side draft service with auto-save debouncing
- `gateway/src/routes/drafts.ts` — CRUD draft routes (save/upsert, list, load, delete)

**Modified files:**
- `gateway/src/index.ts` — registered `draftRoutes`
- `web/src/components/editor/ArticleEditor.tsx` — wired auto-save and manual save

**New migration:**
- `migrations/002_draft_upsert_index.sql` — partial unique index on `(writer_id, nostr_d_tag)` for draft upserts

### 1.4.4 Per-article earnings

The writer dashboard's "Per-article revenue" section was a "coming soon" placeholder.

**Fix:** A new `GET /earnings/:writerId/articles` endpoint returns per-article earnings breakdowns (reads, net earnings, pending, paid). The dashboard now shows a table with each article's title, published date, read count, and net earnings split.

**New/modified files:**
- `payment-service/src/services/payout.ts` — added `getPerArticleEarnings()` method
- `payment-service/src/types/index.ts` — added `ArticleEarnings` type
- `payment-service/src/routes/payment.ts` — added `GET /earnings/:writerId/articles`
- `gateway/src/routes/articles.ts` — added proxy route for per-article earnings
- `web/src/lib/api.ts` — added `payment.getPerArticleEarnings()` client method
- `web/src/app/dashboard/page.tsx` — replaced stub with real per-article table

### 1.4.5 Operational hardening

**docker-compose.yml changes:**
- Postgres password is now read from `POSTGRES_PASSWORD` environment variable (was hardcoded as `password`)
- Postgres port bound to `127.0.0.1:5432` (was `0.0.0.0:5432`)
- Gateway, payment, and key service ports bound to `127.0.0.1` (were `0.0.0.0`)
- All `DATABASE_URL` values use `${POSTGRES_PASSWORD}` interpolation

**New file:** `scripts/harden-server.sh` — run once on the production server before launch:
- Configures UFW firewall (allow 22, 80, 443 only)
- Switches SSH to key-only authentication
- Sets up certbot auto-renewal cron (daily at 03:00)
- Generates a strong Postgres password and writes it to `.env`

### 1.4.6 ArticleReader gate-pass client cleanup

The `ArticleReader` component used raw `fetch()` to call the gate-pass endpoint. The typed `articles.gatePass()` client in `web/src/lib/api.ts` already existed but was unused.

**Fix:** `ArticleReader` now uses the typed API client. Error handling is cleaner — the `ApiError` class provides structured status codes. The unlock flow now correctly calls `unwrapContentKey` and `decryptVaultContent` as separate steps (previously it called `unlockArticle` which redundantly re-requested the key).

**File:** `web/src/components/article/ArticleReader.tsx` — `handleUnlock()` rewritten.

---

## New API endpoints (v1.4)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/drafts | requireAuth | Save or upsert a draft |
| GET | /api/v1/drafts | requireAuth | List writer's drafts |
| GET | /api/v1/drafts/:id | requireAuth | Load a single draft |
| DELETE | /api/v1/drafts/:id | requireAuth | Delete a draft |
| GET | /api/v1/earnings/:writerId/articles | requireAuth | Per-article earnings breakdown |

---

## Files changed in v1.4

| File | Status | Change |
|------|--------|--------|
| web/src/lib/publish.ts | REWRITTEN | Index-first pipeline, real articleId for vault |
| web/src/components/editor/ArticleEditor.tsx | MODIFIED | ADR price brackets, auto-paywall, auto-save, manual save |
| web/src/lib/drafts.ts | NEW | Draft saving client with auto-save debouncing |
| web/src/lib/api.ts | MODIFIED | Added ArticleEarnings type and getPerArticleEarnings |
| web/src/app/dashboard/page.tsx | MODIFIED | Real per-article earnings table |
| web/src/components/article/ArticleReader.tsx | MODIFIED | Typed gate-pass client, cleaner unlock flow |
| gateway/src/index.ts | MODIFIED | Registered draftRoutes |
| gateway/src/routes/drafts.ts | NEW | Draft CRUD endpoints |
| gateway/src/routes/articles.ts | MODIFIED | Added per-article earnings proxy |
| payment-service/src/services/payout.ts | MODIFIED | Added getPerArticleEarnings() |
| payment-service/src/types/index.ts | MODIFIED | Added ArticleEarnings type |
| payment-service/src/routes/payment.ts | MODIFIED | Added GET /earnings/:writerId/articles |
| docker-compose.yml | MODIFIED | Env var passwords, localhost-only ports |
| scripts/harden-server.sh | NEW | Server hardening script |
| migrations/002_draft_upsert_index.sql | NEW | Draft upsert partial unique index |

---

## Deploying v1.4

### Pre-deployment

1. Run the migration on the database:
```bash
docker exec -it platform-pub-postgres-1 psql -U platformpub platformpub \
  -f /dev/stdin < migrations/002_draft_upsert_index.sql
```

2. If not already done, run the server hardening script:
```bash
bash scripts/harden-server.sh
```

3. Ensure `.env` in `/root/platform-pub/` contains `POSTGRES_PASSWORD`.

### Deploy

Upload the 15 changed files to the server under `/root/platform-pub`, then:

```bash
cd /root/platform-pub
docker compose build --no-cache web gateway payment keyservice
docker compose up -d
docker compose restart nginx
```

The nginx restart is required because rebuilt containers receive new internal IPs.

---

## Outstanding items before launch (updated)

| Item | Priority | Status |
|------|----------|--------|
| Stripe test/live keys | Launch-blocking | Unchanged |
| CCA legal sign-off | Launch-blocking | Unchanged — engage solicitor |
| Launch cohort recruitment | Launch-blocking | Unchanged |
| Email provider (Postmark/Resend) | Important | Unchanged |
| Server hardening | Important | **Script ready** — run before launch |
| Comments (kind 1 with reply tags) | Post-launch (v1.5) | Unchanged |
| For You feed ranking | Post-launch | Requires engagement data |
| Receipt event retry queue | Post-launch | Fire-and-forget currently |
