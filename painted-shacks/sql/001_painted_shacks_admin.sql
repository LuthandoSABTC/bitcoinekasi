-- Painted Shacks admin app: tables, security and audit log.
-- Adds NEW tables only (all named ps_*). The old shack_owners / shack_checkins
-- tables used by the Diploma Tracker are not changed.
--
-- Security model
--   * Every ps_* table has row level security switched on.
--   * Only people listed in ps_staff can read or write. Everyone else
--     (including the public anon key) sees nothing.
--   * Every insert / update / delete is written to ps_audit_log.
--   * The public dashboard will later read from a separate view that only
--     shows safe fields (Lightning address only when the owner opted in).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- staff
create table if not exists public.ps_staff (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null,
  role       text not null default 'admin' check (role in ('admin','inspector')),
  created_at timestamptz not null default now()
);

create or replace function public.ps_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ps_staff where user_id = auth.uid() and role = 'admin');
$$;
revoke all on function public.ps_is_admin() from public;
grant execute on function public.ps_is_admin() to authenticated;

-- ---------------------------------------------------------------- sponsors
create table if not exists public.ps_sponsors (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null unique,
  website             text,
  kind                text not null default 'unaffiliated'
                      check (kind in ('for_profit','non_profit','unaffiliated','bitcoin_ekasi')),
  logo_url            text,          -- link to the logo artwork (Drive or upload)
  support_in_kind     text,          -- e.g. "Sponsors a node", "Skateboards"
  payment_status      text not null default 'never_paid'
                      check (payment_status in ('paying','ongoing_in_kind','never_paid','lapsed')),
  should_request_sats boolean not null default false,
  last_contact        text,          -- free text until we clean the dates
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.ps_sponsor_contacts (
  id          uuid primary key default gen_random_uuid(),
  sponsor_id  uuid not null references public.ps_sponsors(id) on delete cascade,
  name        text not null,
  email       text,
  chat        text,                  -- WhatsApp / Telegram / Signal handle or number
  notes       text,
  created_at  timestamptz not null default now()
);

-- Money in: sponsor funding (shown on the public dashboard when show_publicly).
create table if not exists public.ps_sponsor_payments (
  id            uuid primary key default gen_random_uuid(),
  sponsor_id    uuid not null references public.ps_sponsors(id) on delete restrict,
  received_on   date not null,
  amount_sats   bigint not null check (amount_sats >= 0),
  amount_zar    numeric(12,2),
  purpose       text not null default 'Painted Shacks',
  renews_on     date,
  show_publicly boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- owners
create table if not exists public.ps_owners (
  id                       uuid primary key default gen_random_uuid(),
  full_name                text,          -- may be blank until we visit them
  phone                    text,
  age                      int check (age is null or age between 10 and 110),
  occupation               text,
  lightning_address        text check (lightning_address is null or lightning_address ~* '^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  show_address_publicly    boolean not null default false,
  preferred_language       text not null default 'xh' check (preferred_language in ('xh','en','af')),
  active                   boolean not null default true,
  joined_on                date,
  legacy_shack_owner_id    bigint,        -- id in the old shack_owners table, if any
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create unique index if not exists ps_owners_lnaddr_uq on public.ps_owners (lower(lightning_address)) where lightning_address is not null;

-- ---------------------------------------------------------------- shacks
create table if not exists public.ps_shacks (
  id                uuid primary key default gen_random_uuid(),
  shack_no          int not null unique check (shack_no > 0),
  owner_id          uuid references public.ps_owners(id) on delete set null,  -- one owner can have more than one wall
  sponsor_id        uuid references public.ps_sponsors(id) on delete set null, -- the logo painted on the wall
  status            text not null default 'painted'
                    check (status in ('painted','needs_repaint','to_replace','free_wall','removed')),
  needs_maintenance boolean not null default false,
  first_painted_on  date,
  photo_url         text,
  x_post_url        text,
  area              text,           -- street / section of the township
  latitude          numeric(9,6),
  longitude         numeric(9,6),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists ps_shacks_owner_idx   on public.ps_shacks(owner_id);
create index if not exists ps_shacks_sponsor_idx on public.ps_shacks(sponsor_id);
create index if not exists ps_contacts_sponsor_idx on public.ps_sponsor_contacts(sponsor_id);
create index if not exists ps_payments_sponsor_idx on public.ps_sponsor_payments(sponsor_id);

-- ---------------------------------------------------------------- audit log
create table if not exists public.ps_audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid default auth.uid(),
  table_name  text not null,
  row_id      text,
  action      text not null,
  before      jsonb,
  after       jsonb
);

create or replace function public.ps_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.ps_audit_log(table_name, row_id, action, before, after)
  values (tg_table_name,
          coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'id', ''),
          tg_op,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create or replace function public.ps_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['ps_sponsors','ps_sponsor_contacts','ps_sponsor_payments','ps_owners','ps_shacks','ps_staff'] loop
    execute format('drop trigger if exists %1$s_audit on public.%1$s', t);
    execute format('create trigger %1$s_audit after insert or update or delete on public.%1$s for each row execute function public.ps_audit()', t);
  end loop;
  foreach t in array array['ps_sponsors','ps_owners','ps_shacks'] loop
    execute format('drop trigger if exists %1$s_touch on public.%1$s', t);
    execute format('create trigger %1$s_touch before update on public.%1$s for each row execute function public.ps_touch()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- row level security
alter table public.ps_staff            enable row level security;
alter table public.ps_sponsors         enable row level security;
alter table public.ps_sponsor_contacts enable row level security;
alter table public.ps_sponsor_payments enable row level security;
alter table public.ps_owners           enable row level security;
alter table public.ps_shacks           enable row level security;
alter table public.ps_audit_log        enable row level security;

-- Staff can see their own staff row (so the app knows who is signed in); admins see all.
drop policy if exists ps_staff_self on public.ps_staff;
create policy ps_staff_self on public.ps_staff for select to authenticated
  using (user_id = auth.uid() or public.ps_is_admin());

do $$
declare t text;
begin
  foreach t in array array['ps_sponsors','ps_sponsor_contacts','ps_sponsor_payments','ps_owners','ps_shacks'] loop
    execute format('drop policy if exists %1$s_admin_all on public.%1$s', t);
    execute format('create policy %1$s_admin_all on public.%1$s for all to authenticated using (public.ps_is_admin()) with check (public.ps_is_admin())', t);
  end loop;
end $$;

drop policy if exists ps_audit_admin_read on public.ps_audit_log;
create policy ps_audit_admin_read on public.ps_audit_log for select to authenticated using (public.ps_is_admin());

-- No grants to anon at all: the public dashboard gets its own safe view later.
revoke all on public.ps_staff, public.ps_sponsors, public.ps_sponsor_contacts,
              public.ps_sponsor_payments, public.ps_owners, public.ps_shacks, public.ps_audit_log from anon;
