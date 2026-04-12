-- Email-on-publish: subscribers opt in to email notifications when a writer publishes
ALTER TABLE subscriptions ADD COLUMN notify_on_publish BOOLEAN NOT NULL DEFAULT true;
