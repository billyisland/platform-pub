# Deep code audit — 2026-07-16

> **Resolution status (updated 2026-07-17).** The CRITICAL, all 14 HIGHs, and 21
> of 25 MEDIUMs are fixed and shipped; the per-item fix log is in
> `FIX-PROGRAMME.md` and the live status is in `CONSOLIDATED-TODO.md` §0e.
>
> **C1 took TWO fixes, and the 2026-07-16 sign-off on it was wrong.** The pin fix
> (`a157834`) was real but only got the worker *to* strfry; strfry then rejected
> 100% of what it was handed (`relay/strfry.conf` had `rejectEventsOlderThanSeconds
> = 0` — a reject window, not the "no limit" its comment assumed). Native publishing
> stayed dead for another day while the audit recorded C1 as closed, because the
> sign-off's evidence only proved *transport* reached the relay and was read as
> proving publishing worked. Second fix + prod end-to-end verification (a real
> publish landing, strfry 89→90) shipped 2026-07-17 — see FIX-PROGRAMME 2026-07-17
> and the corrected §0e C1 entry. **Worth generalising when reading the rest of
> this document's "shipped" claims: proving a component ≠ proving the feature.**
> Deliberately deferred as design-sensitive (not mechanical fixes): **M8**
> (event-id squatting → needs signed-event↔writer ownership verification),
> **M16** (RSS guid dedup → unique-constraint migration + re-ingest trade-off),
> **M17** (email fuzzy dedup → per-subscriber read-time suppression), **M23**
> (strfry open-write → write-policy plugin with a DB-synced pubkey allowlist).
> The 18 LOWs remain. This document is the historical finding record — do not
> edit the findings below; track status in CONSOLIDATED-TODO.md.

Seven-agent adversarial audit of the full repo at HEAD (`c000beb`), one agent per subsystem (money/payments, gateway core, feed-ingest, feeds/follow/dedup, key services, web frontend, schema/shared/infra), findings filtered against CONSOLIDATED-TODO.md and FIX-PROGRAMME.md so nothing below is already-tracked work. Findings marked **[verified]** were re-confirmed by the orchestrating auditor against the source (and where noted, empirically against the running dev stack); the rest carry the reporting agent's code excerpts.

Severity legend: CRITICAL = core platform function broken or direct money/key theft · HIGH = money loss, content-integrity, privacy, or invariant violation · MEDIUM = real defect, bounded blast radius · LOW = defence-in-depth / edge case.

---

## CRITICAL

### C1. The relay outbox worker cannot reach the platform's own relay — every native Nostr publish silently abandons **[verified — empirically, in the running dev stack]**

`feed-ingest/src/adapters/nostr-outbound.ts:85` runs every relay target through `pinnedWebSocketOptions`, which rejects any hostname resolving to a private IP (`shared/src/lib/http-client.ts:207-213` — no allowlist mechanism exists anywhere in the file). The configured publish target in **both dev and prod** is `ws://strfry:7777` (`docker-compose.yml:148/173/195/282`, `DEPLOYMENT.md:130`), which Docker DNS resolves to a 172.18.x compose address.

Empirically confirmed:

```
$ docker exec platform-pub-dev-feed-ingest-1 node -e "…pinnedWebSocketOptions('ws://strfry:7777')…"
THREW: Hostname strfry resolves to private IP 172.18.0.9
```

Consequence: every event enqueued into `relay_outbox` (article kind-30023s, notes, kind-5 tombstones, discovery kind 0/3/10002) fails the pin on claim, retries to `max_attempts` (10), then flips to `status='abandoned'` — while every API returns success, because the invariant is "signed and durably queued." Nothing has been able to reach strfry since the DNS-hardening commit (`8375365`, 2026-05-16); the dev strfry LMDB was last written 2026-05-25, consistent with that.

**Check prod immediately**: `SELECT status, count(*) FROM relay_outbox GROUP BY status;` — expect a pile of `abandoned`. Fix shape: an explicit exemption for the configured `PLATFORM_RELAY_WS_URL` host (an operator-controlled value, not user input), never a general weakening of the pin. Abandoned rows will need a redrive after the fix.

---

## HIGH

### H1. key-service vault/key-issuance routes have no internal-secret gate; `readerId == writerId` skips the payment check entirely **[verified]

`key-service/src/routes/keys.ts:43` (`POST /articles/:id/vault`) and `:141` (`POST /articles/:id/key`) trust caller-supplied `x-writer-id` / `x-reader-id` / `x-reader-pubkey` headers with **no** `x-internal-secret` check — unlike `/writers/export-keys` (`keys.ts:204-208`) and `/articles/:id/paywall-content` in the same file, and unlike every key-custody route. In `issueKey`, `key-service/src/services/vault.ts:190-193` skips the whole unlock/payment block when `readerId === writerId`, then wraps the content key to the caller-supplied pubkey (`:238`).

The internet front door is safe (gateway strips identity headers globally; nginx proxies nothing to :3002), but any container on the compose bridge (web SSR is the realistic pivot) can POST `/api/v1/articles/<eventId>/key` with `x-reader-id: <writer's account UUID>` + its own pubkey and decrypt **any paywalled article** — no payment, no gate pass. Fix: mirror the `INTERNAL_SECRET` preHandler onto both routes + add the header at the two gateway call sites (`gate-pass.ts:293-306` and the vault-publish caller).

### H2. `POST /subscriptions/:writerId/convert` is an unmetered money pump **[verified]

`gateway/src/routes/articles/subscription-convert.ts:50-186`, four compounding defects:

1. **No card gate** — creates/reactivates an `active, auto_renew` subscription with no `stripe_customer_id` check (violates the Wave-3 402 `card_required` invariant; contrast `writer.ts:59-65`).
2. **Credits back spend that never debited the tab** — the spend SUM (`:91-97`) has no `state` filter (provisional reads count) and no `publication_id IS NULL` filter.
3. **The charge leg is a phantom** — `:153-158` inserts a bare `subscription_events` row; no `applyLedgerDelta`, no tab debit, no `subscription_earning`, no writer ledger entry (contrast `logSubscriptionCharge`). The reader is never charged; the writer never earns the month; the credited-back reads still pay the writer at settlement — the platform funds the credit.
4. **Repeatable** — the 409 fires only on `status === 'active'` (`:83-88`); cancel → re-convert re-credits the same `read_events` rows any number of times per month.

Net: any authed account with one month's spend ≥ 0.7 × sub price can drive its tab arbitrarily negative (pre-paid credit), and because the ledger mirror books the movement, the reconcile halt never fires. No web UI calls this route, but it is live on the API.

### H3. Account deletion publishes the user's **email address** in signed public Nostr events (and mis-addresses the kind-5) **[verified]

`gateway/src/routes/auth.ts:674` — the kind-5 `a` coordinate is built as `30023:${accountRows[0].email}:${d_tag}` (the SELECT at `:623-626` fetches only `email`; the pubkey belongs there — compare the correct path at `routes/articles/manage.ts:174`). Deleting an account with N published articles enqueues N permanently-public signed events, each disclosing the email — at the moment the user is erasing their data — to the platform relay and any `PUBLIC_FANOUT_RELAY_URLS`. The malformed coordinate also means address-based relay deletion of the replaceable 30023 doesn't happen. GDPR-grade. (Blast radius currently reduced by C1 — abandoned outbox rows never reach a relay — but the fix must land before C1's fix redrives the queue.)

### H4. Admin "remove_content" / "suspend_account" leaves content in every workspace feed and on the relay **[verified]

`gateway/src/routes/moderation.ts:263-309` and `:349-361` only null `articles.published_at` (notes are hard-deleted, which cascades). No `feed_items` cleanup — feed queries filter only `fi.deleted_at` and select `content_free` regardless of `published_at` — so a removed article's card, title and free body stay in every feed indefinitely; and no kind-5 tombstone is enqueued, so the full NIP-23 event stays served by the platform's own relay. Personal unpublish (`manage.ts:271-275`) does both correctly. For `illegal_content` reports, moderation is currently cosmetic.

### H5. "Reversible" deactivation is a permanent lockout **[verified — repo-wide grep: nothing ever sets `status='active'`]

`gateway/src/routes/auth.ts:588` sets `deactivated`; magic-link request matches only `status='active'` (`shared/src/auth/magic-links.ts:39-41`), Google exchange 403s non-active (`google-auth.ts:163-166`), `requireAuth` 403s surviving sessions. The UI promises "you can reactivate by logging back in" (`DangerZone.tsx:58`). No reactivation path exists anywhere — every deactivation requires operator DB surgery to undo.

### H6. `DELETE /feeds/:id` orphans feed-derived `external_subscriptions` **[verified]

`gateway/src/routes/feeds/crud.ts:391-393` deletes the feed; `feed_sources` cascades away without ever passing through `removeSource` — no last-feed check, no subscription delete, no `markFollowListDirty`. Violates the feed-derived-subscription invariant by omission: the GC (`external-sources-gc.ts:41-44`) keys "orphaned" strictly on `external_subscriptions`, so the source polls forever; the author card stays "Following" with no surface left to undo it; a `nostr_external` follow stays on the published kind-3. Fires on every feed delete containing external sources. Fix: tear down like N `removeSource` calls under the `feed_sub:<owner>` advisory lock.

### H7. Scheduling a paywalled article with an empty free section publishes the entire paid body free **[verified]

`web/src/hooks/useArticleEditorInit.ts:241-244` — `data.freeContent && data.paywallContent` is falsy when the gate sits at the very top (legal: validation checks only `paywallContent` non-empty, `publish-validation.ts:21`), so the schedule-save falls back to `data.content`, which `ArticleEditor.tsx:350` built with `PAYWALL_GATE_MARKER` already stripped. The scheduler finds no marker (`scheduler.ts:135`) and publishes the whole body as a free public article. Publish-now handles the same input correctly; only the schedule path is broken.

### H8. Scheduling an article "Publishing as <publication>" publishes it to the personal profile **[verified]

`useArticleEditorInit.ts:245-254` — `handleSchedule`'s `saveDraft` call omits `publicationId` (the field exists end-to-end: `drafts.ts:26` client, `drafts.ts:34` gateway schema, and the scheduler branches on `draft.publication_id`). A scheduled publication article silently publishes as personal — wrong byline, wrong surface, bypasses review/splits.

### H9. Comp-subscription grant can never execute — `ON CONFLICT` has no arbiter **[verified — empirically: 42P10 raised in dev Postgres]

`gateway/src/routes/subscriptions/subscribers.ts:154-163` — `ON CONFLICT (reader_id, writer_id)` with no `WHERE writer_id IS NOT NULL` predicate; migration 038 replaced the full unique with the partial `idx_subscriptions_reader_writer … WHERE (writer_id IS NOT NULL)` (`schema.sql:4898`), and Postgres refuses to infer a partial index without a matching predicate. Plan-time error on **every** execution:

```
ERROR:  there is no unique or exclusion constraint matching the ON CONFLICT specification
```

Every first-time comp grant 500s — and per CONSOLIDATED-TODO §1.10 this endpoint is "the functional gift mechanism." Reactivations survive via the SELECT-then-UPDATE branch. Fix: append `WHERE writer_id IS NOT NULL`.

### H10. `web:3010` and `strfry:4848` are published on 0.0.0.0 — and Docker's iptables bypass UFW on prod **[verified — compose bindings confirmed]

`docker-compose.yml:308` (`"3010:3000"`), `:57` (`"4848:7777"`) — unlike postgres/gateway, which are `127.0.0.1`-bound. Docker-published ports DNAT in the `DOCKER` chain before UFW's INPUT rules (the classic bypass), so `harden-server.sh`'s allowlist (22/80/443) does not protect them. On prod, `http://all.haus:3010` serves the whole app over plaintext — and since Next.js rewrites `/api/*` → `http://gateway:3000`, **the entire API surface is reachable on :3010, bypassing nginx** (no TLS, no security headers, no `/media` read-only lock). `:4848` exposes the raw relay. Fix: bind both to `127.0.0.1:` (nginx reaches them by service name over the compose network) or add DOCKER-USER rules.

### H11. Jetstream dead zone: between ~40 and 149 active atproto sources, the listener can never connect

`feed-ingest/src/jetstream/listener.ts:505` builds the filtered-mode URL with one `wantedDids` param per DID (~48 chars each) and passes it to `pinnedWebSocketOptions`, whose default `maxLength` is 2048 (`http-client.ts:410-413`) — exceeded at ~40 DIDs. Wildcard mode only engages at `WILDCARD_DID_THRESHOLD = 150` (`:61`). In between, connect throws, is caught (`:507`) and retried forever with the same URL; all Bluesky live ingest degrades to the poll fallback, which uses `posts_no_replies` and never applies deletes. FIX-PROGRAMME #29's wildcard fix reconciled against Jetstream's server cap but not the repo's own 2048-char client cap. Fix: larger `maxLength` for this URL or drop the threshold below ~35.

### H12. External parent/thread prefetch mints doppelgänger `external_authors` from origin-shaped `author_uri`

`feed-ingest/src/tasks/external-parent-prefetch.ts:361` passes `https://bsky.app/profile/<did>` and `:481` passes the Mastodon web URL (`status.account.url`) as `author_uri`; the identity trigger mints `external_authors.stable_handle` directly from that value (`schema.sql:461-466`). EXTERNAL-AUTHOR-HISTORY-ADR pinned exactly this in the profile-hydration fetchers but not here. The doppelgänger author gets the thread byline (`/author/<empty-profile>`); when the post is later ingested for real, promotion clears flags and re-homes `source_id` but never rewrites `author_uri`/`feed_items.external_author_id`, so the post is **permanently** filed under the wrong author — missing from the real profile, invisible to author-level deletions, a duplicate identity in discovery. Gateway shares the defect (`external-hydration.ts:252`, `external-items/{parent,thread,quote}.ts`).

### H13. Jetstream reconnect leaks live sockets on every DID-set refresh

`feed-ingest/src/jetstream/listener.ts:542-555` — the `close` handler unconditionally nulls `this.ws` and schedules a reconnect without checking it belongs to the closing socket. `refreshDids` (`:306-315`) closes socket A and immediately connects socket B; A's async close event then clobbers `this.ws = null` (orphaning B — still ingesting, unreachable even by `stop()`) and spawns socket C. Connection count multiplies across DID churn/network blips in a long-lived process; duplicate ingest is masked by ON CONFLICT but doubles load. Fix: `if (this.ws !== ws) return;` guard (or a generation token).

### H14. Mobile: opening the reader/profile from any guarded sheet instantly closes it (back-guard pops the successor's URL)

`web/src/lib/backGuard.ts:73-83` — on unregister, the guard assumes its sentinel is the top history entry and fires a balancing `history.back()` with only its own listener suppressed. Supersede order violates the LIFO premise: tapping an article in Library/Dashboard/Messages/Network pushes the reader's URL first, *then* unmounts the sheet, so the cleanup `history.back()` pops the **reader's** entry; `ReaderOverlay`'s own popstate handler (`reader.ts:311`) closes the just-opened reader. Every reader/profile open from a guarded mobile sheet flashes and self-closes. Desktop unaffected.

---

## MEDIUM

**Money & payments**

1. **Reconcile `ledger_orphans` false-positives on every legitimate `transfer.reversed`, halting all payouts.** `payment-service/src/services/reconcile-ledger.ts:116-117` (and `scripts/reconcile-ledger.sql:224-225`) looks up `*_payout_reversal` trigger refs in `tab_settlements` regardless of `ref_table`, but the three reversal handlers post refs to `writer_payouts`/`publication_payout_splits`/`tribute_payouts` (`payout.ts:894/2196/1964`). One real reversal ⇒ `haltPayouts()` on the next run, recurring forever (append-only entry) until a human resumes. Fix: predicate on `(trigger_type, ref_table)` pairs.
2. **Pledge fulfilment inserts `read_events` with NULL `tab_id` — pledger charged, writer never paid.** `gateway/src/routes/drives.ts:804-810` omits `tab_id` (the adjacent `applyLedgerDelta` at `:827` even returns it); `confirmSettlement` advances reads `WHERE tab_id = $2` (`settlement.ts:597-606`), so the read never reaches `platform_settled` and no `writer_accrual`/payout ever fires, while the tab debit is real and collected. Pledges are parked, so latent — HIGH on revival; distinct from the tracked §0d.1 withdrawal-guard item.
3. **Chargeback during a reserved-but-pending payout pays out clawed-back money with no reversing entry.** `chargeback.ts:226-237` reverses only `state === 'writer_paid'`; a read claimed by a *pending* payout keeps its fixed `amount_pence` (`payout.ts:670-673`), which the resume sweep then transfers in full. The identical tribute-accrual case was deliberately closed (`chargeback.ts:33-45`); the read case (and the publication-split analogue, `settlement.ts:958-962` vs `resumePendingPublicationPayouts`) was not.
4. **`computePublicationSplits` bps overrides aren't clamped to the remaining pool.** `payout.ts:110-130` — flat fees check `remainingPool`, bps overrides compute against `articleNet` unchecked, and the floor-at-0 only protects standing shares; combined flat+bps splits can pay out more than the pool (platform funds the difference). Adjacent: the shares load (`:1244-1248`) has no `ORDER BY`, so which fee wins when short is nondeterministic.

**Gateway / auth**

5. **`GET /publications/:id/members` has no auth and leaks revenue splits.** `publications/members.ts:51-70` — no preHandler; any anonymous caller gets every member's account id, permission matrix, and `revenue_share_bps` for any publication. The intended public projection is the masthead route (role/title/name only).
6. **Publication unpublish leaves the article in all workspace feeds.** `publications/cms.ts:341-355` nulls `published_at` with no `feed_items` cleanup (personal unpublish deletes them; feed queries never re-check `published_at`). Daily reconcile is `ON CONFLICT DO NOTHING` and won't remove it either.
7. **`GET /articles/by-event/:id` serves unpublished (withdrawn) articles** — no `published_at IS NOT NULL` (`articles/publish.ts:380-391`), unlike the sibling by-dTag route; any authed user with the event id reads metadata + full `content_free` after withdrawal.
8. **Event-id squatting on `POST /articles` / `POST /notes`.** Client-supplied `nostrEventId` is trusted with no ownership/signature verification; the web pipeline enqueues the relay publish *before* indexing, so a relay-watcher can register the victim's event id under their own `writer_id` first — the victim's index call then dies on the unique violation (articles: unhandled 23505 → 500; notes: silent `duplicate: true`, never indexed).
9. **`can_manage_members` alone can mint an `editor_in_chief`** (`publications/members.ts:76-109`) — invite accepts `role: 'editor_in_chief'`, accept path applies `ROLE_DEFAULTS`, so a members-manager can grant a colluding account finance/settings powers above their own.
10. **Magic-link single-use is SELECT-then-UPDATE, not atomic** (`shared/src/auth/magic-links.ts:80-100`, found independently by two agents) — concurrent verifications of one token both mint sessions; the defence against email interception silently fails under a race. Fix: single atomic `UPDATE … WHERE used_at IS NULL … RETURNING`.

**Feeds / dedup / ingest**

11. **Dedup can pick a winner the final WHERE filters out — both copies hidden.** `dedup-sql.ts:96-122` computes suppression over `matched` (only `deleted_at` filtered), but `items.ts:281-286` applies context-only/reply filters *after*; a context-only or reply winner suppresses its visible twin, then is filtered itself. Exactly the failure SLICE-8 says the candidate universe must prevent. Fix: mirror the visibility predicates inside `candidates`.
12. **Feed merge 500s when both feeds carry the same `reach` source.** `crud.ts:461-476` — the duplicate guard enumerates four source types, omits `reach`; the move then violates `feed_sources_reach_uniq` and the unhandled 23505 rolls back the whole merge. Common with starter-template feeds.
13. **`feed_saves` cursor truncates to whole seconds** (`saves.ts:69` casts before ×1000) while comparing full-precision timestamps → duplicates/skips at page boundaries when several saves land in one second; same class in `placeholderExploreItems` (`items.ts:343/375-380`) and the author log cursor (`author.ts:523/554`).
14. **RSS: one unparseable `pubDate` eventually kills the whole feed.** `adapters/rss.ts:163-175` — `new Date()` never throws (dead try/catch) and `NaN > x` is false, so an Invalid Date passes the future-guard, poisons the batched INSERT, fails the whole fetch, and after 10 polls deactivates the source. Same gap in `parseJsonFeed` (`:403-412`); AP/atproto both guard with `isNaN`.
15. **`external-items-prune` guards broken two ways + a permanent wedge.** `external-items-prune.ts:19-31`: the reply-thread guard is `WHERE FALSE` dead code, so at 90 days a native reply's external parent is deleted (`ON DELETE SET NULL`) and the thread breaks; `citation_edges.source_external_item_id` has **no** ON DELETE action, so one old citation edge fails the DELETE every night and nothing is ever pruned again (unbounded growth; same wedge for `external-context-gc`/sources-gc Phase B); both prunes filter `deleted_at IS NULL`, so tombstoned (author-deleted) content is the one class retained forever — inverted retention with privacy implications.
16. **RSS guid dedup is global, enabling cross-feed suppression.** `feed-ingest-rss.ts:179` + `UNIQUE (protocol, source_item_uri)` (`schema.sql:3544`) — the raw guid isn't namespaced by source; colliding guids (multi-category CMS feeds, or a hostile feed replaying a competitor's guids) attribute the row to whoever fetched first, so the second source's followers never see it.
17. **Email fuzzy dedup drops distinct newsletters globally.** `email-ingest.ts:41-55` — title ± 1h match scoped by *shared subscriber* decides not to write the row **at all**, so subscriber B of source Y loses Y's issue because subscriber A also gets a same-titled issue from X.
18. **Nostr poll interval never resets on success.** `feed-ingest-nostr.ts:235-258` writes no `fetch_interval_seconds` on success (error path backs off up to 19,200s), so a recovered source polls every ~5.3h forever; same omission in the backfill completer. AP resets on every success; RSS is adaptive.

**Web frontend**

19. **"Allow replies" is dead at publish time** — `PublishData.commentsEnabled` is collected but transmitted by neither `publishArticle` nor `submitArticle`; the gateway index route has no such field. Unchecking it does nothing; edit-load also hardcodes `commentsEnabled: true` (`useArticleEditorInit.ts:154`).
20. **The dek/standfirst is silently dropped by the whole draft pipeline** — client sends `dek`, the gateway drafts schema has no such field (Zod strips), GET returns none; reopening a draft loses it and a scheduled article publishes with no summary and no NIP-23 `summary` tag.
21. **Editor close discards work silently** — autosave fires only from TipTap body edits (title/dek/price changes schedule nothing, so a title-only new article has zero persisted state), and close/supersede cancels the pending debounce with no flush or dirty-check (`ArticleEditor.tsx:144/195-217`, `EditorOverlay.tsx:56`).
22. **Escape closes both the Lightbox and the Glasshouse under it** — uncoordinated document/window keydown listeners (`LightboxOverlay.tsx:21-34`, `Glasshouse.tsx:493-497`); for URL-synced panes that also fires their `history.back()`.

**Infra / shared**

23. **strfry is open-write and the config header claims otherwise.** `relay/strfry.conf` has no `writePolicy`/plugin; the relay is public at `wss://all.haus/relay`, so anyone can publish arbitrary signed events into the platform's own relay — spam/disk-fill toward the 8GB LMDB cap (which would then also break legitimate publishes), or injection of foreign kind-30023s/9901 "receipts" served to any unfiltered query. Needs a write-policy allowlist of custodial pubkeys, independent of the H10 port fix.
24. **migrate.ts has no advisory lock against concurrent runners** — two simultaneous manual runs double-apply; for the no-transaction path (`ALTER TYPE`/`CONCURRENTLY`) a partial double-apply can't roll back. One `pg_advisory_lock` closes it. (Distinct from the tracked §7.12 CONCURRENTLY-regex item.)
25. **safeFetch forwards `Authorization` and the body unchanged across cross-origin redirect hops** (`http-client.ts:285-339`); `activitypub-resolve.ts:298` threads a user's Mastodon token through it, so a 302 to a third-party host re-sends the token. Strip auth headers on host change; convert 301/302/303 POST→GET.

---

## LOW

1. `approveAndPublishArticle` has no `deleted_at`/status guard (`publication-publisher.ts:346-359`) — publish on a soft-deleted article re-signs a fresh 30023 (resurrecting content after its kind-5) and leaves DB/relay disagreeing.
2. Scheduler deletes the working draft even when the publication publish lands as an in-review submission (`scheduler.ts:68-77/:154`) — diverges from the publish-now invariant; also skips drive fulfilment for the submitted case while the delete SET-NULLs `pledge_drives.draft_id`.
3. Notifications + DM cursors paginate on bare non-unique `created_at` (`notifications.ts:27/74`, `messages.ts:272-274`) — boundary rows sharing the timestamp are dropped.
4. `useFollows.hydrate()` clobbers an optimistic follow raced against the initial fetch (`follows.ts:44-78`).
5. Schedule picker `min` mixes UTC into `datetime-local` (`ArticleEditor.tsx:768`) — west of UTC blocks near-term schedules, east permits the past; the `finally` also clears the picked time on failure.
6. `GET /trust/:userId` doesn't validate the UUID → Postgres 22P02 → 500 (`trust.ts:30-44`; the poll routes all validate).
7. "Cannot delete your only feed" guard is check-then-act with no lock (`crud.ts:380-393`) — two concurrent deletes can leave zero feeds (client self-heals).
8. `GET /thread/:postId` serves email-protocol items with no subscriber scoping (`post-thread.ts:92-98`) — unguessable sha256 ids in practice, but it's the one single-subscriber row type the public projector serves.
9. Identity-link targets aren't canonicalised (`identity-links.ts:56-58/:108-112`) — uppercase hex / trailing-slash URLs mint phantom `external_sources` rows and the link silently no-ops; also violates omnivorous input (no npub).
10. Subscription offer redemption burns `redemption_count` on the 409 path and the max-redemptions check is TOCTOU (`subscriptions/writer.ts:117-145`).
11. Reactivating a cancelled-but-still-paid subscription charges full price immediately, discarding the unexpired remainder (`writer.ts:147-164`; same in `publication.ts:75-101`).
12. `withTransaction` — failed ROLLBACK masks the original error and `release()` returns a poisoned client (`shared/src/db/client.ts:55-60`); use `client.release(err)`.
13. Internal-secret comparisons use `!==` instead of the project's `timingSafeEqual` convention (`key-custody/src/routes/keypairs.ts:28`, `key-service/src/routes/keys.ts:206/:274`).
14. atproto: unguarded `record.reply?.parent.uri` TypeErrors on a malformed reply; in the backfill it sits outside the per-entry try, so one bad record aborts the whole run permanently (`atproto.ts:455-464`, `feed-ingest-atproto-backfill.ts:217/229-257`; gateway twin is tracked, this instance is not).
15. Kind-5 tombstoning is two non-transactional pool statements and the cursor can advance past the deletion — a crash between them leaves a live feed card over a tombstoned item forever (`nostr-ingest.ts:400-417`).
16. `fetchNostrRelayEvents` buffers unbounded for the 10s window; engagement counts (dark-flagged) tally signature-unverified events, permanently inflatable (`nostr-ingest.ts:571-585`, `nostr-relay.ts:123-188`).
17. Ledger-adjacency guard bypass shapes beyond the tracked §0d.5: no-space `balance_pence=balance_pence+x`, aliased `t.balance_pence`, case/multi-line INSERT forms (`check-ledger-adjacency.sh:96-99`) — hardening notes for the tracked item.
18. NAT64 `64:ff9b::/96` absent from the blocked v6 ranges in http-client.ts (only relevant on NAT64 egress; negligible here).

---

## Verified clean (so it needn't be re-audited)

- **Ledger discipline**: all nine tab-write sites route through `applyLedgerDelta` (signed, unclamped, derived mirror); views match documented trigger sets; migration 119/124 append-only guards present; migration 121 opening-balance arithmetic correct; relay-outbox enqueue is a pure INSERT on the caller's client.
- **Settlement/payout three-phase**: row-stable idempotency keys, terminal/ambiguous split via `executeStripeIdempotent` at every create site; lock ordering consistent; webhook signature/livemode/dedup and partial-reversal delta-posting sound; payout halt gates all three cycles.
- **Gate pass**: Step 1b vault/price refusal precedes money; F3/F7/F14 correct. Publication pool keys exclusively on `read_events.publication_id`; sub earnings claim-first, settled-gated, post-fee, out of `total_pool_pence`; F5 denominator correct in both sites.
- **Custody/crypto**: AES-256-GCM (fresh IVs, tag-verified) for custodial keys and credentials; XChaCha20-Poly1305 envelopes; key buffers zeroed; export gated to the session subject + rate-limited; signing strictly session/membership-scoped; JWT HS256-pinned, secret-length enforced, no default secret anywhere.
- **Invariant sweeps**: relay-outbox-in-transaction at every gateway publish site; draft row-targeting + advisory lock; paywall lockstep + publication-paywall blocks; discovery double-gate; media BUD-02 hash-verify; nginx Blossom read-only lock; relay-free Nostr identity incl. repost edges; three-writer context-row promotion with dual `source_id` re-home; backfill vs poll job-key separation; tldts PSL for domain_match; `safeFetch`/`pinnedWebSocketOptions` on all outbound I/O (the C1 finding is the pin *working*, on the wrong target); feed-derived subscriptions on both `addSource` branches and `removeSource` (H6 is the bypass); follow-import one-way/exclusion-symmetry/truncation rules; component-based dedup closure; last-write-wins identity-link ops; `FEED_SCHEME_IDS` mirror; the `is_profile_hydrated` disjunct confined to the author log; migrate.ts ordering/checksums; ~50-site ON CONFLICT arbiter sweep (H9 the sole mismatch); web publish v1/v2 ordering + vault-failure soft-delete; Glasshouse supersede/presence token guards; rehype-sanitize + ingest-side sanitisation of external HTML.

## Suggested attack order

1. **C1 relay-outbox pin** (+ prod `relay_outbox` triage/redrive) — but land **H3** (kind-5 email leak) first or in the same change, since the redrive would publish any queued deletion events.
2. **H1 key-service gate** and **H10 port bindings** (both are one-file network-surface fixes).
3. **H2 subscription-convert** (disable the route or fix all four legs) and **H9 comp-grant arbiter** (one-line).
4. **H7/H8 schedule path** (paywall strip + publicationId) — content-integrity, cheap.
5. **H4 moderation**, **H5 reactivation**, **H6 feed-delete teardown**.
6. **M1 reconcile false-halt** before any real `transfer.reversed` arrives; then the remaining mediums by subsystem.
