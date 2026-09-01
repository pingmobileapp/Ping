-- App Store Guideline 1.2 (Safety - User-Generated Content) compliance:
-- a terms-of-use acceptance gate, a report/flag mechanism, a block
-- mechanism (with instant feed removal), and admin-only visibility so
-- reports can actually be acted on. None of this existed before - see
-- the discover_payments_roadmap-adjacent session notes for the rejection
-- this addresses.

alter table public.profiles add column if not exists accepted_terms_at timestamptz;
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists banned_at timestamptz;

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.profiles(id) on delete set null,
  reported_user_id uuid references public.profiles(id) on delete cascade,
  content_type text not null check (content_type in ('event', 'message', 'group_message', 'block')),
  content_id uuid,
  event_id uuid references public.events(id) on delete cascade,
  reason text not null,
  -- 'block' means this row exists only because of a block action, not a
  -- separate report - Apple's guideline explicitly requires blocking to
  -- also notify the developer, so every block writes one of these too.
  source text not null default 'user' check (source in ('user', 'auto_filter', 'block')),
  status text not null default 'open' check (status in ('open', 'dismissed', 'removed', 'user_banned')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.reports enable row level security;

drop policy if exists reports_insert_self on public.reports;
create policy reports_insert_self
  on public.reports for insert
  to authenticated
  with check (reporter_id = auth.uid());

drop policy if exists reports_select_admin on public.reports;
create policy reports_select_admin
  on public.reports for select
  to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin));

-- Without this, a plain insert-with-select-back (Prefer: return=representation,
-- which supabase-js sends whenever .select() follows .insert()) 403s for a
-- non-admin reporter, since PostgREST's read-back after INSERT is itself
-- subject to SELECT RLS - confirmed by hitting exactly this while verifying
-- reports_insert_self. lib/moderation.ts doesn't chain .select() today, so
-- this isn't live-broken, but it's cheap insurance against that trap, and a
-- reasonable feature on its own (seeing reports you've filed).
drop policy if exists reports_select_own on public.reports;
create policy reports_select_own
  on public.reports for select
  to authenticated
  using (reporter_id = auth.uid());

drop policy if exists reports_update_admin on public.reports;
create policy reports_update_admin
  on public.reports for update
  to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin));

create table if not exists public.blocked_users (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

alter table public.blocked_users enable row level security;

drop policy if exists blocked_users_select_self on public.blocked_users;
create policy blocked_users_select_self
  on public.blocked_users for select
  to authenticated
  using (blocker_id = auth.uid());

drop policy if exists blocked_users_insert_self on public.blocked_users;
create policy blocked_users_insert_self
  on public.blocked_users for insert
  to authenticated
  with check (blocker_id = auth.uid());

drop policy if exists blocked_users_delete_self on public.blocked_users;
create policy blocked_users_delete_self
  on public.blocked_users for delete
  to authenticated
  using (blocker_id = auth.uid());

-- Instant feed removal: redefine the live SELECT policies (as they exist
-- today, fetched directly from pg_policies before writing this) to also
-- exclude anyone the viewer has blocked.
drop policy if exists events_select_discoverable on public.events;
create policy events_select_discoverable
  on public.events for select
  to authenticated
  using (
    discoverable = true
    and not exists (select 1 from public.blocked_users where blocker_id = auth.uid() and blocked_id = events.host_id)
  );

drop policy if exists messages_select_host_or_member on public.messages;
create policy messages_select_host_or_member
  on public.messages for select
  to authenticated
  using (
    is_event_member(event_id, auth.uid())
    and not exists (select 1 from public.blocked_users where blocker_id = auth.uid() and blocked_id = messages.sender_id)
  );

-- group_messages has two live SELECT policies that OR together - both
-- need the exclusion, or the other one alone still lets blocked senders'
-- messages through.
drop policy if exists group_messages_select on public.group_messages;
create policy group_messages_select
  on public.group_messages for select
  to authenticated
  using (
    (
      exists (select 1 from groups g where g.id = group_messages.group_id and g.owner_id = auth.uid())
      or exists (select 1 from group_members gm where gm.group_id = group_messages.group_id and gm.user_id = auth.uid())
    )
    and not exists (select 1 from public.blocked_users where blocker_id = auth.uid() and blocked_id = group_messages.sender_id)
  );

drop policy if exists ping_group_messages_shared_select on public.group_messages;
create policy ping_group_messages_shared_select
  on public.group_messages for select
  to authenticated
  using (
    exists (select 1 from groups g where g.id = group_messages.group_id and g.is_shared = true)
    and is_group_member(group_id)
    and not exists (select 1 from public.blocked_users where blocker_id = auth.uid() and blocked_id = group_messages.sender_id)
  );
