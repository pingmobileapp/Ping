-- Security advisor cleanup (2026-10-24).
--
-- 1. Trigger-only SECURITY DEFINER functions: nobody should call these
--    through /rest/v1/rpc. Triggers fire regardless of the caller's EXECUTE
--    privilege, so revoking is safe.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.sync_event_accepted_count() from public, anon, authenticated;
revoke execute on function public.enforce_item_claim_limit() from public, anon, authenticated;

-- 2. RLS helper functions: policies evaluate these as the querying role, so
--    signed-in users must keep EXECUTE. Signed-out callers never need them.
revoke execute on function public.is_event_host(uuid, uuid) from public, anon;
revoke execute on function public.is_event_invitee(uuid, uuid) from public, anon;
revoke execute on function public.is_event_member(uuid, uuid) from public, anon;
revoke execute on function public.is_event_public(uuid) from public, anon;
revoke execute on function public.is_own_invitee(uuid, uuid) from public, anon;
revoke execute on function public.event_has_capacity(uuid) from public, anon;
revoke execute on function public.event_id_for_item(uuid) from public, anon;
revoke execute on function public.is_group_member(uuid) from public, anon;
grant execute on function public.is_event_host(uuid, uuid) to authenticated, service_role;
grant execute on function public.is_event_invitee(uuid, uuid) to authenticated, service_role;
grant execute on function public.is_event_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.is_event_public(uuid) to authenticated, service_role;
grant execute on function public.is_own_invitee(uuid, uuid) to authenticated, service_role;
grant execute on function public.event_has_capacity(uuid) to authenticated, service_role;
grant execute on function public.event_id_for_item(uuid) to authenticated, service_role;
grant execute on function public.is_group_member(uuid) to authenticated, service_role;

-- The shared-group policies were written TO public, which includes anon.
-- With anon's EXECUTE gone, a signed-out read would error instead of
-- returning nothing, so scope them to signed-in users (they key off
-- auth.uid() anyway).
alter policy ping_groups_shared_member_select on public.groups to authenticated;
alter policy ping_group_members_shared_select on public.group_members to authenticated;
alter policy ping_group_messages_shared_insert on public.group_messages to authenticated;
alter policy ping_contacts_shared_group_select on public.contacts to authenticated;

-- 3. Message guard triggers touch no tables, so an empty search_path is safe.
alter function public.guard_message_edit() set search_path = '';
alter function public.guard_event_message_move() set search_path = '';
alter function public.guard_group_message_move() set search_path = '';
