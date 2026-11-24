#!/usr/bin/env bash
# Installs or updates the Painted Shacks admin app on an Ubuntu server (built for "ekasi-server", Ubuntu 22.04, 1 GB RAM).
#
# Usage (as root):   bash setup-server.sh 89-125-10-8.sslip.io
#                    (later, with your own domain: bash setup-server.sh admin.bitcoinekasi.com)
# Run the same command again any time to update to the latest version. Your data is never touched by an update.
#
# What it sets up:
#   * Node.js 22 (runs the app; the database is SQLite, built in, no extra database server)
#   * Caddy (web server; gets the HTTPS certificate automatically)
#   * The app in /opt/painted-shacks, data in /var/lib/painted-shacks, nightly backups in /var/backups/painted-shacks
#   * 1 GB swap if the server has none
set -euo pipefail

DOMAIN="${1:-}"
REPO="https://github.com/LuthandoSABTC/bitcoinekasi"
BRANCH="${BRANCH:-main}"
APP=/opt/painted-shacks

if [[ -z "$DOMAIN" ]]; then echo "Usage: bash setup-server.sh your-domain"; exit 1; fi
if [[ $EUID -ne 0 ]]; then echo "Please run as root (type: sudo -i, then run this again)."; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

echo "==> 1/7 Packages"
apt-get update -y -q
apt-get install -y -q ca-certificates curl git gnupg debian-keyring debian-archive-keyring apt-transport-https ufw

echo "==> 2/7 Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
node -e "require('node:sqlite')" 2>/dev/null || { echo "This Node.js has no built-in SQLite. Please send this output to Claude."; exit 1; }

echo "==> 3/7 Caddy web server"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y -q && apt-get install -y -q caddy
fi
if ss -ltnp | grep -E ':(80|443)\s' | grep -vq caddy; then
  echo "Something else is already using port 80 or 443:"; ss -ltnp | grep -E ':(80|443)\s'
  echo "Stopping here so nothing breaks. Send this output to Claude."; exit 1
fi

if ss -ltn | grep -q '127.0.0.1:3417\s' && ! systemctl is-active --quiet painted-shacks; then
  echo "Port 3417 is already used by another program. Send this output to Claude."; ss -ltnp | grep ':3417'; exit 1
fi

echo "==> 4/7 Swap and firewall"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
ufw allow OpenSSH >/dev/null || true
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
if ufw status | grep -q inactive; then echo "    (ufw firewall is off; leaving it off so nothing else on this server breaks)"; fi

echo "==> 5/7 App files"
id painted-shacks >/dev/null 2>&1 || useradd --system --home /var/lib/painted-shacks --shell /usr/sbin/nologin painted-shacks
install -d -o painted-shacks -g painted-shacks -m 700 /var/lib/painted-shacks /var/backups/painted-shacks
tmp="$(mktemp -d)"
git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$tmp/repo"
rm -rf "$APP.new" && cp -r "$tmp/repo/painted-shacks" "$APP.new"
rm -rf "$APP.old"; [[ -d "$APP" ]] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"
rm -rf "$tmp"
chown -R root:root "$APP" && chmod -R a+rX "$APP"

echo "==> 6/7 Services"
cp "$APP/deploy/painted-shacks.service" "$APP/deploy/painted-shacks-backup.service" "$APP/deploy/painted-shacks-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now painted-shacks-backup.timer >/dev/null
systemctl enable painted-shacks >/dev/null
systemctl restart painted-shacks
for i in $(seq 1 15); do curl -fsS http://127.0.0.1:3417/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:3417/api/health >/dev/null || { echo "The app did not start. Log:"; journalctl -u painted-shacks -n 30 --no-pager; exit 1; }

echo "==> 7/7 HTTPS"
mkdir -p /etc/caddy/sites
grep -q 'import sites/\*' /etc/caddy/Caddyfile 2>/dev/null || { [ -s /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak; echo 'import sites/*' > /etc/caddy/Caddyfile; }
cat > /etc/caddy/sites/painted-shacks <<EOF
$DOMAIN {
  encode gzip
  handle /api/* {
    reverse_proxy 127.0.0.1:3417
  }
  handle {
    root * $APP/admin
    file_server
  }
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options nosniff
    X-Frame-Options DENY
    Referrer-Policy no-referrer
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"
    -Server
  }
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable --now caddy >/dev/null; systemctl reload caddy || systemctl restart caddy

echo
echo "All done. Open https://$DOMAIN"
if [[ -z "$(cd "$APP/server" && sudo -u painted-shacks DB_PATH=/var/lib/painted-shacks/painted-shacks.db node --disable-warning=ExperimentalWarning admin-user.js list)" ]]; then
  echo
  echo "No admin account yet. Create yours with:"
  echo "  cd $APP/server && sudo -u painted-shacks DB_PATH=/var/lib/painted-shacks/painted-shacks.db node --disable-warning=ExperimentalWarning admin-user.js add you@example.com \"Your Name\""
fi
