-- XIE Spaces · schema (Supabase / Postgres 15+)
-- Run in the Supabase SQL editor, or `npm run db:migrate` with SUPABASE_DB_URL set.
-- The booking engine (src/lib/engine.ts) decides; apply_engine_changes() persists atomically,
-- and the EXCLUDE constraint is the final arbiter against double bookings.

create extension if not exists btree_gist;
create extension if not exists vector;

do $$ begin
  create type user_role as enum ('student', 'faculty', 'approver', 'admin');
exception when duplicate_object then null; end $$;
do $$ begin
  create type booking_purpose as enum ('exam', 'academic_class', 'faculty_event', 'club_event', 'casual');
exception when duplicate_object then null; end $$;
do $$ begin
  create type booking_status as enum ('draft', 'pending_approval', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show', 'bumped');
exception when duplicate_object then null; end $$;

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null,
  role user_role not null default 'student',
  approver_pools text[] not null default '{}',
  club text
);

create table if not exists floors (
  id smallint primary key,
  name text not null
);

create table if not exists resources (
  id text primary key,                       -- e.g. F2-10, COURT-TURF
  name text not null,
  type text not null,                        -- lh | lab | tutorial | seminar | study | meeting | outdoor
  floor smallint references floors,
  capacity int not null,
  capacity_verified boolean not null default true,
  tags text[] not null default '{}',
  embedding vector(1536),
  svg_path_id text not null,
  min_role_required user_role not null default 'student',
  requires_approval boolean not null default false,
  approval_pool_id text,
  max_advance_days_by_role jsonb not null default '{"student":3,"faculty":21,"approver":21,"admin":null}',
  max_duration_minutes int not null default 240,
  checkin_window_minutes int not null default 10,
  active boolean not null default true
);

-- One row per resource; a multi-resource bundle shares the same id (all-or-nothing).
create table if not exists bookings (
  id text not null,
  resource_id text not null references resources,
  requester_id uuid references profiles,
  requester_name text not null,
  requester_role user_role not null,
  club text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  title text not null,
  purpose booking_purpose not null,
  priority_score int not null default 0,
  status booking_status not null default 'pending_approval',
  attendee_count int not null,
  checked_in boolean not null default false,
  occupancy real not null default 0,
  parent_booking_id text,
  series_id uuid,
  created_at timestamptz not null default now(),
  primary key (id, resource_id),
  check (ends_at > starts_at),
  -- THE double-booking guard. App logic is never the only defence.
  constraint bookings_no_overlap exclude using gist (
    resource_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('confirmed', 'pending_approval', 'checked_in'))
);
create index if not exists bookings_resource_range on bookings using gist (resource_id, tstzrange(starts_at, ends_at));
create index if not exists bookings_starts on bookings (starts_at);

create table if not exists blackouts (
  id text primary key,
  label text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  resource_ids text[] not null,
  allow booking_purpose[] not null default '{exam}'
);

create table if not exists conflict_events (
  id text primary key,
  at timestamptz not null default now(),
  kind text not null,
  resource_ids text[] not null default '{}',
  booking_id text,
  loser_booking_id text,
  winner_score jsonb,
  loser_score jsonb,
  explanation text not null
);
create index if not exists conflict_events_at on conflict_events (at desc);

create table if not exists fairness_ledger (
  subject text primary key,                  -- user name or club
  bumps_suffered int not null default 0,
  points int not null default 0
);

create table if not exists waitlist (
  id text primary key,
  resource_ids text[] not null,
  requester_name text not null,
  requester_role user_role not null,
  club text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  title text not null,
  purpose booking_purpose not null,
  attendee_count int not null,
  created_at timestamptz not null default now()
);

create table if not exists occupancy_signals (
  id bigserial primary key,
  resource_id text not null references resources,
  density real not null check (density between 0 and 1),
  source text not null,
  at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text,
  action text not null,
  payload jsonb not null
);

-- ---------------------------------------------------------------- RLS
-- Reads are public (live map). Every write goes through the server (service role) after the
-- engine re-checks rules and the caller's role from profiles. Never trust the client.
alter table profiles enable row level security;
alter table floors enable row level security;
alter table resources enable row level security;
alter table bookings enable row level security;
alter table blackouts enable row level security;
alter table conflict_events enable row level security;
alter table fairness_ledger enable row level security;
alter table waitlist enable row level security;
alter table occupancy_signals enable row level security;
alter table audit_log enable row level security;

drop policy if exists "read own profile" on profiles;
create policy "read own profile" on profiles for select using (id = auth.uid());
drop policy if exists "public read" on floors;
create policy "public read" on floors for select using (true);
drop policy if exists "public read" on resources;
create policy "public read" on resources for select using (true);
drop policy if exists "public read" on bookings;
create policy "public read" on bookings for select using (true);
drop policy if exists "public read" on blackouts;
create policy "public read" on blackouts for select using (true);
drop policy if exists "public read" on conflict_events;
create policy "public read" on conflict_events for select using (true);
drop policy if exists "public read" on fairness_ledger;
create policy "public read" on fairness_ledger for select using (true);
drop policy if exists "public read" on waitlist;
create policy "public read" on waitlist for select using (true);
-- occupancy_signals and audit_log: no client policies (service role only).

revoke update, delete on audit_log from anon, authenticated; -- append-only

-- ---------------------------------------------------------------- the one write path
-- Applies an engine diff in ONE transaction: status/time updates first (releases), then inserts.
-- On overlap Postgres raises 23P01; we roll back and report it so the engine can re-decide.
create or replace function apply_engine_changes(changes jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u jsonb;
  b jsonb;
  r text;
begin
  for u in select * from jsonb_array_elements(coalesce(changes -> 'updates', '[]')) loop
    update bookings set
      status = coalesce((u ->> 'status')::booking_status, status),
      ends_at = coalesce((u ->> 'ends_at')::timestamptz, ends_at),
      checked_in = coalesce((u ->> 'checked_in')::boolean, checked_in),
      occupancy = coalesce((u ->> 'occupancy')::real, occupancy)
    where id = u ->> 'id';
  end loop;

  for b in select * from jsonb_array_elements(coalesce(changes -> 'inserts', '[]')) loop
    for r in select jsonb_array_elements_text(b -> 'resource_ids') loop
      insert into bookings (id, resource_id, requester_id, requester_name, requester_role, club, starts_at, ends_at, title, purpose, priority_score, status, attendee_count)
      values (
        b ->> 'id', r, nullif(b ->> 'requester_id', '')::uuid, b ->> 'requester_name', (b ->> 'requester_role')::user_role, b ->> 'club',
        (b ->> 'starts_at')::timestamptz, (b ->> 'ends_at')::timestamptz, b ->> 'title', (b ->> 'purpose')::booking_purpose,
        coalesce((b ->> 'priority')::int, 0), (b ->> 'status')::booking_status, (b ->> 'attendees')::int
      );
    end loop;
  end loop;

  insert into conflict_events (id, at, kind, resource_ids, booking_id, loser_booking_id, winner_score, loser_score, explanation)
  select e ->> 'id', to_timestamp((e ->> 'at')::double precision / 1000), e ->> 'kind',
         array(select jsonb_array_elements_text(e -> 'roomIds')), e ->> 'bookingId', e ->> 'loserId',
         e -> 'winnerScore', e -> 'loserScore', e ->> 'text'
  from jsonb_array_elements(coalesce(changes -> 'events', '[]')) e
  on conflict (id) do nothing;

  insert into fairness_ledger (subject, bumps_suffered, points)
  select l ->> 'subject', (l ->> 'bumps')::int, (l ->> 'points')::int
  from jsonb_array_elements(coalesce(changes -> 'ledger', '[]')) l
  on conflict (subject) do update set bumps_suffered = excluded.bumps_suffered, points = excluded.points;

  delete from waitlist where id in (select jsonb_array_elements_text(coalesce(changes -> 'waitlist_remove', '[]')));
  insert into waitlist (id, resource_ids, requester_name, requester_role, club, starts_at, ends_at, title, purpose, attendee_count)
  select w ->> 'id', array(select jsonb_array_elements_text(w -> 'resource_ids')), w ->> 'requester_name', (w ->> 'requester_role')::user_role,
         w ->> 'club', (w ->> 'starts_at')::timestamptz, (w ->> 'ends_at')::timestamptz, w ->> 'title', (w ->> 'purpose')::booking_purpose, (w ->> 'attendees')::int
  from jsonb_array_elements(coalesce(changes -> 'waitlist_add', '[]')) w;

  insert into audit_log (actor, action, payload) values (changes ->> 'actor', 'apply_engine_changes', changes);
  return jsonb_build_object('ok', true);
exception when exclusion_violation then
  return jsonb_build_object('ok', false, 'code', '23P01', 'detail', sqlerrm);
end $$;

revoke execute on function apply_engine_changes(jsonb) from public, anon, authenticated;

-- Live map updates.
do $$ begin
  alter publication supabase_realtime add table bookings, conflict_events;
exception when duplicate_object or undefined_object then null; end $$;
