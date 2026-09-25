-- Marks a game whose date is set but whose kickoff time hasn't been
-- announced yet (college football TV times typically come out only 6-12
-- days ahead). Such a row's starts_at is a placeholder at noon on the game
-- date, never a real time - Discover shows "Time TBA" instead.
-- Run via `npx supabase db query --linked -f supabase/activities_time_tba.sql`.

alter table public.activities add column time_tba boolean not null default false;
