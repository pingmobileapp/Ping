-- How many things a notification row stands for since it was last read
-- (TestFlight feedback 83, 2026-11-07: show a number on each event's chat
-- bubble and on the Ping logo instead of a plain red mark).
--
-- Notifications are merged: every new chat message in an event upserts the
-- same row (recipient_id, notif_group, thread_key) with a fresh created_at
-- and read_at = null, so the row itself can't say how many messages arrived.
-- This trigger keeps that count on the row:
--   insert unread            -> 1
--   marked read              -> 0
--   new activity (created_at changes) while still unread -> +1
--   new activity after it had been read                  -> 1
-- Any other update leaves the count alone.
--
-- Run via `npx supabase db query --linked -f supabase/notification_unread_count.sql`.

alter table public.notifications add column if not exists unread_count integer not null default 0;

create or replace function public.notifications_track_unread_count()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.unread_count := case when new.read_at is null then 1 else 0 end;
  elsif new.read_at is not null then
    new.unread_count := 0;
  elsif new.created_at is distinct from old.created_at then
    new.unread_count := case when old.read_at is null then old.unread_count + 1 else 1 end;
  else
    new.unread_count := old.unread_count;
  end if;
  return new;
end;
$$;

-- Trigger-only: nobody calls it through /rest/v1/rpc (see security_definer_lockdown.sql).
revoke execute on function public.notifications_track_unread_count() from public, anon, authenticated;

drop trigger if exists notifications_track_unread_count on public.notifications;
create trigger notifications_track_unread_count
  before insert or update on public.notifications
  for each row execute function public.notifications_track_unread_count();

-- Rows already unread when this shipped count as one.
update public.notifications set unread_count = 1 where read_at is null and unread_count = 0;
