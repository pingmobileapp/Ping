-- Admin's "Remove Content" action (app/admin.tsx's handleRemoveContent) has
-- never actually been able to delete anything - events_delete_own and
-- messages_delete_host (rls_policies.sql) only ever granted delete to the
-- event's own host, and group_messages had no delete policy at all. An
-- admin isn't the host of every reported event, so the delete silently
-- failed under RLS every time, while the calling code marked the report
-- "removed" regardless of whether the delete actually succeeded - a real
-- compliance gap against Apple's Guideline 1.2 requirement to actually
-- remove reported content within 24 hours, not just record that someone
-- looked at it.

drop policy if exists events_delete_own on public.events;
create policy events_delete_own
  on public.events for delete
  to authenticated
  using (
    host_id = auth.uid()
    or exists (select 1 from public.event_hosts where event_hosts.event_id = events.id and event_hosts.user_id = auth.uid())
    or exists (select 1 from public.profiles where id = auth.uid() and is_admin)
  );

drop policy if exists messages_delete_host on public.messages;
create policy messages_delete_host
  on public.messages for delete
  to authenticated
  using (
    public.is_event_host(event_id, auth.uid())
    or exists (select 1 from public.profiles where id = auth.uid() and is_admin)
  );

drop policy if exists group_messages_delete_admin on public.group_messages;
create policy group_messages_delete_admin
  on public.group_messages for delete
  to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin));
