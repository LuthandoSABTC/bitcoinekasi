# Painted Shacks admin app

Mobile-friendly admin app for the Bitcoin Ekasi Painted Shacks project: shacks, owners, sponsor logos, sponsor contacts and sponsor funding.
It runs entirely on our own server. No Supabase, no outside database, no npm packages.

## How it fits together

```
phone / laptop ──HTTPS──> Caddy (web server, certificate)
                             ├── /        -> admin/ (the app files)
                             └── /api/*   -> Node.js server (127.0.0.1:3417)
                                                 └── SQLite file /var/lib/painted-shacks/painted-shacks.db
nightly 01:30 -> copy to /var/backups/painted-shacks (kept 30 days)
```

| Path | What it is |
|---|---|
| `admin/index.html` | The admin app. Plain HTML + JS. |
| `server/server.js` | The API: sign-in, data, audit log, import, backup download. |
| `server/db.js` | Database tables. Created automatically on first start. |
| `server/admin-user.js` | Add, reset or disable admin accounts from the server's command line. |
| `server/backup.js` | Nightly backup (run by a systemd timer). |
| `deploy/setup-server.sh` | One command that installs or updates everything on Ubuntu. |

Real data (owner Lightning addresses, sponsor contacts) is **not** kept in this public repo. Load it once through Settings > Import data file.

## Install or update on the server

```
sudo -i
curl -fsSL https://raw.githubusercontent.com/LuthandoSABTC/bitcoinekasi/main/painted-shacks/deploy/setup-server.sh -o setup-server.sh
bash setup-server.sh 89-125-10-8.sslip.io
```

Then create your admin account (the command prints a password once):

```
cd /opt/painted-shacks/server && sudo -u painted-shacks DB_PATH=/var/lib/painted-shacks/painted-shacks.db node --disable-warning=ExperimentalWarning admin-user.js add you@example.com "Your Name"
```

## Security

- Passwords are hashed with scrypt. Sessions are random tokens in an HttpOnly, Secure, SameSite=Strict cookie.
- Login is limited to 10 tries per 15 minutes per IP address.
- Every change needs the app's own request header, which blocks cross-site requests.
- The server only accepts known fields and checks them (dates, numbers, links, Lightning addresses).
- Every change is recorded in `audit_log` (who, when, before, after).
- The API listens on 127.0.0.1 only and runs as its own locked-down system user.
- No payment keys anywhere yet. Blink payouts will run on this server in a later step.

## Try it locally

```
cd server && COOKIE_SECURE=0 DB_PATH=./dev.db node server.js
```
and serve `admin/` with any static server that forwards `/api` to port 3417.
