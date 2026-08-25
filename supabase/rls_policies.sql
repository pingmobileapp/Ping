-- Row Level Security policies for Ping.
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every function/policy is dropped or replaced first.
--
-- REVISION 2: the first version caused 500s on events/invitees and
-- anything joined to them (contacts, notifications included). Cause:
-- events' policy checked invitees, and invitees' policy checked events -
-- each re-triggers the other's RLS evaluation, and Postgres detects the
-- loop and raises "infinite recursion detected in policy", which
-- PostgREST reports as a 500. The fix is the standard one: route every
-- cross-table check through a SECURITY DEFINER function, which runs with
-- the privileges of whoever defined it and so bypasses RLS internally -
-- that's what actually breaks the cycle, not just tidier SQL.
--
-- Scope: only the 6 tables confirmed to have RLS disabled (profiles,
-- events, invitees, items, item_claims, messages). If contacts, groups,
-- group_members, or notifications are still failing after this runs,
-- they have their own separate policy (likely also referencing
-- events/invitees) that needs the same treatment - send that policy's
-- text over and it can get the same fix.
--
-- Access model, in plain English, derived from the actual app code:
--   - An event's host can do anything to their own event and everything
--     under it (invitees, items, item_claims, messages).
--   - Anyone invited to an event (an invitees row with their user_id) can
--     see the event, the full guest list, items, claims, and messages -
--     these are all things every guest already sees in the app today.
--   - A person can only create/change/claim things as themselves, never
--     as someone else, except where the host is explicitly allowed to
--     act on behalf of a guest with no linked account (setting their
--     RSVP from what they said over text - see EventDetailContent.tsx).
--   - profiles is readable by any signed-in user (not just people you
--     share an event with) - this is required for the phone-number
--     contact-matching feature (lib/phone.ts), which looks up whether a
--     phone number belongs to an existing Ping user *before* any event
--     or invite connects the two people. Narrowing this further would
--     break that matching. What this DOES fix is that today, even a
--     signed-out/unauthenticated request can read every profile
--     (phone numbers included) - these policies close that off entirely.

-- ============================================================
-- Helper functions (SECURITY DEFINER - see note above)
-- ============================================================

-- A co-host (event_hosts) has identical full permissions to the primary
-- host (host_id) everywhere this function gates - every other table's
-- policy below already routes through this function rather than
-- inlining host_id, so this one change is what grants co-hosts full
-- permissions on invitees/items/item_claims/messages with no other
-- policy edits needed. events' own policies are the one exception - see
-- the comment above them for why.
create or replace function public.is_event_host(p_event_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.events
    where events.id = p_event_id and events.host_id = p_user_id
  ) or exists (
    select 1 from public.event_hosts
    where event_hosts.event_id = p_event_id and event_hosts.user_id = p_user_id
  );
$$;

create or replace function public.is_event_invitee(p_event_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.invitees
    where invitees.event_id = p_event_id and invitees.user_id = p_user_id
  );
$$;

-- Host OR invited guest - the "can see/act on this event's stuff" check
-- used everywhere below.
create or replace function public.is_event_member(p_event_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.is_event_host(p_event_id, p_user_id)
      or public.is_event_invitee(p_event_id, p_user_id);
$$;

create or replace function public.is_event_public(p_event_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_public from public.events where events.id = p_event_id), false);
$$;

create or replace function public.event_id_for_item(p_item_id uuid)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select event_id from public.items where items.id = p_item_id;
$$;

create or replace function public.is_own_invitee(p_invitee_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.invitees
    where invitees.id = p_invitee_id and invitees.user_id = p_user_id
  );
$$;

grant execute on function public.is_event_host(uuid, uuid) to authenticated;
grant execute on function public.is_event_invitee(uuid, uuid) to authenticated;
grant execute on function public.is_event_member(uuid, uuid) to authenticated;
grant execute on function public.is_event_public(uuid) to authenticated;
grant execute on function public.event_id_for_item(uuid) to authenticated;
grant execute on function public.is_own_invitee(uuid, uuid) to authenticated;

-- ============================================================
-- profiles
-- ============================================================
alter table public.profiles enable row level security;

drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ============================================================
-- events
-- ============================================================
alter table public.events enable row level security;

-- Deliberately NOT using is_event_member()/is_event_host() here.
-- is_event_host() is SECURITY DEFINER and queries events itself -
-- calling it from events' own SELECT policy makes it self-referencing,
-- and that self-query does not reliably see the row's own INSERT within
-- the same statement. That broke `insert ... returning` (PostgREST's
-- default) with a spurious "new row violates row-level security policy"
-- even when host_id correctly matched auth.uid(). host_id is already a
-- column on the row being evaluated, so the host check doesn't need a
-- subquery at all. The co-host check below queries event_hosts directly
-- (not through is_event_host()) for the same reason - only the invitee
-- check genuinely needs to look at a different table.
drop policy if exists events_select_host_or_invitee on public.events;
create policy events_select_host_or_invitee
  on public.events for select
  to authenticated
  using (
    host_id = auth.uid()
    or exists (select 1 from public.event_hosts where event_hosts.event_id = events.id and event_hosts.user_id = auth.uid())
    or public.is_event_invitee(id, auth.uid())
  );

drop policy if exists events_insert_own on public.events;
create policy events_insert_own
  on public.events for insert
  to authenticated
  with check (host_id = auth.uid());

drop policy if exists events_update_own on public.events;
create policy events_update_own
  on public.events for update
  to authenticated
  using (
    host_id = auth.uid()
    or exists (select 1 from public.event_hosts where event_hosts.event_id = events.id and event_hosts.user_id = auth.uid())
  )
  with check (
    host_id = auth.uid()
    or exists (select 1 from public.event_hosts where event_hosts.event_id = events.id and event_hosts.user_id = auth.uid())
  );

drop policy if exists events_delete_own on public.events;
create policy events_delete_own
  on public.events for delete
  to authenticated
  using (
    host_id = auth.uid()
    or exists (select 1 from public.event_hosts where event_hosts.event_id = events.id and event_hosts.user_id = auth.uid())
  );

-- ============================================================
-- event_hosts (co-hosts - full permissions, same as host_id, added
-- directly by an existing host/co-host with no accept step - see
-- supabase/event_hosts.sql for the table definition)
-- ============================================================
alter table public.event_hosts enable row level security;

drop policy if exists event_hosts_select_member on public.event_hosts;
create policy event_hosts_select_member
  on public.event_hosts for select
  to authenticated
  using (public.is_event_member(event_id, auth.uid()));

-- Any existing host or co-host can add another - matches "full
-- permissions" (a co-host isn't second-class, they can grow the host
-- list too).
drop policy if exists event_hosts_insert_host on public.event_hosts;
create policy event_hosts_insert_host
  on public.event_hosts for insert
  to authenticated
  with check (public.is_event_host(event_id, auth.uid()));

-- A host/co-host can remove another co-host, and a co-host can remove
-- themselves (leave).
drop policy if exists event_hosts_delete_host_or_self on public.event_hosts;
create policy event_hosts_delete_host_or_self
  on public.event_hosts for delete
  to authenticated
  using (public.is_event_host(event_id, auth.uid()) or user_id = auth.uid());

-- ============================================================
-- invitees
-- ============================================================
alter table public.invitees enable row level security;

drop policy if exists invitees_select_host_or_member on public.invitees;
create policy invitees_select_host_or_member
  on public.invitees for select
  to authenticated
  using (public.is_event_member(event_id, auth.uid()));

-- Covers: the host adding invitees (including their own accepted row) to
-- their own event, and a user self-joining a public event via a share
-- link (see lib/rsvp.ts submitRsvp's insert branch).
drop policy if exists invitees_insert_host_or_self_public on public.invitees;
create policy invitees_insert_host_or_self_public
  on public.invitees for insert
  to authenticated
  with check (
    public.is_event_host(event_id, auth.uid())
    or (user_id = auth.uid() and public.is_event_public(event_id))
  );

-- Covers: a guest updating their own RSVP/reminder, and the host manually
-- setting RSVP for a guest with no linked account (EventDetailContent.tsx
-- handleHostRsvpPress).
drop policy if exists invitees_update_self_or_host on public.invitees;
create policy invitees_update_self_or_host
  on public.invitees for update
  to authenticated
  using (user_id = auth.uid() or public.is_event_host(event_id, auth.uid()))
  with check (user_id = auth.uid() or public.is_event_host(event_id, auth.uid()));

drop policy if exists invitees_delete_host on public.invitees;
create policy invitees_delete_host
  on public.invitees for delete
  to authenticated
  using (public.is_event_host(event_id, auth.uid()));

-- ============================================================
-- items
-- ============================================================
alter table public.items enable row level security;

drop policy if exists items_select_host_or_member on public.items;
create policy items_select_host_or_member
  on public.items for select
  to authenticated
  using (public.is_event_member(event_id, auth.uid()));

drop policy if exists items_insert_host on public.items;
create policy items_insert_host
  on public.items for insert
  to authenticated
  with check (public.is_event_host(event_id, auth.uid()));

drop policy if exists items_delete_host on public.items;
create policy items_delete_host
  on public.items for delete
  to authenticated
  using (public.is_event_host(event_id, auth.uid()));

-- No update policy: the app never edits an item after creation, only
-- adds or removes them.

-- ============================================================
-- item_claims
-- ============================================================
alter table public.item_claims enable row level security;

drop policy if exists item_claims_select_host_or_member on public.item_claims;
create policy item_claims_select_host_or_member
  on public.item_claims for select
  to authenticated
  using (public.is_event_member(public.event_id_for_item(item_id), auth.uid()));

drop policy if exists item_claims_insert_own on public.item_claims;
create policy item_claims_insert_own
  on public.item_claims for insert
  to authenticated
  with check (public.is_own_invitee(invitee_id, auth.uid()));

drop policy if exists item_claims_update_own on public.item_claims;
create policy item_claims_update_own
  on public.item_claims for update
  to authenticated
  using (public.is_own_invitee(invitee_id, auth.uid()))
  with check (public.is_own_invitee(invitee_id, auth.uid()));

-- Covers: a guest un-claiming their own item, and the host's cascade
-- delete when removing an item or the whole event (EditEventModal.tsx).
drop policy if exists item_claims_delete_own_or_host on public.item_claims;
create policy item_claims_delete_own_or_host
  on public.item_claims for delete
  to authenticated
  using (
    public.is_own_invitee(invitee_id, auth.uid())
    or public.is_event_host(public.event_id_for_item(item_id), auth.uid())
  );

-- ============================================================
-- messages
-- ============================================================
alter table public.messages enable row level security;

drop policy if exists messages_select_host_or_member on public.messages;
create policy messages_select_host_or_member
  on public.messages for select
  to authenticated
  using (public.is_event_member(event_id, auth.uid()));

drop policy if exists messages_insert_own on public.messages;
create policy messages_insert_own
  on public.messages for insert
  to authenticated
  with check (sender_id = auth.uid() and public.is_event_member(event_id, auth.uid()));

-- Covers: the host's cascade delete when removing an event
-- (EditEventModal.tsx). No self-delete-a-message feature exists today.
drop policy if exists messages_delete_host on public.messages;
create policy messages_delete_host
  on public.messages for delete
  to authenticated
  using (public.is_event_host(event_id, auth.uid()));
