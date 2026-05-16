-- Add status column to tab_settlements to support three-phase settlement pattern.
-- Pending settlements exist in the DB before the Stripe call, enabling crash recovery
-- with a stable idempotency key (settlement-{id}).

ALTER TABLE tab_settlements
  ADD COLUMN status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed'));

-- Existing rows are all completed (they have stripe_payment_intent_id set)
UPDATE tab_settlements SET status = 'completed' WHERE stripe_payment_intent_id IS NOT NULL;

-- Index for resumePendingSettlements startup scan
CREATE INDEX idx_tab_settlements_pending ON tab_settlements(status) WHERE status = 'pending';
