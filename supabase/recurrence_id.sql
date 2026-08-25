-- Adds series support to events - lets multiple `events` rows (e.g. a
-- weekly practice created as 10 occurrences at once) be grouped as one
-- series, while each occurrence stays a fully independent row with its
-- own invitees/items/messages/RSVP (see components/CreateEventModal.tsx's
-- batch-create loop and components/EditEventModal.tsx's "this event only /
-- this and following events" scoping).
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
--
-- Nullable: null means "not part of a series," which is every existing
-- row today and most rows going forward (a one-off event never gets this
-- set). No RLS policy changes needed - every events policy keys only on
-- host_id (see supabase/rls_policies.sql), and this column is invisible
-- to all of them.

alter table public.events add column recurrence_id uuid;

-- Speeds up the "this and following events" bulk update/delete
-- (events.update(...).eq('recurrence_id', ...).gte('event_date', ...))
-- once a series exists.
create index events_recurrence_id_idx on public.events(recurrence_id);
