-- Phase 3 of the Discover roadmap: lets a host list their own Ping on the
-- Discover page for the whole community to browse, not just people they've
-- directly invited. Reuses the existing events/invitees system end to end
-- instead of a parallel "listings" table - a listed Ping shows up in
-- Discover, and "I'm Going" is just the same self-join invitees insert a
-- public event's share link already allows (see
-- invitees_insert_host_or_member_public below), so RSVPs land on the
-- host's real guest list automatically.
-- Run via `npx supabase db query --linked -f supabase/discover_listings.sql`.

alter table public.events add column if not exists discoverable boolean not null default false;
alter table public.events add column if not exists discover_category text;

-- `is_public` alone only ever powered the share-link self-join flow (see
-- invitees_insert_host_or_member_public) - it was never enough to let a
-- stranger with no link actually SELECT the event row in the first place
-- (events_select_host_or_invitee is host/co-host/invitee-only). This is
-- the new, narrower visibility grant Discover actually needs: any signed-in
-- user can see an event that's explicitly opted into discoverable, without
-- touching what "public" means for existing share-link behavior. Postgres
-- OR-combines multiple permissive select policies on the same table, so
-- this is additive - it can't loosen anything events_select_host_or_invitee
-- already restricts.
drop policy if exists events_select_discoverable on public.events;
create policy events_select_discoverable
  on public.events for select
  to authenticated
  using (discoverable = true);
