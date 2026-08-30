-- Adds the nightly pro-sports crawl to the existing schedule (see
-- activities_cron.sql). Staggered 20 minutes after college sports for the
-- same shared geocode_cache/Nominatim rate-limit reason as the others.

select cron.schedule(
  'refresh-pro-sports-nightly',
  '37 10 * * *', -- 10:37am UTC =~ 4:37am Mountain Time, daily
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-pro-sports',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
