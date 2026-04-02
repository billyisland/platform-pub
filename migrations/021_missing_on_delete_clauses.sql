-- Migration 021: Add missing ON DELETE clauses
--
-- Tables missed by migration 018. These FKs currently have no ON DELETE clause,
-- meaning account or article deletion would fail with a FK violation rather than
-- cascading or restricting intentionally.
--
-- Defensive: each block checks the table exists before altering it, so this
-- migration is safe on databases where earlier CREATE TABLE migrations were
-- incorporated into schema.sql and skipped.

-- subscriptions: reader/writer deletion should cascade (subscription is meaningless without both)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscriptions') THEN
    ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_reader_id_fkey;
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_reader_id_fkey
      FOREIGN KEY (reader_id) REFERENCES accounts(id) ON DELETE CASCADE;

    ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_writer_id_fkey;
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_writer_id_fkey
      FOREIGN KEY (writer_id) REFERENCES accounts(id) ON DELETE CASCADE;
  END IF;
END $$;

-- subscription_events: audit log — cascade with account deletion
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscription_events') THEN
    ALTER TABLE subscription_events DROP CONSTRAINT IF EXISTS subscription_events_reader_id_fkey;
    ALTER TABLE subscription_events ADD CONSTRAINT subscription_events_reader_id_fkey
      FOREIGN KEY (reader_id) REFERENCES accounts(id) ON DELETE CASCADE;

    ALTER TABLE subscription_events DROP CONSTRAINT IF EXISTS subscription_events_writer_id_fkey;
    ALTER TABLE subscription_events ADD CONSTRAINT subscription_events_writer_id_fkey
      FOREIGN KEY (writer_id) REFERENCES accounts(id) ON DELETE CASCADE;
  END IF;
END $$;

-- article_unlocks: cascade on both reader and article deletion
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'article_unlocks') THEN
    ALTER TABLE article_unlocks DROP CONSTRAINT IF EXISTS article_unlocks_reader_id_fkey;
    ALTER TABLE article_unlocks ADD CONSTRAINT article_unlocks_reader_id_fkey
      FOREIGN KEY (reader_id) REFERENCES accounts(id) ON DELETE CASCADE;

    ALTER TABLE article_unlocks DROP CONSTRAINT IF EXISTS article_unlocks_article_id_fkey;
    ALTER TABLE article_unlocks ADD CONSTRAINT article_unlocks_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE;

    ALTER TABLE article_unlocks DROP CONSTRAINT IF EXISTS article_unlocks_subscription_id_fkey;
    ALTER TABLE article_unlocks ADD CONSTRAINT article_unlocks_subscription_id_fkey
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- vote_charges: cascade on vote deletion, restrict on account deletion (financial record)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'vote_charges') THEN
    ALTER TABLE vote_charges DROP CONSTRAINT IF EXISTS vote_charges_vote_id_fkey;
    ALTER TABLE vote_charges ADD CONSTRAINT vote_charges_vote_id_fkey
      FOREIGN KEY (vote_id) REFERENCES votes(id) ON DELETE CASCADE;

    ALTER TABLE vote_charges DROP CONSTRAINT IF EXISTS vote_charges_voter_id_fkey;
    ALTER TABLE vote_charges ADD CONSTRAINT vote_charges_voter_id_fkey
      FOREIGN KEY (voter_id) REFERENCES accounts(id) ON DELETE RESTRICT;

    ALTER TABLE vote_charges DROP CONSTRAINT IF EXISTS vote_charges_recipient_id_fkey;
    ALTER TABLE vote_charges ADD CONSTRAINT vote_charges_recipient_id_fkey
      FOREIGN KEY (recipient_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- pledges: cascade on pledger deletion
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pledges') THEN
    ALTER TABLE pledges DROP CONSTRAINT IF EXISTS pledges_pledger_id_fkey;
    ALTER TABLE pledges ADD CONSTRAINT pledges_pledger_id_fkey
      FOREIGN KEY (pledger_id) REFERENCES accounts(id) ON DELETE CASCADE;
  END IF;
END $$;
