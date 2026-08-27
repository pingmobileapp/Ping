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
