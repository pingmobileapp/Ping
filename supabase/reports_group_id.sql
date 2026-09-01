-- A group_message report had no way to identify which group it came from
-- (unlike an event/message report, which already carries event_id) - the
-- admin screen needs this to actually navigate to the reported content
-- instead of just showing the reason text with nothing to click into.
alter table public.reports add column if not exists group_id uuid references public.groups(id) on delete cascade;
