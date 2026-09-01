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

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) {
      console.error('STRIPE_SECRET_KEY is not set');
      return new Response(JSON.stringify({ error: 'Payments are not configured yet' }), { status: 500 });
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const stripeRequest = async (path: string, body: Record<string, string>) => {
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

    const { data: existing, error: fetchError } = await admin
      .from('stripe_accounts')
      .select('stripe_account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (fetchError) throw new Error(`look up stripe_accounts: ${fetchError.message}`);

    let accountId = existing?.stripe_account_id as string | undefined;

    if (!accountId) {
      const account = await stripeRequest('accounts', {
        type: 'express',
        email: user.email || '',
        'capabilities[card_payments][requested]': 'true',
        'capabilities[transfers][requested]': 'true',
      });
      accountId = account.id as string;

      const { error: insertError } = await admin.from('stripe_accounts').insert({
        user_id: user.id,
        stripe_account_id: accountId,
      });
      if (insertError) throw new Error(`insert stripe_accounts: ${insertError.message}`);
    }

    const accountLink = await stripeRequest('account_links', {
      account: accountId,
      refresh_url: returnUrl,
      return_url: returnUrl,
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
