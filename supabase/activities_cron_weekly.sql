-- Switches every AI-search Discover crawler from nightly to weekly, to cut
-- Anthropic API cost - each of these runs a real web-search pass with a
-- large token budget, and running 7 of them every single night was adding
-- up. Keeps the same time-of-day stagger (still spread out to avoid
-- overlapping the shared geocode_cache/Nominatim rate limit), just moves
-- from "every day" to "every Sunday". refresh-city-days-yearly is already
-- annual and untouched. Renamed from -nightly to -weekly so the cron list
-- itself stays accurate - Postgres cron.schedule upserts by name, so a
-- rename needs the old name explicitly unscheduled first.

select cron.unschedule('refresh-activities-nightly');
select cron.unschedule('refresh-activities-utahagenda-nightly');
select cron.unschedule('refresh-activities-allevents-nightly');
select cron.unschedule('refresh-college-sports-nightly');
select cron.unschedule('refresh-pro-sports-nightly');
select cron.unschedule('refresh-concerts-nightly');
select cron.unschedule('refresh-hs-sports-6a-nightly');

select cron.schedule(
  'refresh-activities-weekly',
  '17 9 * * 0', -- Sundays, 9:17am UTC =~ 3:17am Mountain Time
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

select cron.schedule(
  'refresh-activities-utahagenda-weekly',
  '37 9 * * 0',
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

select cron.schedule(
  'refresh-activities-allevents-weekly',
  '57 9 * * 0',
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

select cron.schedule(
  'refresh-college-sports-weekly',
  '17 10 * * 0',
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

select cron.schedule(
  'refresh-pro-sports-weekly',
  '37 10 * * 0',
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

select cron.schedule(
  'refresh-concerts-weekly',
  '57 10 * * 0',
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

select cron.schedule(
  'refresh-hs-sports-6a-weekly',
  '17 11 * * 0',
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
