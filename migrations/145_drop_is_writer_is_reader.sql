-- Drop the vestigial reader/writer taxonomy. Every account has been created
-- with is_writer/is_reader both TRUE since signup granted full capability,
-- nothing ever set either FALSE, and the only consumers were tautological
-- guards and display fields (all removed with this migration). Moderation
-- rides accounts.status (auth middleware 403s non-active accounts wholesale).
-- See docs/audits/migrate-hardening.md §3.

DROP INDEX IF EXISTS idx_accounts_is_writer;

ALTER TABLE accounts
  DROP COLUMN is_writer,
  DROP COLUMN is_reader;
