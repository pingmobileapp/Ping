-- Phase 3 of paid Discover listings: a real Stripe payment now sits between
-- tapping "Accept" on a priced event and the invitee row actually flipping
-- to accepted. discover-checkout creates the Checkout Session and a
-- pending row here; stripe-webhook (the only thing that ever marks a row
-- 'paid' or 'refunded') is the actual source of truth once Stripe confirms
-- the charge - never the client's return from the browser, since the app
-- can be closed before that redirect ever happens.
create table if not exists public.discover_payments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- Set when the buyer already had a pending invitee row (a direct invite,
  -- not a Discover self-join) - tells stripe-webhook to UPDATE that row
  -- instead of INSERT a new one, mirroring submitRsvp's own branching.
  invitee_id uuid references public.invitees(id) on delete set null,
  stripe_checkout_session_id text not null unique,
  stripe_payment_intent_id text,
  buyer_total_cents integer not null,
  application_fee_cents integer not null,
  host_payout_cents integer not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.discover_payments enable row level security;

drop policy if exists discover_payments_select_self on public.discover_payments;
create policy discover_payments_select_self
  on public.discover_payments for select
  to authenticated
  using (user_id = auth.uid());

-- No insert/update policy for `authenticated` at all, deliberately - only
-- discover-checkout and stripe-webhook (service role) ever write here.

-- Pure idempotency ledger for stripe-webhook - Stripe can and does retry
-- delivery, and this table is what stops a retried event from being
-- double-processed (see lib/notify.ts's consolidateNotification for the
-- same insert-on-conflict pattern used elsewhere in this codebase).
create table if not exists public.stripe_webhook_events (
  id text primary key,
  processed_at timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;
-- Zero policies, not even select - only the service role ever touches this.
