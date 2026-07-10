-- 152: publication-subscription distribution (CONSOLIDATED-TODO §1.3)
--
-- F1 (migration 140) made subscription charges collectable through the reading
-- tab, but only WRITER subscriptions had a payout leg: the writer cycle's sub
-- CTE claims them via subscription_events.writer_payout_id. A PUBLICATION
-- subscription collected the reader leg (tab debit + subscription_charge) and
-- then the money sat: no earning ledger entry (deliberate — publication
-- distribution is reconciliation-only until the pool pays), and the publication
-- payout cycle summed only read_events, so nothing ever paid it out.
--
-- This migration gives the publication payout cycle a claim marker for
-- subscription earnings. writer_payout_id cannot be overloaded the way
-- read_events.writer_payout_id is (it carries an FK to writer_payouts), so
-- publication claims get their own column, FK'd to publication_payouts.
ALTER TABLE subscription_events
  ADD COLUMN publication_payout_id uuid REFERENCES publication_payouts(id);

-- Claim-scan twin of idx_subscription_events_earning_unpaid: unclaimed
-- publication subscription earnings, grouped/claimed per publication. The
-- settled_at collection gate (migration 146) applies at claim time, same as
-- the writer cycle.
CREATE INDEX idx_sub_events_pub_earning_unpaid
  ON subscription_events (publication_id)
  WHERE event_type = 'subscription_earning'
    AND publication_id IS NOT NULL
    AND publication_payout_id IS NULL;

-- The subscription leg of each pool. Kept SEPARATE from total_pool_pence
-- (which stays Σ gross read amounts — the F5 chargeback prorates a charged-back
-- read's reversal across splits by read_gross ÷ pool, and its denominator is
-- now total_pool_pence + sub_net_pence so sub-derived split money is never
-- reversed by a read chargeback — subscription debt on chargeback is the
-- recorded platform-absorbs posture, see chargeback.ts). Subscription earnings
-- are already NET of the per-charge platform fee (logSubscriptionCharge), so
-- they join the distributable pool post-fee, never through the pooled-fee
-- formula.
ALTER TABLE publication_payouts
  ADD COLUMN sub_net_pence integer DEFAULT 0 NOT NULL;
