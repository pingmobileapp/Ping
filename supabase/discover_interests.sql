-- Backs the Discover "star this" feature - tapping a hollow star on a
-- Discover card marks it interested, showing it on Home in light yellow.
--
-- Deliberately NOT a foreign key to activities.id. Every ai_search_*
-- crawler (utahagenda, allevents, citydays, collegesports, prosports,
-- concerts, hs6a) does a delete-and-reinsert of its whole source each
-- night, since AI search has no stable external_id to upsert against -
-- the same real-world event gets a brand new row id every night. A star
-- keyed to that id would silently vanish on the very next nightly refresh
-- even though the actual event hasn't changed at all. Only Ticketmaster/
-- SeatGeek rows (real external_id, true upsert) keep a stable id across
-- nights - but starring needs to work for every source uniformly.
--
-- Instead this keys on activity_key (title + start time, normalized) and
-- stores a full snapshot of the activity's display fields at the moment
-- it was starred. That makes the star durable across the source table's
-- own churn, and lets Home render the starred card directly from this
-- table with no join back to activities needed at all - it shows exactly
-- what the user starred, even on a night where that source's crawl
-- happens to skip re-finding it.

create table if not exists public.discover_interests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  activity_key text not null,
  title text not null,
  category text not null,
  description text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  price_label text,
  url text,
  created_at timestamptz not null default now(),
  unique (user_id, activity_key)
);

create index if not exists discover_interests_user_starts_at_idx
  on public.discover_interests (user_id, starts_at);

alter table public.discover_interests enable row level security;

drop policy if exists discover_interests_select_own on public.discover_interests;
create policy discover_interests_select_own
  on public.discover_interests for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists discover_interests_insert_own on public.discover_interests;
create policy discover_interests_insert_own
  on public.discover_interests for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists discover_interests_delete_own on public.discover_interests;
create policy discover_interests_delete_own
  on public.discover_interests for delete
  to authenticated
  using (user_id = auth.uid());
