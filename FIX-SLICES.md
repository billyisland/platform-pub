# Fix Slices

Actionable fix plan derived from the codebase review in `REVIEW-PLAN.md` (2026-05-15), verified against the actual codebase on 2026-05-16.

**Branch:** `workspace-experiment`
**How to use:** Work through slices in order. Each slice is scoped for a single context window. When starting a slice, read this section, then read the files listed in the slice's table before making changes. Diagnosis numbers (D76, D91, etc.) reference the detailed analysis in `REVIEW-PLAN.md` if you need more context on why a fix is needed.

**Important:** Many high-severity diagnoses in the review plan have **already been fixed** in the uncommitted working tree. The first task (Slice 0) is to commit those fixes. Do not re-implement anything listed in the "Already resolved" table — those are done, they just need committing.

---

## Already resolved in working tree (just commit — do NOT re-implement)

| Diagnosis | Claimed issue                                          | Actual state (verified 2026-05-16)                                                      |
| --------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| D94       | Publication unpublish doesn't remove feed_items        | Unpublish route has `DELETE FROM feed_items WHERE article_id = $1`                      |
| D114      | Layer 4 query uses `followed_id`                       | Column is already `followee_id`                                                         |
| D116      | Blocks/mutes use `a.avatar`                            | Both queries use `a.avatar_blossom_url`                                                 |
| D150      | Missing `fi.title` in FEED_SELECT                      | `fi.title` is present on line 132 of timeline.ts                                        |
| D170      | `optionalAuth` skips status/invalidation checks        | `optionalAuth` now performs identical checks, clears session on failure                 |
| D171      | Identity headers not stripped                          | `stripIdentityHeaders` exported and registered as global `onRequest` hook in `index.ts` |
| D175      | Email change token stored plaintext, no expiry         | Token is SHA-256 hashed; 24h TTL via `email_verification_requested_at`                  |
| D178      | Google OAuth bypasses account status check             | Explicit `status !== 'active'` check present, returns 403                               |
| D180      | Account deletion hard-deletes row                      | Uses `UPDATE accounts SET status = 'deleted'` (soft-delete)                             |
| D184      | Scheduler `FOR UPDATE SKIP LOCKED` outside transaction | Wrapped in `withTransaction` with claim-and-update pattern                              |
| D188      | Missing `x-internal-token` on card-connected call      | `X-Internal-Token` header is present                                                    |
| D159      | Bluesky callback uses cookie userId blindly            | Cross-checks `statePayload.userId` against `req.session!.sub!`                          |
| D210      | Migration 083 uses CONCURRENTLY                        | `CONCURRENTLY` already removed with explanatory comment                                 |
| D253      | `crossPost` → `crossPosts` breaking API change         | Both gateway and frontend already use `crossPosts` (plural)                             |

---

## Confirmed — still need fixing

| Diagnosis  | Severity | Summary                                                                             |
| ---------- | -------- | ----------------------------------------------------------------------------------- |
| D76        | Critical | Settlement: Stripe call inside DB transaction                                       |
| D77        | Critical | Settlement: random UUID idempotency key                                             |
| D34 (3.4)  | Critical | `ROW_NUMBER() FILTER` syntax error — all traffology hourly aggregation broken       |
| D333       | Critical | Scheduled articles lose paywall split (gate marker stripped before draft save)      |
| D91        | High     | Gate-pass fetches deleted/unpublished articles                                      |
| D92        | High     | Key proxy doesn't inject `x-reader-id` from session                                 |
| D34 (8.1)  | High     | oEmbed proxy uses raw `fetch()` — SSRF bypass                                       |
| D35 (3.4)  | High     | Traffology referrer resolver uses raw `fetch()` — SSRF                              |
| D222       | High     | ActivityPub media URL accepts `javascript:`/`data:` schemes                         |
| D402       | High     | nginx CSP missing Stripe.js directives                                              |
| D203       | High     | `sampling_mode` maps `"random"` to two different DB values in two routes            |
| D334       | High     | Gate marker not reconstructed on draft load (missing parse rule in PaywallGateNode) |
| D336       | High     | Edit mode loads only `contentFree` — paid content discarded on edit                 |
| D300 (8.2) | High     | Pool exhaustion: 7 services × max 20 = 140 connections vs PG default 100            |
| D36 (8.1)  | Medium   | Subscription email XSS — unescaped display names in HTML                            |
| D100       | Medium   | CDATA injection in RSS `content:encoded`                                            |
| D316       | Medium   | Cross-post IDs collected in ComposeOverlay but never passed to `publishNote`        |

---

## Slice 0: Commit the working-tree fixes ✓ DONE (2026-05-16)

**DO THIS FIRST. Estimated effort: 30 minutes.**

The working tree contains valuable security and correctness fixes that are stuck on the experiment branch instead of protecting production. These need to be committed as independent, well-described commits.

**Process:** For each group below, `git diff <file>` to review the change, confirm it matches the described fix, then stage and commit. Separate any formatting-only changes (quote style, semicolons) into a single separate commit.

| #   | What                        | Files                                                                               | Commit message                                                                                         |
| --- | --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Auth hardening              | `gateway/src/middleware/auth.ts`                                                    | `fix(auth): harden optionalAuth — check account status + session invalidation, strip identity headers` |
| 2   | Rate limits on verification | `gateway/src/routes/auth.ts`                                                        | `fix(auth): add rate limits to /auth/verify and /auth/verify-email-change`                             |
| 3   | Email change token security | `gateway/src/routes/auth.ts` + `migrations/084_email_verification_requested_at.sql` | `fix(auth): hash email change token, add 24h expiry`                                                   |
| 4   | Negative balance prevention | `gateway/src/workers/subscription-expiry.ts`                                        | `fix(subscriptions): prevent negative free_allowance via GREATEST(..., 0)`                             |
| 5   | Search pagination cap       | `gateway/src/routes/search.ts`                                                      | `fix(search): cap offset at 1000 to prevent deep-scan DoS`                                             |
| 6   | Subscribe rate limit        | `gateway/src/routes/external-feeds.ts`                                              | `fix(feeds): add rate limit to subscribe endpoint`                                                     |
| 7   | Account soft-delete         | `gateway/src/routes/auth.ts`                                                        | `fix(auth): soft-delete accounts instead of hard-delete to avoid FK violations`                        |
| 8   | Google OAuth status check   | `gateway/src/routes/google-auth.ts`                                                 | `fix(auth): check account status on Google OAuth login`                                                |
| 9   | Bluesky OAuth cross-check   | `gateway/src/routes/linked-accounts.ts`                                             | `fix(oauth): verify session matches state cookie on Bluesky callback`                                  |
| 10  | Column/query correctness    | `gateway/src/routes/social.ts`, `trust.ts`, `timeline.ts`, `notes.ts`               | `fix(gateway): correct column names, add feed_items cleanup on unpublish`                              |

**Verification:** `tsc --noEmit` in gateway. `npm test` in gateway. Diff each file to confirm only the intended fix is included — formatting noise goes in its own commit.

**Caution:** `auth.ts` appears in items 2, 3, and 7 — these are different changes in the same file. Review the full diff carefully to split them into logical commits. If the changes are entangled, a single commit with a broader message is acceptable.

---

## Slice 1: Security — SSRF, XSS, injection ✓ DONE (2026-05-16)

**Priority: URGENT. Estimated effort: 1 hour.**
**Services:** gateway, shared, feed-ingest, traffology-worker

All items are one-line or few-line fixes with a clear pattern.

| #   | Diagnosis | File                                                                | Fix                                                                                                                                                                                                                                                                                                                 |
| --- | --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D1/D44    | root                                                                | `npm audit fix` — sanitize-html patch for critical XSS via `xmp` raw-text passthrough                                                                                                                                                                                                                               |
| 2   | D34 (8.1) | `gateway/src/routes/media.ts` ~line 160                             | Replace `fetch()` with `safeFetch()` from `shared/src/lib/http-client.ts` in oEmbed proxy. Import `safeFetch` at top of file. The oEmbed URL is constructed from a hardcoded provider allowlist so SSRF risk is low, but this closes the gap                                                                        |
| 3   | D35 (3.4) | `traffology-worker/src/tasks/resolve-source.ts` ~line 209           | Replace `fetch(referrerUrl, ...)` with `safeFetch(referrerUrl, ...)`. This is the highest-risk SSRF: `referrerUrl` is attacker-controlled (HTTP Referer header). Import from `@platform-pub/shared`                                                                                                                 |
| 4   | D36 (8.1) | `shared/src/lib/subscription-emails.ts`                             | Apply `escapeHtml()` to `writerName` and `readerName` before interpolating into HTML templates. The function exists in `shared/src/lib/publish-email-template.ts` — either import it or extract to a shared location. Check all `${writerName}` and `${readerName}` interpolations (~lines 90, 186, and any others) |
| 5   | D100      | `gateway/src/routes/rss.ts` ~line 222                               | Before interpolating `item.content` into `<![CDATA[...]]>`, replace `]]>` sequences: `content.replace(/\]\]>/g, ']]]]><![CDATA[>')`. This is the standard CDATA escaping pattern                                                                                                                                    |
| 6   | D222      | `feed-ingest/src/adapters/activitypub.ts` in `extractAttachments()` | Add `if (!/^https?:\/\//i.test(url)) continue` before pushing to the media array. Also audit the same pattern in `adapters/rss.ts` and `tasks/feed-ingest-nostr.ts` for consistency                                                                                                                                 |
| 7   | D211      | `feed-ingest/src/lib/sanitize.ts`                                   | Add `allowProtocolRelative: false` to the sanitize-html options object. Without this, `//evil.com/tracker.gif` in `<img src>` passes through                                                                                                                                                                        |

**Verification:** `npm test` in shared, gateway, feed-ingest. Manually test oEmbed by fetching a YouTube URL through the API.

---

## Slice 2: Payment settlement three-phase refactor

**Priority: HIGH. Estimated effort: 2–3 hours.**
**Service:** payment-service

D76 and D77 are the most dangerous confirmed bugs — a Stripe charge can succeed with no audit trail if the DB COMMIT fails after the Stripe call. The payout code in `payment-service/src/services/payout.ts` already demonstrates the correct three-phase pattern (reserve → Stripe → complete). Mirror that pattern here.

| #   | Diagnosis | File                                         | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D76       | `payment-service/src/services/settlement.ts` | Refactor `executeSettlement` to three-phase: **(1)** txn 1: `FOR UPDATE` lock on reading_tab, INSERT into `tab_settlements` with status `'pending'`, COMMIT; **(2)** Stripe `paymentIntents.create` call **outside** any transaction; **(3)** txn 2: UPDATE `tab_settlements` with `stripe_payment_intent_id` and status `'completed'`. On crash recovery, add `resumePendingSettlements()` (called at startup) that retries pending settlements using their stable idempotency key |
| 2   | D77       | same                                         | Use `settlement-${settlementId}` as Stripe idempotency key. Requires D76 so the settlement row (and its ID) exists before the Stripe call                                                                                                                                                                                                                                                                                                                                           |
| 3   | D78       | same                                         | After re-checking the amount inside the transaction, add `if (actualAmount < 30) return null` — Stripe rejects GBP charges under 30p                                                                                                                                                                                                                                                                                                                                                |
| 4   | D79       | same                                         | Before creating a new settlement, check for existing pending settlement: `SELECT id FROM tab_settlements WHERE tab_id = $1 AND stripe_charge_id IS NULL`                                                                                                                                                                                                                                                                                                                            |
| 5   | D82       | `payment-service/src/services/accrual.ts`    | Move `publishReceiptAsync` call to **after** `withTransaction` returns, not inside it. The `readEvent.id` is available in the return value                                                                                                                                                                                                                                                                                                                                          |
| 6   | D80       | `payment-service/src/index.ts`               | Add `requireEnv('STRIPE_WEBHOOK_SECRET')`, `requireEnv('INTERNAL_SERVICE_TOKEN')`, `requireEnv('PLATFORM_SERVICE_PRIVKEY')` at startup                                                                                                                                                                                                                                                                                                                                              |

**Verification:** Run existing payment tests (`npm test` in payment-service — 41 tests). Trace the settlement flow to verify txn boundaries. Reference `payout.ts` for the three-phase pattern.

---

## Slice 3: Article access + gate-pass fixes

**Priority: HIGH. Estimated effort: 1 hour.**
**Service:** gateway

| #   | Diagnosis | File                                                           | Fix                                                                                                                                                                                                                                                                                                              |
| --- | --------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D91       | `gateway/src/services/article-access/gate-pass.ts` ~line 62    | Add `AND deleted_at IS NULL AND published_at IS NOT NULL` to the `WHERE nostr_event_id = $1` article lookup. Without this, a reader can be charged for a deleted or unpublished article                                                                                                                          |
| 2   | D92       | `gateway/src/routes/articles/gate-pass.ts` ~line 50            | On the `POST /articles/:nostrEventId/key` proxy route, inject `req.headers['x-reader-id'] = req.session!.sub!` before calling `proxyToService`. The vault routes (lines 20–48) already do this with `x-writer-id` — follow the same pattern. Without this, a client can set `x-reader-id` to another reader's ID |
| 3   | D97       | Find the `/content/resolve` route handler                      | Add `AND deleted_at IS NULL AND published_at IS NOT NULL` to the article query. Currently leaks metadata (title, summary, author) for deleted articles                                                                                                                                                           |
| 4   | D98       | New migration file                                             | `ALTER TABLE reading_tabs ADD CONSTRAINT reading_tabs_balance_non_negative CHECK (balance_pence >= 0)`. Alternatively, change the UPDATE in the subscription-convert route to `WHERE balance_pence >= $1` and check `rowCount`                                                                                   |
| 5   | D99       | `gateway/src/routes/subscriptions/` — find the convert handler | The charge calculation: if `spendPence > subPrice`, credit is full `spendPence` but charge is 0 — net gain for reader. Fix: `const credit = Math.min(spendPence, subPrice)`                                                                                                                                      |

**Verification:** Test gate-pass with a deleted article ID — should return 404. Test `/content/resolve` with a deleted article. Verify tab balance can't go negative via the subscription-convert path.

---

## Slice 4: Editor paywall round-trip

**Priority: HIGH. Estimated effort: 3–4 hours.**
**Service:** web

These bugs interact — the paywall content lifecycle is: compose → save draft → load draft → publish → edit. Fixing them requires understanding the full chain.

| #   | Diagnosis | File                                                           | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D333      | `web/src/app/write/page.tsx` ~line 181                         | `handleSchedule` saves `data.content` to the draft, but `data.content` has the gate marker **already stripped** (see `ArticleEditor.tsx` ~line 300: `fullContent.replace(PAYWALL_GATE_MARKER, '')`). When the scheduler later tries to split the content, the marker is gone and the article publishes fully free. **Fix:** Save the raw content with the gate marker intact. Either: (a) add a `rawContent` field to `PublishData` carrying the unstripped markdown, or (b) reconstruct it: `data.freeContent + '\n\n' + PAYWALL_GATE_MARKER + '\n\n' + data.paywallContent` |
| 2   | D334      | `web/src/components/editor/PaywallGateNode.ts` ~line 79        | The `parse: {}` object is empty — there is no rule to reconstruct a `paywallGate` node from `<!-- paywall-gate -->` when loading a draft. The custom serialiser (line 76–78) correctly writes the marker, but the round-trip breaks on load. **Fix:** Add a `parse.setup` hook that registers a `markdown-it` rule matching `<!-- paywall-gate -->` and converting it to a `paywallGate` node                                                                                                                                                                                 |
| 3   | D335      | `web/src/components/editor/EmbedNode.ts`                       | Missing `addStorage()` with `markdown.serialize` — embeds serialize as `[embed]` (losing the URL). **Fix:** Add `addStorage()` that serialises as bare URL on its own line, and a corresponding parse hook to reconstruct embed nodes from embeddable URLs                                                                                                                                                                                                                                                                                                                    |
| 4   | D336      | `web/src/app/write/page.tsx` ~line 110 + gateway article route | When editing a paywalled article, only `contentFree` is loaded — all paid content is discarded. **Fix:** (a) Gateway: add a route or option that returns `contentPaywall` to the article's own author (verify `writer_id = req.session.sub`). (b) Frontend: fetch both, concatenate with gate marker in between, load into editor                                                                                                                                                                                                                                             |
| 5   | D337      | `web/src/components/compose/ArticleComposePanel.tsx`           | `parseFloat('')` returns `NaN`, `Math.round(NaN)` is `NaN`. **Fix:** `Number.isFinite(val) ? Math.round(val * 100) : 0`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | D338      | `web/src/components/editor/PaywallGateNode.ts`                 | `insertPaywallGate` calls `deleteRange()` then `insertContent()` as separate commands against the same initial state. **Fix:** Use `editor.chain().deleteRange(...).insertContentAt(...).run()` for a single transaction                                                                                                                                                                                                                                                                                                                                                      |

**Verification:** Create a paywalled article in compose overlay → autosave → close → reopen draft → verify gate is present. Schedule a paywalled article → verify scheduler publishes with split. Edit an existing paywalled article → verify paid content loads. Clear price input → verify no NaN in payload.

---

## Slice 5: Compose overlay + cross-posting

**Priority: MEDIUM. Estimated effort: 2 hours.**
**Service:** web

| #   | Diagnosis | File                                                            | Fix                                                                                                                                                                                                                          |
| --- | --------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D316      | `web/src/components/compose/ComposeOverlay.tsx` in `handlePost` | `crossPostIds` (Set) is maintained but never passed to `publishNote`. Map the Set to `CrossPostTarget[]` and pass as 4th argument. `publishNote` already accepts and forwards `crossPosts` — the break is only in the caller |
| 2   | D317      | same, Escape key `useEffect`                                    | Add `media.attachments.length` to the dependency array. Currently, if only images are attached (no text), Escape skips the confirmation prompt                                                                               |
| 3   | D318      | same, `setMode('article')` handler                              | Pass current note `content` to ArticleComposePanel (via store or prop) and seed the TipTap editor body. Currently, typed text is silently lost on mode switch                                                                |
| 4   | D319      | same, article mode close button                                 | Wire through `handleDismiss` guard (unsaved-changes check) or call `flushDraft` before closing. Currently the X button calls `close()` directly                                                                              |
| 5   | D320      | `web/src/components/compose/ArticleComposePanel.tsx`            | `createAutoSaver` returns a closure over a `setTimeout` handle that can fire after unmount. **Fix:** Return a `cancel()` method; call it in a `useEffect` cleanup                                                            |
| 6   | D322      | same, `buildPublishData`                                        | `sendEmail: true` is hardcoded — every article published from the overlay sends an email blast. **Fix:** Default to `false`, or add a visible toggle. The full editor is the proper channel for intentional email-on-publish |
| 7   | D324      | same, autosave and `flushDraft`                                 | `selectedPubId` is only included in the publish path, not autosave or flush. **Fix:** Pass `selectedPubId` to `saveDraft` in both autosave and `flushDraft` calls                                                            |

**Verification:** Cross-post a note with a linked account — verify it actually posts to the external service. Press Escape with only images attached — verify confirmation prompt appears. Type text in note mode → click "Write an article" → verify text transfers to TipTap. Close article mode with unsaved content → verify guard fires.

---

## Slice 6: Database schema migration

**Priority: MEDIUM. Estimated effort: 1–2 hours.**
**Service:** migrations/

Create a single new migration file (next number after 084) containing all schema-level fixes. No application code changes in this slice.

| #   | Diagnosis | SQL                                                                                                                                                                                                                                                                                             |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D54       | `CREATE INDEX idx_subscriptions_publication ON subscriptions(publication_id) WHERE publication_id IS NOT NULL;`                                                                                                                                                                                 |
| 2   | D55       | `CREATE INDEX idx_pub_article_shares_pub ON publication_article_shares(publication_id);` and `CREATE INDEX idx_pub_article_shares_article ON publication_article_shares(article_id);`                                                                                                           |
| 3   | D56       | `CREATE INDEX idx_pub_payout_splits_article ON publication_payout_splits(article_id) WHERE article_id IS NOT NULL;`                                                                                                                                                                             |
| 4   | D57       | Drop and recreate FK constraints on `articles.publication_id` and `article_drafts.publication_id` with `ON DELETE SET NULL`, and `subscriptions.publication_id` with `ON DELETE CASCADE`                                                                                                        |
| 5   | D58       | Drop and recreate FK constraints on `vouches.attestor_id` and `vouches.subject_id` with `ON DELETE CASCADE`                                                                                                                                                                                     |
| 6   | D59       | Drop and recreate FK constraints on `trust_profiles.user_id` and `trust_layer1.user_id` with `ON DELETE CASCADE`                                                                                                                                                                                |
| 7   | D65       | 8× `CREATE TRIGGER set_updated_at BEFORE UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION set_updated_at();` for: `subscriptions`, `linked_accounts`, `external_sources`, `activitypub_instance_health`, `notification_preferences`, `vote_tallies`, `platform_config`, `atproto_oauth_sessions` |
| 8   | D63       | `DROP INDEX idx_feed_items_score; CREATE INDEX idx_feed_items_score ON feed_items(score DESC, published_at DESC, id DESC) WHERE deleted_at IS NULL;`                                                                                                                                            |
| 9   | D98       | `ALTER TABLE reading_tabs ADD CONSTRAINT reading_tabs_balance_non_negative CHECK (balance_pence >= 0);` (skip if already done in Slice 3)                                                                                                                                                       |

Also add a cron task for D67 (relay_outbox cleanup):

| #   | Diagnosis | File                                           | Fix                                                                                                                               |
| --- | --------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 10  | D67       | `feed-ingest/src/index.ts` (cron registration) | Add `relay_outbox_prune` daily cron: `DELETE FROM relay_outbox WHERE status = 'sent' AND updated_at < now() - INTERVAL '30 days'` |

**Verification:** Apply migration to dev DB. `\d+ subscriptions`, `\d+ vouches`, etc. to verify indexes and constraints. Run full test suite.

---

## Slice 7: Infrastructure fixes

**Priority: MEDIUM. Estimated effort: 30 minutes.**
**Files:** nginx.conf, docker-compose.yml

| #   | Diagnosis  | File                                           | Fix                                                                                                                                                                                                                                                                |
| --- | ---------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | D402       | `nginx.conf` CSP header                        | Add `https://js.stripe.com` to `script-src` and add `frame-src https://js.stripe.com`; add `https://api.stripe.com` to `connect-src`; add `font-src 'self'`. Without this, Stripe.js and 3DS iframes are blocked in browsers that enforce CSP                      |
| 2   | D403       | `nginx.conf` `/media/` block                   | The `/media/` block has its own `add_header` directives, which drops **all** parent security headers (HSTS, X-Frame-Options, CSP, etc.) due to nginx inheritance rules. Either repeat all security headers in the block, or extract them into an `include` snippet |
| 3   | D300 (8.2) | `docker-compose.yml`                           | Add `DB_POOL_MAX: 10` to environment for non-gateway services (payment-service, key-service, key-custody, traffology-ingest, traffology-worker, feed-ingest). 7 services × 20 = 140 potential connections exceeds PG default of 100                                |
| 4   | D400       | `docker-compose.yml` feed-ingest               | Add `PLATFORM_RELAY_WS_URL: ws://strfry:7777` to environment. Without this, relay-publish falls back to `ws://localhost:4848` which doesn't resolve inside Docker                                                                                                  |
| 5   | D401       | `docker-compose.yml`                           | Add `ATPROTO_CLIENT_BASE_URL` and `ATPROTO_PRIVATE_JWK` to gateway and feed-ingest environment blocks. Without these, AT Protocol OAuth falls back to loopback dev mode in production                                                                              |
| 6   | D309 (8.2) | cron config in feed-ingest and payment-service | Stagger the 02:00 UTC cron stampede: move payout to `0 2 30 * * *` (02:30), move `external_items_prune` to `0 2 15 * * *` (02:15). Trust epoch stays at 02:00                                                                                                      |

**Verification:** `docker compose config` to validate YAML. `nginx -t` to validate nginx config. Test Stripe checkout flow in browser to confirm CSP doesn't block js.stripe.com.

---

## Slice 8: Traffology critical fix + misc gateway fixes

**Priority: MEDIUM. Estimated effort: 2 hours.**
**Services:** traffology-worker, gateway

| #   | Diagnosis | File                                                                     | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D34 (3.4) | `traffology-worker/src/tasks/aggregate-hourly.ts` ~lines 193–198         | **CRITICAL — all hourly aggregation is currently broken.** `ROW_NUMBER() OVER (...) FILTER (WHERE ...)` is invalid SQL — `FILTER` only works on aggregate functions, not window functions. The entire hourly transaction rolls back. **Fix:** Move the filter into the CTE: add `WHERE p.published_at >= date_trunc('year', CURRENT_DATE)` to the FROM clause for the year-ranking window, or use `CASE WHEN p.published_at >= ... THEN <value> ELSE NULL END` inside the ORDER BY |
| 2   | D36 (3.4) | `traffology-worker/src/tasks/resolve-source.ts` ~lines 262–297           | `findOrCreateSource` has SELECT-then-INSERT race. **Fix:** Add unique constraint on `(writer_id, source_type, domain)` (migration), switch to `INSERT ... ON CONFLICT DO NOTHING RETURNING id` with fallback SELECT                                                                                                                                                                                                                                                                |
| 3   | D203      | `gateway/src/routes/feeds.ts`                                            | PUT `/feeds/:id/author-volume/:pubkey` maps `"random"` → `"random"` in the DB. PATCH `/feeds/:id/sources/:sourceId` maps `"random"` → `"chronological"`. **Fix:** Make the PUT route match the PATCH: `sampling === "random" ? "chronological" : ...`                                                                                                                                                                                                                              |
| 4   | D109      | `gateway/src/routes/notes.ts`                                            | Note deletion signs event (HTTP to key-custody) before confirming ownership. If note doesn't belong to user, wasted signing call. **Fix:** Move ownership check (`WHERE id = $1 AND author_id = $2`) before the `signEvent` call                                                                                                                                                                                                                                                   |
| 5   | D110      | `gateway/src/routes/publications/` (find publication delete/soft-delete) | `signEvent` is called inside `withTransaction`. If the HTTP call hangs, the transaction holds row locks. **Fix:** Move `signEvent` before the `withTransaction` block, same pattern as personal article deletion                                                                                                                                                                                                                                                                   |
| 6   | D95       | `gateway/src/routes/publications/cms.ts`                                 | CMS PATCH runs 3 separate `pool.query` calls (article UPDATE + feed_items title + feed_items media). **Fix:** Wrap in `withTransaction`                                                                                                                                                                                                                                                                                                                                            |
| 7   | D96       | same                                                                     | CMS PATCH doesn't verify article exists — `UPDATE ... WHERE id = $X AND publication_id = $Y` with no `RETURNING` clause. **Fix:** Add `RETURNING id`, check `rowCount === 0` → return 404                                                                                                                                                                                                                                                                                          |

**Verification:** After fixing D34, verify that `traffology.piece_stats` and `traffology.source_stats` tables actually receive data from the hourly cron. Test workspace sampling mode changes via both PUT and PATCH routes.

---

## Slice 9: Workspace data layer + UI fixes

**Priority: MEDIUM. Estimated effort: 2 hours.**
**Services:** gateway, web

| #   | Diagnosis  | File                                                | Fix                                                                                                                                                                                                                 |
| --- | ---------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D201 (5.1) | `gateway/src/routes/feeds.ts` — external source add | `withTransaction` commits `external_sources` + `external_subscriptions`, then `insertSource` runs outside. **Fix:** Move `insertSource` and `add_job` inside the `withTransaction`; pass `client` to `insertSource` |
| 2   | D206       | `web/src/stores/workspace.ts` `readFromStorage`     | JSON parse has no per-entry validation. Corrupt data produces `NaN` positions. **Fix:** Drop entries where `typeof x !== 'number' \|\| typeof y !== 'number'`                                                       |
| 3   | D207       | same, `hydrate()`                                   | `writeTimer` not cleared on user switch. **Fix:** Add `if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }` at the top of `hydrate()`                                                                  |
| 4   | D216       | `web/src/components/workspace/FeedComposer.tsx`     | `deleteBlocked` counts hidden vessels. **Fix:** `vessels.filter(v => !positions[v.feed.id]?.hidden).length <= 1`                                                                                                    |
| 5   | D217       | `gateway/src/routes/feeds.ts` DELETE endpoint       | No server-side last-feed guard. **Fix:** `SELECT COUNT(*) FROM feeds WHERE owner_id = $1` before delete; return 409 if count ≤ 1                                                                                    |
| 6   | D211 (5.2) | `web/src/components/workspace/WorkspaceView.tsx`    | `refreshAll` closes over stale `vessels` array. **Fix:** Read vessels via `useRef` or functional updater                                                                                                            |
| 7   | D212 (5.2) | same                                                | `handleMergeConfirm` reads stale `vessels` closure. **Fix:** Use `setVessels(prev => { ... })` functional updater                                                                                                   |
| 8   | D246/D247  | `web/src/hooks/useResolverInput.ts`                 | No unmount cleanup; context hardcoded to `"subscribe"`. **Fix:** (a) Add `useEffect` cleanup that increments `genRef.current` and clears `debounceRef`; (b) Add `context` option to hook with default `'subscribe'` |

**Verification:** Test workspace: create/delete feeds (verify last-feed guard), drag-to-merge, resize browser. Log out → log in as different user → verify no cross-user position bleed.

---

## Slice 10: Test coverage — critical pure functions

**Priority: MEDIUM. Estimated effort: 3–4 hours.**
**Services:** gateway, shared, feed-ingest, web

New test files for untested pure functions. May require exporting currently module-private functions.

| #   | Diagnosis | File to create                            | What to test                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D326      | `gateway/tests/resolver-classify.test.ts` | Export `classifyInput` from `gateway/src/lib/resolver.ts`. Test all 11 input types: npub, nprofile, hex-64 pubkey, DID (`did:plc:...`), bluesky handle (`@x.bsky.social`), fediverse handle (`@user@domain`), ambiguous email-like, dotted host, URL (http/https), platform username (`@localuser`), free text. ~30 cases including edge cases (leading @, case sensitivity, 64-char hex boundary) |
| 2   | D328      | `shared/tests/http-client.test.ts`        | Export `isPrivateIpv4`, `isPrivateIpv6`, `parseIpv6` from `shared/src/lib/http-client.ts`. Test: 127.0.0.1, 10.x, 172.16–31.x, 192.168.x, 169.254.x (link-local), 100.64.x (CGNAT), 224.x (multicast), ::1, ::ffff:10.0.0.1 (IPv4-mapped), fe80:: (link-local v6), fc00:: (ULA), public IPs that should pass. ~25 cases                                                                            |
| 3   | D329      | `feed-ingest/src/lib/sanitize.test.ts`    | Test `sanitizeContent`: `<script>` tags stripped, event handlers (`onerror`, `onload`) stripped, `data:` URIs in img src stripped, `javascript:` in href stripped, protocol-relative URLs (after D211 fix), allowed tags preserved, attributes preserved. ~15 cases                                                                                                                                |
| 4   | D351      | `web/tests/resolve.test.ts`               | Import `resolveMatches`/`matchToOptions`/`tagFallback` from `web/src/lib/workspace/resolve.ts`. Test: native_account mapping, external_source mapping, rss_feed mapping, tag fallback for `#tag` input, dedup of tag fallback when already in results. ~15 cases                                                                                                                                   |
| 5   | D353      | `web/tests/collision.test.ts`             | Import `resolveCollisions` from `web/src/lib/workspace/collision.ts`. Test: no overlap (no-op), single overlap (verify push direction), chain cascade (A→B→C), boundary clamping, 30-iteration safety cap, disjoint vessels (no-op). ~12 cases                                                                                                                                                     |

**Verification:** `npm test` in each workspace — all new tests pass. Existing tests still pass.

---

## Slice 11: Design system token sweep

**Priority: LOW. Estimated effort: 3–4 hours.**
**Service:** web

Mechanical find-and-replace across ~40 files. No logic changes. Reference CLAUDE.md "Design system rules" for token definitions.

| #   | Diagnosis  | Scope                   | Pattern to find                                                                                    | Replace with                                                           |
| --- | ---------- | ----------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | D300 (4.1) | 22 files, ~88 instances | `font-mono text-[11px] uppercase tracking-[0.06em]`                                                | `label-ui`                                                             |
| 2   | D301 (4.1) | 24 files, ~73 instances | `text-[13px]` (in non-serif contexts)                                                              | `text-ui-xs`                                                           |
| 3   | D302 (4.1) | 21 files, ~57 instances | `text-[14px]` (in non-serif contexts)                                                              | `text-ui-sm`                                                           |
| 4   | D303 (4.1) | 12 files, ~25 instances | `font-mono text-[11px]` (without uppercase)                                                        | `text-mono-xs`                                                         |
| 5   | D305 (4.1) | ~20 locations           | Page titles, error headings, modal titles, data values using `font-serif` for non-literary content | `font-sans` (titles) or `font-mono tabular-nums` (data values)         |
| 6   | D309 (4.1) | ~15 locations           | Form labels using `text-ui-xs uppercase tracking-wider` or `text-sm text-black` or `label-muted`   | `label-ui text-grey-400`                                               |
| 7   | D311 (4.1) | 6 components            | Hand-rolled conditional `bg-black text-white` / `bg-grey-100 text-grey-600` toggle groups          | `toggle-chip label-ui` + `toggle-chip-active` / `toggle-chip-inactive` |

**Caution:** Don't replace `text-[13px] font-serif` — those are literary content previews, not UI text. Only replace in `font-sans` / no-font contexts.

**Verification:** Visual inspection of affected pages at localhost:3010. Verify no layout shifts, missing text, or changed font sizes.

---

## Slice 12: Frontend accessibility

**Priority: LOW. Estimated effort: 2 hours.**
**Service:** web

| #   | Diagnosis | File                                                                                                     | Fix                                                                                                                                                                     |
| --- | --------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D410      | `web/src/components/trust/VouchModal.tsx`                                                                | Add `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (pointing to h3 ID). Add ESC key handler. Add focus trap (trap focus within modal while open)               |
| 2   | D407      | `web/src/components/trust/TrustProfile.tsx`                                                              | Add `role="progressbar"` with `aria-valuenow={score}`, `aria-valuemin={0}`, `aria-valuemax={1}` to dimension bar divs                                                   |
| 3   | D423      | `web/src/app/network/page.tsx`, `web/src/components/social/WriterActivity.tsx`, and other tab components | Add `role="tablist"` to tab container, `role="tab"` + `aria-selected` to each tab button, `role="tabpanel"` to content panels. Add left/right arrow keyboard navigation |
| 4   | D425      | `web/src/components/social/FollowingTab.tsx`                                                             | Add `role="dialog"`, `aria-modal`, ESC handler, focus trap to unsubscribe modal. Remove `rounded-lg` and `shadow-xl` (no rounded corners per redesign spec)             |
| 5   | D427      | `web/src/components/trust/TrustPip.tsx`                                                                  | Add `role="img"` to the span (has `aria-label` but bare `<span>` means screen readers skip it)                                                                          |
| 6   | D224      | `web/src/components/workspace/VesselCard.tsx`                                                            | Add `role="button"`, `tabIndex={0}`, `onKeyDown` (Enter/Space) to CardShell clickable div                                                                               |
| 7   | D225      | same                                                                                                     | Add `role="img" aria-label="Play video"` to the video play button overlay                                                                                               |
| 8   | D428      | `web/src/components/messages/ConversationList.tsx`                                                       | Add `<span className="sr-only">Unread</span>` alongside the visual crimson dot                                                                                          |

**Verification:** Tab through each affected component — verify focus order is logical and all interactive elements are reachable. If a screen reader is available, verify announcements.

---

## Slice 13: Cleanup, dead code, docs

**Priority: LOW. Estimated effort: 1 hour.**

| #   | Diagnosis  | File                                                                                          | Fix                                                                                                                                                |
| --- | ---------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D6         | all backend workspaces                                                                        | `npx eslint --fix` — clears 176 auto-fixable `no-unnecessary-type-assertion` warnings                                                              |
| 2   | D317       | `key-service/src/services/vault.ts` + `key-service/src/types/index.ts`                        | Remove dead `nostrVaultEvent` construction and the `@deprecated` type field. No consumers read it                                                  |
| 3   | D318       | `shared/src/lib/publish-email-template.ts` → extract `escapeHtml` to `shared/src/lib/text.ts` | Export `escapeHtml` so feed-ingest can import it instead of reimplementing (3 copies currently). Web copy stays (can't import shared from Next.js) |
| 4   | D319       | `gateway/package.json`                                                                        | Remove `jose` — gateway never imports it directly (used via shared's session module)                                                               |
| 5   | D320       | `shared/package.json`                                                                         | Remove `nostr-tools` — shared never imports it directly (each consumer imports its own)                                                            |
| 6   | D322       | `feed-ingest/src/lib/trust-pip.ts`                                                            | Remove `export` keyword from `PipStatus` type — only used internally                                                                               |
| 7   | D323       | `CLAUDE.md`                                                                                   | Remove stale "NoteComposer is deprecated — kept in codebase" note. File is already deleted                                                         |
| 8   | D324       | `knip.json`                                                                                   | Remove 3 stale `ignoreBinaries` entries (`next`, `vitest`, `tsx`) — knip auto-detects these now                                                    |
| 9   | D213       | `feed-ingest/src/tasks/trust-epoch-aggregate.ts`                                              | Remove unused `applyDecay` import                                                                                                                  |
| 10  | D305 (6.2) | `feature-debt.md` line 16, `docs/adr/CODE-QUALITY.md` line 14                                 | Update stale "no CI pipeline" claims — CI has existed since the CODE-QUALITY.md implementation                                                     |

**Verification:** `tsc --noEmit` across all workspaces. `npm test` in all workspaces. `npx knip` — should show 0 or fewer findings than before.

---

## Recommended attack order

```
Slice 0  (commit working-tree fixes)      — 30 min  ← DO FIRST
Slice 1  (security: SSRF/XSS/injection)   — 1 hour
Slice 2  (payment settlement refactor)     — 3 hours
Slice 3  (article access / gate-pass)      — 1 hour
Slice 4  (editor paywall round-trip)       — 4 hours
Slice 7  (infrastructure / nginx / docker) — 30 min
Slice 8  (traffology + misc gateway)       — 2 hours
Slice 6  (database schema migration)       — 2 hours
Slice 5  (compose overlay)                — 2 hours
Slice 9  (workspace fixes)                — 2 hours
Slice 10 (test coverage)                  — 4 hours
Slice 13 (cleanup / dead code / docs)     — 1 hour
Slice 11 (design system token sweep)      — 4 hours
Slice 12 (accessibility)                  — 2 hours
```

**Total estimated effort:** ~28 hours across 14 slices.

Each slice produces one or more commits. After completing a slice, run the verification steps listed in that slice before moving on.
