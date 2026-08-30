-- Adds the nightly concerts crawl to the existing schedule (see
-- activities_cron.sql). Staggered 20 minutes after pro sports for the
-- same shared geocode_cache/Nominatim rate-limit reason as the others.

select cron.schedule(
  'refresh-concerts-nightly',
  '57 10 * * *', -- 10:57am UTC =~ 4:57am Mountain Time, daily
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/refresh-concerts',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
