-- Migration 087: Schema hardening — indexes, FK cascades, updated_at triggers, feed_items score tiebreaker
-- Addresses D54, D55, D56, D57, D58, D59, D63, D65

-- =============================================================================
-- D54: Missing index on subscriptions(publication_id)
-- =============================================================================

CREATE INDEX idx_subscriptions_publication ON subscriptions(publication_id) WHERE publication_id IS NOT NULL;

-- =============================================================================
-- D55: Missing indexes on publication_article_shares
-- =============================================================================

CREATE INDEX idx_pub_article_shares_pub ON publication_article_shares(publication_id);
CREATE INDEX idx_pub_article_shares_article ON publication_article_shares(article_id);

-- =============================================================================
-- D56: Missing index on publication_payout_splits(article_id)
-- =============================================================================

CREATE INDEX idx_pub_payout_splits_article ON publication_payout_splits(article_id) WHERE article_id IS NOT NULL;

-- =============================================================================
-- D57: FK cascades on publication deletion
-- =============================================================================

ALTER TABLE articles DROP CONSTRAINT articles_publication_id_fkey;
ALTER TABLE articles ADD CONSTRAINT articles_publication_id_fkey
  FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE SET NULL;

ALTER TABLE article_drafts DROP CONSTRAINT article_drafts_publication_id_fkey;
ALTER TABLE article_drafts ADD CONSTRAINT article_drafts_publication_id_fkey
  FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE SET NULL;

ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_publication_id_fkey;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_publication_id_fkey
  FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE CASCADE;

-- =============================================================================
-- D58: FK cascades on vouches (account deletion)
-- =============================================================================

ALTER TABLE vouches DROP CONSTRAINT vouches_attestor_id_fkey;
ALTER TABLE vouches ADD CONSTRAINT vouches_attestor_id_fkey
  FOREIGN KEY (attestor_id) REFERENCES accounts(id) ON DELETE CASCADE;

ALTER TABLE vouches DROP CONSTRAINT vouches_subject_id_fkey;
ALTER TABLE vouches ADD CONSTRAINT vouches_subject_id_fkey
  FOREIGN KEY (subject_id) REFERENCES accounts(id) ON DELETE CASCADE;

-- =============================================================================
-- D59: FK cascades on trust tables (account deletion)
-- =============================================================================

ALTER TABLE trust_profiles DROP CONSTRAINT trust_profiles_user_id_fkey;
ALTER TABLE trust_profiles ADD CONSTRAINT trust_profiles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE;

ALTER TABLE trust_layer1 DROP CONSTRAINT trust_layer1_user_id_fkey;
ALTER TABLE trust_layer1 ADD CONSTRAINT trust_layer1_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE;

-- =============================================================================
-- D65: Missing updated_at triggers
-- =============================================================================

CREATE TRIGGER trg_subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_linked_accounts_updated_at BEFORE UPDATE ON linked_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_external_sources_updated_at BEFORE UPDATE ON external_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_activitypub_instance_health_updated_at BEFORE UPDATE ON activitypub_instance_health
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_notification_preferences_updated_at BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_vote_tallies_updated_at BEFORE UPDATE ON vote_tallies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_platform_config_updated_at BEFORE UPDATE ON platform_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_atproto_oauth_sessions_updated_at BEFORE UPDATE ON atproto_oauth_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- D63: Feed items score index — add id tiebreaker for stable cursor pagination
-- =============================================================================

DROP INDEX idx_feed_items_score;
CREATE INDEX idx_feed_items_score ON feed_items(score DESC, published_at DESC, id DESC) WHERE deleted_at IS NULL;
