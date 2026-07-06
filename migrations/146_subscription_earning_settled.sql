-- 146: subscription_earning collection gate (2026-07-06 audit P0)
--
-- F1 (migration 140) wired subscription charges into the reading tab, but the
-- writer-side subscription_earning was payable the moment it existed, while
-- the reader-side charge is only ever collected when the tab settles — and a
-- card-less reader's tab NEVER settles (checkAndSettle returns early on a
-- missing stripe_customer_id). Real Stripe money could therefore leave via the
-- 02:30 payout cycle funded by uncollectible tab debt.
--
-- settled_at is the subscription twin of read_events.state = 'platform_settled':
--   NULL     → the paired subscription_charge has not been collected;
--              the earning is NOT payable and payout.ts must not claim it.
--   NOT NULL → collected. Stamped by confirmSettlement when the reader's tab
--              settlement lands (created_at <= the settlement's snapshot, the
--              same approximate attribution reads use), or at charge time when
--              the charge was fully funded by pre-paid credit (post-charge
--              balance <= 0, see logSubscriptionCharge).
ALTER TABLE subscription_events ADD COLUMN settled_at timestamptz;

-- Backfill: earnings already claimed by a payout are inside a paid or
-- in-flight transfer (a failed payout unclaims via rollbackWriterPayoutRows,
-- which never touches settled_at) — stamp them so "claimed implies settled"
-- holds across history. Pre-F1 unclaimed earnings deliberately stay NULL:
-- their charges were the never-collected free-allowance fiction, so nobody
-- was charged and nobody gets paid. An unclaimed post-F1 earning whose tab
-- settlement landed before this migration (a ~1-day window, likely zero rows)
-- is stamped by the reader's NEXT settlement; scripts/reconcile-ledger.sql
-- surfaces any straggler.
UPDATE subscription_events
SET settled_at = created_at
WHERE event_type = 'subscription_earning'
  AND writer_payout_id IS NOT NULL;
