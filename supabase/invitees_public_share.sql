-- Fixes ShareInviteModal ("+ Invite others" on a public event's detail
-- screen): any guest already on a public event's guest list should be able
-- to add more people to it, not just the host. Run this in the Supabase
-- SQL Editor (Dashboard -> SQL Editor -> New query), or via
-- `npx supabase db query --linked -f supabase/invitees_public_share.sql`.
-- Safe to re-run - the policy is dropped and recreated.
--
-- Bug: invitees' INSERT policy (see supabase/rls_policies.sql) only ever
-- allowed the host to insert a row for someone else, or a user inserting
-- a row for themselves (the self-join-via-share-link case in
-- lib/rsvp.ts). A guest using ShareInviteModal to invite a third person
-- is neither - the row they're inserting has someone else's contact_id/
-- user_id, and they aren't the host - so the insert was rejected by RLS
-- and surfaced in the app as "Something went wrong sending invites."
--
-- Fix: also allow an existing member (host or invitee) of a public event
-- to insert invitee rows for other people on that same event.
drop policy if exists invitees_insert_host_or_self_public on public.invitees;
drop policy if exists invitees_insert_host_or_member_public on public.invitees;
create policy invitees_insert_host_or_member_public
  on public.invitees for insert
  to authenticated
  with check (
    public.is_event_host(event_id, auth.uid())
    or (user_id = auth.uid() and public.is_event_public(event_id))
    or (public.is_event_member(event_id, auth.uid()) and public.is_event_public(event_id))
  );
