-- Follow-up to discover_listings.sql: lets someone who joined a Discover
-- listing themselves (never actually invited by the host) fully un-join by
-- tapping their current RSVP selection again - "as if they never
-- responded" means the invitee row is gone entirely, not left behind as a
-- lingering pending one. Two things were missing for that to work:
--
-- 1. invited_via's check constraint only allowed 'app'/'sms'/'email' - a
--    self-join via Discover is genuinely none of those (nobody invited
--    them), so it needs its own value to even insert, and to let the app
--    tell "real invite" and "self-joined" rows apart afterward.
-- 2. There was no DELETE policy at all letting a user remove their own
--    invitee row - only invitees_delete_host existed. Scoped narrowly to
--    invited_via = 'discover' so this can't be used to un-invite yourself
--    from a real host invitation, only to undo a self-join.

alter table public.invitees drop constraint if exists invitees_invited_via_check;
alter table public.invitees add constraint invitees_invited_via_check
  check (invited_via = any (array['app', 'sms', 'email', 'discover']));

drop policy if exists invitees_delete_self_discover on public.invitees;
create policy invitees_delete_self_discover
  on public.invitees for delete
  to authenticated
  using (user_id = auth.uid() and invited_via = 'discover');
