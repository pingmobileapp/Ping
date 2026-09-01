-- Phase 1 of paid Discover listings: lets a host connect a Stripe Express
-- account so they can receive payouts. No pricing/checkout yet - this is
-- just the account-linking piece everything else builds on. Stripe itself
-- handles identity verification, tax forms, and payout compliance for
-- Express accounts; this table only mirrors the handful of status fields
-- the app needs to render "not started / pending / ready", plus the
-- account id used by every later edge function that creates a charge or
-- account link for this host.
--
-- Every column here is written only by edge functions running with the
-- service role (stripe-connect-onboarding, stripe-connect-status) - a
-- client could never fabricate a real stripe_account_id, so there is
-- deliberately no insert/update policy for `authenticated` at all, only
-- select.

create table if not exists public.stripe_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  stripe_account_id text not null unique,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.stripe_accounts enable row level security;

drop policy if exists stripe_accounts_select_self on public.stripe_accounts;
create policy stripe_accounts_select_self
  on public.stripe_accounts for select
  to authenticated
  using (user_id = auth.uid());
