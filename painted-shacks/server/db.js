// Database for the Painted Shacks admin app: one SQLite file on the server.
// Uses Node's built-in SQLite (node:sqlite), so there are no packages to install.
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = `
pragma journal_mode = wal;
pragma foreign_keys = on;
pragma busy_timeout = 5000;

create table if not exists staff (
  id          text primary key,
  email       text not null unique collate nocase,
  full_name   text not null,
  role        text not null default 'admin' check (role in ('admin','inspector')),
  pw_hash     text not null,
  disabled    integer not null default 0,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists sessions (
  token_hash  text primary key,
  staff_id    text not null references staff(id) on delete cascade,
  expires_at  integer not null,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists sponsors (
  id                  text primary key,
  name                text not null unique collate nocase,
  website             text,
  kind                text not null default 'unaffiliated' check (kind in ('for_profit','non_profit','unaffiliated','bitcoin_ekasi')),
  logo_url            text,
  support_in_kind     text,
  payment_status      text not null default 'never_paid' check (payment_status in ('paying','ongoing_in_kind','never_paid','lapsed')),
  should_request_sats integer not null default 0,
  last_contact        text,
  notes               text,
  created_at          text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists sponsor_contacts (
  id          text primary key,
  sponsor_id  text not null references sponsors(id) on delete cascade,
  name        text not null,
  email       text,
  chat        text,
  notes       text,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists sponsor_payments (
  id            text primary key,
  sponsor_id    text not null references sponsors(id) on delete restrict,
  received_on   text not null,
  amount_sats   integer not null check (amount_sats >= 0),
  amount_zar    real,
  purpose       text not null default 'Painted Shacks',
  renews_on     text,
  show_publicly integer not null default 1,
  notes         text,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists owners (
  id                    text primary key,
  full_name             text,
  phone                 text,
  age                   integer check (age is null or age between 10 and 110),
  occupation            text,
  lightning_address     text,
  show_address_publicly integer not null default 0,
  preferred_language    text not null default 'xh' check (preferred_language in ('xh','en','af')),
  active                integer not null default 1,
  joined_on             text,
  notes                 text,
  created_at            text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create unique index if not exists owners_lnaddr_uq on owners (lower(lightning_address)) where lightning_address is not null;

create table if not exists shacks (
  id                text primary key,
  shack_no          integer not null unique check (shack_no > 0),
  owner_id          text references owners(id) on delete set null,
  sponsor_id        text references sponsors(id) on delete set null,
  status            text not null default 'painted' check (status in ('painted','needs_repaint','to_replace','free_wall','removed')),
  needs_maintenance integer not null default 0,
  first_painted_on  text,
  photo_url         text,
  x_post_url        text,
  area              text,
  name              text,                 -- what owners call their shack; shown when they sign in to the app
  latitude          real,
  longitude         real,
  notes             text,
  created_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists shacks_owner_idx on shacks(owner_id);
create index if not exists shacks_sponsor_idx on shacks(sponsor_id);

-- Inspections. The id is made on the inspector's phone, so an inspection saved offline
-- and sent twice (bad signal) is only stored once.
create table if not exists inspections (
  id            text primary key,
  shack_id      text not null references shacks(id) on delete cascade,
  inspector_id  text references staff(id) on delete set null,
  inspected_on  text not null,
  paint         text not null check (paint in ('good','fading','damaged')),
  logo          text not null check (logo in ('yes','partly','no')),
  result        text not null check (result in ('good','touch_up','repaint')),
  notes         text,
  photo_count   integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists inspections_shack_idx on inspections(shack_id, inspected_on);
create index if not exists inspections_inspector_idx on inspections(inspector_id, inspected_on);

-- Photo files live on disk in PHOTO_DIR (compressed JPEG made on the phone); this table only holds where.
create table if not exists inspection_photos (
  id            text primary key,
  inspection_id text not null references inspections(id) on delete cascade,
  label         text,
  file          text not null,
  bytes         integer not null,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists inspection_photos_insp_idx on inspection_photos(inspection_id);

-- ---------------------------------------------------------------- Lightning payouts to shack owners
-- One row of settings. Changes are kept in audit_log.
create table if not exists pay_settings (
  id                 integer primary key check (id = 1),
  sats_per_week      integer not null default 7000 check (sats_per_week between 1 and 1000000),
  max_weeks          integer not null default 4 check (max_weeks between 1 and 5),
  draft_days_before  integer not null default 2 check (draft_days_before between 0 and 14),
  batch_limit_sats   integer not null default 1200000 check (batch_limit_sats > 0),
  single_limit_sats  integer not null default 50000 check (single_limit_sats > 0),
  max_fee_sats       integer not null default 100 check (max_fee_sats >= 0),
  updated_at         text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
insert or ignore into pay_settings(id) values (1);

-- A batch = the monthly payout run (period set) or a hand-made group.
create table if not exists payout_batches (
  id          text primary key,
  period      text unique,                 -- '2026-12' for the monthly run
  title       text not null,
  pay_date    text,
  status      text not null default 'open' check (status in ('open','closed')),
  created_by  text,
  notes       text,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One payment to one owner. Nothing is sent unless an admin approved it (approved_by + approved_at).
-- pending = waiting for approval, approved = queued to send, sending = sent to Blink (outcome being checked),
-- paid, failed (can be retried), cancelled.
create table if not exists payouts (
  id                text primary key,
  batch_id          text references payout_batches(id) on delete restrict,
  owner_id          text not null references owners(id) on delete restrict,
  period            text,
  reason            text not null default 'weekly_learning' check (reason in ('weekly_learning','bonus','correction','other')),
  weeks_earned      integer check (weeks_earned is null or weeks_earned between 0 and 5),
  amount_sats       integer not null check (amount_sats >= 0),
  note              text,
  lightning_address text,
  status            text not null default 'pending' check (status in ('pending','approved','sending','paid','failed','cancelled')),
  approved_by       text,
  approved_by_name  text,
  approved_at       text,
  payment_request   text,
  payment_hash      text,
  blink_tx_id       text,
  fee_sats          integer,
  paid_at           text,
  failure_reason    text,
  attempts          integer not null default 0,
  sending_since     text,
  created_by        text,
  created_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- An owner is paid for learning only once per month.
create unique index if not exists payouts_learning_once on payouts(owner_id, period) where reason = 'weekly_learning' and status <> 'cancelled';
create unique index if not exists payouts_hash_uq on payouts(payment_hash) where payment_hash is not null;
create index if not exists payouts_batch_idx on payouts(batch_id);
create index if not exists payouts_status_idx on payouts(status);

-- Every try to send a payout, for checking and retries.
create table if not exists payout_attempts (
  id            integer primary key autoincrement,
  payout_id     text not null references payouts(id) on delete cascade,
  at            text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  payment_hash  text,
  result        text not null,
  message       text
);
create index if not exists payout_attempts_idx on payout_attempts(payout_id);

-- Last check of each owner's Lightning address (works for any wallet, not only Blink).
create table if not exists address_checks (
  owner_id    text primary key references owners(id) on delete cascade,
  address     text not null,
  ok          integer not null,
  message     text,
  min_sats    integer,
  max_sats    integer,
  checked_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------- Owner learning app (/learn)
-- One row of settings for lessons and quizzes.
create table if not exists learn_settings (
  id               integer primary key check (id = 1),
  questions_shown  integer not null default 4 check (questions_shown between 1 and 20),
  pass_correct     integer not null default 3 check (pass_correct between 1 and 20),
  one_per_week     integer not null default 1,
  total_weeks      integer not null default 20 check (total_weeks between 1 and 60),
  start_date       text default '2026-12-01',  -- week 1 opens on this day (SA time); empty = open now
  updated_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
insert or ignore into learn_settings(id) values (1);

-- One lesson per week of the course. Owners only see published lessons; an admin publishes after checking.
create table if not exists lessons (
  id                 text primary key,
  week_no            integer not null unique check (week_no between 1 and 60),
  title              text not null,
  body               text not null default '',
  status             text not null default 'draft' check (status in ('draft','published')),
  source             text,
  published_at       text,
  published_by_name  text,
  updated_by_name    text,
  created_at         text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Pictures in lessons. Files are JPEGs on disk in LESSON_PIC_DIR.
create table if not exists lesson_pictures (
  id          text primary key,
  lesson_id   text not null references lessons(id) on delete cascade,
  file        text not null,
  bytes       integer not null,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Quiz questions. choices is a JSON list of strings, answer is the index of the right one.
create table if not exists quiz_questions (
  id          text primary key,
  lesson_id   text not null references lessons(id) on delete cascade,
  sort        integer not null default 0,
  question    text not null,
  choices     text not null,
  answer      integer not null check (answer >= 0),
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists quiz_questions_lesson_idx on quiz_questions(lesson_id, sort);

-- Owner sign-in for the learning app: shack number (or phone) + a 6-digit PIN an admin gives them.
create table if not exists owner_logins (
  owner_id       text primary key references owners(id) on delete cascade,
  pin_hash       text not null,
  failed         integer not null default 0,
  locked_until   integer not null default 0,
  disabled       integer not null default 0,
  last_login_at  text,
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists owner_sessions (
  token_hash  text primary key,
  owner_id    text not null references owners(id) on delete cascade,
  expires_at  integer not null,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Reading progress per owner and week.
create table if not exists lesson_reads (
  owner_id         text not null references owners(id) on delete cascade,
  week_no          integer not null,
  lesson_id        text references lessons(id) on delete set null,
  first_opened_at  text not null,
  last_opened_at   text not null,
  read_done_at     text,
  primary key (owner_id, week_no)
);

-- Every quiz an owner started. The server picks the questions, so the phone never sees the answers first.
create table if not exists quiz_attempts (
  id            text primary key,
  owner_id      text not null references owners(id) on delete cascade,
  week_no       integer not null,
  lesson_id     text references lessons(id) on delete set null,
  question_ids  text not null,
  orders        text,                      -- how each question's answers were shuffled on the phone
  started_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  submitted_at  text,
  score         integer,
  total         integer not null,
  passed        integer,
  answers       text
);
create index if not exists quiz_attempts_owner_idx on quiz_attempts(owner_id, week_no);

-- A finished week (lesson read + quiz passed). This is what payouts count: 7,000 sats per row.
-- pay_period = the monthly payout it belongs to (finishing on or after the draft day counts for next month).
create table if not exists lesson_completions (
  owner_id      text not null references owners(id) on delete cascade,
  week_no       integer not null,
  lesson_id     text references lessons(id) on delete set null,
  completed_on  text not null,
  completed_at  text not null,
  pay_period    text not null,
  passed        integer not null default 1,
  score         integer,
  total         integer,
  primary key (owner_id, week_no)
);
create index if not exists lesson_completions_period_idx on lesson_completions(pay_period, owner_id);

create table if not exists audit_log (
  id          integer primary key autoincrement,
  at          text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  staff_id    text,
  staff_email text,
  table_name  text not null,
  row_id      text,
  action      text not null,
  before      text,
  after       text
);
`;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // 2026-11-24: the "Roof and walls" check was removed from inspections.
  if (db.prepare("select 1 from pragma_table_info('inspections') where name = 'structure'").get())
    db.exec("alter table inspections drop column structure");
  // 2026-11-25: weeks on a learning payout come from the owner app unless an admin changed them by hand.
  if (!db.prepare("select 1 from pragma_table_info('payouts') where name = 'weeks_by_admin'").get())
    db.exec("alter table payouts add column weeks_by_admin integer not null default 0");
  // 2026-11-25: pay day for one month can be moved off the last Friday. December 2026 is paid on Wed 30 Dec (not Christmas).
  if (!db.prepare("select 1 from sqlite_master where type = 'table' and name = 'paydays'").get()) {
    db.exec(`create table paydays (
      period      text primary key check (period glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
      pay_date    text not null,
      set_by_name text,
      updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    db.prepare("insert into paydays(period, pay_date, set_by_name) values ('2026-12', '2026-12-30', 'Luthando')").run();
  }
  // 2026-11-25: owners pick their shack by name when they sign in to the learning app.
  if (!db.prepare("select 1 from pragma_table_info('shacks') where name = 'name'").get())
    db.exec("alter table shacks add column name text");
  // 2026-11-25: practice mode on the owner app's sign-in page (first weeks, no sign-in, no sats). 0 = off.
  if (!db.prepare("select 1 from pragma_table_info('learn_settings') where name = 'demo_weeks'").get())
    db.exec("alter table learn_settings add column demo_weeks integer not null default 2");
  // 2026-11-25: the learning programme starts on 1 December 2026.
  if (!db.prepare("select 1 from pragma_table_info('learn_settings') where name = 'start_date'").get())
    db.exec("alter table learn_settings add column start_date text default '2026-12-01'");
  return db;
}

module.exports = { open };
