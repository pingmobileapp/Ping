-- Schedules the Boise / Treasure Valley Discover crawlers. Run about every two
-- weeks (the 1st and 15th of each month - cron can't express "every 14
-- days", so gaps are 14-16 days) rather than weekly like Utah's, to keep
-- Anthropic cost down; city celebrations run yearly. Each job posts
-- {"region": "boise"} to the same function Utah uses - the function tags its
-- rows *_boise so it never touches Utah's rows.
--
-- Times are staggered 20 minutes apart and start after the last Utah job
-- (11:17am UTC) - all of these share the geocode_cache/Nominatim rate limit.
-- Run this in the Supabase SQL Editor, or via
-- `supabase db query --linked -f supabase/activities_cron_boise.sql`.
--
-- The key below is the app's own public publishable key (see supabase.js),
-- used only to pass the platform's gateway check - not a secret.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'refresh-activities-boise-biweekly',
  '37 11 1,15 * *', -- 1st and 15th of each month, 11:37am UTC =~ 5:37am Mountain Time
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-activities',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{"region": "boise"}'::jsonb
  );
  $$
);

select cron.schedule(
  'refresh-activities-calendars-boise-biweekly',
  '57 11 1,15 * *',
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-activities-utahagenda',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{"region": "boise"}'::jsonb
  );
  $$
);

select cron.schedule(
  'refresh-activities-allevents-boise-biweekly',
  '17 12 1,15 * *',
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-activities-allevents',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{"region": "boise"}'::jsonb
  );
  $$
);

select cron.schedule(
  'refresh-college-sports-boise-biweekly',
  '37 12 1,15 * *',
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-college-sports',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{"region": "boise"}'::jsonb
  );
  $$
);

select cron.schedule(
  'refresh-pro-sports-boise-biweekly',
  '57 12 1,15 * *',
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-pro-sports',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{"region": "boise"}'::jsonb
  );
  $$
);

select cron.schedule(
  'refresh-concerts-boise-biweekly',
  '17 13 1,15 * *',
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-concerts',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{"region": "boise"}'::jsonb
  );
  $$
);

select cron.schedule(
  'refresh-hs-sports-6a-boise-biweekly',
  '37 13 1,15 * *',
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-hs-sports-6a',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{"region": "boise"}'::jsonb
  );
  $$
);

-- City celebrations are announced once a year: March 1st, 20 minutes after
-- Utah's refresh-city-days-yearly job (8:17am UTC).
select cron.schedule(
  'refresh-city-days-boise-yearly',
  '37 8 1 3 *',
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-city-days',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{"region": "boise"}'::jsonb
  );
  $$
);
