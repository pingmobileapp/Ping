-- Applied to production 2026-10-20 (migration discover_area_requests).
-- "Let me know when Discover comes to my area" - one row per person,
-- refreshed if they ask again from somewhere else. Coordinates are rounded
-- on the device to ~7 miles; city/state come from the phone's own reverse
-- geocoding. Read by the team (service role / SQL) to pick the next area:
--   select city, region, count(*) from discover_area_requests group by 1, 2 order by 3 desc;
create table if not exists public.discover_area_requests (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  city text,
  region text,
  country text,
  lat numeric(5,1),
  lng numeric(5,1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.discover_area_requests enable row level security;

create policy discover_area_requests_select_own on public.discover_area_requests
  for select using (user_id = auth.uid());
create policy discover_area_requests_insert_own on public.discover_area_requests
  for insert with check (user_id = auth.uid());
create policy discover_area_requests_update_own on public.discover_area_requests
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy discover_area_requests_delete_own on public.discover_area_requests
  for delete using (user_id = auth.uid());

revoke all on public.discover_area_requests from anon;
-- Explicit grants: from 2026-10-30, Supabase stops granting Data API access
-- to new public tables automatically (RLS above still limits rows).
grant select, insert, update, delete on public.discover_area_requests to authenticated;
grant select, insert, update, delete on public.discover_area_requests to service_role;
