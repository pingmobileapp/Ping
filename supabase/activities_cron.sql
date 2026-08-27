-- Schedules the nightly refresh-activities run (see
-- supabase/functions/refresh-activities) so Discover's data stays current
-- without anyone needing to trigger it by hand.
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor -> New
-- query), or via `npx supabase db query --linked -f supabase/activities_cron.sql`.
--
-- The key used below is the app's own public anon/publishable key (see
-- supabase.js - it's already shipped inside the app itself, not a secret).
-- refresh-activities doesn't check caller identity, it just needs any
-- valid Supabase key to pass the platform's own gateway auth check before
-- the request reaches the function at all. Every real write happens
-- inside the function using its own SUPABASE_SERVICE_ROLE_KEY secret,
-- which is never referenced here.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'refresh-activities-nightly',
  '17 9 * * *', -- 9:17am UTC =~ 3:17am Mountain Time, daily
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-activities',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Staggered 20 minutes after the run above - both functions share the
-- geocode_cache table's Nominatim rate limit (a module-level clock local
-- to each function's own isolate, not coordinated between them), so
-- running them back-to-back rather than simultaneously keeps geocoding
-- requests from the two functions from overlapping.
select cron.schedule(
  'refresh-activities-utahagenda-nightly',
  '37 9 * * *', -- 9:37am UTC =~ 3:37am Mountain Time, daily
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-activities-utahagenda',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Staggered another 20 minutes further out, for the same reason as above.
select cron.schedule(
  'refresh-activities-allevents-nightly',
  '57 9 * * *', -- 9:57am UTC =~ 3:57am Mountain Time, daily
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-activities-allevents',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
