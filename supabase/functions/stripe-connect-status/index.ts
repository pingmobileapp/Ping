import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Refreshes the caller's own stripe_accounts row from Stripe directly -
// called right after the onboarding browser closes (see Settings), and any
// time the screen just wants to know where things stand. No webhook yet:
// Express onboarding is a short, synchronous flow the host is sitting in
// front of, so pulling the current state the moment they return covers
// this phase fine. A webhook (account.updated) becomes worth it once
// payments (phase 3) need to react to Stripe events with nobody staring at
// the screen.
serve(async (req) => {
  try {
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

    const { data: existing, error: fetchError } = await admin
      .from('stripe_accounts')
      .select('stripe_account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (fetchError) throw new Error(`look up stripe_accounts: ${fetchError.message}`);

    if (!existing) {
      return new Response(
        JSON.stringify({ status: 'not_started', charges_enabled: false, payouts_enabled: false, details_submitted: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) {
      console.error('STRIPE_SECRET_KEY is not set');
      return new Response(JSON.stringify({ error: 'Payments are not configured yet' }), { status: 500 });
    }

    const res = await fetch(`https://api.stripe.com/v1/accounts/${existing.stripe_account_id}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const account = await res.json();
    if (!res.ok) throw new Error(account?.error?.message || 'Stripe account lookup failed');

    const chargesEnabled = !!account.charges_enabled;
    const payoutsEnabled = !!account.payouts_enabled;
    const detailsSubmitted = !!account.details_submitted;

    const { error: updateError } = await admin
      .from('stripe_accounts')
      .update({
        charges_enabled: chargesEnabled,
        payouts_enabled: payoutsEnabled,
        details_submitted: detailsSubmitted,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id);
    if (updateError) throw new Error(`update stripe_accounts: ${updateError.message}`);

    return new Response(
      JSON.stringify({
        status: chargesEnabled && payoutsEnabled ? 'ready' : detailsSubmitted ? 'pending' : 'incomplete',
        charges_enabled: chargesEnabled,
        payouts_enabled: payoutsEnabled,
        details_submitted: detailsSubmitted,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
});
