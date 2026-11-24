#!/usr/bin/env bash
# Sets up the Painted Shacks admin app on a fresh Ubuntu/Debian server (e.g. a Nymbox VPS).
# Usage (as root):  bash setup-server.sh admin.example.com
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

echo "==> Firewall: allow SSH and web only"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

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
cat > /etc/caddy/Caddyfile <<EOF
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
systemctl reload caddy || systemctl restart caddy

echo
echo "Done. Open https://$DOMAIN"
if grep -q "YOUR-PROJECT" "$WEBROOT/admin/config.js"; then
  echo "NOTE: the app is in preview mode until $WEBROOT/admin/config.js has your Supabase URL and publishable key."
fi
