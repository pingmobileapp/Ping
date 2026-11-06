-- Applied to production 2026-11-05 (migration ai_connections). Written for
-- the AI connector: supabase/functions/mcp, docs/connect.html, Settings -> Connected AI.
--
-- People link Ping to an AI app (Meta's Muse, Claude, ChatGPT) through
-- Supabase Auth's OAuth 2.1 server. The AI app then holds an access token
-- for that person, and every token it gets carries a `client_id` claim naming
-- the AI app. Normal app sign-ins have no `client_id`.
--
-- One row per person per AI app, written by the consent page
-- (docs/connect.html) with the person's own web sign-in, when they choose
-- Full access or Read only. Settings -> Connected AI reads it to show the
-- choice; Disconnect deletes it (and revokes the grant in Supabase Auth).
create table if not exists public.ai_connections (
  user_id uuid not null references public.profiles(id) on delete cascade,
  client_id uuid not null,
  client_name text,
  read_only boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

alter table public.ai_connections enable row level security;

-- An AI app's own token must never be able to change its own access (flip
-- itself from Read only to Full access), so writes need a normal sign-in:
-- a JWT with no client_id claim.
create policy ai_connections_select_own on public.ai_connections
  for select using (user_id = (select auth.uid()));
create policy ai_connections_insert_own on public.ai_connections
  for insert with check (
    user_id = (select auth.uid()) and coalesce((select auth.jwt()) ->> 'client_id', '') = ''
  );
create policy ai_connections_update_own on public.ai_connections
  for update using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid()) and coalesce((select auth.jwt()) ->> 'client_id', '') = ''
  );
create policy ai_connections_delete_own on public.ai_connections
  for delete using (
    user_id = (select auth.uid()) and coalesce((select auth.jwt()) ->> 'client_id', '') = ''
  );

revoke all on public.ai_connections from anon;
-- Explicit grants: from 2026-10-30, Supabase stops granting Data API access
-- to new public tables automatically (RLS above still limits rows).
grant select, insert, update, delete on public.ai_connections to authenticated;
grant select, insert, update, delete on public.ai_connections to service_role;

-- True when the current request may write. Normal app sign-ins always may.
-- An AI app's token may only when the person chose Full access for that app
-- on the consent page. No row at all (consent page never saved one) counts
-- as Read only: fail closed.
create or replace function public.ai_write_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'client_id', '') = ''
    or exists (
      select 1 from public.ai_connections c
      where c.user_id = auth.uid()
        and c.client_id::text = auth.jwt() ->> 'client_id'
        and not c.read_only
    );
$$;

revoke all on function public.ai_write_allowed() from public, anon;
grant execute on function public.ai_write_allowed() to authenticated, service_role;

-- Read only is enforced by the database, not just by the connector: the AI
-- app holds a real token and could call the Data API directly. A RESTRICTIVE
-- policy is ANDed with every existing policy, so on each table people can
-- write, inserts/updates/deletes also need ai_write_allowed(). Reads are
-- untouched. service_role bypasses RLS, so server jobs are unaffected.
--
-- Covers every public table with RLS on today. A table added later needs
-- the same three policies in its own migration.
do $$
declare
  t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public' and rowsecurity and tablename <> 'ai_connections'
  loop
    execute format('drop policy if exists %I on public.%I', t || '_ai_ro_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_ai_ro_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_ai_ro_delete', t);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated with check ((select public.ai_write_allowed()))',
      t || '_ai_ro_insert', t);
    execute format(
      'create policy %I on public.%I as restrictive for update to authenticated using ((select public.ai_write_allowed()))',
      t || '_ai_ro_update', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete to authenticated using ((select public.ai_write_allowed()))',
      t || '_ai_ro_delete', t);
  end loop;
end $$;
