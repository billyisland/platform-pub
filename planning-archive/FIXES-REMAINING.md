# Remaining Fixes

Issues surfaced during the 2026-04-02 codebase review that were not addressed in the critical/high/resilience batch. Organised by priority.

---

## Medium Priority

### 1. Config cache TTL with no invalidation

**File:** `shared/src/db/client.ts` (loadConfig)

`loadConfig()` caches `platform_fee_bps` and other config for 5 minutes. Admin changes to fee rates are stale during the cache window, potentially causing incorrect financial calculations.

**Fix:** Reduce TTL to 30 seconds, or implement a LISTEN/NOTIFY trigger on the config table so services invalidate on change.

---

### 2. No upper bound on article price

**File:** `gateway/src/routes/articles.ts` (IndexArticleSchema)

`pricePence: z.number().int().min(0)` has no `.max()`. A writer could set a price of 999999999 pence, overflowing Stripe limits or payment calculations.

**Fix:** Add `.max(999999)` (£9,999.99) or whatever the business maximum is.

---

### 3. Fire-and-forget notification inserts without await

**File:** `gateway/src/routes/notes.ts` (lines 92-97)

Quote notification uses `pool.query(...).catch()` without `await`. If the catch handler itself throws (edge case), the rejection is unhandled.

**Fix:** Wrap in `try { await pool.query(...) } catch (err) { logger.warn(...) }` or at minimum add a proper `.catch()` chain.

---

### 4. Missing NODE_ENV=production in 3 Dockerfiles

**Files:** `web/Dockerfile`, `payment-service/Dockerfile`, `key-service/Dockerfile`

These don't set `ENV NODE_ENV=production`. Gateway and key-custody do. Without it, dev dependencies are installed in production images.

**Fix:** Add `ENV NODE_ENV=production` before `npm install` in each.

---

### 5. Missing .dockerignore

**File:** Root directory (missing)

No `.dockerignore` exists. Every `docker build` sends `node_modules`, `.git`, `.next`, and all dev files as build context.

**Fix:** Create `.dockerignore`:
```
node_modules
dist
.git
.next
*.log
.env
```

---

### 6. Dependency version conflicts across services

**Files:** All `package.json` files

| Package | Root | Services |
|---------|------|----------|
| pg | 8.20.0 | 8.11.0 |
| dotenv | 17.3.1 | 16.4.0 |

Different library versions across services sharing the same DB can cause subtle bugs.

**Fix:** Align all services to the same version of shared dependencies. Consider using npm workspaces.

---

### 7. CSP header allows unsafe-inline for styles

**File:** `nginx.conf` (line 36)

`style-src 'self' 'unsafe-inline'` allows style injection attacks. Should use nonces or external stylesheets only.

**Fix:** Remove `'unsafe-inline'` and add nonce support, or use a hash-based approach.

---

### 8. Missing HSTS preload directive

**File:** `nginx.conf` (line 31)

`Strict-Transport-Security` header is missing the `preload` directive.

**Fix:** Add `preload` to enable HSTS preload list inclusion:
```
Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
```

---

## Low Priority

### 9. Unused dynamic import in webhook handler

**File:** `payment-service/src/routes/webhook.ts` (line 134)

`const { pool } = await import('../db/client.js')` when `pool` is already imported at the top of the file.

**Fix:** Remove the dynamic import, use the top-level import.

---

### 10. 33 instances of `any` across the frontend

**Files:** Scattered across `web/src/lib/api.ts`, `FeedView.tsx`, `CommentComposer.tsx`, `ReplyComposer.tsx`, `editor/ImageUpload.ts`, etc.

**Fix:** Replace `any` with proper types incrementally. Start with the API client (`api.ts:255` — `articles: any[]`) and composable types (`CommentComposer.tsx:23`, `ReplyComposer.tsx:18`).

---

### 11. No multi-stage Docker builds

**Files:** All service Dockerfiles

Build artifacts (`.tsbuildinfo`, source maps) ship in production images, increasing size.

**Fix:** Add a build stage that compiles TypeScript, then a production stage that copies only `dist/` and `node_modules`.

---

### 12. TypeScript target mismatch

**Files:** `web/tsconfig.json` (ES2017) vs `tsconfig.base.json` (ES2022)

Inconsistent transpilation between frontend and backend. The web target could be safely bumped to ES2020+ since Next.js handles browser compatibility.

**Fix:** Update `web/tsconfig.json` target to at least ES2020.

---

### 13. Accessibility gaps

**Files:** `VoteControls.tsx`, `Nav.tsx`, `ArticleCard.tsx`

- Vote buttons use "▲"/"▼" symbols without aria-labels
- Paywall indicator is colour-only (red border, no text alternative)
- Dropdown menus lack keyboard navigation support

**Fix:** Add `aria-label` to vote buttons, add text "Paid" label alongside the colour indicator, add `onKeyDown` handlers to dropdowns.

---

### 14. CommentSection and ReplySection near-identical

**Files:** `web/src/components/comments/CommentSection.tsx`, `web/src/components/replies/ReplySection.tsx`

Nearly identical structure, loading, error handling, and nested reply logic.

**Fix:** Extract a shared `ThreadSection` component parameterized by endpoint and display mode.

---

### 15. No CI/CD configuration

No GitHub Actions, GitLab CI, or other CI/CD configuration exists.

**Fix:** Add at minimum: lint + typecheck + test on PR, build validation on merge to main.

---

### 16. Session storage not cleared on logout

**File:** `web/src/components/article/ArticleReader.tsx`

`sessionStorage.getItem('unlocked:${article.id}')` is never cleared on logout, meaning a shared device could show unlocked state from a previous user's session.

**Fix:** Clear `sessionStorage` keys matching `unlocked:*` in the logout handler.

---

### 17. Missing CHECK constraints for state machines

**File:** `schema.sql`

No CHECK constraints validate that `read_state`, `drive_status`, or `pledge_status` columns contain valid values or transition in the correct order.

**Fix:** Add CHECK constraints for allowed values. State transition ordering is better enforced in application code, but valid-value checks belong in the schema.

---

## Summary

| Priority | Count | Key themes |
|----------|-------|------------|
| Medium | 8 | Financial accuracy, Docker hygiene, security headers, dependency alignment |
| Low | 9 | Type safety, a11y, Docker optimisation, code dedup, CI/CD |
