-- Adds co-hosts: full host permissions shared with other people, added
-- directly by an existing host/co-host with no accept step. Run this in
-- the Supabase SQL Editor (Dashboard -> SQL Editor -> New query), or via
-- `npx supabase db query --linked -f supabase/event_hosts.sql`. Safe to
-- re-run - the function/policies are dropped or replaced first, and the
-- table create is guarded.
--
-- Why one function change is (almost) the whole feature: every RLS
-- policy on invitees/items/item_claims/messages that needs a host check
-- already routes through is_event_host() rather than inlining host_id -
-- see supabase/rls_policies.sql for the full picture. Updating that one
-- function to also recognize event_hosts membership grants co-hosts full
-- permissions everywhere those tables are concerned, with zero changes
-- to their own policies. events' own SELECT/UPDATE/DELETE policies are
-- the one exception (see the comment on them below).

create table if not exists public.event_hosts (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index if not exists event_hosts_user_id_idx on public.event_hosts(user_id);
alter table public.event_hosts enable row level security;

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

-- events' own policies inline the event_hosts check directly (not via
-- is_event_host()) for the same self-reference reason host_id already
-- avoids it - see supabase/rls_policies.sql's comment on these policies.
drop policy if exists events_select_host_or_invitee on public.events;
create policy events_select_host_or_invitee
  on public.events for select
  to authenticated
  using (
    host_id = auth.uid()
    or exists (select 1 from public.event_hosts where event_hosts.event_id = events.id and event_hosts.user_id = auth.uid())
    or public.is_event_invitee(id, auth.uid())
  );

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

drop policy if exists event_hosts_select_member on public.event_hosts;
create policy event_hosts_select_member
  on public.event_hosts for select
  to authenticated
  using (public.is_event_member(event_id, auth.uid()));

drop policy if exists event_hosts_insert_host on public.event_hosts;
create policy event_hosts_insert_host
  on public.event_hosts for insert
  to authenticated
  with check (public.is_event_host(event_id, auth.uid()));

drop policy if exists event_hosts_delete_host_or_self on public.event_hosts;
create policy event_hosts_delete_host_or_self
  on public.event_hosts for delete
  to authenticated
  using (public.is_event_host(event_id, auth.uid()) or user_id = auth.uid());
