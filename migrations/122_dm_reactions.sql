-- Item 6: migrate dm_likes → typed dm_reactions while the table is still empty.
-- Existing heart-likes become reaction_type='like'; the schema is now
-- reaction-ready. The reaction vocabulary stays APP-controlled (validated in
-- gateway/src/services/messages.ts), deliberately not pinned in a DB CHECK, so
-- adding a reaction needs no migration.

ALTER TABLE dm_likes RENAME TO dm_reactions;

ALTER TABLE dm_reactions ADD COLUMN reaction_type text NOT NULL DEFAULT 'like';

-- Uniqueness moves from one-reaction-per-(message,user) to one-per-type.
ALTER TABLE dm_reactions DROP CONSTRAINT dm_likes_message_id_user_id_key;
ALTER TABLE dm_reactions
  ADD CONSTRAINT dm_reactions_message_id_user_id_reaction_type_key
  UNIQUE (message_id, user_id, reaction_type);

-- Carry the inherited identifiers over to the new name for a clean schema dump.
ALTER TABLE dm_reactions RENAME CONSTRAINT dm_likes_pkey TO dm_reactions_pkey;
ALTER TABLE dm_reactions RENAME CONSTRAINT dm_likes_message_id_fkey TO dm_reactions_message_id_fkey;
ALTER TABLE dm_reactions RENAME CONSTRAINT dm_likes_user_id_fkey TO dm_reactions_user_id_fkey;
ALTER INDEX idx_dm_likes_message RENAME TO idx_dm_reactions_message;
