-- Phase 2 of paid Discover listings: lets a host set a price on an event.
-- This is data + UI only - nothing actually charges anyone yet. "Accept"
-- on a priced event still just writes rsvp_status='accepted' directly
-- until phase 3 (Checkout Session + webhook) replaces that. null/zero
-- price_cents means free, same as today.
alter table public.events add column if not exists price_cents integer;
alter table public.events add column if not exists currency text not null default 'usd';
