-- Migration 072: Add expiry_warning_sent to subscription_events.event_type
--
-- The expiry-warning dedup marker previously reused event_type
-- 'subscription_charge' with amount_pence=0 and a magic description string.
-- Analytics that count(*) where event_type='subscription_charge' therefore
-- over-counted charges by the number of warning emails sent.
--
-- Give the marker its own event_type so the taxonomy is honest and any
-- future COUNT query aggregates on type rather than a description substring.

ALTER TABLE subscription_events DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;

ALTER TABLE subscription_events
  ADD CONSTRAINT subscription_events_event_type_check
  CHECK (event_type IN (
    'subscription_charge',
    'subscription_earning',
    'subscription_read',
    'expiry_warning_sent'
  ));
