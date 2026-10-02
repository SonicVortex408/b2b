-- XIE Spaces · 0002: negotiations, swap marketplace, counter-proposals, soft-holds,
-- in-app notifications and live occupancy (one generic document table), editable blackouts.

create table if not exists engine_docs (
  kind text not null,          -- neg | swap | counter | hold | notice | occ
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (kind, id)
);
create index if not exists engine_docs_updated on engine_docs (kind, updated_at desc);

alter table engine_docs enable row level security;
drop policy if exists "public read" on engine_docs;
create policy "public read" on engine_docs for select using (true);

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
      starts_at = coalesce((u ->> 'starts_at')::timestamptz, starts_at),
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

  -- negotiations, swaps, counter-offers, soft-holds, notifications, occupancy
  delete from engine_docs d using jsonb_array_elements(coalesce(changes -> 'docs_remove', '[]')) x
   where d.kind = x ->> 'kind' and d.id = x ->> 'id';
  insert into engine_docs (kind, id, data, updated_at)
  select x ->> 'kind', x ->> 'id', x -> 'data', now()
  from jsonb_array_elements(coalesce(changes -> 'docs_upsert', '[]')) x
  on conflict (kind, id) do update set data = excluded.data, updated_at = now();

  -- rules editor (exam blackouts)
  delete from blackouts where id in (select jsonb_array_elements_text(coalesce(changes -> 'blackouts_remove', '[]')));
  insert into blackouts (id, label, starts_at, ends_at, resource_ids, allow)
  select x ->> 'id', x ->> 'label', (x ->> 'starts_at')::timestamptz, (x ->> 'ends_at')::timestamptz,
         array(select jsonb_array_elements_text(x -> 'resource_ids')),
         array(select jsonb_array_elements_text(x -> 'allow'))::booking_purpose[]
  from jsonb_array_elements(coalesce(changes -> 'blackouts_upsert', '[]')) x
  on conflict (id) do update set label = excluded.label, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
    resource_ids = excluded.resource_ids, allow = excluded.allow;

  insert into audit_log (actor, action, payload) values (changes ->> 'actor', 'apply_engine_changes', changes);
  return jsonb_build_object('ok', true);
exception when exclusion_violation then
  return jsonb_build_object('ok', false, 'code', '23P01', 'detail', sqlerrm);
end $$;

revoke execute on function apply_engine_changes(jsonb) from public, anon, authenticated;

do $$ begin
  alter publication supabase_realtime add table engine_docs;
exception when duplicate_object or undefined_object then null; end $$;
