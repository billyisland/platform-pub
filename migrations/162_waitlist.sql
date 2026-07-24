-- 162: Closed-beta waiting list (CLOSED-BETA-ADR Phase 2, D2/D3).
--
-- Capture, not a mailto: a stored list is the launch-cohort recruitment
-- pipeline — prospects join here and are admitted in cohorts as the beta opens
-- (converting a waitlister to a member is a manual/next-phase action; this ADR
-- only stores the list — §VII).
--
-- Shape is deliberately minimal, no more PII than necessary (D2/D5): a
-- lower-cased unique email and `created_at`. `publish_interest` is the single
-- unticked opt-in of D3 — everyone joins as a reader/user by default, so this
-- flag is the "I'd also like to publish" signal that lets would-be publishers
-- be pulled out of a cohort first, without a reader/writer fork on the page.
--
-- The UNIQUE(email) constraint makes the POST /waitlist endpoint
-- enumeration-safe by construction: it upserts ON CONFLICT DO NOTHING and
-- returns the same generic acknowledgement whether the email was new or already
-- present — the endpoint never reveals list membership (mirrors the
-- "if an account exists…" posture on /auth/login). Emails are lower-cased in
-- the route before insert, so the unique key also collapses case variants.

CREATE TABLE waitlist (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    publish_interest boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
