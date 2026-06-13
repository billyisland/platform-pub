-- 115_network_presences_external_id_unique.sql
--
-- Prevent two accounts from claiming the same external identity on one network.
--
-- Migration 109 reduced network_presences uniqueness to (account_id, protocol),
-- but atproto_oauth_sessions is keyed solely by DID (ON CONFLICT (did)). So a
-- second account linking a Bluesky DID that another account already linked
-- would clobber the first account's shared OAuth session row — and the outbound
-- worker would then post under whichever account last wrote the session. Both
-- presence rows survive and both pass the dispatcher's is_valid/active gate, so
-- this is a silent cross-account impersonation / data-integrity bug.
--
-- A partial unique index on (protocol, external_id) makes the second link fail
-- cleanly. The OAuth callbacks catch the unique violation (23505) and redirect
-- to an "already-linked" message rather than 500-ing or clobbering. The WHERE
-- clause is defensive (external_id is currently NOT NULL) so the constraint
-- stays correct if a future provenance tier ever leaves it null.

CREATE UNIQUE INDEX IF NOT EXISTS network_presences_protocol_external_id_uniq
  ON network_presences (protocol, external_id)
  WHERE external_id IS NOT NULL;
