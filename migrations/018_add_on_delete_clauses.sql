-- =============================================================================
-- Migration 018: Add ON DELETE clauses to FKs from migrations 016-017
--
-- These foreign keys defaulted to NO ACTION. This migration drops and re-adds
-- them with appropriate ON DELETE behavior.
-- =============================================================================

-- conversations.created_by → accounts(id)
ALTER TABLE conversations DROP CONSTRAINT conversations_created_by_fkey;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE CASCADE;

-- dm_pricing.owner_id → accounts(id)
ALTER TABLE dm_pricing DROP CONSTRAINT dm_pricing_owner_id_fkey;
ALTER TABLE dm_pricing
  ADD CONSTRAINT dm_pricing_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE CASCADE;

-- dm_pricing.target_id → accounts(id)
ALTER TABLE dm_pricing DROP CONSTRAINT dm_pricing_target_id_fkey;
ALTER TABLE dm_pricing
  ADD CONSTRAINT dm_pricing_target_id_fkey
  FOREIGN KEY (target_id) REFERENCES accounts(id) ON DELETE CASCADE;

-- pledge_drives.creator_id → accounts(id)
ALTER TABLE pledge_drives DROP CONSTRAINT pledge_drives_creator_id_fkey;
ALTER TABLE pledge_drives
  ADD CONSTRAINT pledge_drives_creator_id_fkey
  FOREIGN KEY (creator_id) REFERENCES accounts(id) ON DELETE CASCADE;

-- pledge_drives.target_writer_id → accounts(id)
ALTER TABLE pledge_drives DROP CONSTRAINT pledge_drives_target_writer_id_fkey;
ALTER TABLE pledge_drives
  ADD CONSTRAINT pledge_drives_target_writer_id_fkey
  FOREIGN KEY (target_writer_id) REFERENCES accounts(id) ON DELETE CASCADE;

-- pledges.pledger_id → accounts(id)
ALTER TABLE pledges DROP CONSTRAINT pledges_pledger_id_fkey;
ALTER TABLE pledges
  ADD CONSTRAINT pledges_pledger_id_fkey
  FOREIGN KEY (pledger_id) REFERENCES accounts(id) ON DELETE CASCADE;
