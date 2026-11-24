#!/usr/bin/env bash
# Sets up the Painted Shacks admin app on a fresh Ubuntu/Debian server (e.g. a Nymbox VPS).
# Usage (as root):  bash setup-server.sh admin.example.com
# No domain yet? Use  89-125-10-8.sslip.io  (a free name that points at the IP; HTTPS still works).
# What it does:
#   1. Installs Caddy (web server with automatic HTTPS certificates).
#   2. Downloads the admin app from GitHub into /srv/painted-shacks/admin.
#   3. Serves it on your domain over HTTPS with strict security headers.
# Run it again any time to update the app to the latest version.
set -euo pipefail

DOMAIN="${1:-}"
REPO="https://github.com/LuthandoSABTC/bitcoinekasi"
BRANCH="${BRANCH:-main}"
WEBROOT="/srv/painted-shacks"

if [[ -z "$DOMAIN" ]]; then echo "Usage: bash setup-server.sh your-domain.com"; exit 1; fi
if [[ $EUID -ne 0 ]]; then echo "Please run as root (sudo -i first)."; exit 1; fi

echo "==> Installing packages"
apt-get update -y
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl git ufw gnupg
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "==> Checking ports 80 and 443 are free"
if ss -ltnp | grep -E ':(80|443)\s' | grep -vq caddy; then
  echo "Something else is already using port 80 or 443:"; ss -ltnp | grep -E ':(80|443)\s'
  echo "Stopping here so nothing breaks. Send this output to Claude."; exit 1
fi

echo "==> Swap (this server has little memory)"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Firewall: open web ports (existing rules are kept)"
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
if ufw status | grep -q inactive; then echo "Note: the ufw firewall is off. Not switching it on, so your other services keep working."; fi

echo "==> Getting the latest app"
tmp="$(mktemp -d)"
git clone --depth 1 --branch "$BRANCH" "$REPO" "$tmp/repo"
mkdir -p "$WEBROOT"
# Keep the server's own config.js (it is not in GitHub).
if [[ -f "$WEBROOT/admin/config.js" ]]; then cp "$WEBROOT/admin/config.js" "$tmp/config.js"; fi
rm -rf "$WEBROOT/admin"
cp -r "$tmp/repo/painted-shacks/admin" "$WEBROOT/admin"
if [[ -f "$tmp/config.js" ]]; then cp "$tmp/config.js" "$WEBROOT/admin/config.js"; else cp "$WEBROOT/admin/config.example.js" "$WEBROOT/admin/config.js"; fi
rm -rf "$tmp"
chown -R caddy:caddy "$WEBROOT"

echo "==> Web server config"
mkdir -p /etc/caddy/sites
grep -q 'import sites/\*' /etc/caddy/Caddyfile 2>/dev/null || { [ -s /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak; echo 'import sites/*' > /etc/caddy/Caddyfile; }
cat > /etc/caddy/sites/painted-shacks <<EOF
$DOMAIN {
  root * $WEBROOT/admin
  file_server
  encode gzip
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options nosniff
    X-Frame-Options DENY
    Referrer-Policy no-referrer
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'"
    -Server
  }
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy >/dev/null; systemctl reload caddy || systemctl restart caddy

echo
echo "Done. Open https://$DOMAIN"
if grep -q "YOUR-PROJECT" "$WEBROOT/admin/config.js"; then
  echo "NOTE: the app is in preview mode until $WEBROOT/admin/config.js has your Supabase URL and publishable key."
fi
