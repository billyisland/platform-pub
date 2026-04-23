# Relay Outbox — §60 specification

## Context

The platform writes signed Nostr events to relays at 13 call sites across gateway and payment-service. Every site follows the same pattern: mutate local state (INSERT/UPDATE the authoritative DB row), then `await publishToRelay(signed)`. If the relay publish throws, the caller handles it ad-hoc — scheduler retains the draft, publish-path returns 5xx, subscription-state fires `.catch(logger.error)`, deletion paths swallow quietly.

This produces three families of bug:

1. **Ledger-relay drift.** DB says `articles.deleted_at IS NOT NULL` but the kind-5 tombstone never hit the relay — readers fetching directly from the relay still see the article.
2. **Silent degradation.** `publishSubscriptionEvent` on renewal fires-and-forgets; a relay blip means the kind-7003 attestation is lost. Federated verifiers querying `GET /platform-pubkey` can't prove the subscription was active during the period.
3. **Ordering contortions.** FIX-PROGRAMME §1 fixed the scheduler's "v1 on relay, DB paywalled, v2 encryption failed" bug by inverting the sequence — v1 is now never published for paywalled articles. The contortion exists because publish is synchronous; with an outbox the natural order (DB → enqueue → worker publishes) has no such hazard.

The outbox pattern already exists for **outbound cross-posts** (Mastodon, Bluesky, external-Nostr) via `outbound_posts` + `enqueueCrossPost` + the `outbound-cross-post` Graphile task. §60 extends the same shape to native relay writes.

---

## Key Decisions

### D1: New table, don't overload `outbound_posts`

`outbound_posts` semantically means "cross-post a user's reply/quote to a linked external service". Native publishes have no linked account, no source item, no action type. Squeezing them in would require nullable everything and muddy the schema.

Introduce `relay_outbox` as a parallel table. Same worker infrastructure (Graphile), same enqueue-in-txn contract, separate lifecycle.

### D2: Phased migration — (c) then (a)

Phase the work so the correctness dividend on safe sites lands in week 1; the UX-sensitive publish-path migration is its own follow-up with its own spec.

**Phase 1–3 + 5–6 in programme one (~4 working days):**
- Infra: table + helper + worker + reconciliation cron
- Migrate the 14 fire-and-forget and swallowed-error call sites (Phases 2–3)
- Retire the §1 contortion in the scheduler (Phase 5)
- Backfill + observability (Phase 6)

**Phase 4 deferred to programme two (~2 working days, separate ADR):**
- Publish-path rewrite (personal articles, publication articles, scheduler v1/v2)
- Requires a UX decision on "publishing…" state vs. sync-blocking publish
- Once decided, the `pg_notify` nudge gives sub-second worker latency, so the looser semantics should be imperceptible

This ordering gets the biggest correctness wins (deletion retries, subscription attestation durability, receipt durability) without any user-visible change to the publish flow.

### D3: One `signed_event.id` = one outbox row (dedup)

Unique index on `(signed_event->>'id')`. A double-enqueue (retry on crash between sign-and-insert) hits ON CONFLICT and returns the existing row; the worker job is idempotent via the same key. Same model as `outbound_posts`.

### D4: Exponential backoff, abandon at max_attempts

Default `max_attempts = 10`, backoff `min(2^attempts * 1min, 1h)`. Past max_attempts the row is marked `abandoned` and surfaced to an ops dashboard. Matches the existing `outbound_posts` retry model.

### D5: Target relays as an array column, empty = platform relay only

Native publishes default to the platform's strfry relay. A later phase (writer NIP-65 outbox lists, federated relays) populates `target_relay_urls` per row. Treat empty array as "use `PLATFORM_RELAY_WS_URL`" to avoid per-row duplication of the default.

### D6: Monthly partition, archive `sent` rows after 30 days

Back-of-envelope: 10k users × ~5 state changes/month × 12 months ≈ 600k rows/year. Not huge, but the hot query (`status IN ('pending','failed') AND next_attempt_at <= now()`) degrades once `sent` rows dominate the index. Partition by `created_at` monthly; drop partitions older than 30 days after moving rows to a cold `relay_outbox_archive` table (or just drop — the signed event is already on the relay, the outbox row is audit only).

### D7: Shared helper lives in `shared/src/lib/relay-outbox.ts`

Gateway and payment-service both publish to the relay. Rather than duplicate the helper, put it in `shared/` alongside the existing crypto/env helpers. The helper takes a `PoolClient` so callers pass their own in-flight transaction.

---

## Data Model

### Migration 076_relay_outbox.sql

```sql
CREATE TABLE relay_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Entity binding — debug / reconciliation, not load-bearing
  entity_type TEXT NOT NULL
    CHECK (entity_type IN (
      'article', 'article_deletion',
      'note', 'note_deletion',
      'subscription',
      'receipt',
      'drive',
      'signing_passthrough',
      'conversation_pulse',
      'account_deletion'
    )),
  entity_id UUID,

  -- Payload
  signed_event JSONB NOT NULL,
  target_relay_urls TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- State machine
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'abandoned')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 10,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  sent_at TIMESTAMPTZ
);

-- Hot query: "give me the next jobs to run"
CREATE INDEX relay_outbox_ready_idx
  ON relay_outbox (next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- Dedup — same signed event can't be enqueued twice
CREATE UNIQUE INDEX relay_outbox_event_id_idx
  ON relay_outbox ((signed_event->>'id'));

-- Reconciliation
CREATE INDEX relay_outbox_entity_idx
  ON relay_outbox (entity_type, entity_id);
```

Monthly partition can be added in a follow-up migration once volume justifies it. Starting un-partitioned keeps the first migration minimal.

---

## Implementation

### `shared/src/lib/relay-outbox.ts`

```ts
interface EnqueueRelayPublishInput {
  entityType: RelayOutboxEntityType
  entityId?: string
  signedEvent: SignedNostrEvent
  targetRelayUrls?: string[]
  maxAttempts?: number
}

export async function enqueueRelayPublish(
  client: PoolClient,
  input: EnqueueRelayPublishInput,
): Promise<{ id: string; existed: boolean }>
```

- INSERT with `ON CONFLICT ((signed_event->>'id')) DO NOTHING RETURNING id`
- On insert, `graphile_worker.add_job('relay_publish', {outboxId}, job_key := 'relay_publish_' || outboxId, max_attempts := 1)` — `max_attempts := 1` so Graphile doesn't re-run; our own `attempts` column owns retry semantics
- On conflict, return existing row without re-scheduling
- Caller passes their open transaction; the helper does not commit or acquire its own connection

### `feed-ingest/src/tasks/relay-publish.ts`

Mirror of `outbound-cross-post.ts`. Per run:

1. `SELECT ... FROM relay_outbox WHERE id = $1 FOR UPDATE SKIP LOCKED` — claim the row
2. If `status != 'pending' AND status != 'failed'`, return (idempotency / late arrival)
3. Choose relay URLs: `target_relay_urls` if non-empty, else `[PLATFORM_RELAY_WS_URL]`
4. `Promise.allSettled(urls.map(u => publishToRelayUrl(u, signed_event)))`
5. All accepted → `UPDATE status='sent', sent_at=now()`
6. All rejected or network error → `attempts++`, if `attempts >= max_attempts` set `status='abandoned'`, else `status='failed'`, `next_attempt_at = now() + backoff(attempts)`, `last_error = ...`
7. Partial (some accepted, some rejected) → `status='sent'` with a warn log (per FIX-PROGRAMME §71 — one-accepts rule; divergence logged for signal). Note: rejecting relays are not retried once any relay has accepted — this is the deliberate cost of the one-accepts rule.

Backoff: `min(2^attempts minutes, 1 hour)` with ±10% jitter.

### Re-drive cron

`relay_outbox_redrive` task, `* * * * *` (every minute): `SELECT id FROM relay_outbox WHERE status IN ('pending','failed') AND next_attempt_at <= now() LIMIT 100` → `graphile_worker.add_job` for each. Covers the case where the original `add_job` is lost (Graphile DB crash) and provides a second heartbeat independent of the enqueue path.

### Reconciliation cron

`relay_outbox_reconcile`, daily 04:30 UTC: emit metrics only.

- `COUNT(*) WHERE status='abandoned'` — alert if > 0 (these are manual intervention)
- `COUNT(*) WHERE status='failed' AND attempts > 3` — ops signal
- `COUNT(*) WHERE status='sent'` rolling 24h — throughput metric

No attempt to reconcile DB entities against outbox rows — the outbox is the record of what was published; drift between entity state and outbox state is a symptom, not a source of truth worth rebuilding.

---

## Call-site migration table (Phases 2–3)

| File:line | Current shape | Entity | Treatment |
|---|---|---|---|
| `subscriptions/writer.ts:167` | fire-and-forget | subscription | enqueue in txn |
| `subscriptions/writer.ts:228` | fire-and-forget | subscription | enqueue in txn |
| `subscriptions/writer.ts:299` | fire-and-forget | subscription | enqueue in txn |
| `workers/subscription-expiry.ts:102` | fire-and-forget | subscription | enqueue in txn |
| `services/messages.ts:596` | `.catch` | conversation_pulse | enqueue (fire-and-forget stays fire-and-forget; outbox adds durability) |
| `auth.ts:479` | awaited | account_deletion | enqueue in txn |
| `articles/manage.ts:198` | awaited | article_deletion | enqueue in txn |
| `notes.ts:284` | awaited | note_deletion | enqueue in txn |
| `publications/cms.ts:218` | awaited | article_deletion | enqueue in txn |
| `drives.ts:839` | awaited | drive | enqueue in txn |
| `drives.ts:868` | awaited | drive | enqueue in txn |
| `signing.ts:115` | awaited | signing_passthrough | enqueue (no txn — this is a passthrough endpoint, no local state). **API semantic change**: 200 currently means "event on relay"; post-migration it means "event signed and enqueued". Clients relying on the old semantic will need a status poll or resigned contract. |
| `payment-service/src/lib/nostr.ts:97` | awaited | receipt | enqueue in txn |

Every row wraps the enqueue in the caller's existing transaction where one exists; the signed event itself does not need to be re-computed on retry because it's stored verbatim in `signed_event`.

### Phase 4 (deferred — own spec)

| File:line | Current shape | Notes |
|---|---|---|
| `services/publication-publisher.ts:147` | awaited, 5xx on failure | publication article v1 |
| `services/publication-publisher.ts:312` | awaited, 5xx on failure | publication article v2 |
| `workers/scheduler.ts:252` | awaited, retain draft | scheduled v2 |
| `workers/scheduler.ts:265` | awaited, retain draft | scheduled v1 |
| `routes/articles/publish.ts` | awaited, 5xx on failure | personal draft publish |

These share a UX contract: the handler returns after the relay has accepted the event. Migrating requires either (a) looser "publishing…" semantics with `pg_notify` sub-second nudge, or (b) a two-phase "enqueue + await outbox row flip to `sent`" inside the handler (still blocks the response but gets the retry benefit). Decision belongs in the follow-up ADR.

---

## Phase 5: retire the §1 contortion

`gateway/src/workers/scheduler.ts::publishPersonalDraft` currently does this order to avoid the original §1 bug:

1. Sign v1 (no publish)
2. INSERT article row keyed on v1.id
3. Create vault via key-service (which verifies the article row exists)
4. Sign v2
5. Publish v2 to relay  ← only this reaches the relay
6. UPDATE article + feed_items to v2.id in one txn

With the outbox, the natural order returns:

1. Sign v1, sign v2 (paywalled only), create vault
2. In one txn: INSERT article + feed_items with final event id, enqueue v2 (paywalled) or v1 (free) into `relay_outbox`
3. Commit; worker publishes

No intermediate DB state that references an unpublished event. The vault-ownership check still runs against the article row, which exists before the relay publish — the ordering constraint is preserved, the hazard is gone.

---

## Risks

1. **Volume** — ~600k rows/year at steady state. Monitor via the reconciliation cron metrics; add monthly partitioning if `relay_outbox_ready_idx` degrades. Not required for launch.

2. **Ordering across entity** — a subscription cancel followed by a reactivate writes two outbox rows; the worker might pick them up in parallel. Most relays accept out-of-order kind-7003 events (each is timestamped). For kind-30023 articles this is a non-issue (replaceable-event semantics collapse by `d`-tag). The Phase 1 worker ships with a transaction-scoped `pg_try_advisory_xact_lock` keyed on `(entity_type, entity_id)` so concurrent workers on the same entity skip and let the minute redrive pick them up serially; the row-level `FOR UPDATE SKIP LOCKED` still does the per-row claim.

3. **Payment-service coupling** — `payment-service/src/lib/nostr.ts:97` publishes kind-9901 receipts. Either (a) move the helper to `shared/` and import from both services, or (b) give payment-service its own outbox table. Preferring (a) — same table, same worker, same observability.

4. **Test migration** — `scheduler.test.ts`, `publication-publisher.test.ts`, and payment-service integration tests currently assert "relay has event after publish()". Options: (i) stub the worker inline to run synchronously during tests, (ii) move tests to assert "outbox row exists with status='pending'" and test the worker separately, (iii) expose an `async flushRelayOutbox()` helper for tests. Recommend (ii) — truer to the new semantics.

5. **Relay auth / future federation** — strfry currently accepts all events signed by known pubkeys; future NIP-42 auth or a rate-limited federation endpoint could change that. The outbox model handles this well — if the relay rejects with a recoverable error (e.g. 429), the row sits `failed` and retries; a permanent reject (`invalid signature`) abandons after max_attempts and alerts.

6. **Migration rollback** — the new call-site shape (enqueue-in-txn) is a one-way door. A rollback would need both the code reverted and `pg_dump | grep relay_outbox` rows re-published by hand. Deploy with the reconcile metrics in place and a one-week observation window before considering Phase 4.

---

## Open questions

1. **Worker location** — gateway or feed-ingest?
   - feed-ingest has Graphile Worker wired and already owns `outbound-cross-post`, `source-metadata-refresh`, `feed-items-reconcile`, etc. Putting `relay-publish` there is the lowest-friction choice.
   - Counter-argument: feed-ingest is currently "read external feeds and ingest". Adding "write to our own relay" broadens its responsibility. But the same was true when `outbound-cross-post` landed.
   - **Lean: feed-ingest.** Rename the package if the mental model gets confusing — "ingest-and-outbound" is honest — but that's a cosmetic decision, not a design one.

2. **Should the helper support `TEXT` entity_ids?** — most of our entities are UUID but `signing_passthrough` has no entity at all (it's a passthrough for user-signed events). Current plan: `entity_id UUID NULL` and `signing_passthrough` rows have `entity_id = NULL`. Reconciliation loses a trace for passthrough events, but signing is already non-load-bearing.

3. **Should Phase 4 happen at all?** — current sync publish is correct (it blocks until relay accepts, returning 5xx on failure) and the UX is clean. The dividend of moving to outbox is "retry on relay blip instead of surfacing a 5xx to the user", which may or may not be worth the "publishing…" latency. Decision belongs in the Phase 4 follow-up; possible outcome is "leave publish-path as-is, revisit after a year of production data on how often publish actually fails".

---

## Acceptance criteria (programme one)

- Migration creates `relay_outbox` with schema above
- `shared/src/lib/relay-outbox.ts::enqueueRelayPublish` exists, tested
- `feed-ingest/src/tasks/relay-publish.ts` worker runs, tested against a local relay
- 13 call sites migrated to `enqueueRelayPublish`
- `relay_outbox_redrive` cron runs per minute
- `relay_outbox_reconcile` cron runs daily, emits counts
- Scheduler v1/v2 ordering dance (§1 contortion) retired
- Pre-existing deletion paths demonstrably retry on simulated relay failure (integration test)
- No regression in any of the 155 backend tests
- Knip clean on the default gate

## Phase 1 landed (infra)

- `migrations/076_relay_outbox.sql` — table + `relay_outbox_ready_idx`, unique index on `signed_event->>'id'`, and `(entity_type, entity_id)` reconciliation index
- `shared/src/lib/relay-outbox.ts` — `enqueueRelayPublish(client, input)` with ON CONFLICT dedup; schedules the graphile-worker job inside the caller's transaction
- `feed-ingest/src/tasks/relay-publish.ts` — worker with `FOR UPDATE SKIP LOCKED` row claim, `pg_try_advisory_xact_lock` per-entity serialisation, own retry semantics with ±10% jitter, reuses existing `publishNostrToRelays` adapter
- `feed-ingest/src/tasks/relay-outbox-redrive.ts` — minute cron, batches 100, distinct `job_key` per tick
- `feed-ingest/src/tasks/relay-outbox-reconcile.ts` — daily cron at 04:30 UTC, emits `abandoned` / `failed_high_retry` / `sent_last_24h`

## Phase 2 landed (fire-and-forget + swallowed-error call sites)

All five non-awaited call sites now sign + enqueue in a single transaction. `publishSubscriptionEvent` was split into `signSubscriptionEvent` (returns a `SignedNostrEvent`); the publish step is owned by the `relay_publish` worker.

- `gateway/src/lib/nostr-publisher.ts` — `publishSubscriptionEvent` replaced by `signSubscriptionEvent`
- `gateway/src/routes/subscriptions/writer.ts` — create, reactivate, cancel now sign + `enqueueRelayPublish` inside `withTransaction`; cancel picked up a txn (was bare `pool.query`). `nostr_event_id` now written synchronously from the signed event id inside the same txn
- `gateway/src/workers/subscription-expiry.ts` — renew branch signs + enqueues inside the existing `withTransaction` block; `nostr_event_id` persists atomically with the period roll
- `gateway/src/services/messages.ts` — `publishConversationPulse` signs via `signEvent` and enqueues (entity_type = `conversation_pulse`) inside a short `withTransaction`; caller semantics unchanged (fire-and-forget `.catch`)

## Phase 3 landed (remaining awaited call sites)

Eight call sites migrated to enqueue-in-txn. Per risk #3 the payment-service receipt helper was refactored to sign-only; publishing now flows through the shared `relay_publish` worker. All deletion paths fold the sign + DB update + enqueue into a single transaction so a crash can't leave the DB marked deleted while the relay still serves the event.

- `payment-service/src/lib/nostr.ts` — `publishReceiptEvent` replaced by `signReceiptEvent`; `publishToRelay` helper deleted
- `payment-service/src/services/accrual.ts` — `publishReceiptAsync` signs then `withTransaction(UPDATE read_events + enqueueRelayPublish)`; retry now owned by `relay_outbox`, no bespoke fallback
- `gateway/src/routes/auth.ts` — account-deletion loop enqueues per-article kind-5 tombstones inside the existing `withTransaction`
- `gateway/src/routes/articles/manage.ts` — article soft-delete folds the deletion event into the existing `withTransaction` with `articles`/`feed_items` updates
- `gateway/src/routes/notes.ts` — note deletion now runs DELETE + enqueue in a single txn
- `gateway/src/routes/publications/cms.ts` — publication article soft-delete wrapped in `withTransaction`; UPDATE + sign + enqueue atomic
- `gateway/src/routes/drives.ts` — `publishDriveEvent` + `publishDriveDeletion` sign + enqueue in a short txn; caller `.catch` pattern preserved
- `gateway/src/routes/signing.ts` — `POST /sign-and-publish` now signs + enqueues. **API semantic change**: 200 means "signed and durably queued" rather than "event on relay"

Phases 5, 6 (§1 scheduler retirement, backfill + integration tests) still to land. Phase 4 (publish-path rewrite) remains deferred to its own ADR.

## Phase 5 landed (scheduler §1 contortion retired)

`gateway/src/workers/scheduler.ts::publishPersonalDraft` no longer publishes to the relay outside a transaction. The `publishToRelay` import is dropped from the scheduler (it remains live for `publication-publisher.ts` which is Phase 4 scope).

- **Free drafts** — the INSERT article + INSERT feed_items txn now also calls `enqueueRelayPublish` with v1. One txn, one commit; the worker publishes. No intermediate state where the DB says "published" but the relay hasn't seen the event.
- **Paywalled drafts** — the two-txn shape is preserved because the vault-ownership check still requires the article row to exist with v1.id before the key-service call. But txn 2 now UPDATE-s articles/feed_items to v2.id *and* enqueues v2 in the same txn; on crash between commit and worker pickup the outbox redrive catches the row. The old post-commit `await publishToRelay(v2)` (which was the §1 hazard source) is gone.
- Vault reuse on retry: if the outer catch retains the draft and the next cycle re-signs v1' + v2', `vaultService.publishArticle` detects the existing `vault_keys` row for this `article_id` and reuses the content key; the UPDATE + enqueue txn writes the fresh v2' id. Relay-side, replaceable-event (kind 30023 with same d-tag) semantics collapse by `created_at`.

No migration. Gateway build + 24 tests + shared 28 tests pass. `publishPersonalDraft` now has no `publishToRelay` reference.

## Phase 6 landed (observability + relay-failure integration test)

Per acceptance criterion "pre-existing deletion paths demonstrably retry on simulated relay failure": `feed-ingest/src/tasks/relay-publish.test.ts` exercises the worker against a scripted pg client and a mocked `publishNostrToRelays`. Ten cases — `computeBackoff` formula (exported for the test) scales `2^attempts` minutes ±10% with a 1h cap; happy-path commit writes `status='sent'`; relay rejection writes `status='failed'`, increments `attempts`, persists `last_error`, and schedules a versioned `relay_publish_<id>_r<n>` retry with `runAt` via `helpers.addJob`; a row already at `attempts = max_attempts - 1` flips to `status='abandoned'` with no retry; already-sent rows and SELECT-missed rows are no-ops; advisory-lock contention returns without touching state so the redrive picks up; missing-relay-URL path fails cleanly. The final case is the deletion-path retry story in miniature: two consecutive `relayPublish` invocations on the same `outbox_id` (first `pending→failed`, second `failed→sent`) with the relay mocked to throw once then resolve — the exact shape a real blip produces against a kind-5 tombstone enqueued from `articles/manage.ts` or `notes.ts`.

"Backfill" turned out to be a null task. Migration 076 shipped atomically with Phases 2+3; there is no pre-outbox ledger-relay drift to sweep — every call site swapped to `enqueueRelayPublish` in the same landing. Any row on the relay that isn't backed by a DB entity (or vice versa) predates the outbox and is out of scope; the daily `relay_outbox_reconcile` already emits abandoned / high-retry / sent-24h counts as the ongoing observability surface.

Feed-ingest build clean, 52 tests pass (11 trust-weighting + 31 trust-aggregation + 10 new). Programme one complete — Phase 4 publish-path rewrite remains the only outstanding piece and is deferred to its own ADR.

## Out of scope (deferred)

- Phase 4 publish-path migration (own ADR)
- Monthly partitioning of `relay_outbox`
- NIP-65 outbox-list relay selection
- NIP-42 auth for target relays
- Federation outbox (multi-relay fan-out beyond platform + source relays)
