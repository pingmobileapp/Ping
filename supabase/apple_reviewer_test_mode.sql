-- Lets specific accounts (a demo host + a demo buyer, whose credentials get
-- handed to Apple in App Store Connect's App Review Information) transact
-- against Stripe's TEST mode instead of live, so App Review can actually
-- complete a real checkout - with a Stripe test card, zero real money - to
-- verify the paid-booking feature works end to end. See
-- discover-checkout/stripe-connect-onboarding/stripe-connect-status/
-- stripe-webhook for where this is read. Service-role only - no policy
-- grants `authenticated` write access, same convention as stripe_accounts'
-- own columns; nothing in the client app ever sets or reads this.
alter table public.profiles
  add column if not exists use_stripe_test_mode boolean not null default false;
