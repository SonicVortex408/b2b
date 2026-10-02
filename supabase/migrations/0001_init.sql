-- XIE Spaces · Phase 1 schema (Supabase / Postgres 16)
-- The demo build runs the same engine in-memory (src/lib/engine.ts); this is its production twin.

create extension if not exists btree_gist;
create extension if not exists vector;

create type user_role as enum ('student', 'faculty', 'approver', 'admin');
create type booking_purpose as enum ('exam', 'academic_class', 'faculty_event', 'club_event', 'casual');
create type booking_status as enum ('draft', 'pending_approval', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show', 'bumped');

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null,
  role user_role not null default 'student',
  approver_pools text[] not null default '{}',
  club text
);

create table floors (
  id smallint primary key,
  name text not null
);

create table resources (
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
  blackout_rules jsonb not null default '[]',
  checkin_window_minutes int not null default 10,
  active boolean not null default true
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  resource_id text not null references resources,
  requester_id uuid not null references profiles,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  title text not null,
  purpose booking_purpose not null,
  priority_score int not null default 0,
  status booking_status not null default 'pending_approval',
  attendee_count int not null,
  parent_booking_id uuid references bookings,
  series_id uuid,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  -- THE double-booking guard. App logic is never the only defence.
  constraint bookings_no_overlap exclude using gist (
    resource_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('confirmed', 'pending_approval', 'checked_in'))
);
create index bookings_resource_range on bookings using gist (resource_id, tstzrange(starts_at, ends_at));

create table conflict_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  winner_booking uuid references bookings,
  loser_booking uuid references bookings,
  rule_fired text,
  score jsonb,
  decision text not null,
  explanation text not null
);

create table fairness_ledger (
  subject text primary key,                  -- user id or club name
  bumps_suffered int not null default 0,
  conflicts_won int not null default 0,
  boost int not null default 0
);

create table waitlist (
  id bigserial primary key,
  resource_id text not null references resources,
  requester_id uuid not null references profiles,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  purpose booking_purpose not null,
  attendee_count int not null,
  created_at timestamptz not null default now()
);

create table approvals (
  booking_id uuid primary key references bookings on delete cascade,
  assignee_pool text not null,
  deadline timestamptz not null,
  escalated_to text,
  decision text,
  note text
);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  payload jsonb not null
);
revoke update, delete on audit_log from authenticated, anon; -- append-only

-- ---------------------------------------------------------------- RLS
alter table profiles enable row level security;
alter table resources enable row level security;
alter table bookings enable row level security;
alter table conflict_events enable row level security;
alter table waitlist enable row level security;
alter table approvals enable row level security;
alter table audit_log enable row level security;

create function my_role() returns user_role language sql stable security definer as $$
  select role from profiles where id = auth.uid()
$$;

create policy "read own profile" on profiles for select using (id = auth.uid() or my_role() = 'admin');
create policy "everyone reads resources" on resources for select using (true);
create policy "admins manage resources" on resources for all using (my_role() = 'admin');
create policy "everyone reads bookings (live map)" on bookings for select using (true);
-- No direct inserts: all writes go through book_resources().
create policy "cancel own" on bookings for update using (requester_id = auth.uid()) with check (status in ('cancelled', 'completed', 'checked_in'));
create policy "approvers act on pool" on bookings for update using (my_role() in ('approver', 'admin'));
create policy "read decisions" on conflict_events for select using (true);
create policy "own waitlist" on waitlist for all using (requester_id = auth.uid());
create policy "approvers read approvals" on approvals for select using (my_role() in ('approver', 'admin'));
create policy "admins read audit" on audit_log for select using (my_role() = 'admin');

-- ---------------------------------------------------------------- the one write path
-- Simplified: rules + scoring live in the app/edge function; this RPC is the transactional insert.
-- On 23P01 it returns the conflicting rows so the conflict engine can decide (bump / negotiate / share).
create function book_resources(bundle jsonb) returns jsonb
language plpgsql security definer as $$
declare
  item jsonb;
  ids uuid[] := '{}';
  new_id uuid;
begin
  for item in select * from jsonb_array_elements(bundle -> 'items') loop
    insert into bookings (resource_id, requester_id, starts_at, ends_at, title, purpose, priority_score, status, attendee_count)
    values (
      item ->> 'resource_id', auth.uid(), (item ->> 'starts_at')::timestamptz, (item ->> 'ends_at')::timestamptz,
      bundle ->> 'title', (bundle ->> 'purpose')::booking_purpose, coalesce((bundle ->> 'priority')::int, 0),
      coalesce((bundle ->> 'status')::booking_status, 'pending_approval'), (bundle ->> 'attendees')::int
    ) returning id into new_id;
    ids := ids || new_id;
  end loop;
  insert into audit_log (actor, action, payload) values (auth.uid(), 'book_resources', bundle);
  return jsonb_build_object('ok', true, 'booking_ids', to_jsonb(ids));
exception when exclusion_violation then           -- SQLSTATE 23P01; whole bundle rolls back (all-or-nothing)
  return jsonb_build_object(
    'ok', false, 'code', '23P01',
    'conflicts', (
      select coalesce(jsonb_agg(to_jsonb(b)), '[]') from bookings b, jsonb_array_elements(bundle -> 'items') i
      where b.resource_id = i ->> 'resource_id'
        and b.status in ('confirmed', 'pending_approval', 'checked_in')
        and tstzrange(b.starts_at, b.ends_at) && tstzrange((i ->> 'starts_at')::timestamptz, (i ->> 'ends_at')::timestamptz)
    )
  );
end $$;

alter publication supabase_realtime add table bookings, conflict_events;
