-- Backs the Week view's per-day notes bar - a private scratchpad per day
-- (to-dos, reminders), one row per user per date. Keyed by the local
-- calendar date the user picked, not a timestamp, so a note never shifts
-- to another day when read in a different timezone.
--
-- Cascades from profiles like discover_interests, so delete-account's
-- profile delete removes a user's notes too.
-- Run via `npx supabase db query --linked -f supabase/day_notes.sql`.

create table if not exists public.day_notes (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  body text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.day_notes enable row level security;

drop policy if exists day_notes_select_own on public.day_notes;
create policy day_notes_select_own
  on public.day_notes for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists day_notes_insert_own on public.day_notes;
create policy day_notes_insert_own
  on public.day_notes for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists day_notes_update_own on public.day_notes;
create policy day_notes_update_own
  on public.day_notes for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists day_notes_delete_own on public.day_notes;
create policy day_notes_delete_own
  on public.day_notes for delete
  to authenticated
  using (user_id = auth.uid());
