-- Adds the nightly college-sports crawl to the existing schedule (see
-- activities_cron.sql). Staggered 20 minutes after the allevents pass for
-- the same reason the others are staggered - shared geocode_cache/Nominatim
-- rate limit, not coordinated between functions beyond not running at the
-- exact same moment.

select cron.schedule(
  'refresh-college-sports-nightly',
  '17 10 * * *', -- 10:17am UTC =~ 4:17am Mountain Time, daily
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-college-sports',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
