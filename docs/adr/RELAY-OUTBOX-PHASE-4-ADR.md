# Relay Outbox — Phase 4 (publish-path rewrite)

Follow-up to `docs/adr/RELAY-OUTBOX-ADR.md` (programme one). Programme one
migrated 13 non-publish-path call sites and retired the scheduler's §1
contortion. Two publish-path sites remain live on `publishToRelay`.

## Scope

Two call sites in `gateway/src/services/publication-publisher.ts`:

| File:line | Function | Trigger |
|---|---|---|
| `publication-publisher.ts:147` | `publishToPublication` | `POST /publications/:id/articles` (CMS) and `publishScheduledPublicationDraft` in the scheduler |
| `publication-publisher.ts:312` | `approveAndPublishArticle` | `POST /publications/:id/articles/:articleId/publish` (editor approves a submitted article) |

The original ADR's Phase 4 table also listed `routes/articles/publish.ts`
and two scheduler sites. Those entries are stale:

- **`routes/articles/publish.ts` is not a publish site.** `POST /articles`
  is an indexer — the client signs and publishes to the relay directly, then
  calls the gateway to index the row. Migrating the gateway can't change
  that shape without moving signing server-side, which is a bigger product
  decision than this ADR. Personal articles stay client-driven.
- **Scheduler sites already landed in Phase 5.** `publishPersonalDraft`
  has no `publishToRelay` import today; free drafts enqueue in the INSERT
  txn, paywalled drafts keep the two-txn vault anchor shape with v2
  enqueue in the second txn. The `publishToPublication` call inside
  `publishScheduledPublicationDraft` (scheduler.ts:97) is the only
  remaining scheduler exposure, and it lifts automatically when
  `publishToPublication` itself migrates — no separate treatment needed.

After this phase, `publishToRelay` and its `publishToRelayUrl` helper can
be deleted from `gateway/src/lib/nostr-publisher.ts`.

## The UX decision

Current contract for both endpoints: the handler blocks until the relay
accepts the event and returns 201 with the article metadata. A relay
failure produces a 500 and no DB row.

Three possible post-migration shapes:

- **A. Eager commit, worker publishes.** Sign → in one txn: INSERT/UPDATE
  article + feed_items + `enqueueRelayPublish` → commit → 201. The row
  exists immediately; the relay event is pending until the worker runs
  (sub-second under normal load, retries on blip). Response shape
  unchanged.
- **B. Enqueue then poll-to-sent.** Same as A but the handler waits for
  `status='sent'` before returning. Preserves "201 means on relay" at the
  cost of tying request lifetime to worker latency.
- **C. Explicit `status: 'pending'` response.** Return 202 with the
  article id; client polls to confirm relay state. Honest but requires
  UI work on the dashboard's "article published" confirmation and on
  the scheduler's log lines.

**Choose A.** Reasons:

1. Phase 5 already committed the platform to A for scheduled free
   articles — free drafts return success once the txn commits, with the
   outbox doing the publish. Publication articles should behave the same
   way; mixed semantics would be harder to reason about than a uniform
   eager-commit policy.
2. The `pg_notify` nudge in the graphile-worker runtime gives sub-second
   pickup under normal load. The observable difference from today's sync
   publish is a few hundred ms of worst-case latency for the relay's own
   acknowledgement — well inside the jitter the dashboard's optimistic
   UI already tolerates.
3. The relay blip that today produces a 500 (and leaves the writer
   hitting publish again, risking duplicate `d`-tag collisions on the
   ON CONFLICT upsert) becomes an invisible worker retry. Net UX win.
4. Replaceable-event 30023 semantics collapse by `(kind, pubkey, d)` on
   the relay, so any residual retry-collision that does surface degrades
   to a no-op rather than a duplicate article.

The ADR's open question 3 ("should Phase 4 happen at all? — current
sync publish is correct and the UX is clean") resolves yes, and
specifically in Shape A form. The dividend is automatic retry on blip
and uniformity with the rest of the outbox story; the cost is one
paragraph of "the relay event may be pending for up to a minute" in the
response contract.

## Implementation

### `publishToPublication`

Current (publication-publisher.ts:116–147, 152–229):

```
build tags → signEvent → publishToRelay → withTransaction { INSERT article + INSERT feed_items }
```

Target:

```
build tags → signEvent → withTransaction { INSERT article + INSERT feed_items + enqueueRelayPublish(v1, entityType='article') }
```

- The article row is inserted with `signed.id` exactly as today — the
  event id is already known at txn-open time, no placeholder dance.
- Publications do not use the key-service vault mechanism, so there is
  no vault-ownership anchor requirement — the personal paywalled
  two-txn shape does not apply here. One txn covers the whole write.
- Entity binding: `entity_type = 'article'`, `entity_id = articleId`.
  `'article'` is already a valid entity type in the migration 076
  CHECK constraint (enumerated from programme one).
- `signEvent` stays outside the txn: it's an IO call to key-custody and
  holding a txn open across it lengthens connection pool time-under-lock
  for no benefit — the signed event is just data on failure.

### `approveAndPublishArticle`

Current (publication-publisher.ts:288–364):

```
fetch article + pub + author → build tags → signEvent → publishToRelay
  → withTransaction { UPDATE article + UPSERT feed_items + notify author }
```

Target:

```
fetch article + pub + author → build tags → signEvent
  → withTransaction { UPDATE article + UPSERT feed_items + notify author + enqueueRelayPublish }
```

Same entity binding as above.

### Deletion — final step of the phase

Once both sites are migrated and the test suite is green:

1. Delete `publishToRelay` and `publishToRelayUrl` from
   `gateway/src/lib/nostr-publisher.ts`.
2. Update the file-level comment that currently explains both helpers;
   the file stays alive for `signSubscriptionEvent`, `publishToExternalRelays`,
   and the external-Nostr outbound path.
3. Search for any stray `publishToRelay` imports or docs references;
   update CLAUDE.md's "Relay outbox" paragraph to state "all write paths
   now flow through `enqueueRelayPublish`".

## Test migration

Three existing test surfaces touch the publish path:

- `gateway/src/services/publication-publisher.test.ts` (if present) or
  equivalent integration coverage. Assertions of the form "relay has
  event after `publishToPublication` returns" become "outbox row exists
  with `status='pending'` and `signed_event->>'id' = signed.id`".
- `gateway/src/workers/scheduler.test.ts` — no changes, since the
  scheduler's exposure lifts automatically via `publishToPublication`.
- `feed-ingest/src/tasks/relay-publish.test.ts` already covers the
  worker state machine; no new cases needed.

Per risk #4 of the parent ADR, option (ii) — assert outbox row state,
test the worker separately — is the chosen pattern. An
`async flushRelayOutbox()` helper would simplify any remaining
end-to-end assertion but is not required: the unit coverage of the
worker plus the enqueue-site unit coverage of outbox-row presence is
sufficient.

## Risks

1. **Silent scheduled-publication loss, today.** Before this phase, a
   scheduled publication draft whose `publishToPublication` call throws
   on relay failure will land in the `sendPublishNotifications.catch`
   path and log-error, but the writer never learns. Shape A *improves*
   this — the article row commits, the worker retries the relay publish,
   and the writer sees the article in their dashboard while the outbox
   worker works through the blip. No regression; a quiet class of bug
   gets fixed as a side-effect.
2. **Uniqueness of `signed.id` on retry.** The unique index on
   `(signed_event->>'id')` means a re-signed event (e.g. writer
   re-publishes after an observed failure) produces a different id and a
   new outbox row. Relay-side, the 30023 replaceable-event rule collapses
   by `(kind, pubkey, d)` so the newest `created_at` wins — no duplicate
   article. The old outbox row for the superseded event stays `pending`
   momentarily, succeeds, then the new one wins. Slightly wasted work,
   no user-visible defect.
3. **`POST /publications/:id/articles` response compatibility.** The
   response body already returns `{ articleId, status, nostrEventId?,
   dTag }`. Shape A keeps that shape — `nostrEventId` is the signed
   event id, same as today. Clients that store this id to key feed
   cache entries see no change.
4. **Observability during transition.** Once `publishToRelay` is gone
   and the two sites run through the outbox, the `relay_outbox_reconcile`
   daily cron will pick up any abandoned publishes. The first week
   after deploy should be watched for unexpected `status='abandoned'`
   counts beyond the programme-one baseline.

## Acceptance criteria

- `publishToPublication` and `approveAndPublishArticle` call
  `enqueueRelayPublish` inside their DB transaction; neither imports
  `publishToRelay`.
- `gateway/src/lib/nostr-publisher.ts` no longer exports
  `publishToRelay` or `publishToRelayUrl`; a grep across
  `gateway/src`, `payment-service/src`, `feed-ingest/src`, and
  `shared/src` returns no matches.
- Gateway build clean, gateway tests green (counts stable vs. programme
  one's 24 pass), knip clean.
- The `POST /publications/:id/articles` response shape and status codes
  are unchanged on success; 5xx on relay-only failures is replaced by
  201 + a pending outbox row (the relay is no longer in the request
  path).
- CLAUDE.md's relay-outbox paragraph updated to remove the "Phase 4
  publish-path rewrite… is the only outstanding piece" sentence and
  describe the complete model.
- `feature-debt.md` header entry added: "Completed: relay outbox §60
  Phase 4 per RELAY-OUTBOX-PHASE-4-ADR. Publication publish path now
  enqueues in-txn; `publishToRelay` deleted from
  `gateway/src/lib/nostr-publisher.ts`."

## Out of scope

- Moving personal-article signing server-side (would bring
  `routes/articles/publish.ts` into the outbox story). That is a
  product decision about custodial-vs-client signing, not a relay
  reliability decision.
- Monthly partitioning of `relay_outbox` (volume still well inside the
  unpartitioned regime; programme one deferred this and nothing has
  changed).
- NIP-65 outbox-list relay selection, NIP-42 relay auth, federation
  fan-out — all remain deferred per the parent ADR.
