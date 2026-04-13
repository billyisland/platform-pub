-- Email-on-publish v2: track when email was sent for an article
ALTER TABLE articles ADD COLUMN email_sent_at TIMESTAMPTZ;
