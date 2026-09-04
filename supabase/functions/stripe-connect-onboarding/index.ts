import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Creates (or reuses) a Stripe Express account for the caller, then returns
// a fresh onboarding link URL for the client to open in an in-app browser.
// Plain fetch against Stripe's REST API rather than the `stripe` npm
// package - matches how every other edge function in this app talks to a
// third-party API (see refresh-activities), and avoids finding out whether
// the Stripe SDK's Node internals are happy running on Deno.
//
// { returnUrl } in the request body is the client's own
// AuthSession.makeRedirectUri() output - both Stripe's refresh_url (link
// expired/abandoned) and return_url (onboarding step finished, may still
// be incomplete) point at the same place, since either way the client's
// job on return is just to call stripe-connect-status and show whatever
// is actually true now.
serve(async (req) => {
  try {
    const { returnUrl } = await req.json().catch(() => ({}));
    if (!returnUrl || typeof returnUrl !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing returnUrl' }), { status: 400 });
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), { status: 401 });
    }

    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const {
      data: { user },
      error: userError,
    } = await callerClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // A flagged demo/reviewer account (see
    // supabase/apple_reviewer_test_mode.sql) onboards against Stripe's TEST
    // mode instead of live - lets App Review's demo host complete Connect
    // onboarding with fake test data instead of a real bank account, and
    // keeps that account's stripe_accounts row in the same object space as
    // the test-mode checkout discover-checkout creates for a test buyer.
    const { data: callerProfile } = await admin
      .from('profiles')
      .select('use_stripe_test_mode')
      .eq('id', user.id)
      .maybeSingle();
    const useTestMode = !!callerProfile?.use_stripe_test_mode;
    const stripeKey = useTestMode ? Deno.env.get('STRIPE_TEST_SECRET_KEY') : Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) {
      console.error(useTestMode ? 'STRIPE_TEST_SECRET_KEY is not set' : 'STRIPE_SECRET_KEY is not set');
      return new Response(JSON.stringify({ error: 'Payments are not configured yet' }), { status: 500 });
    }

    // v1 endpoints (account_links has no v2 equivalent yet) still take a v2
    // account id directly - see https://docs.stripe.com/connect/accounts-v2.
    const stripeRequestV1 = async (path: string, body: Record<string, string>) => {
      const res = await fetch(`https://api.stripe.com/v1/${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || `Stripe ${path} failed`);
      return json;
    };

    // Accounts v2 (Core) is JSON-bodied and requires a pinned Stripe-Version,
    // unlike every other v1 call in this file. New Stripe accounts no longer
    // support creating accounts via v1's POST /v1/accounts at all.
    const stripeRequestV2 = async (path: string, body: Record<string, unknown>) => {
      const res = await fetch(`https://api.stripe.com/v2/${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          'Content-Type': 'application/json',
          'Stripe-Version': '2026-08-26.preview',
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || `Stripe ${path} failed`);
      return json;
    };

    const { data: existing, error: fetchError } = await admin
      .from('stripe_accounts')
      .select('stripe_account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (fetchError) throw new Error(`look up stripe_accounts: ${fetchError.message}`);

    let accountId = existing?.stripe_account_id as string | undefined;

    if (!accountId) {
      // merchant.card_payments + recipient.stripe_transfers is the v2
      // equivalent of the v1 Express account's card_payments + transfers
      // capabilities. dashboard: 'express' (the hosted dashboard a host
      // gets, matching the old Express UX) requires the platform - not
      // Stripe - to be the fees/losses collector; that's a Stripe-imposed
      // rule for express dashboards in v2, not a choice made here.
      const account = await stripeRequestV2('core/accounts', {
        contact_email: user.email || '',
        dashboard: 'express',
        identity: { country: 'us' },
        configuration: {
          merchant: {
            capabilities: {
              card_payments: { requested: true },
            },
          },
          recipient: {
            capabilities: {
              stripe_balance: { stripe_transfers: { requested: true } },
            },
          },
        },
        defaults: {
          responsibilities: { fees_collector: 'application', losses_collector: 'application' },
        },
      });
      accountId = account.id as string;

      const { error: insertError } = await admin.from('stripe_accounts').insert({
        user_id: user.id,
        stripe_account_id: accountId,
      });
      if (insertError) throw new Error(`insert stripe_accounts: ${insertError.message}`);
    }

    // account_links only accepts http(s) URLs, not the app's custom
    // pingapp:// scheme - bounce through a same-project https page that
    // hands off to the real returnUrl (see stripe-connect-return).
    const bridgeUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/stripe-connect-return?to=${encodeURIComponent(returnUrl)}`;

    const accountLink = await stripeRequestV1('account_links', {
      account: accountId,
      refresh_url: bridgeUrl,
      return_url: bridgeUrl,
      type: 'account_onboarding',
    });

    return new Response(JSON.stringify({ url: accountLink.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
});
