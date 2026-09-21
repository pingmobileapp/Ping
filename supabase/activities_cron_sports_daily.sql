-- Pro and college sports now read free ESPN / MLB schedule feeds (see
-- functions/_shared/schedules.ts) instead of paying for AI web search, so for
-- Utah there is no per-run cost left to save by running them weekly - and
-- daily matters: leagues announce game times gradually, and a game with no
-- confirmed time is skipped until it has one. Boise still hands a few teams
-- (small colleges, minor leagues) to the AI crawler, so it stays on its
-- existing twice-a-month schedule (activities_cron_boise.sql).
--
-- Renames the weekly Utah jobs to -daily. Postgres cron.schedule upserts by
-- name, so the old names are unscheduled explicitly first.

select cron.unschedule('refresh-pro-sports-weekly');
select cron.unschedule('refresh-college-sports-weekly');

select cron.schedule(
  'refresh-pro-sports-daily',
  '37 10 * * *', -- 10:37am UTC =~ 4:37am Mountain Time
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
  'refresh-college-sports-daily',
  '17 10 * * *', -- 10:17am UTC =~ 4:17am Mountain Time
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
