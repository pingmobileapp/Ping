-- Fixes the upsert used for Ticketmaster/SeatGeek rows in
-- refresh-activities (`.upsert(rows, {onConflict: 'source,external_id'})`)
-- - it failed with "no unique or exclusion constraint matching the ON
-- CONFLICT specification" because the original index was PARTIAL (`where
-- external_id is not null`), and Postgres won't match a plain
-- ON CONFLICT (source, external_id) against a partial index unless the
-- same WHERE clause is repeated there too.
--
-- A plain (non-partial) unique index works fine for this table's actual
-- data: Postgres already treats NULL as distinct from every other value
-- (including another NULL) for uniqueness purposes, so ai_search rows
-- (external_id always NULL) never conflict with each other regardless -
-- only ticketmaster/seatgeek rows (always a real external_id) get real
-- conflict detection, which is exactly what upserting them needs.
-- Run this in the Supabase SQL Editor, or via
-- `npx supabase db query --linked -f supabase/activities_fix_upsert_index.sql`.

drop index if exists public.activities_source_external_id_idx;
create unique index activities_source_external_id_idx on public.activities (source, external_id);
