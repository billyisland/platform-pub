-- 165_funds_segregation.sql
--
-- Stripe funds segregation (allocated funds) — the state the design needs.
-- Spec: docs/adr/FUNDS-SEGREGATION-INTEGRATION.md §3.3a / §3.3c / §4.
--
-- WHAT SEGREGATION CHANGES. Under the beta, a settlement charge's full amount is
-- LOCKED in an "allocated" state on the platform account and can only leave it
-- toward a connected account, via a transfer that names its funding charge
-- (`source_transaction`). Our current model — one aggregate transfer per writer,
-- summing many settlements — cannot express that. The payout unit becomes
-- (payout × funding charge): N child transfers per payout, one per charge drawn on.
--
-- WHAT THIS MIGRATION IS FOR. Two things Stripe does not give us:
--
--   1. A queryable view of how much allocation a charge has LEFT. Stripe exposes
--      the balance on the charge but not our claims against it, so we keep our own
--      drawing budget: `tab_settlements.allocated_pence` (read BACK from Stripe by
--      the allocation-sync sweep — never assumed) minus the sum of
--      `allocated_draws` rows against it.
--
--   2. A per-transfer identity for a payout. `writer_payouts.stripe_transfer_id`
--      holds ONE id; with N transfers per payout it can only ever name one child,
--      so a `transfer.reversed` for any other is silently dropped. `payout_transfers`
--      is the child row — one per slice, shared by all three payout cycles — and
--      the `payout_transfer_id` columns record which earning-unit landed on which
--      child, which is what makes per-child failure (release exactly that child's
--      units, siblings untouched) implementable at all.
--
-- ALL OF IT IS INERT UNTIL THE FLAG FLIPS. Every column added here is nullable
-- with no default behaviour change; `STRIPE_ALLOCATED_FUNDS=0` (the default) means
-- nothing writes them and the payout cycles run exactly as they do today.
--
-- ORDERING: payout_transfers must exist before the three payout_transfer_id FKs.

-- ── payout_transfers: one child transfer per slice ──────────────────────────
-- Polymorphic parent deliberately (parent_table + parent_id, no FK): one packer,
-- one execute loop, one resume sweep, three callers. Three near-identical child
-- tables is how the three payout cycles drifted apart in the first place.
--
-- `status` is a text CHECK, NOT the payout_status enum — not because a value is
-- missing (all four already exist there) but to DECOUPLE: the child lifecycle
-- should be able to grow a state without an `ALTER TYPE … ADD VALUE` migration
-- (which the runner routes down the no-transaction path, its new value unusable
-- until commit) rippling through the three parent tables that share the enum.
CREATE TABLE payout_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_table text NOT NULL,
  parent_id uuid NOT NULL,
  -- NULL for a residual child: no charge behind it (see `funding`).
  settlement_id uuid REFERENCES tab_settlements(id),
  stripe_charge_id text,
  funding text NOT NULL,
  net_pence integer NOT NULL,
  fee_pence integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  stripe_transfer_id text,
  -- Cumulative pence reversed on THIS child. Stripe reports transfer.reversed
  -- with a cumulative `amount_reversed`, and the reversal handlers post only the
  -- delta over what is already recorded — so a redelivery is a no-op and a
  -- staged partial is an increment. The existing handlers derive that figure by
  -- SUMming reversal ledger entries against the payout row, which cannot work
  -- here: the ledger ref stays the PARENT (deliberately, §3.3c), so N children
  -- share one ref and their reversals are indistinguishable in it. Per-child
  -- state is the only place this can live.
  reversed_pence integer NOT NULL DEFAULT 0,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT payout_transfers_parent_table_check CHECK (
    parent_table IN ('writer_payouts', 'publication_payout_splits', 'tribute_payouts')),
  CONSTRAINT payout_transfers_funding_check CHECK (
    funding IN ('allocated', 'platform_balance')),
  CONSTRAINT payout_transfers_status_check CHECK (
    status IN ('pending', 'completed', 'failed', 'reversed')),
  -- Stripe rejects amount: 0, so a zero-value slice must never be created
  -- (§3.3c). A pure-fee slice is not a transfer — that fee is left as dust.
  CONSTRAINT payout_transfers_net_positive CHECK (net_pence > 0),
  CONSTRAINT payout_transfers_fee_non_negative CHECK (fee_pence >= 0),
  CONSTRAINT payout_transfers_reversed_bounded CHECK (
    reversed_pence >= 0 AND reversed_pence <= net_pence),
  -- An allocated child MUST name its funding charge; a residual one must not.
  -- This is the segregation guarantee expressed as a constraint: nothing can
  -- ship a row claiming allocated funding with no source_transaction to draw on.
  CONSTRAINT payout_transfers_allocated_has_charge CHECK (
    (funding = 'allocated'
       AND settlement_id IS NOT NULL AND stripe_charge_id IS NOT NULL)
    OR
    (funding = 'platform_balance'
       AND settlement_id IS NULL AND stripe_charge_id IS NULL))
);

CREATE INDEX idx_payout_transfers_parent
  ON payout_transfers (parent_table, parent_id);
CREATE INDEX idx_payout_transfers_settlement
  ON payout_transfers (settlement_id);
-- The webhook lookup key: confirm / reverse / fail all resolve a child by the
-- Stripe transfer id (§3.5). UNIQUE because Stripe never reuses one, and a
-- duplicate here would make the reversal handler's row lock ambiguous.
CREATE UNIQUE INDEX idx_payout_transfers_stripe_transfer
  ON payout_transfers (stripe_transfer_id)
  WHERE stripe_transfer_id IS NOT NULL;
-- The resume sweep's only query.
CREATE INDEX idx_payout_transfers_pending
  ON payout_transfers (created_at)
  WHERE status = 'pending';

COMMENT ON TABLE payout_transfers IS
  'One child Stripe transfer per payout slice (migration 165). Under funds segregation a payout becomes N transfers, one per funding charge drawn on; this is the per-transfer row the webhook handlers key on. Shared by all three payout cycles via (parent_table, parent_id).';
COMMENT ON COLUMN payout_transfers.funding IS
  'allocated = drawn from a charge''s segregated balance via source_transaction; platform_balance = the residual path (§3.3d), an ordinary transfer for earnings with no charge behind them (credit-funded subscriptions, pre-flip earnings).';

-- ── allocated_draws: our drawing budget against a charge's allocation ───────
-- NOT a ledger. It mirrors no ledger_entries row, posts no money movement, and
-- exists only so we can compute "how much of this charge is still drawable"
-- (Stripe gives us no such view). Its remainder is DERIVED, never stored:
--
--   GREATEST(0, ts.allocated_pence - COALESCE(SUM(d.gross_pence), 0))
--
-- The clamp is deliberate and safe here — unlike the reading_tabs clamp the
-- money-ledger invariant bans, it can only make us UNDER-draw, which degrades to
-- the residual path and never to an over-transfer. Stripe's own accounting stays
-- authoritative; the reconcile sweep (§3.6) is what catches divergence.
--
-- gross_pence is SIGNED: a transfer draw is positive, a reversal draw negative
-- (reversed funds return to the ALLOCATED state, not platform balance).
CREATE TABLE allocated_draws (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES tab_settlements(id),
  kind text NOT NULL,
  ref_table text NOT NULL,
  ref_id uuid NOT NULL,
  gross_pence integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allocated_draws_kind_check CHECK (
    kind IN ('transfer', 'refund', 'reversal')),
  -- Idempotency: one draw per (row, kind). For a transfer draw the ref is
  -- ('payout_transfers', <child id>) — one draw per child, which is what makes
  -- releasing a failed child's draw a single DELETE.
  CONSTRAINT allocated_draws_ref_unique UNIQUE (ref_table, ref_id, kind)
);

CREATE INDEX idx_allocated_draws_settlement ON allocated_draws (settlement_id);

COMMENT ON TABLE allocated_draws IS
  'Drawing budget against a charge''s Stripe allocation (migration 165). One row per claim: transfer (+), refund (−, allocation consumed by a refund), reversal (−, funds returned to allocated state). NOT a ledger — it records no money movement and mirrors no ledger_entries row.';

-- ── tab_settlements: what Stripe actually locked for this charge ────────────
-- NULL means "not known to be drawable" — pre-flip, an ineligible card brand
-- (the beta admits only Visa/MC/Amex/Discover/Swish, and payment_method_types:
-- ['card'] is broader), a charge whose payment method has not settled yet, or a
-- sweep that has not run. NULL is the safe default and the ONLY default: the
-- packer never assumes allocation, it reads it back.
ALTER TABLE tab_settlements
  ADD COLUMN allocated_pence integer,
  ADD COLUMN allocation_synced_at timestamptz;

COMMENT ON COLUMN tab_settlements.allocated_pence IS
  'What Stripe reports locked in allocated state for this charge (pending + available), read back by the allocation-sync sweep. NULL = not known to be drawable; never assumed (migration 165).';

-- The sweep's candidate query: completed settlements with a charge, oldest
-- unsynced first. Partial so it stays small — a fully-synced, fully-drawn
-- settlement drops out on the next pass only by age, so keep both arms.
CREATE INDEX idx_tab_settlements_allocation_sync
  ON tab_settlements (allocation_synced_at NULLS FIRST, settled_at)
  WHERE status = 'completed' AND stripe_charge_id IS NOT NULL;

-- ── subscription_events: the settlement that stamped this earning ───────────
-- A subscription earning is payable but carries only `settled_at`, stamped
-- now() by confirmSettlement or at charge time by logSubscriptionCharge — so
-- "which settlement stamped it" is unrecoverable after the fact, and a time-join
-- would reintroduce the read↔settlement approximation at a second site. Stamped
-- going forward in the same UPDATE that already sets settled_at.
--
-- NULL is correct and expected for the charge-time credit-funded branch: that
-- earning has no charge at all and belongs in the residual. To the packer a NULL
-- simply means "no preferred settlement", which it already handles.
ALTER TABLE subscription_events
  ADD COLUMN tab_settlement_id uuid REFERENCES tab_settlements(id);

COMMENT ON COLUMN subscription_events.tab_settlement_id IS
  'The settlement whose confirm stamped settled_at on this earning — the packer''s preferred funding charge. NULL = funded by pre-paid credit, no charge exists (migration 165).';

CREATE INDEX idx_subscription_events_tab_settlement
  ON subscription_events (tab_settlement_id)
  WHERE tab_settlement_id IS NOT NULL;

-- ── the unit → child mapping ────────────────────────────────────────────────
-- Releasing a failed child's units, and un-claiming packer overflow, both need
-- to know which earning-unit landed on which slice — and nothing in the claim
-- tables records it (`writer_payout_id` points at the PARENT, and
-- rollbackWriterPayoutRows is payout-granular by construction, its state filters
-- load-bearing for the chargeback interaction). Without these columns per-child
-- failure is unimplementable.
--
-- Stamped in Txn 1 alongside the existing parent claim column; nulled together
-- with it on release.
ALTER TABLE read_events
  ADD COLUMN payout_transfer_id uuid REFERENCES payout_transfers(id);
ALTER TABLE subscription_events
  ADD COLUMN payout_transfer_id uuid REFERENCES payout_transfers(id);
ALTER TABLE tribute_accruals
  ADD COLUMN payout_transfer_id uuid REFERENCES payout_transfers(id);

-- Partial indexes: the release path's only query, and NULL for every row until
-- the flag flips (and for every residual-free cycle after), so the partial form
-- keeps them near-empty.
CREATE INDEX idx_read_events_payout_transfer
  ON read_events (payout_transfer_id)
  WHERE payout_transfer_id IS NOT NULL;
CREATE INDEX idx_subscription_events_payout_transfer
  ON subscription_events (payout_transfer_id)
  WHERE payout_transfer_id IS NOT NULL;
CREATE INDEX idx_tribute_accruals_payout_transfer
  ON tribute_accruals (payout_transfer_id)
  WHERE payout_transfer_id IS NOT NULL;

COMMENT ON COLUMN read_events.payout_transfer_id IS
  'Which payout_transfers child slice funds this read''s earning unit. Parent claim stays writer_payout_id; this is the per-child grain that makes one Stripe rejection out of N an ordinary event (migration 165).';

-- No ledger_entries change: this design adds no trigger type and no ref-shape
-- change. Per-child ledger entries keep the PARENT row as (ref_table, ref_id),
-- which is what keeps ledger_publication_distribution's
-- `ref_table = 'publication_payout_splits'` filter matching and keeps the new
-- entries inside reconcile-ledger's ledger_orphans default-deny catch-all.
