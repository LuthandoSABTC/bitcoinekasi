# Painted Shacks admin app

Mobile-friendly admin app for the Bitcoin Ekasi Painted Shacks project: shacks, owners, sponsor logos, sponsor contacts and sponsor funding.
It is the first of three apps (admin, owner, inspector) that share one Supabase database.

## Folders

| Path | What it is |
|---|---|
| `admin/` | The admin app. Plain HTML + JS, no build step. |
| `admin/config.example.js` | Copy to `config.js` on the server and add the Supabase URL and publishable key. |
| `sql/001_painted_shacks_admin.sql` | Creates the `ps_*` tables, row level security and the audit log. Old Diploma Tracker tables are not touched. Safe to re-run. |
| `deploy/setup-server.sh` | One-command setup for an Ubuntu/Debian server (Caddy + HTTPS). |

Real data (owner Lightning addresses, sponsor contacts) is **not** kept in this public repo. It is loaded straight into the database.

## Security

- Sign in with Supabase Auth (email + password). Only people in `ps_staff` with role `admin` can read or change anything.
- Row level security is on for every `ps_*` table, and the public anon key can read nothing.
- Every change is recorded in `ps_audit_log` (who, when, before, after).
- No payment keys in the browser. Blink payouts will run on the server (next step).

## Try it without a database

Open `admin/index.html?demo` (or leave `config.js` unset). It runs in preview mode and saves nothing.

## Add an admin

1. Supabase dashboard > Authentication > Users > Add user (email + password).
2. In the SQL editor: `insert into ps_staff(user_id, full_name, role) select id, 'Name', 'admin' from auth.users where email = 'person@example.com';`
