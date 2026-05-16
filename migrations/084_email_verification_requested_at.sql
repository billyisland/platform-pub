ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verification_requested_at TIMESTAMPTZ;
