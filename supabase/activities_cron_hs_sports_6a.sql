-- Adds the nightly 6A high school sports crawl to the existing schedule
-- (see activities_cron.sql). Staggered 20 minutes after concerts for the
-- same shared geocode_cache/Nominatim rate-limit reason as the others.

select cron.schedule(
  'refresh-hs-sports-6a-nightly',
  '17 11 * * *', -- 11:17am UTC =~ 5:17am Mountain Time, daily
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-hs-sports-6a',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
