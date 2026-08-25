-- Lets a Ping be explicitly tagged as belonging to a group, so the
-- group's own screen can show "everything happening for this group" in
-- one place instead of it being mixed into the general Upcoming list.
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor -> New
-- query), or via `npx supabase db query --linked -f supabase/group_id.sql`.
--
-- Nullable, and "on delete set null" rather than cascade - deleting a
-- group shouldn't take its past Pings down with it, just un-tag them.
-- No RLS changes needed: events' existing SELECT policy (host, co-host,
-- or invitee) already governs who can see a group-tagged event - a group
-- member who wasn't personally invited to that specific Ping still won't
-- see it just because they're in the group.

alter table public.events add column group_id uuid references public.groups(id) on delete set null;
create index events_group_id_idx on public.events(group_id);
