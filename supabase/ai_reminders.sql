-- Reminders set from an AI app (the connector's set_reminder tool,
-- 2026-11-07). The app's own "Remind me" picker schedules a notification on
-- the phone itself (lib/eventReminders.ts), which a server can't do. So a
-- reminder set from an AI app is sent as a push by the event-reminders
-- function instead, which runs every 5 minutes.
--
-- reminder_push: true when the reminder should come as a push from the
--   server. The app sets it back to false when the person changes the
--   reminder in the app (the phone then handles it).
-- reminder_pushed_for: the event start time the last push was for. Moving
--   the event changes event_date, so the reminder goes out again for the
--   new time; a second run can't send the same one twice.
--
-- Run via `npx supabase db query --linked -f supabase/ai_reminders.sql`.

alter table public.invitees add column if not exists reminder_push boolean not null default false;
alter table public.invitees add column if not exists reminder_pushed_for timestamptz;

create index if not exists invitees_reminder_push_idx on public.invitees (event_id) where reminder_push;

-- Every 5 minutes. Same secret header as the other scheduled functions
-- (supabase/cron_secret.sql).
select cron.unschedule('event-reminders-5min') where exists (select 1 from cron.job where jobname = 'event-reminders-5min');
select cron.schedule(
  'event-reminders-5min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://rmooxzkinakbyhvxcivv.supabase.co/functions/v1/event-reminders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO',
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
