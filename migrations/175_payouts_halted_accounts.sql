-- =============================================================================
-- 175 — the payout halt gets a per-account granularity
--
-- PAYMENT-PERIMETER-ADR §3.W4. `platform_config.payouts_halted` is a single
-- durable boolean: any ledger-reconciliation divergence freezes EVERY writer's,
-- publication's and tribute's outbound money until a human clears it. The
-- control is right and stays; its BREADTH is the largest surviving HJ ¶7.14.6
-- "principal-like control" marker — VNL exercising discretion over every
-- writer's money on the strength of a divergence that may implicate one.
--
-- This table is the narrower instrument. A divergence the reconciler can
-- honestly ATTRIBUTE to an account halts that account and nobody else; the
-- global flag stays for everything that cannot be attributed, and its reason
-- names the class that could not be.
--
-- WHY A TABLE. `platform_config` is one key to one value; a halt SET does not
-- fit that shape. The table is also the natural home for the requirement that a
-- halt name a mismatch CLASS rather than free text: `mismatch_class` is the
-- reconciler's check name, so an operator reading the row learns which check
-- fired, and `reason` carries the specifics (the orphaned entry's trigger type
-- and id) rather than having to encode both in one string.
--
-- FIRST-WRITER-WINS, like the global flag. The PRIMARY KEY on account_id plus
-- `ON CONFLICT DO NOTHING` at the one writer preserves the ORIGINAL halt: the
-- first divergence is the one to investigate, and a later run re-detecting the
-- same orphan (the ledger being append-only, it will re-detect it every run
-- until a human acts) must not keep rewriting the timestamp — which would make
-- every halt look as though it had just happened and defeat the age escalation
-- below.
--
-- created_at IS LOAD-BEARING, not bookkeeping. A halt that is never cleared is
-- indistinguishable from a policy of not paying, and that failure is already on
-- the record: dev sat globally halted for a fortnight, silently, from
-- 2026-07-17 — every payout cycle a no-op with nothing wrong with the payout
-- code (scripts/backfill-seed-opening-balances.ts header). The reconciler
-- escalates on this column against the `payout_halt_escalation_hours` dial.
--
-- ON DELETE CASCADE: a deleted account has no payouts to halt, and a halt row
-- pointing at nothing would block the FK for no purpose.
-- =============================================================================

CREATE TABLE payouts_halted_accounts (
  account_id     uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  mismatch_class text NOT NULL,
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE payouts_halted_accounts IS
  'Accounts whose outbound payouts are frozen by an ATTRIBUTABLE ledger-reconciliation divergence (PAYMENT-PERIMETER-ADR W4). Presence means halted; a row is deleted to resume, exactly as the global payouts_halted key is. Narrower than that flag by design — the global halt remains for divergences no check can attribute to an account, and HJ ¶7.14.6 is the reason the narrow instrument exists.';

COMMENT ON COLUMN payouts_halted_accounts.mismatch_class IS
  'The reconciler check name that attributed this halt (today only ledger_orphans, whose payout-side trigger types are the sole attributable class). A class, never free text, so an operator can tell two halts apart and so a new class cannot inherit an old one''s meaning by accident.';

COMMENT ON COLUMN payouts_halted_accounts.reason IS
  'The specifics behind mismatch_class — the offending ledger entry''s trigger type and id. The class says which check; this says which row.';

COMMENT ON COLUMN payouts_halted_accounts.created_at IS
  'When this account was first halted. First-writer-wins, so it is the FIRST detection and not the most recent one — which is what makes it a sound input to the payout_halt_escalation_hours bound. A halt that is never cleared is indistinguishable from a policy of not paying.';
