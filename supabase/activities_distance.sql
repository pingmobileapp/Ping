-- Backs real distance verification in refresh-activities - instead of
-- just trusting the AI's own sense of "near the anchor," each result's
-- location gets geocoded to real coordinates and a real haversine
-- distance from the anchor, and anything actually outside the radius
-- gets dropped rather than shown.
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor -> New
-- query), or via `npx supabase db query --linked -f supabase/activities_distance.sql`.

alter table public.activities add column distance_miles double precision;

-- Caches geocoding results so a venue that shows up night after night
-- (the same farmers market, the same library) only ever gets geocoded
-- once, not on every single refresh - both for speed and to stay a good
-- citizen of Nominatim's free public rate-limit policy long-term.
-- Entirely internal to the backend job - RLS is enabled with no policy
-- at all, so even authenticated users get zero access; only the service
-- role (which bypasses RLS) ever touches this.
create table public.geocode_cache (
  location_text text primary key,
  lat double precision,
  lng double precision,
  resolved_at timestamptz not null default now()
);

alter table public.geocode_cache enable row level security;
