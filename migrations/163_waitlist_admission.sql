-- 163: Waitlist admission state (CLOSED-BETA-ADR §XI.2, build order item 3).
--
-- The panel's read half shipped without an Admit button precisely because the
-- row had nothing to record an admission on, and a button with no state behind
-- it is a double-admit waiting to happen: the operator clicks, the response is
-- slow, they click again, and the prospect gets two accounts or two invitations.
-- These three columns are what makes the action safe.
--
-- THREE COLUMNS, BECAUSE THEY ARE THREE FACTS — and the ADR flagged that the
-- last two can fail apart:
--
--   · admitted_at         — an account now exists for this address. The
--                           guard: a second admit of the same row is refused
--                           on this, under a row lock.
--   · admitted_account_id — WHICH account it became. Without it, "was this
--                           person admitted?" and "who are they now?" are
--                           different questions with no join between them, and
--                           the panel can't show the operator what it did.
--                           ON DELETE SET NULL: an admitted prospect who later
--                           deletes their account leaves the admission stamp
--                           standing (it happened) with a dangling pointer
--                           cleared, rather than taking the waitlist row with
--                           them.
--   · invited_at          — the "there's room now" email actually went. It is
--                           SEPARATE from admitted_at because the send happens
--                           outside the admission transaction and can fail on
--                           its own (Postmark has a bad minute; the process
--                           restarts between the two). An admission that
--                           silently didn't reach anyone is the failure this
--                           whole section exists to stop happening again, so
--                           the state has to be able to say "admitted, not yet
--                           told" and the panel has to be able to offer the
--                           retry.
--
-- All three are nullable with no default: NULL is the meaningful state (not
-- admitted / not told), and every existing row is correctly NULL for both.

ALTER TABLE waitlist
    ADD COLUMN admitted_at timestamptz,
    ADD COLUMN admitted_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    ADD COLUMN invited_at timestamptz;
