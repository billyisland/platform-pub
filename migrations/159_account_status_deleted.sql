-- 159: Add 'deleted' to account_status
--
-- POST /auth/delete-account has always written status = 'deleted', but
-- migration 049 ("account deletion") only added 'deactivated' — so every
-- account deletion aborted on the enum (22P02) and rolled back.
-- 'deleted' is deliberately a NEW terminal value rather than a reuse of
-- 'deactivated': deactivated is reversible (magic-link login matches
-- ('active','deactivated'); Google login reactivates 'deactivated'), and a
-- deleted account must never resurrect through either path.

ALTER TYPE account_status ADD VALUE IF NOT EXISTS 'deleted';
