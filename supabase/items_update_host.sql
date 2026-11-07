-- Hosts can change What to bring items (2026-11-07). items had insert,
-- delete and select policies but no update policy, so every update silently
-- changed 0 rows: the connector's edit_bring_item, and the app's
-- "remove guest" step that clears items.assigned_to. Hosts could already
-- delete and re-add items, so this grants nothing new. The restrictive
-- items_ai_ro_update policy still blocks Read only AI connections.
-- Run via `npx supabase db query --linked -f supabase/items_update_host.sql`.

drop policy if exists items_update_host on public.items;
create policy items_update_host on public.items for update to authenticated
  using (is_event_host(event_id, auth.uid()))
  with check (is_event_host(event_id, auth.uid()));
