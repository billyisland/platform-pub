-- Session invalidation: reject JWTs issued before this timestamp on logout
ALTER TABLE accounts ADD COLUMN sessions_invalidated_at TIMESTAMPTZ;
