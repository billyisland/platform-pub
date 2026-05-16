# ADR Conformance Matrix — 2026-05-15

Produced as Session 0.2 of the codebase review plan. Assessed all 18 files in `docs/adr/` against the `workspace-experiment` branch.

## Executive Summary

| ADR                            | Status             | Conformant | Partial | Missing   | Divergent | Notes                                              |
| ------------------------------ | ------------------ | ---------- | ------- | --------- | --------- | -------------------------------------------------- |
| RELAY-OUTBOX-ADR               | Live, complete     | 49         | 1       | 0         | 1         | All 6 phases shipped                               |
| RELAY-OUTBOX-PHASE-4-ADR       | Live, complete     | 14         | 0       | 0         | 0         | Publish-path rewrite done                          |
| UNIVERSAL-FEED-ADR             | Live, complete     | ~90        | 2       | 0         | 3         | Phases 1–5A shipped                                |
| ALLHAUS-REDESIGN-SPEC          | Live, active       | 47         | 2       | 4         | 1         | Steps 1–6 shipped; TODOs remain                    |
| ALLHAUS-OMNIBUS                | Live, active       | 47         | 0       | 4         | 0         | Phases 1–2+4 shipped; Phase 5/B future             |
| PUBLICATIONS-SPEC              | Live, complete     | ~68        | 2       | 1         | 1         | Phases 1–5 shipped                                 |
| EMAIL-ON-PUBLISH-SPEC          | Live, partial      | 10         | 0       | 14        | 0         | Phase 1 only; Phases 2–4 unbuilt                   |
| TRAFFOLOGY-MASTER-ADR-2        | Live, partial      | ~40        | 2       | ~20       | 1         | Foundation solid; interpreter incomplete           |
| CODE-QUALITY                   | Live, active       | 14         | 0       | 7         | 0         | Tier 1 shipped; Tiers 2–5 deferred per plan        |
| ALLHAUS-ADR-UNIFIED            | Live, aspirational | 3          | 2       | 3         | 1         | Dual-graph anonymity unbuilt; workspace superseded |
| GATEWAY-DECOMPOSITION          | Live, partial      | 2          | 0       | 3         | 0         | Step 1 done; Steps 2–3 outstanding                 |
| OWNER-DASHBOARD-SPEC           | Live, draft        | 0          | 0       | 10        | 0         | Entirely unbuilt                                   |
| UI-DESIGN-SPEC                 | Live, active       | 2 batches  | 1 item  | 4 batches | 0         | Batches 1–2 shipped; 3–6 outstanding               |
| WORKSPACE-EXPERIMENT-ADR       | Live, active       | 32         | 1       | 0         | 0         | All 32 slices shipped on branch                    |
| REDESIGN-SCOPE                 | Descriptive        | —          | —       | —         | 1         | Anti-workspace stance superseded by experiment     |
| platform-bucket-system-design  | Design notes       | 0          | 0       | 8         | 0         | Entirely unbuilt                                   |
| platform-pub-currency-strategy | Live, pending      | 1          | 0       | 5         | 0         | Option 2 (display currency) unbuilt                |
| WORKSPACE-MIGRATION-MAP        | Reference          | —          | —       | —         | —         | Route verdicts, not normative                      |

**Totals across normative ADRs:** ~400+ requirements checked. The core platform (relay outbox, universal feed, publications, redesign UI, trust graph, workspace experiment) is strongly conformant. Gaps concentrate in: unbuilt specs (owner dashboard, currency, bucket system), incomplete phases (email Phases 2–4, traffology interpreter, gateway decomposition Steps 2–3), and acknowledged future work (trust anonymity, UI batches 3–6).

---

## 1. Relay Outbox ADR + Phase 4 ADR

**Overall: 49/50 conformant. Implementation is thorough and complete across all 6 phases.**

### Phase 1 — Infrastructure

| Requirement                                                               | Status        | Evidence                                                                                                                  |
| ------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Migration 076 creates `relay_outbox` with spec schema                     | Conformant    | All columns, CHECK constraints, defaults match                                                                            |
| Unique index on `(signed_event->>'id')`                                   | Conformant    | `076_relay_outbox.sql:59`                                                                                                 |
| Partial index on `(next_attempt_at) WHERE status IN ('pending','failed')` | Conformant    | `076_relay_outbox.sql:53-55`                                                                                              |
| `enqueueRelayPublish` exists with spec signature                          | Conformant    | `shared/src/lib/relay-outbox.ts` — takes `PoolClient` + input, returns `{id, existed}`                                    |
| INSERT with ON CONFLICT DO NOTHING + RETURNING                            | Conformant    | `relay-outbox.ts:58-70`                                                                                                   |
| On insert, `graphile_worker.add_job` with `max_attempts := 1`             | Conformant    | `relay-outbox.ts:77-84`                                                                                                   |
| Worker: `SELECT FOR UPDATE SKIP LOCKED` claim                             | Conformant    | `relay-publish.ts:46-52`                                                                                                  |
| Worker: idempotent — returns on `status != pending/failed`                | Conformant    | `relay-publish.ts:59-62`                                                                                                  |
| Worker: `pg_try_advisory_xact_lock` per-entity serialisation              | Conformant    | `relay-publish.ts:64-75`                                                                                                  |
| Worker: all accepted → `status='sent'`, `sent_at=now()`                   | Conformant    | `relay-publish.ts:93-101`                                                                                                 |
| Worker: abandon at `max_attempts`                                         | Conformant    | `relay-publish.ts:127-143`                                                                                                |
| Worker: backoff `min(2^attempts * 1min, 1h)` with +/-10% jitter           | Conformant    | `relay-publish.ts:176-181`                                                                                                |
| Partial success delegation to adapter                                     | **Partial**   | ADR specifies `Promise.allSettled` in worker; implementation delegates to `publishNostrToRelays`. Functionally equivalent |
| Redrive cron every minute                                                 | Conformant    | `feed-ingest/src/index.ts:86`                                                                                             |
| Reconcile cron daily 04:30 UTC                                            | Conformant    | `feed-ingest/src/index.ts:88`                                                                                             |
| CHECK constraint on `entity_type`                                         | **Divergent** | Migration includes `drive_deletion` not in ADR. Benign addition for the deletion path                                     |

### Phase 2 — Fire-and-forget call sites

| Requirement                                                  | Status     | Evidence                                           |
| ------------------------------------------------------------ | ---------- | -------------------------------------------------- |
| `publishSubscriptionEvent` → `signSubscriptionEvent`         | Conformant | `nostr-publisher.ts:46` exports sign-only function |
| Subscription create/reactivate/cancel: sign + enqueue in txn | Conformant | `writer.ts:169-320` — all three paths verified     |
| Subscription expiry renew: sign + enqueue in txn             | Conformant | `subscription-expiry.ts:102-119`                   |
| Conversation pulse: sign + enqueue fire-and-forget           | Conformant | `messages.ts:590-605`                              |
| `nostr_event_id` written synchronously from signed event id  | Conformant | All paths UPDATE inside the txn                    |

### Phase 3 — Remaining awaited call sites

| Requirement                                                  | Status     | Evidence                                         |
| ------------------------------------------------------------ | ---------- | ------------------------------------------------ |
| `publishReceiptEvent` → `signReceiptEvent` (payment-service) | Conformant | `payment-service/src/lib/nostr.ts:75`            |
| Account deletion enqueues per-article kind-5 in txn          | Conformant | `auth.ts:470-488`                                |
| Article/note/publication soft-delete via txn enqueue         | Conformant | `manage.ts`, `notes.ts`, `cms.ts` — all verified |
| Drive events sign + enqueue in short txn                     | Conformant | `drives.ts:839-879`                              |
| `POST /sign-and-publish` enqueues (semantic change)          | Conformant | `signing.ts:90-135`                              |
| 13 call sites migrated total                                 | Conformant | All 13 verified individually                     |

### Phase 4 — Publish-path rewrite (separate ADR)

| Requirement                                                      | Status     | Evidence                                 |
| ---------------------------------------------------------------- | ---------- | ---------------------------------------- |
| `publishToPublication` calls `enqueueRelayPublish` in DB txn     | Conformant | `publication-publisher.ts:239-243`       |
| `approveAndPublishArticle` calls `enqueueRelayPublish` in DB txn | Conformant | `publication-publisher.ts:383-387`       |
| `signEvent` stays outside the txn (IO to key-custody)            | Conformant | Sign at line 151, txn starts at line 156 |
| `publishToRelay`/`publishToRelayUrl` deleted from codebase       | Conformant | grep returns zero functional matches     |
| Response shape unchanged on success (201 + metadata)             | Conformant | `publication-publisher.ts:255-261`       |

### Phase 5 — Scheduler contortion retired

| Requirement                                                             | Status     | Evidence               |
| ----------------------------------------------------------------------- | ---------- | ---------------------- |
| Free drafts: INSERT + feed_items + enqueue in one txn                   | Conformant | `scheduler.ts:175-260` |
| Paywalled drafts: two-txn shape, txn 2 UPDATEs + enqueues v2 atomically | Conformant | `scheduler.ts:262-294` |

### Phase 6 — Observability + integration tests

| Requirement                                                                                                           | Status     | Evidence                             |
| --------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------ |
| 10 test cases in `relay-publish.test.ts`                                                                              | Conformant | Exactly 10 `it()` blocks verified    |
| Tests cover: success, failure+retry, abandon, already-sent, skip-locked, lock contention, missing URL, deletion retry | Conformant | All 8 worker tests + 2 backoff tests |

---

## 2. Universal Feed ADR

**Overall: ~90 conformant, 3 divergences, 2 partial. Phases 1–5A faithfully implemented.**

### Schema (§IV)

| Requirement                                                    | Status        | Evidence                                                                                                                                  |
| -------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `external_protocol` enum (4 values)                            | Conformant    | Migration 052                                                                                                                             |
| `external_sources` — all columns + indexes                     | Conformant    | Migration 052 matches exactly                                                                                                             |
| `external_subscriptions` — columns + constraints               | Conformant    | Migration 052                                                                                                                             |
| `external_items` — all 20+ columns + CHECKs                    | Conformant    | Migration 052                                                                                                                             |
| `feed_items` — all columns + indexes                           | **Divergent** | Missing `content_html` column. Implementation reads via LEFT JOIN from `external_items` instead of denormalising. Functionally equivalent |
| `linked_accounts`, `outbound_posts`, `oauth_app_registrations` | Conformant    | Migrations 057–058                                                                                                                        |
| `atproto_oauth_sessions`, `atproto_oauth_pending_states`       | Conformant    | Migrations 059–060                                                                                                                        |
| `resolver_async_results`                                       | Conformant    | Migration 061                                                                                                                             |
| 13 `platform_config` keys                                      | Conformant    | Migration 052                                                                                                                             |

### Service Architecture (§V)

| Requirement                                                  | Status        | Evidence                                                                                                                        |
| ------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `feed-ingest`: Graphile Worker + Jetstream listener, no HTTP | Conformant    | `feed-ingest/src/index.ts`                                                                                                      |
| All cron jobs registered (12+ jobs)                          | Conformant    | All crontab entries verified                                                                                                    |
| Jetstream: leader election via `pg_try_advisory_lock`        | Conformant    | Session-scoped lock, 30s poll by non-leaders                                                                                    |
| Jetstream: 60s DID refresh, reconnect on change              | Conformant    | `DID_REFRESH_INTERVAL_MS = 60_000`                                                                                              |
| Jetstream: cursor resume from oldest across sources          | Conformant    | `oldestCursor()` function                                                                                                       |
| Jetstream: reconnect backoff 1s→30s                          | Conformant    | Doubles on each close, capped at 30s                                                                                            |
| Jetstream: `jetstream_healthy` flag in `platform_config`     | Conformant    | `setHealthy()` writes flag; poll reads it for fallback                                                                          |
| DID cardinality handling                                     | **Divergent** | Threshold at 150 DIDs (URL length), not ~10K. Falls back to firehose + client-side filtering. Different mechanism, same outcome |

### Universal Resolver (§V.5)

| Requirement                                                | Status     | Evidence                                                                                                                                                 |
| ---------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input classification — all pattern types                   | Conformant | `classifyInput()` covers URL, npub, nprofile, hex_pubkey, did, bluesky_handle, fediverse_handle, ambiguous_at, dotted_host, platform_username, free_text |
| `bluesky_handle` restricted to `.bsky.social`/`.bsky.team` | Conformant | Explicit suffix check                                                                                                                                    |
| Two-phase resolution: Phase A instant, Phase B async       | Conformant | Returns immediately with `status: 'pending'`; fires `resolveAsync()`                                                                                     |
| Async results persist in DB (not memory)                   | Conformant | `resolver_async_results` table, initiator-bound                                                                                                          |
| `dotted_host` concurrent atproto + URL probes              | Conformant | `Promise.all` with incremental `storePartial()`                                                                                                          |
| `invite`/`dm` contexts skip external chains                | Conformant | `skipExternal` gate                                                                                                                                      |
| Well-known RSS paths — parallelised, 5min TTL, 1000 cap    | Conformant | `Promise.all`, `WELL_KNOWN_TTL_MS`, size cap enforced                                                                                                    |
| Nostr kind-0 profile enrichment                            | Conformant | `fetchNostrProfile()` with 4s timeout                                                                                                                    |
| `POST /api/resolve` + `GET /api/resolve/:requestId`        | Conformant | Both endpoints with auth + rate-limit (30/min)                                                                                                           |

### Protocol Adapters (§VI)

| Requirement                                                                                            | Status     | Evidence                                                     |
| ------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------ |
| RSS: ETag/If-Modified-Since, rss-parser, sanitisation, dedup, dual-write, error backoff, deactivate    | Conformant | All requirements verified in `feed-ingest-rss.ts` + `rss.ts` |
| External Nostr: temp WS, kinds 1/30023/5, NIP-19 encoding, signature verification, cursor              | Conformant | `feed-ingest-nostr.ts`                                       |
| Bluesky: Jetstream listener, `at://` URIs, facets→HTML via `@atproto/api`, strong-ref chains, backfill | Conformant | `listener.ts` + `atproto.ts` + `atproto-ingest.ts`           |
| ActivityPub: outbox polling, public-only, cursor=id URI, instance health                               | Conformant | `activitypub.ts` + `feed-ingest-activitypub.ts`              |
| AT Protocol OAuth: confidential client, PKCE+DPoP+PAR, `private_key_jwt`, DB session store             | Conformant | `shared/src/lib/atproto-oauth.ts`                            |
| Outbound Mastodon: `Idempotency-Key`, federated reply via search resolve                               | Conformant | `activitypub-outbound.ts`                                    |
| Outbound Bluesky: `createRecord`, 300-grapheme truncation, reply strong-refs, quotes                   | Conformant | `atproto-outbound.ts`                                        |
| Outbound Nostr: WS publish to source relays                                                            | Conformant | `nostr-outbound.ts`                                          |

### Feed Assembly (§VII)

| Requirement                                        | Status      | Evidence                                                                                                                                                   |
| -------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-table query on `feed_items` with LEFT JOINs | Conformant  | `timeline.ts`                                                                                                                                              |
| Compound cursor `(published_at, id)`               | Conformant  | Verified                                                                                                                                                   |
| Per-source cap via windowed `ROW_NUMBER`           | **Partial** | Cap works but missing the rolling 24h window filter. Intentional — documented in CLAUDE.md: "no time-window filter so backfilled items appear immediately" |
| External items excluded from explore               | Conformant  | `item_type IN ('article', 'note')`                                                                                                                         |
| Explore: scored by `score DESC`, 48h window        | Conformant  | Verified                                                                                                                                                   |

### Security (§XVI)

| Requirement                                                                                         | Status     | Evidence                                    |
| --------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------- |
| Credential encryption with `LINKED_ACCOUNT_KEY_HEX`                                                 | Conformant | `encryptJson/decryptJson` in `crypto.ts`    |
| SSRF: private IP rejection, scheme check, 10s timeout, 5MB limit, 3 redirects, DNS-rebinding TOCTOU | Conformant | `http-client.ts` — all protections verified |
| HTML sanitisation allowlist matches ADR exactly                                                     | Conformant | `sanitize.ts`                               |
| Sanitisation at ingestion time (all 3 HTML-producing adapters)                                      | Conformant | Verified                                    |

### Feed Rendering

| Requirement                                         | Status     | Evidence                       |
| --------------------------------------------------- | ---------- | ------------------------------ |
| `ExternalCard` with provenance badges (4 protocols) | Conformant | `PROTOCOL_LABELS` map          |
| `at://` URIs rewritten to `bsky.app` URLs           | Conformant | `resolveUrl()` in ExternalCard |
| Mastodon BETA label                                 | Conformant | `label-ui text-amber-600`      |

### Backfill migration (§VII.2)

| Requirement                           | Status      | Evidence                                                                                                             |
| ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| Backfill via `ON CONFLICT DO NOTHING` | **Partial** | Migration 054 uses three monolithic `INSERT...SELECT` instead of batched 1000-row iterations. Works at current scale |

### Mastodon OAuth scopes

| Requirement                         | Status        | Evidence                                                                                                                                    |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR: `read:statuses write:statuses` | **Divergent** | Implementation uses `read:accounts write:statuses`. Broader read scope needed for `verify_credentials`. Justified but differs from ADR text |

---

## 3. Redesign Spec (ALLHAUS-REDESIGN-SPEC)

**Overall: 47 conformant, 2 partial, 4 missing (all marked TODO in spec), 1 divergent.**

### §1 Topbar

| Requirement                                                      | Status      | Evidence                                          |
| ---------------------------------------------------------------- | ----------- | ------------------------------------------------- |
| 60px black beam, fixed top, mono typography                      | Conformant  | `Nav.tsx` L335: `fixed top-0 bg-black h-[60px]`   |
| 4px crimson under-rule on active link                            | Conformant  | `navLinkClass(true)`: `border-b-4 border-crimson` |
| Wordmark: crimson mark 18px + Jost 18px, links to `/feed` or `/` | Conformant  | L297/L343-354                                     |
| Logo 360° spin on hover                                          | Conformant  | `logo-spin` class                                 |
| Nav: Feed / Dashboard only (authenticated)                       | Conformant  | L361-362                                          |
| COMPOSE button with `Cmd+K` hint                                 | Conformant  | L387-393, mono-caps styling                       |
| Search: borderless, 144→208px on focus                           | Conformant  | `w-36 bg-white/10 focus:w-52`                     |
| Avatar: 28px square, no border-radius                            | Conformant  | `NavAvatar`                                       |
| Canvas mode: crimson mark only + avatar                          | Conformant  | L292-329                                          |
| Focus-preference nav filtering                                   | **Missing** | Spec marks as TODO                                |

### §2 Feed Surface

| Requirement                                          | Status      | Evidence                                          |
| ---------------------------------------------------- | ----------- | ------------------------------------------------- |
| 780px column (`max-w-feed`), 40px rhythm             | Conformant  | `FeedView.tsx` L218, L240                         |
| 72px zone-break before brief runs                    | Conformant  | L240: `block.leadsBriefRun ? 72 : 40`             |
| Subscribe input sticky under topbar                  | Conformant  | `SubscribeInput` at `top-[60px]`                  |
| Filter bar (60px, sticky)                            | **Missing** | Spec marks as TODO                                |
| End-of-feed, zero state, filtered-empty, error state | Conformant  | All four components match spec exactly            |
| Error state: 3-failure gateway hint in 60s           | Conformant  | `failureTimestampsRef` with window check          |
| Infinite scroll with 1000px threshold                | **Partial** | No visible pagination/infinite scroll in FeedView |

### §3 Compose Overlay

| Requirement                                                  | Status     | Evidence                                    |
| ------------------------------------------------------------ | ---------- | ------------------------------------------- |
| Three modes: note/reply/article                              | Conformant | `stores/compose.ts`                         |
| 40% scrim, topbar visible                                    | Conformant | `bg-black/40`, `top: '60px'`                |
| 640px wide (760px article mode)                              | Conformant | Conditional `max-w-[640px]`/`max-w-[760px]` |
| 6px solid black top rule                                     | Conformant | `borderTop: '6px solid #111111'`            |
| Note mode: Jost 16px textarea, "What's on your mind?"        | Conformant | L183-184                                    |
| Reply mode: pinned preview of target                         | Conformant | `ReplyPreview` renders                      |
| Article mode: Literata 22px italic title, Tiptap, PUBLISH AS | Conformant | `ArticleComposePanel.tsx`                   |
| Double-escape dismiss with confirmation                      | Conformant | L47-68                                      |
| Mobile: full-screen bottom sheet, 90% height                 | Conformant | L282-291                                    |

### §4 Card Family

| Requirement                                      | Status     | Evidence                              |
| ------------------------------------------------ | ---------- | ------------------------------------- |
| 4px left bar: black/crimson/grey-300             | Conformant | All three cards verified              |
| 24px left padding                                | Conformant | `paddingLeft: '24px'`                 |
| Byline: mono-caps 11px, pip/author/dot/timestamp | Conformant | All three cards                       |
| No avatars                                       | Conformant | Verified                              |
| Action row: mono-caps 11px, tracking 0.02em      | Conformant | All three cards                       |
| Reply opens compose overlay                      | Conformant | All three call `openCompose('reply')` |

### §4a Article Tiers

| Requirement                                         | Status     | Evidence                       |
| --------------------------------------------------- | ---------- | ------------------------------ |
| Three tiers: lead 30px / standard 22px / brief 20px | Conformant | `ArticleCard` L79-82           |
| Brief: no excerpt, no tags                          | Conformant | L128-135                       |
| Two-up briefs: 40px gutter, condensed mono          | Conformant | FeedView L244, ArticleCard L84 |
| Adjacent briefs paired; odd remainder full-width    | Conformant | `layoutBlocks()` L43-57        |
| Migration 068 `size_tier` column                    | Conformant | Migration file exists          |

### §4 Playscript Threads

| Requirement                             | Status     | Evidence                        |
| --------------------------------------- | ---------- | ------------------------------- |
| Flat chronological, no nesting          | Conformant | `PlayscriptThread`: flat `<ol>` |
| 32px step-in, 32px rhythm               | Conformant | `ml-8`, `space-y-[32px]`        |
| Speaker line: pip + bold name + colon   | Conformant | PlayscriptReply L87-109         |
| `YOU:` for self, no pip                 | Conformant | L100-103                        |
| Non-adjacent parent arrow               | Conformant | L89-97                          |
| Dialogue: Jost 14.5px, 1.55 line height | Conformant | L117-128                        |
| Vote top-right, action row on hover     | Conformant | L66-83, L132                    |
| Pagination: first 10 + "SHOW N MORE"    | Conformant | `INITIAL_VISIBLE = 10`          |

### §5 Reading History

| Requirement                          | Status        | Evidence                                       |
| ------------------------------------ | ------------- | ---------------------------------------------- |
| Migration 069 `reading_positions`    | Conformant    | Migration exists                               |
| Debounced scroll + pagehide flush    | Conformant    | `useReadingPosition` hook                      |
| 10% grace zone                       | Conformant    | Implementation verified                        |
| Always-open-at-top preference        | Conformant    | Settings toggle exists                         |
| Reading-history surface              | **Missing**   | Spec marks as TODO                             |
| Bookmark replaced by reading-history | **Divergent** | `BookmarkButton` still rendered in ArticleCard |

### §6 Feed States

All four states (end-of-feed, zero, filtered-empty, error) are conformant — see §2 above.

---

## 4. Trust Graph (ALLHAUS-OMNIBUS)

**Overall: 47 conformant, 0 divergent, 4 missing (all acknowledged future work).**

### Layer 1 — Automatic Signals

| Requirement                                                                   | Status      | Evidence                       |
| ----------------------------------------------------------------------------- | ----------- | ------------------------------ |
| `trust_layer1` table                                                          | Conformant  | Migration 065                  |
| Daily cron (01:00 UTC)                                                        | Conformant  | `trust_layer1_refresh`         |
| Signals: account age, paying readers, article count, payment verified, NIP-05 | Conformant  | All computed in refresh task   |
| Subscriber count signal                                                       | **Missing** | Spec lists it; not computed    |
| Continuous activity (days since last pub)                                     | **Missing** | Spec lists it; not computed    |
| Pip: four states (known/partial/unknown/contested)                            | Conformant  | `trust-pip.ts` + migration 079 |
| Pip renders on all cards                                                      | Conformant  | All three card types           |
| `GET /trust/:userId` returns L1 + L2 + L4                                     | Conformant  | `trust.ts` L31-215             |

### Layer 2 — Vouches

| Requirement                                                            | Status     | Evidence                                  |
| ---------------------------------------------------------------------- | ---------- | ----------------------------------------- |
| `vouches` table: all columns + constraints                             | Conformant | Migration 066                             |
| Four dimensions, two values, two visibilities                          | Conformant | CHECK constraints match                   |
| Contests must be aggregate                                             | Conformant | CHECK + gateway validation                |
| Self-vouch prevention                                                  | Conformant | CHECK + gateway validation                |
| Upsert semantics                                                       | Conformant | `ON CONFLICT DO UPDATE`                   |
| Soft-delete withdrawal                                                 | Conformant | `DELETE` sets `withdrawn_at`              |
| All CRUD endpoints                                                     | Conformant | `POST/DELETE /vouches`, `GET /my/vouches` |
| VouchModal: dimension selector, visibility radio, aggregate disclaimer | Conformant | UI verified                               |
| VouchList on `/network?tab=vouches`                                    | Conformant | Component exists                          |

### Layer 4 — Relational Presentation

| Requirement                                | Status     | Evidence                                |
| ------------------------------------------ | ---------- | --------------------------------------- |
| Valued set: follows + active subscriptions | Conformant | `trust.ts` L150-153                     |
| Intersect with public endorsements         | Conformant | Explicit `visibility = 'public'` filter |
| "N writers you follow endorse…" text       | Conformant | Generated at L174                       |
| "No one in your network" fallback          | Conformant | L179                                    |
| Authenticated viewers only                 | Conformant | `if (viewerId && viewerId !== userId)`  |

### Epoch Aggregation

| Requirement                                                      | Status     | Evidence                                  |
| ---------------------------------------------------------------- | ---------- | ----------------------------------------- |
| Quarterly full epochs + Mon/Thu mop-ups                          | Conformant | Crontab entries verified                  |
| Full epoch increments `epochs_since_reaffirm`                    | Conformant | `trust-epoch-aggregate.ts` L51-57         |
| Mop-up: <10 attestations always scored; ≥5 changes threshold     | Conformant | `MOPUP_THRESHOLD = 5`                     |
| Freshness decay table (0→1.0 through 6+→0.0)                     | Conformant | `trust-aggregation.ts` L13-20 exact match |
| Small-scale decay protection                                     | Conformant | `decayRateMultiplier()` exact match       |
| Attestor weight = `age × payment × readership × activity`        | Conformant | `trust-weighting.ts` L25                  |
| Sub-formulas (age/365, payment 1.0/0.3, readers/50, articles/10) | Conformant | L20-23 exact match                        |
| Dry-run mode                                                     | Conformant | Checks `TRUST_DRY_RUN` and payload        |
| Pre-epoch fallback to live counts                                | Conformant | `trust.ts` L72-89                         |

### Phase 5 — Graph Analysis (future)

| Requirement                                               | Status      | Evidence                          |
| --------------------------------------------------------- | ----------- | --------------------------------- |
| Sybil detection, diversity weighting, cluster discounting | **Missing** | Not built; acknowledged as future |

### Phase B — Strong Anonymity (future)

| Requirement                                       | Status      | Evidence                         |
| ------------------------------------------------- | ----------- | -------------------------------- |
| Dual-graph, blind signatures, attestation service | **Missing** | Not built; not year-one per spec |

---

## 5. Publications Spec

**Overall: ~68 conformant, 2 partial, 1 missing, 1 divergent. Phases 1–5 shipped.**

### Data Model

All tables conformant: `publications`, `publication_members` (role defaults, ownership constraint), `publication_invites`, `publication_article_shares`, `publication_follows`, payout tables, article/draft/subscription extensions. Migration 038 matches spec exactly.

### Access Control

| Requirement                                        | Status     | Evidence                      |
| -------------------------------------------------- | ---------- | ----------------------------- |
| `checkArticleAccess` extended with `publicationId` | Conformant | `access-check.ts:28`          |
| Publication member free access                     | Conformant | Queries `publication_members` |
| `requirePublicationPermission()` middleware        | Conformant | Boolean perm checks           |
| `requirePublicationOwner()` middleware             | Conformant | Checks `is_owner = TRUE`      |

### Nostr Integration

All conformant: articles signed with publication key, `p` tags with author/publisher markers, key-custody `signerType`/`signerId`, `POST /sign` accepts `publicationId`.

### Revenue

All conformant: rate card routes, payroll with 10,000 bps cap, publication payout worker with orphan-safe reserve/process/finalise shape, idempotent Stripe transfers.

### Gateway API

| Requirement                       | Status        | Evidence                                                                                                               |
| --------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| All 20+ CRUD/management endpoints | Conformant    | `core.ts`, `members.ts`, `cms.ts`, `revenue.ts`, `public.ts`                                                           |
| Ownership transfer                | **Partial**   | Implemented but **no magic-link re-auth** — spec requires fresh verification                                           |
| Reader-facing articles route      | **Divergent** | Uses `/publications/by-slug/:slug/articles` instead of spec's `/publications/:slug/articles` (path conflict avoidance) |

### Notifications

| Requirement                                                                                                                           | Status      | Evidence      |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------- |
| `pub_article_submitted`, `pub_article_published`, `pub_new_subscriber`, `pub_member_joined`, `pub_member_left`, `pub_invite_received` | Conformant  | All verified  |
| `pub_payout_completed`                                                                                                                | **Missing** | Never emitted |

### Frontend

All conformant: 6 `/pub/[slug]/*` pages, 3 homepage layouts, CMS tabs, invite acceptance, API client namespace.

---

## 6. Email-on-Publish Spec

**Phase 1 conformant (10 requirements). Phases 2–4 entirely unbuilt (14 requirements missing).**

### Phase 1 (shipped)

| Requirement                                          | Status     | Evidence                                                |
| ---------------------------------------------------- | ---------- | ------------------------------------------------------- |
| Broadcast stream (`sendBroadcastEmail`)              | Conformant | `email.ts:95` with Postmark `MessageStream`             |
| `sendEmail` flag on `POST /articles`                 | Conformant | `publish.ts:31`                                         |
| Email template (avatar, title, excerpt, CTA, footer) | Conformant | `publish-email-template.ts`                             |
| `email_sent_at` on articles                          | Conformant | Migration 044                                           |
| Signed unsubscribe endpoint                          | Conformant | HMAC verification in `unsubscribe.ts`                   |
| Audience: paid subscribers only                      | Conformant | Queries `subscriptions` with `notify_on_publish = true` |
| Daily send cap (warm-up)                             | Conformant | In-memory counter with `BROADCAST_DAILY_SEND_LIMIT`     |

### Phases 2–4 (unbuilt)

- **Phase 2**: No `notify_on_publish` on `follows`/`publication_follows`. No `article_email_sends` log table. No follower recipient expansion. No notification toggles for follows.
- **Phase 3**: Publication publish paths don't trigger email. No `sendEmail` flag on CMS routes. No publication-specific subject format.
- **Phase 4**: No per-recipient delivery logging. No `GET /articles/:id/email-stats`. No dashboard display.

---

## 7. Traffology ADR

**Foundation solid (~40 conformant). Interpreter layer incomplete (~20 missing). 1 port divergence.**

### Phase 1 Step 1: Page Script + Ingest Service

All conformant: page script (<5KB, Beacon API, session dedup, scroll depth, active reading time), Zod-validated ingest endpoint, IP hashing, geoip, concurrent reader tracker, Docker services, Nginx proxy.

| Divergence  | Detail                                                                        |
| ----------- | ----------------------------------------------------------------------------- |
| Ingest port | ADR specifies 3004; implementation uses 3005. Nginx correctly proxies to 3005 |

### Phase 1 Step 2: Data Model + Aggregation

All conformant: `traffology` schema with 10 tables matching ADR, hourly/daily/weekly aggregation jobs, ranking pass, bounce definition.

### Phase 1 Step 3: Interpretation Layer

| Observation type                                                                  | Status                                             |
| --------------------------------------------------------------------------------- | -------------------------------------------------- |
| FIRST_DAY_SUMMARY                                                                 | Conformant                                         |
| ANOMALY_HIGH / ANOMALY_LOW                                                        | Conformant                                         |
| SOURCE_NEW                                                                        | Conformant                                         |
| SOURCE_BREAKDOWN                                                                  | Conformant                                         |
| MILESTONE_READERS                                                                 | Conformant                                         |
| ARRIVAL_CURRENT / ARRIVAL_NONE                                                    | **Partial** — templates exist, no generation logic |
| SOURCE_SHIFT, SOURCE_FAMILIAR, SOURCE_UNATTRIBUTED                                | **Missing**                                        |
| MILESTONE_GEO, MILESTONE_LONGEVITY, MILESTONE_SUBSCRIBERS                         | **Missing**                                        |
| ANOMALY_LATE_SPIKE, ANOMALY_READING_TIME, ANOMALY_SCROLL_DEPTH, ANOMALY_OPEN_RATE | **Missing**                                        |
| SUBSCRIBER_NEW/LOST/CONVERSION/REVENUE                                            | **Missing**                                        |
| CATCHUP, SYSTEM_DEGRADED                                                          | **Missing**                                        |
| Suppression windows, feed density control                                         | **Missing**                                        |

### Presentation Layer

Three screens (Feed, Piece, Overview) conformant. Provenance bar (IKB blue), temporal anchors, number formatting, and template voice all match spec. 18 of ~30 template cases handled.

### Source Resolution

| Requirement                  | Status      | Evidence                         |
| ---------------------------- | ----------- | -------------------------------- |
| Platform-internal resolution | Conformant  | `resolvePlatformInternal()`      |
| Known domain lookup          | **Partial** | 99 entries vs ADR's ~200         |
| Shortener redirect following | Conformant  | HEAD request + fallback          |
| UTM mailing list detection   | Conformant  | Checks `utm_medium`/`utm_source` |

### Tests

No test files for either traffology service (`--passWithNoTests` in both).

---

## 8. Code Quality ADR

**Tier 1 (CI + ESLint) fully shipped. Tiers 2–5 correctly deferred per ADR's own priority guidance.**

### Tier 1a: CI Pipeline — Conformant

All checks running: `tsc`/build all workspaces, Vitest, `next lint`, `npm audit`, knip.

### Tier 1b: Backend ESLint — Conformant

Flat config with `no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-unused-vars`, `no-explicit-any`, `no-duplicate-imports`. One omission: `consistent-type-imports` rule not present.

### Tiers 2–5 — Deferred (as planned)

Prettier, coverage reporting, dependency-cruiser, madge, squawk, SonarCloud — all deferred per ADR guidance for solo developer.

---

## 9. Workspace Experiment ADR

**All 32 slices conformant on branch. 1 partial (a11y floor).**

All slices verified: vessel rendering, chrome retirement, forall menu, composer (note/DM/cross-protocol/article), feeds schema+CRUD, feed composer+sources, vessel gestures (drag/resize/brightness/density/orientation), reset, rename/delete, fork, ceremony animation, card actions+reply, pip panel, inline threads, volume bar, trust polls, weighted items query, pip colour composition, encounter count, pip panel framing, feed saves, notifications anchor, search anchor, cards with media, vessel bar, collision detection, per-source volume, default volume, minimize/hide, forall menu updates, card expand, feed merge, source move.

Migrations 077–082 all present. localStorage persistence conformant. Mobile correctly deferred. A11y experiment floor **partial** — keyboard reachable, ARIA roles present, but full contrast verification and keyboard drag deferred per spec.

---

## 10. Remaining ADRs

### ALLHAUS-ADR-UNIFIED — Aspirational, partially superseded

Live document covering trust graph + workspace + payments. Trust public side (L1–L4) conformant via Omnibus implementation. **Dual-graph anonymous attestation** (§VII.1–VII.14) entirely unbuilt. Workspace section superseded by the workspace experiment ADR (different model). Three-tier payment model missing — only Tier 3 (fiat/Stripe) exists.

### GATEWAY-DECOMPOSITION — Partially implemented

| Step                                                                                | Status      |
| ----------------------------------------------------------------------------------- | ----------- |
| Step 1: Feed scorer extracted to feed-ingest                                        | Conformant  |
| Step 2: Messages service layer extracted                                            | Conformant  |
| Step 2: Remaining service extractions (publications, subscriptions, articles, auth) | **Missing** |
| Step 3: Extract messaging-service                                                   | **Missing** |

### OWNER-DASHBOARD-SPEC — Entirely unbuilt

All 10 requirements missing: no admin layout shell, no 6-tab structure, no overview/users/content/config/regulatory panels, no admin-dashboard gateway routes, no regulatory config migration.

### REDESIGN-SCOPE — Descriptive, partially superseded

Product philosophy document. Anti-workspace stance ("there is no workspace to build") **divergent** — directly contradicted by the workspace experiment. Trust-is-ambient and compose-as-mode conformant. Phase A/B items partially complete.

### UI-DESIGN-SPEC — Batches 1–2 shipped, 3–6 outstanding

Batches 1–2 (bookmarks, tags, unpublish, notification prefs, subscriber list, account deletion, change email/username, RSS discovery) all conformant. Batches 3–6 (~20 features across publication management, engagement, subscription depth, operational) outstanding.

### platform-bucket-system-design — Entirely unbuilt

Design notes only. No schema, routes, or UI. Use cases partially addressed by other systems (workspace feeds for curation, DM pricing).

### platform-pub-currency-strategy — Option 2 unbuilt

System correctly operates GBP-only. None of the five Option 2 deliverables (display_currency column, exchange rate endpoint, frontend conversion, author pricing preview, settings UI) have been implemented.

### WORKSPACE-MIGRATION-MAP — Reference only

Route verdicts document, not a normative spec. Used for guidance on what to keep/remove on merge.

---

## Cross-Cutting Findings

### 1. Workspace vs REDESIGN-SCOPE tension

REDESIGN-SCOPE explicitly declares "there is no workspace to build" while WORKSPACE-EXPERIMENT-ADR builds exactly that. The experiment is the active direction of travel. REDESIGN-SCOPE's anti-workspace stance is superseded in practice but no document formally retires it.

### 2. ALLHAUS-ADR-UNIFIED overlap

Covers the same trust graph ground as ALLHAUS-OMNIBUS (both marked Active), the same workspace ground as WORKSPACE-EXPERIMENT-ADR, and the same scope ground as REDESIGN-SCOPE. Its unique contribution — dual-graph anonymous attestation (§VII.1–VII.14) — is entirely unbuilt.

### 3. Significant unbuilt specs

Three specs have zero implementation: Owner Dashboard, Bucket System, Currency Strategy. Email-on-Publish has only Phase 1 of 4. These represent a substantial backlog of specced-but-unbuilt features.

### 4. Traffology interpreter gap

The traffology foundation is solid but only 5 of ~29 observation types have interpreter generation logic. Templates are further ahead (18 types) but can't fire without the interpreter. No tests exist for either traffology service.

### 5. BookmarkButton retention

The redesign spec says bookmarks are replaced by reading-history. `BookmarkButton` is still rendered on ArticleCard. Either the spec or the code needs updating.
