-- 033: Move admin account IDs to platform_config
--
-- Replaces the ADMIN_ACCOUNT_IDS env var with a platform_config row,
-- so admin list changes don't require a redeploy.

INSERT INTO platform_config (key, value, description) VALUES
  ('admin_account_ids', '', 'Comma-separated account UUIDs with admin access')
ON CONFLICT (key) DO NOTHING;
