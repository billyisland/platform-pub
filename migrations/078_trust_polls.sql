-- =============================================================================
-- 078: trust_polls — workspace experiment slice 15
--
-- Per CARDS-AND-PIP-PANEL-HANDOFF.md §"Trust section" + ADR-OMNIBUS §III.7.
-- The pip panel surfaces three poll questions:
--
--   1. Are they human?               → question = 'humanity'
--   2. Are they who they seem to be? → question = 'authenticity'
--   3. Do they engage in good faith? → question = 'good_faith'
--
-- These are intentionally *not* the same as the four `vouches` dimensions
-- (humanity, encounter, identity, integrity) — the panel handoff explicitly
-- rejects "integrity" as a question (too abstract) and frames "authenticity"
-- as deliberately weaker than the formal `identity` dimension on a vouch.
-- Polls are the lightweight tap; vouches are the formal attestation.
--
-- Honesty about anonymity. The handoff and ADR-OMNIBUS describe polling as
-- "anonymous and secure" via a separate attestation service. Slice 15 ships
-- a non-anonymous `respondent_id` so writes are attributable at the row
-- level. Panel-side reads only ever surface aggregates + the viewer's own
-- answer — no other respondent's identity ever ships. The full anonymous
-- pipeline (encrypted attestations through a service that doesn't see
-- session data, per ADR-OMNIBUS §III.7) is the trust-system-proper work and
-- replaces this table when it lands.
-- =============================================================================

CREATE TABLE trust_polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  respondent_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  question TEXT NOT NULL
    CHECK (question IN ('humanity', 'authenticity', 'good_faith')),
  answer TEXT NOT NULL CHECK (answer IN ('yes', 'no')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One answer per respondent per subject per question. Updates upsert.
  CONSTRAINT trust_polls_unique UNIQUE (respondent_id, subject_id, question),

  -- A respondent cannot poll themselves.
  CONSTRAINT trust_polls_no_self CHECK (respondent_id != subject_id)
);

CREATE INDEX trust_polls_subject_idx
  ON trust_polls (subject_id, question);

-- updated_at trigger — useful for both audit and for any future "recent
-- answers" reporting.
CREATE OR REPLACE FUNCTION trust_polls_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trust_polls_touch_updated_at
  BEFORE UPDATE ON trust_polls
  FOR EACH ROW EXECUTE FUNCTION trust_polls_touch_updated_at();
