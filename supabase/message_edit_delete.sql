-- Edit and delete your own chat messages (asked for 2026-10-22, Monty).
-- A delete is "soft": the text is wiped and deleted_at set, so open chats
-- update over realtime (an UPDATE, which can be filtered by event/group -
-- DELETE events can't) and reactions on it don't break. The bubble shows
-- "Message deleted".

alter table public.messages add column if not exists edited_at timestamptz;
alter table public.messages add column if not exists deleted_at timestamptz;
alter table public.group_messages add column if not exists edited_at timestamptz;
alter table public.group_messages add column if not exists deleted_at timestamptz;

-- Only the body (and the two timestamps) can change on an edit; who sent
-- it, where, and when stay fixed. A deleted message stays deleted and empty.
create or replace function public.guard_message_edit()
returns trigger
language plpgsql
as $$
begin
  if new.sender_id is distinct from old.sender_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Only a message''s text can be changed';
  end if;
  if tg_table_name = 'messages' and new.event_id is distinct from old.event_id then
    raise exception 'Only a message''s text can be changed';
  end if;
  if tg_table_name = 'group_messages' and new.group_id is distinct from old.group_id then
    raise exception 'Only a message''s text can be changed';
  end if;
  if old.deleted_at is not null then
    raise exception 'This message was deleted';
  end if;
  if new.deleted_at is not null then
    new.body := '';
    new.deleted_at := now();
  elsif new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists messages_guard_edit on public.messages;
create trigger messages_guard_edit before update on public.messages
  for each row execute function public.guard_message_edit();

drop trigger if exists group_messages_guard_edit on public.group_messages;
create trigger group_messages_guard_edit before update on public.group_messages
  for each row execute function public.guard_message_edit();

-- Senders can update (edit or soft-delete) their own messages.
drop policy if exists messages_update_own on public.messages;
create policy messages_update_own
  on public.messages for update
  to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

drop policy if exists group_messages_update_own on public.group_messages;
create policy group_messages_update_own
  on public.group_messages for update
  to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

grant update on public.messages to authenticated;
grant update on public.group_messages to authenticated;

-- Realtime needs the full row on UPDATE to apply the event_id/group_id
-- filter the chat screens subscribe with.
alter table public.messages replica identity full;
alter table public.group_messages replica identity full;
