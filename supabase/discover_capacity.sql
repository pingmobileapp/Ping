-- Lets a host cap how many people can accept a listed Ping - once full,
-- self-joining as "accepted" is blocked (both at insert and at update, so
-- someone can't slip in by first joining as "interested" then switching to
-- "accepted"), while the host retains full control regardless (they can
-- always add/accept whoever they want, capacity is a gate on strangers
-- self-joining, not on the host managing their own event).
--
-- accepted_count is a denormalized, trigger-maintained cache on events
-- itself - a Discover browser who hasn't joined can SELECT the event row
-- (events_select_discoverable), but CANNOT select the invitees table for
-- an event they're not a member of (invitees_select_host_or_member), so
-- there'd be no way to show "12/20 going" or "Full" on a card without
-- either this cache or a new RPC exposing just the count. The trigger
-- recomputes it with a full COUNT on every invitees write for the
-- affected event - cheap at this app's real scale (family/community
-- gatherings, not viral-scale attendance), and immune to increment/
-- decrement drift bugs a +1/-1 trigger could accumulate over time.

alter table public.events add column if not exists capacity integer;
alter table public.events add column if not exists accepted_count integer not null default 0;

create or replace function public.sync_event_accepted_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_event_id uuid;
begin
  affected_event_id := coalesce(new.event_id, old.event_id);
  update public.events
    set accepted_count = (
      select count(*) from public.invitees
      where invitees.event_id = affected_event_id and invitees.rsvp_status = 'accepted'
    )
    where id = affected_event_id;
  return coalesce(new, old);
end;
$$;

drop trigger if exists invitees_sync_accepted_count on public.invitees;
create trigger invitees_sync_accepted_count
  after insert or update or delete on public.invitees
  for each row execute function public.sync_event_accepted_count();

-- One-time backfill for any events that already have accepted invitees.
update public.events e
  set accepted_count = (
    select count(*) from public.invitees where invitees.event_id = e.id and invitees.rsvp_status = 'accepted'
  );

-- Reads the trigger-maintained cache above rather than re-counting itself -
-- safe because the trigger runs synchronously in the same transaction as
-- every invitees write, so accepted_count is never stale when this is
-- evaluated from another write's own RLS check.
create or replace function public.event_has_capacity(p_event_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select capacity is null or accepted_count < capacity
  from public.events where id = p_event_id;
$$;

grant execute on function public.event_has_capacity(uuid) to authenticated;

drop policy if exists invitees_insert_host_or_member_public on public.invitees;
create policy invitees_insert_host_or_member_public
  on public.invitees for insert
  to authenticated
  with check (
    public.is_event_host(event_id, auth.uid())
    or (
      user_id = auth.uid()
      and public.is_event_public(event_id)
      and (rsvp_status <> 'accepted' or public.event_has_capacity(event_id))
    )
    or (public.is_event_member(event_id, auth.uid()) and public.is_event_public(event_id))
  );

drop policy if exists invitees_update_self_or_host on public.invitees;
create policy invitees_update_self_or_host
  on public.invitees for update
  to authenticated
  using (user_id = auth.uid() or public.is_event_host(event_id, auth.uid()))
  with check (
    (user_id = auth.uid() and (rsvp_status <> 'accepted' or public.event_has_capacity(event_id)))
    or public.is_event_host(event_id, auth.uid())
  );
