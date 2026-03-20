#!/usr/bin/env bash
# =============================================================================
# platform.pub — Server Hardening Script
#
# Run once on the production server (91.99.106.104) before launch.
# Requires root. Idempotent — safe to re-run.
#
# What it does:
#   1. Configures UFW firewall (allow 22, 80, 443 only)
#   2. Switches SSH to key-only authentication
#   3. Sets up certbot auto-renewal cron job
#   4. Generates a strong Postgres password and writes it to .env
#
# Usage:
#   scp scripts/harden-server.sh root@91.99.106.104:/root/
#   ssh root@91.99.106.104 'bash /root/harden-server.sh'
#
# IMPORTANT: Ensure you have SSH key access configured BEFORE running this
# script, because it disables password authentication.
# =============================================================================

set -euo pipefail

echo "=== platform.pub server hardening ==="

# -------------------------------------------------------------------------
# 1. UFW Firewall
# -------------------------------------------------------------------------
echo "[1/4] Configuring firewall..."

apt-get update -qq && apt-get install -y -qq ufw > /dev/null

ufw --force reset > /dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    comment 'SSH'
ufw allow 80/tcp    comment 'HTTP (redirect to HTTPS)'
ufw allow 443/tcp   comment 'HTTPS'
ufw --force enable

echo "  Firewall active. Allowed: 22, 80, 443."

# -------------------------------------------------------------------------
# 2. SSH hardening — key-only auth
# -------------------------------------------------------------------------
echo "[2/4] Hardening SSH..."

SSHD_CONFIG="/etc/ssh/sshd_config"

# Ensure key auth is enabled (should be by default)
sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' "$SSHD_CONFIG"

# Disable password auth
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' "$SSHD_CONFIG"

# Disable root login with password (key-only)
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' "$SSHD_CONFIG"

# Check if authorized_keys exists — refuse to continue without it
if [ ! -f /root/.ssh/authorized_keys ] || [ ! -s /root/.ssh/authorized_keys ]; then
  echo "  WARNING: No SSH authorized_keys found!"
  echo "  Add your public key to /root/.ssh/authorized_keys before restarting sshd."
  echo "  Skipping sshd restart to avoid lockout."
else
  systemctl restart sshd
  echo "  SSH hardened. Password auth disabled."
fi

# -------------------------------------------------------------------------
# 3. Certbot auto-renewal cron
# -------------------------------------------------------------------------
echo "[3/4] Setting up certbot auto-renewal..."

CRON_LINE="0 3 * * * cd /root/platform-pub && docker compose run --rm certbot renew --quiet && docker compose restart nginx"

# Add to crontab if not already present
(crontab -l 2>/dev/null | grep -v 'certbot renew' ; echo "$CRON_LINE") | crontab -

echo "  Certbot renewal cron set (daily at 03:00)."

# -------------------------------------------------------------------------
# 4. Postgres password
# -------------------------------------------------------------------------
echo "[4/4] Generating Postgres password..."

ENV_FILE="/root/platform-pub/.env"

if [ -f "$ENV_FILE" ] && grep -q "POSTGRES_PASSWORD" "$ENV_FILE"; then
  echo "  .env already contains POSTGRES_PASSWORD — skipping."
else
  PG_PASS=$(openssl rand -base64 32 | tr -d '=/+' | head -c 40)
  echo "POSTGRES_PASSWORD=${PG_PASS}" >> "$ENV_FILE"
  echo "  Generated and written to $ENV_FILE"
  echo ""
  echo "  IMPORTANT: If this is a fresh install, run:"
  echo "    docker compose down -v   # removes old DB volume with default password"
  echo "    docker compose up -d     # recreates with new password"
  echo ""
  echo "  If the DB already has data, change the password manually:"
  echo "    docker exec -it platform-pub-postgres-1 psql -U platformpub -c \"ALTER USER platformpub PASSWORD '${PG_PASS}';\""
fi

echo ""
echo "=== Hardening complete ==="
echo ""
echo "Verify:"
echo "  ufw status"
echo "  ssh root@91.99.106.104  (should work with key, fail with password)"
echo "  crontab -l | grep certbot"
