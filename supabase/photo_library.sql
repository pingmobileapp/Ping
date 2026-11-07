-- Shared photo library (2026-11-07). Every free stock photo the AI
-- connector puts on an event is saved here once, compressed, under the
-- event-images bucket's library/ folder, and reused by anyone after that:
-- a second "birthday party" photo costs no download and no storage.
--
-- in_gallery: shown in the app's Gallery picker. Only public-domain photos
--   (Openverse CC0 / public domain mark). Pixabay photos are reused behind
--   the scenes but never listed, since Pixabay's license doesn't allow
--   collecting its photos into a browsable library.
-- hidden: an admin pulled it (it stays on events that already use it).
--
-- Only the service role writes rows (the mcp function); signed-in people
-- can read gallery photos and bump use_count through use_gallery_photo().
--
-- Run via `npx supabase db query --linked -f supabase/photo_library.sql`.

create table if not exists public.photo_library (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('pixabay', 'openverse')),
  source_id text not null,
  description text not null default '',
  search_terms text not null default '',
  image_url text not null,
  width int,
  height int,
  kb int,
  license text not null,
  creator text,
  in_gallery boolean not null default false,
  hidden boolean not null default false,
  use_count int not null default 0,
  created_at timestamptz not null default now(),
  unique (source, source_id)
);

create index if not exists photo_library_gallery_idx on public.photo_library (use_count desc) where in_gallery and not hidden;

alter table public.photo_library enable row level security;

drop policy if exists photo_library_select_gallery on public.photo_library;
create policy photo_library_select_gallery
  on public.photo_library for select
  to authenticated
  using (in_gallery and not hidden);

-- New public tables need explicit grants (from 2026-10-30).
revoke all on public.photo_library from anon, authenticated;
grant select on public.photo_library to authenticated;
grant all on public.photo_library to service_role;

-- Picking a gallery photo in the app counts as a use (most-used sort first).
create or replace function public.use_gallery_photo(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.photo_library set use_count = use_count + 1 where id = p_id and in_gallery and not hidden;
$$;

-- Admins can pull a photo from the gallery (long-press in the picker).
create or replace function public.hide_gallery_photo(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin) then
    return false;
  end if;
  update public.photo_library set hidden = true where id = p_id;
  return true;
end;
$$;

-- The connector (service role) records each use plus the words it was
-- found by, so later searches for those words reuse it.
create or replace function public.note_photo_use(p_id uuid, p_terms text)
returns void
language sql
set search_path = public
as $$
  update public.photo_library set use_count = use_count + 1, search_terms = left(p_terms, 600) where id = p_id;
$$;

revoke execute on function public.note_photo_use(uuid, text) from public, anon, authenticated;
grant execute on function public.note_photo_use(uuid, text) to service_role;

revoke execute on function public.use_gallery_photo(uuid) from public, anon;
revoke execute on function public.hide_gallery_photo(uuid) from public, anon;
grant execute on function public.use_gallery_photo(uuid) to authenticated, service_role;
grant execute on function public.hide_gallery_photo(uuid) to authenticated, service_role;
