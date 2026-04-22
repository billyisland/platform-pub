-- =============================================================================
-- 076: relay_outbox — durable queue for Nostr relay publishes
--
-- Per RELAY-OUTBOX-ADR (§60). Replaces the ad-hoc await-publishToRelay pattern
-- at 13 call sites across gateway/ and payment-service/. Callers insert a
-- signed event into this table inside their existing transaction; the
-- feed-ingest worker publishes it and owns retry semantics.
--
-- Dedup: a given signed_event.id can only be enqueued once (unique index on
-- the JSONB id). A double-enqueue (e.g. crash between sign and insert) hits
-- ON CONFLICT DO NOTHING and returns the existing row.
--
-- Target relays: empty array means "publish to PLATFORM_RELAY_WS_URL". A
-- later phase (writer NIP-65 outbox lists, federated relays) populates this
-- per row.
-- =============================================================================

CREATE TABLE relay_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Entity binding — debug / reconciliation, not load-bearing.
  entity_type TEXT NOT NULL
    CHECK (entity_type IN (
      'article', 'article_deletion',
      'note', 'note_deletion',
      'subscription',
      'receipt',
      'drive',
      'drive_deletion',
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

-- Hot query: "give me the next jobs to run".
CREATE INDEX relay_outbox_ready_idx
  ON relay_outbox (next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- Dedup — same signed event can't be enqueued twice.
CREATE UNIQUE INDEX relay_outbox_event_id_idx
  ON relay_outbox ((signed_event->>'id'));

-- Reconciliation lookup.
CREATE INDEX relay_outbox_entity_idx
  ON relay_outbox (entity_type, entity_id);
