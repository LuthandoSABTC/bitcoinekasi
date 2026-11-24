#!/usr/bin/env bash
# Connects the Painted Shacks admin app to Bitcoin Ekasi's Blink payout wallet.
#
# Usage (as root):  bash /opt/painted-shacks/deploy/set-blink-key.sh
#
# The key is typed in hidden, saved to /etc/painted-shacks/blink.env (readable by root only), and loaded by
# the app's service at start. It is never put in the database, the backups, the browser or GitHub.
# Tip: use a separate Blink account just for payouts, holding about one month of payouts.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo "Please run as root (type: sudo -i, then run this again)."; exit 1; fi
FILE=/etc/painted-shacks/blink.env
APP=/opt/painted-shacks

echo "Create the key in the Blink dashboard (https://dashboard.blink.sv > API Keys)."
echo "  For testing, give it Read only. To send payouts it needs Read and Write."
echo
read -rsp "Paste the Blink API key (it won't show): " KEY; echo
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
if [[ -z "$KEY" ]]; then echo "No key given. Nothing changed."; exit 1; fi
if [[ ! "$KEY" =~ ^[A-Za-z0-9_\-]{20,200}$ ]]; then echo "That doesn't look like a Blink API key. Nothing changed."; exit 1; fi
read -rp "Blink BTC wallet id (press Enter to use the account's Bitcoin wallet): " WALLET
WALLET="$(printf '%s' "$WALLET" | tr -d '[:space:]')"
if [[ -n "$WALLET" && ! "$WALLET" =~ ^[A-Za-z0-9-]{8,64}$ ]]; then echo "That wallet id doesn't look right. Nothing changed."; exit 1; fi

install -d -o root -g root -m 700 /etc/painted-shacks
umask 077
tmp="$(mktemp /etc/painted-shacks/.blink.XXXXXX)"
{ echo "BLINK_API_KEY=$KEY"; if [[ -n "$WALLET" ]]; then echo "BLINK_WALLET_ID=$WALLET"; fi; } > "$tmp"
chown root:root "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$FILE"
unset KEY

echo "Testing the connection to Blink..."
if ( set -a; . "$FILE"; set +a; cd "$APP/server" && node -e '
  require("./blink").wallet().then(w => {
    console.log(`Connected. Payout wallet balance: ${w.balance_sats.toLocaleString("en-ZA")} sats.`);
    console.log(w.scopes.includes("WRITE") ? "This key CAN send payouts (after an admin approves them in the app)." : "This key can only READ. Sending stays off until you use a key with Write.");
  }).catch(e => { console.error("Blink test failed: " + e.message); process.exit(1); })' ); then
  systemctl restart painted-shacks
  echo "Saved and the app restarted."
else
  echo "The key was saved, but the test failed (see above). Fix it by running this script again."
  systemctl restart painted-shacks
  exit 1
fi
