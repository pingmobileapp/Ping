-- Backs the Discover feature (see app/(tabs)/explore.tsx and the Open
-- Slots roadmap) - a cache table the refresh-activities edge function
-- writes into on a schedule, so the app only ever has to do a plain
-- SELECT rather than calling any external API or AI itself. Populated by
-- source (currently AI web-search only; Ticketmaster/SeatGeek slot in
-- later without a schema change - see external_id below).
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor -> New
-- query), or via `npx supabase db query --linked -f supabase/activities.sql`.

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  -- 'ai_search' | 'ticketmaster' | 'seatgeek' - which pass in
  -- refresh-activities produced this row.
  source text not null,
  -- Stable id from Ticketmaster/SeatGeek's own API, used to upsert
  -- instead of duplicating on every refresh. AI-search rows have no
  -- stable identity across runs, so this stays null for those - see
  -- refresh-activities, which fully replaces source='ai_search' rows
  -- each run instead of trying to upsert them.
  external_id text,
  title text not null,
  -- Matches ActivityCategory in lib/discoverActivities.ts exactly - kept
  -- as plain text rather than a DB enum so adding a category later is a
  -- one-line change in the app, not a migration.
  category text not null,
  description text,
  location text,
  lat double precision,
  lng double precision,
  starts_at timestamptz not null,
  ends_at timestamptz,
  -- Display string, not authoritative for a real charge anywhere -
  -- "Free", "$12", "$8+", etc. Booking itself always happens on the
  -- source's own site (see url).
  price_label text,
  url text,
  -- AI-search rows are inherently less verifiable than a ticketing
  -- platform's own structured data - lets the app flag them differently
  -- if that turns out to matter once real users see real mixed results.
  confidence text not null default 'high' check (confidence in ('high', 'low')),
  created_at timestamptz not null default now()
);

-- Only meaningful (and only enforced) for rows that have one -
-- Ticketmaster/SeatGeek's own event id, scoped per source so the same
-- external_id from two different sources can't collide.
create unique index activities_source_external_id_idx
  on public.activities (source, external_id) where external_id is not null;

create index activities_starts_at_idx on public.activities (starts_at);
create index activities_category_idx on public.activities (category);

alter table public.activities enable row level security;

-- Read-only from the client's perspective - every write comes from
-- refresh-activities using the service role key, which bypasses RLS
-- entirely, so no insert/update/delete policy exists for anyone else.
create policy "Activities are readable by any signed-in user"
  on public.activities for select
  to authenticated
  using (true);
