-- Ember Mug history schema for Supabase / Postgres.
--
-- Run this in the SQL editor of a new project, then sign in from the app.
--
-- `user_id` is part of every primary key on purpose: it makes a cross-tenant device_id
-- collision impossible, and it lets the row-level-security predicate ride the primary key
-- index instead of filtering after the scan.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.mug_devices (
  user_id          uuid     not null default auth.uid() references auth.users(id) on delete cascade,
  device_id        text     not null,
  serial_number    text,
  name             text,
  model            text,
  device_type      text     not null default 'unknown',
  capacity_ml      int,
  colour           text,
  fw_version       text,
  fw_hardware      text,
  fw_bootloader    text,
  liquid_level_max smallint not null default 30,
  first_seen_ms    bigint   not null,
  last_seen_ms     bigint   not null,
  ble_hint         text,
  meta             jsonb,
  primary key (user_id, device_id)
);

create unique index if not exists mug_devices_serial_uq
  on public.mug_devices (user_id, serial_number)
  where serial_number is not null;

create table if not exists public.mug_sessions (
  user_id      uuid   not null default auth.uid() references auth.users(id) on delete cascade,
  session_id   uuid   not null,
  device_id    text   not null,
  started_ms   bigint not null,
  ended_ms     bigint,
  end_reason   text,
  sample_count int    not null default 0,
  app_version  text,
  primary key (user_id, session_id),
  foreign key (user_id, device_id)
    references public.mug_devices(user_id, device_id) on delete cascade
);

create index if not exists mug_sessions_dev_start
  on public.mug_sessions (user_id, device_id, started_ms);

-- Integers in device-native resolution: centi-degrees, deci-percent, millivolts.
-- `target_c` is NULL - never 0 - when temperature control is off, so that a bucket
-- average is not dragged to the floor by a sentinel value.
create table if not exists public.mug_samples (
  user_id      uuid     not null default auth.uid() references auth.users(id) on delete cascade,
  device_id    text     not null,
  ts           bigint   not null,
  session_id   uuid,
  temp_c       int,
  target_c     int,
  battery_dpc  smallint,
  liquid_dpc   smallint,
  liquid_state smallint,
  battery_mv   int,
  flags        int      not null default 0,
  primary key (user_id, device_id, ts)
);

create table if not exists public.mug_events (
  user_id    uuid   not null default auth.uid() references auth.users(id) on delete cascade,
  event_id   uuid   not null,
  device_id  text   not null,
  ts         bigint not null,
  type       text   not null,
  session_id uuid,
  num_a      double precision,
  num_b      double precision,
  text_a     text,
  data       jsonb,
  primary key (user_id, event_id)
);

-- The client mints the event id, so a replay is free. This natural key is what stops the
-- same transition, recorded from two different browsers, becoming two rows.
create unique index if not exists mug_events_natural_uq
  on public.mug_events (user_id, device_id, ts, type);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The anon key is public by design; RLS is the only thing that makes that safe. A table
-- reaching production without it exposes every user's data to anyone on the internet.
-- ---------------------------------------------------------------------------

alter table public.mug_devices  enable row level security;
alter table public.mug_sessions enable row level security;
alter table public.mug_samples  enable row level security;
alter table public.mug_events   enable row level security;

-- `(select auth.uid())` is not a style choice: the subquery is hoisted to an InitPlan and
-- evaluated once, instead of once per row. On a 200k-row scan that is milliseconds
-- against seconds.
drop policy if exists mug_devices_own on public.mug_devices;
create policy mug_devices_own on public.mug_devices
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists mug_sessions_own on public.mug_sessions;
create policy mug_sessions_own on public.mug_sessions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists mug_samples_own on public.mug_samples;
create policy mug_samples_own on public.mug_samples
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists mug_events_own on public.mug_events;
create policy mug_events_own on public.mug_events
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.mug_devices, public.mug_sessions,
              public.mug_samples, public.mug_events from anon;

-- ---------------------------------------------------------------------------
-- Bucketing RPC
--
-- PostgREST cannot express GROUP BY, so the chart query lives here.
-- `security invoker` is essential: a definer function would bypass RLS entirely.
-- ---------------------------------------------------------------------------

create or replace function public.mug_samples_bucketed(
  p_device_id text,
  p_from bigint,
  p_to bigint,
  p_bucket_ms bigint
) returns table (
  b bigint,
  n int,
  temp_avg double precision,
  temp_min int,
  temp_max int,
  batt_avg double precision,
  batt_min int,
  batt_max int,
  liquid_avg double precision,
  state_last smallint,
  target_last int,
  charge_frac double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select (s.ts / p_bucket_ms) * p_bucket_ms as b,
         count(*)::int,
         avg(s.temp_c)::double precision,
         min(s.temp_c),
         max(s.temp_c),
         avg(s.battery_dpc)::double precision,
         min(s.battery_dpc)::int,
         max(s.battery_dpc)::int,
         avg(s.liquid_dpc)::double precision,
         -- Postgres has no bare-column-with-max() shortcut, so the last value in the
         -- bucket is taken explicitly.
         (array_agg(s.liquid_state order by s.ts desc))[1],
         (array_agg(s.target_c     order by s.ts desc))[1],
         (avg((s.flags & 1)::int))::double precision
  from public.mug_samples s
  where s.device_id = p_device_id
    and s.ts >= p_from
    and s.ts <  p_to
  group by 1
  order by 1;
$$;

grant execute on function public.mug_samples_bucketed(text, bigint, bigint, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- Device merge
--
-- Used when a mug first recorded without a readable serial number later reports one.
-- ---------------------------------------------------------------------------

create or replace function public.mug_merge_devices(p_from text, p_into text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user   uuid := (select auth.uid());
  v_samples int;
  v_events  int;
begin
  -- Rows whose timestamp already exists on the target are dropped rather than colliding.
  delete from public.mug_samples s
   where s.user_id = v_user
     and s.device_id = p_from
     and exists (
       select 1 from public.mug_samples t
        where t.user_id = v_user and t.device_id = p_into and t.ts = s.ts
     );

  update public.mug_samples
     set device_id = p_into
   where user_id = v_user and device_id = p_from;
  get diagnostics v_samples = row_count;

  delete from public.mug_events e
   where e.user_id = v_user
     and e.device_id = p_from
     and exists (
       select 1 from public.mug_events t
        where t.user_id = v_user and t.device_id = p_into
          and t.ts = e.ts and t.type = e.type
     );

  update public.mug_events
     set device_id = p_into
   where user_id = v_user and device_id = p_from;
  get diagnostics v_events = row_count;

  update public.mug_sessions
     set device_id = p_into
   where user_id = v_user and device_id = p_from;

  delete from public.mug_devices
   where user_id = v_user and device_id = p_from;

  return jsonb_build_object('moved_samples', v_samples, 'moved_events', v_events);
end;
$$;

grant execute on function public.mug_merge_devices(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS self-check
--
-- The app calls this on connect and refuses to use a project where any table has RLS
-- switched off, rather than silently writing into a world-readable database.
-- ---------------------------------------------------------------------------

create or replace function public.mug_rls_status()
returns table (table_name text, rls_enabled boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.relname::text, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('mug_devices', 'mug_sessions', 'mug_samples', 'mug_events');
$$;

grant execute on function public.mug_rls_status() to authenticated;

-- Schema version marker, so the client can detect an out-of-date project.
create table if not exists public.mug_schema_meta (
  key   text primary key,
  value text not null
);
insert into public.mug_schema_meta (key, value)
values ('schema_version', '1')
on conflict (key) do update set value = excluded.value;

alter table public.mug_schema_meta enable row level security;

drop policy if exists mug_schema_meta_read on public.mug_schema_meta;
create policy mug_schema_meta_read on public.mug_schema_meta
  for select to authenticated using (true);
