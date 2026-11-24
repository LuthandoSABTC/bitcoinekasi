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
  structure     text not null check (structure in ('sound','leaking','broken')),
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
  return db;
}

module.exports = { open };
