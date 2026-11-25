# Painted Shacks admin, inspector and owner learning apps

Mobile-friendly apps for the Bitcoin Ekasi Painted Shacks project:

- **Admin app** (`/`): shacks, owners, sponsor logos, sponsor contacts, sponsor funding, inspection results, the accounts of inspectors, and **Lightning payouts** to shack owners.
- **Inspector app** (`/inspect`): phone-first. Shacks to inspect (overdue first), a checklist with photos, works with no signal and uploads later. Inspectors never see payments, phone numbers or Lightning addresses.
- **Public dashboard** (`/dashboard`): anyone can open it. Live totals from the three apps (shacks, lessons, inspections, sats paid, sponsor funding, opt-in tip addresses). Read-only; see "Public dashboard" below.
- **Owner learning app** (`/learn`): phone-first, isiXhosa first (English switch). Owners sign in with their shack number and a PIN, read the weekly lesson, pass the quiz, and see the sats they earned this month and their payments.

It runs entirely on our own server. No Supabase, no outside database, no npm packages.

## How it fits together

```
phone / laptop ──HTTPS──> Caddy (web server, certificate)
                             ├── /        -> admin/ (the admin app)
                             ├── /inspect -> inspector/ (the inspector app, works offline)
                             ├── /learn   -> learn/ (the owner learning app)
                             ├── /dashboard -> dashboard/ (public, reads /api/public/dashboard)
                             └── /api/*   -> Node.js server (127.0.0.1:3417)
                                                 ├── SQLite file /var/lib/painted-shacks/painted-shacks.db
                                                 └── inspection photos /var/lib/painted-shacks/photos/YYYY-MM/*.jpg
nightly 01:30 -> database copy to /var/backups/painted-shacks (kept 30 days), new photos copied to /var/backups/painted-shacks/photos
```

| Path | What it is |
|---|---|
| `admin/index.html` | The admin app. Plain HTML + JS. |
| `admin/payments.js` | The Payments screens (monthly batches, approval, single payments, reports). |
| `inspector/` | The inspector app: `index.html`, `sw.js` (keeps it working offline), icons. |
| `server/server.js` | The API: sign-in, data, audit log, import, backup download. |
| `server/db.js` | Database tables. Created automatically on first start. |
| `server/payments.js` | Payouts: monthly drafts, approval, sending, checking, funding summary, CSV reports. |
| `server/lightning.js` | Reads any Lightning address (LNURL-pay) and checks the invoice it returns. |
| `server/blink.js` | Talks to the Blink API to pay invoices from Bitcoin Ekasi's wallet. |
| `server/payments.test.js` | Tests with a fake Blink and fake wallets: `node --test --disable-warning=ExperimentalWarning payments.test.js` |
| `deploy/set-blink-key.sh` | Saves the Blink key on the server (root only) and tests it. |
| `learn/` | The owner learning app: `index.html`, `lesson-render.js` (lesson text to phone pages, also used by the admin preview), `sw.js`. |
| `admin/learning.js` | Learning screens: owner progress, lesson editor and review, quiz settings, owner sign-in PINs. |
| `server/learn.js` | Owner sign-in, lessons, quizzes (marked on the server), progress, finished weeks for payouts. |
| `server/learn.test.js` | Tests: `node --test --disable-warning=ExperimentalWarning learn.test.js` |
| `content/lessons-xh-draft.json` | Draft lessons from the isiXhosa Bitcoin Diploma book (CC BY-SA 4.0, My First Bitcoin). Import in Learning > Lessons; they arrive as drafts. |
| `server/admin-user.js` | Add, reset or disable admin accounts from the server's command line. |
| `server/backup.js` | Nightly backup (run by a systemd timer). |
| `deploy/setup-server.sh` | One command that installs or updates everything on Ubuntu. |

Real data (owner Lightning addresses, sponsor contacts) is **not** kept in this public repo. Load it once through Settings > Import data file.

## Public dashboard

`dashboard/index.html` + `dashboard.js` (the retro "Painted Shacks Dashboard" design, fonts in `dashboard/fonts`, all self-hosted so no visitor data goes to Google). The page calls `GET /api/public/dashboard` every minute. That endpoint (`server/public.js`):

- needs no sign-in and is read-only; it is worked out at most once a minute and kept in memory, so many visitors cost the server almost nothing;
- returns only totals, dates and shack numbers. Never owner names, phone numbers, PINs, notes, inspection photos or payment details;
- shows an owner's Lightning address only when "Owner agreed to show their Lightning address" is ticked on the owner's page, and a sponsor payment only when "show publicly" is on;
- groups shacks into sections of JCC Camp (Zinyoka, Asazani) by each shack's "Section" field. Admins set them in Shacks > **Sections and map**, many at once ("1-29" → Zinyoka). There they also set the place name and where each section is (paste the numbers or a link from Google Maps). With places set, the dashboard shows a satellite map (Leaflet in `dashboard/leaflet`, Esri World Imagery tiles, loaded only then) with one circle per section and links to Google Maps. Single homes are never shown. Without places it shows the sketch.

Tests: `node --test --disable-warning=ExperimentalWarning public.test.js`

**On bitcoinekasi.com/painted-shacks (WordPress.com).** Two ways, nothing to change on the server:

1. Link: a button or link to `https://89-125-10-8.sslip.io/dashboard/` (works on every WordPress plan).
2. Embed: a Custom HTML block with
   `<iframe src="https://89-125-10-8.sslip.io/dashboard/?embed=1" style="width:100%;height:2600px;border:0" title="Painted Shacks live dashboard" loading="lazy"></iframe>`
   (`?embed=1` hides the dashboard's own top bar). WordPress.com only keeps iframes on plans that allow custom HTML/plugins. The server allows the page to be framed by bitcoinekasi.com and *.wordpress.com only; the admin, inspector and owner apps can never be framed.

When Bitcoin Ekasi gets its own domain for the server (for example `shacks.bitcoinekasi.com`), run the setup again with that name and use it in the link.

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
- The checklist is Paint (good / fading / damaged), Logo visible from the road (yes / partly / no).
  Result: **Needs repaint** if paint is damaged or the logo is not visible, **Needs attention** if paint is fading or the logo is only partly visible, otherwise **Good**.
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
- The Blink key is only in `/etc/painted-shacks/blink.env` (root-only, loaded by systemd). Never in the database, backups, browser or GitHub.
- No payment is sent without an admin approving it with their password. Timers only draft the monthly list and check payments already sent.

## Learning app (owners)

- **Sign-in**: on an owner's page, press *Make app sign-in (PIN)*. The admin sees a 6-digit PIN once and can send it on WhatsApp. Owners sign in with their shack number (or phone number) and the PIN. 5 wrong PINs lock it for 15 minutes. Owners can change their PIN; admins can make a new one or block sign-in.
- **Lessons**: one lesson per week, 20 weeks. Lessons are drafts until an admin publishes them; owners only see published lessons. Learning > Lessons has an editor with pictures, quiz questions and a preview of the phone pages. Lesson text format: `---` new page, `# ` heading, `- ` bullet, `> ` box, `**bold**`.
- **Quiz**: the server picks questions at random (default 4 of the lesson's questions, 3 right to pass) and shuffles the answers, and marks them. The phone never gets the answers first. Right answers are shown only after passing.
- **One lesson a week**: the next lesson opens on the Monday after the last one was finished (can be turned off in Quiz settings).
- **Payouts**: each finished week (lesson read + quiz passed) counts 7,000 sats for that month's payout, up to 4 weeks. Weeks finished on or after the day the monthly batch is drafted count for the next month. The batch takes weeks from the app; *Update weeks from app* brings in late ones. An admin can still change a line by hand.
- **Progress**: Learning > Owner progress shows every owner's weeks done, this month's weeks and sats, where they are now, last activity, and a WhatsApp *Remind* button. Each owner's page shows week-by-week detail.

## Payments (Lightning payouts to owners)

- Owners earn 7,000 sats per finished week (lesson and quiz in the app), up to 28,000 sats a month. Change it under Payments > Settings.
- Pay day is the **last Friday** of the month. Two days before, the server drafts that month's list (one line per active owner). Nothing is sent.
- Weeks come from the learning app. An admin checks the weeks per owner, then presses **Approve and send** and types their password. Only then does the server pay.
- Owners can use **any** Lightning address (Blink, Fedi, Aqua, Wallet of Satoshi, Phoenix, Coinos, ...). The server asks the owner's wallet for an invoice of the exact amount (LNURL-pay), checks the amount, and pays it from the Blink wallet. Bitcoin Ekasi pays the network fee.
- Safety: one learning payout per owner per month (database rule); the payment hash is saved before paying, and a payment whose answer was lost is checked with Blink, never sent again; limits per approval, per single payment and per fee; the wallet balance is checked before approving; inspectors can't see payments.
- Statuses: waiting for approval, approved (in queue), sending, paid, failed (retry needs approval again), cancelled.
- Reports: payments CSV (any date range or status, or one batch) and a funding statement CSV (sponsor money in, payouts out, running balance).

Connect the wallet once on the server (it asks for the key without showing it):

```
sudo -i
bash /opt/painted-shacks/deploy/set-blink-key.sh
```

Start with a **Read** only key to test, then use a key with **Read + Write** to send. Use a separate Blink account for payouts that holds about one month of payouts.

## Try it locally

```
cd server && COOKIE_SECURE=0 DB_PATH=./dev.db node server.js
```
and serve `admin/` with any static server that forwards `/api` to port 3417.
