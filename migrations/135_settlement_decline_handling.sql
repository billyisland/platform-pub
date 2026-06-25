-- 135: settlement decline handling — failure_reason + reader card-action flag.
--
-- completeSettlement (payment-service/src/services/settlement.ts) creates a
-- confirmed off-session PaymentIntent. A declined / SCA-required saved card makes
-- paymentIntents.create({confirm:true, off_session:true}) THROW, which — pre-fix,
-- with no try/catch — left the tab_settlements row stuck 'pending' forever:
--   • the pending-guard in reserveSettlement then froze EVERY future settlement
--     for that tab (it refuses to open a new one while a 'pending' exists), so the
--     reader accrued an unbounded tab that could never settle, and
--   • handleFailedPayment keys by stripe_payment_intent_id — never stored on a
--     throw — so the payment_intent.payment_failed webhook hit 0 rows and the row
--     was never marked failed. Nothing surfaced the error. (STRIPE audit S1, P0.)
--
-- The fix catches the terminal charge error, marks the settlement 'failed'
-- (releasing the pending-guard so the tab unfreezes), and records:
--   • tab_settlements.failure_reason — the Stripe error code, for ops triage.
--   • accounts.card_action_required_at — set on a terminal decline so settlement
--     backs off (checkAndSettle skips while it is non-NULL) until the reader
--     re-attaches a card, instead of re-declining on every subsequent read. The
--     UI can read it to prompt a card re-auth. Cleared by connectPaymentMethod
--     (shared/src/auth/accounts.ts) when a card is re-attached.

ALTER TABLE tab_settlements
  ADD COLUMN failure_reason text;

ALTER TABLE accounts
  ADD COLUMN card_action_required_at timestamp with time zone;
