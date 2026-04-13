-- 049: Account deletion/deactivation support + email/username change fields
--
-- Adds 'deactivated' to account_status enum.
-- Adds columns for username change tracking and email change verification.

ALTER TYPE account_status ADD VALUE IF NOT EXISTS 'deactivated';

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS username_changed_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS previous_username TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS username_redirect_until TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_email TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verification_token TEXT;
