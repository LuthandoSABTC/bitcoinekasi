# Painted Shacks admin and inspector apps

Mobile-friendly apps for the Bitcoin Ekasi Painted Shacks project:

- **Admin app** (`/`): shacks, owners, sponsor logos, sponsor contacts, sponsor funding, inspection results, and the accounts of inspectors.
- **Inspector app** (`/inspect`): phone-first. Shacks to inspect (overdue first), a checklist with photos, works with no signal and uploads later. Inspectors never see payments, phone numbers or Lightning addresses.
It runs entirely on our own server. No Supabase, no outside database, no npm packages.

## How it fits together

```
phone / laptop ──HTTPS──> Caddy (web server, certificate)
                             ├── /        -> admin/ (the admin app)
                             ├── /inspect -> inspector/ (the inspector app, works offline)
                             └── /api/*   -> Node.js server (127.0.0.1:3417)
                                                 ├── SQLite file /var/lib/painted-shacks/painted-shacks.db
                                                 └── inspection photos /var/lib/painted-shacks/photos/YYYY-MM/*.jpg
nightly 01:30 -> database copy to /var/backups/painted-shacks (kept 30 days), new photos copied to /var/backups/painted-shacks/photos
```

| Path | What it is |
|---|---|
| `admin/index.html` | The admin app. Plain HTML + JS. |
| `inspector/` | The inspector app: `index.html`, `sw.js` (keeps it working offline), icons. |
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

## Inspections

- Add inspectors in the admin app under **Settings > Inspectors and admins**. It shows their password once.
- Each shack is due for an inspection every 90 days (set `INSPECT_EVERY_DAYS` in the service file to change it). Never-inspected shacks count as overdue.
- The checklist is Paint (good / fading / damaged), Logo visible from the road (yes / partly / no), Roof and walls (sound / leaking / broken).
  Result: **Needs repaint** if paint is damaged or the logo is not visible, **Needs attention** for anything else that isn't perfect, otherwise **Good**.
- The newest inspection sets the shack's "Needs maintenance" flag and moves it between Painted and Needs repaint (other statuses are left alone).
- On the phone, an inspection and its photos are saved in the browser (IndexedDB) first, then sent. Each one has an id made on the phone, so sending twice on bad signal stores it once.
- Photos are shrunk on the phone to at most 1280 px (JPEG, usually 150-300 KB) before upload. The server only accepts JPEG up to 1.5 MB.

## Security

- Passwords are hashed with scrypt. Sessions are random tokens in an HttpOnly, Secure, SameSite=Strict cookie.
- Login is limited to 10 tries per 15 minutes per IP address.
- Every change needs the app's own request header, which blocks cross-site requests.
- The server only accepts known fields and checks them (dates, numbers, links, Lightning addresses).
- Every change is recorded in `audit_log` (who, when, before, after).
- The API listens on 127.0.0.1 only and runs as its own locked-down system user.
- Inspector accounts can only use the inspector endpoints; every admin endpoint answers "Admins only".
- No payment keys anywhere yet. Blink payouts will run on this server in a later step.

## Try it locally

```
cd server && COOKIE_SECURE=0 DB_PATH=./dev.db node server.js
```
and serve `admin/` with any static server that forwards `/api` to port 3417.
