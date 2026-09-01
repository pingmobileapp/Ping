import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Creates a Stripe Checkout Session (a destination charge - the platform is
// charged, then the connected account gets the funds minus the platform's
// cut) for a priced Discover event, and returns the hosted URL for the
// client to open in an in-app browser. This is the only place that ever
// creates a `discover_payments` row; stripe-webhook is the only place that
// ever marks one 'paid' or 'refunded' - the client's return from the
// browser is not the source of truth (see that function's own comment).
//
// Applies to *every* way someone can end up accepted on a priced event -
// a stranger self-joining via Discover, or a guest the host directly
// invited - not just Discover self-joins. Both routes have an existing
// `invitees` row (or don't) by the time this runs; see step 3 below.
serve(async (req) => {
  try {
    const { eventId, returnUrl } = await req.json().catch(() => ({}));
    if (!eventId || typeof eventId !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing eventId' }), { status: 400 });
    }
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

    const stripeRequestV1 = async (
      method: 'GET' | 'POST',
      path: string,
      body?: Record<string, string>
    ) => {
      const res = await fetch(`https://api.stripe.com/v1/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: body ? new URLSearchParams(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || `Stripe ${path} failed`);
      return json;
    };

    // 1. Look up the event.
    const { data: event, error: eventError } = await admin
      .from('events')
      .select('id, title, status, price_cents, currency, capacity, accepted_count, host_id')
      .eq('id', eventId)
      .maybeSingle();
    if (eventError) throw new Error(`look up event: ${eventError.message}`);
    if (!event || event.status !== 'sent') {
      return new Response(JSON.stringify({ error: 'Event not found' }), { status: 404 });
    }
    if (!event.price_cents) {
      return new Response(JSON.stringify({ error: 'This event is free - no checkout needed' }), { status: 400 });
    }

    // 2. The host's Stripe account needs to be live right now, not just
    // whenever they last opened Settings - re-check against Stripe rather
    // than trusting the cached stripe_accounts columns (same GET
    // stripe-connect-status already does).
    const { data: hostAccount, error: hostAccountError } = await admin
      .from('stripe_accounts')
      .select('stripe_account_id')
      .eq('user_id', event.host_id)
      .maybeSingle();
    if (hostAccountError) throw new Error(`look up stripe_accounts: ${hostAccountError.message}`);
    if (!hostAccount) {
      return new Response(JSON.stringify({ error: "This host hasn't set up payouts yet" }), { status: 400 });
    }
    const liveAccount = await stripeRequestV1('GET', `accounts/${hostAccount.stripe_account_id}`);
    if (!liveAccount.charges_enabled || !liveAccount.payouts_enabled) {
      return new Response(
        JSON.stringify({ error: "This host's payment setup isn't ready yet - try again later" }),
        { status: 400 }
      );
    }

    // 3. An existing invitee row means the host invited this person
    // directly - the checkout still applies, but stripe-webhook needs to
    // UPDATE that row instead of INSERT a new one (see discover_checkout.sql).
    const { data: existingInvitee, error: inviteeError } = await admin
      .from('invitees')
      .select('id, rsvp_status')
      .eq('event_id', eventId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (inviteeError) throw new Error(`look up invitees: ${inviteeError.message}`);
    if (existingInvitee?.rsvp_status === 'accepted') {
      return new Response(JSON.stringify({ error: "You're already going" }), { status: 400 });
    }

    const hasCapacity = event.capacity == null || (event.accepted_count ?? 0) < event.capacity;
    if (!hasCapacity) {
      return new Response(JSON.stringify({ error: 'This event is full' }), { status: 400 });
    }

    // 4. Double-payment guard: already paid once (e.g. declined after
    // paying, now wants back in - no refunds means they already paid for
    // this spot) - just re-accept them directly, no second charge.
    const { data: existingPayment, error: paymentLookupError } = await admin
      .from('discover_payments')
      .select('id')
      .eq('event_id', eventId)
      .eq('user_id', user.id)
      .eq('status', 'paid')
      .maybeSingle();
    if (paymentLookupError) throw new Error(`look up discover_payments: ${paymentLookupError.message}`);
    if (existingPayment) {
      if (existingInvitee) {
        const { error: updateError } = await admin
          .from('invitees')
          .update({ rsvp_status: 'accepted', responded_at: new Date().toISOString() })
          .eq('id', existingInvitee.id);
        if (updateError) throw new Error(`update invitees: ${updateError.message}`);
      } else {
        const { error: insertError } = await admin.from('invitees').insert({
          event_id: eventId,
          user_id: user.id,
          rsvp_status: 'accepted',
          invited_via: 'discover',
          responded_at: new Date().toISOString(),
        });
        if (insertError) throw new Error(`insert invitees: ${insertError.message}`);
      }
      return new Response(JSON.stringify({ alreadyPaid: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 5. Compute the charge. price_cents is the host's listed price; the
    // buyer pays +8%, the host receives -12% - applicationFeeCents is the
    // difference between the two so they always reconcile exactly (see
    // the fee split decided 2026-08-31).
    const priceCents = event.price_cents as number;
    const buyerTotalCents = Math.round(priceCents * 1.08);
    const hostPayoutCents = Math.round(priceCents * 0.88);
    const applicationFeeCents = buyerTotalCents - hostPayoutCents;

    // account_links/checkout Sessions only accept http(s) URLs, not the
    // app's custom pingapp:// scheme - same bridge phase 1 built for Stripe
    // Connect onboarding, reused as-is here.
    const bridgeUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/stripe-connect-return?to=${encodeURIComponent(returnUrl)}`;

    const session = await stripeRequestV1('POST', 'checkout/sessions', {
      'line_items[0][price_data][currency]': event.currency || 'usd',
      'line_items[0][price_data][product_data][name]': event.title,
      'line_items[0][price_data][unit_amount]': String(buyerTotalCents),
      'line_items[0][quantity]': '1',
      mode: 'payment',
      'payment_intent_data[application_fee_amount]': String(applicationFeeCents),
      'payment_intent_data[transfer_data][destination]': hostAccount.stripe_account_id,
      'metadata[event_id]': eventId,
      'metadata[user_id]': user.id,
      success_url: bridgeUrl,
      cancel_url: bridgeUrl,
    });

    const { error: insertPaymentError } = await admin.from('discover_payments').insert({
      event_id: eventId,
      user_id: user.id,
      invitee_id: existingInvitee?.id ?? null,
      stripe_checkout_session_id: session.id,
      buyer_total_cents: buyerTotalCents,
      application_fee_cents: applicationFeeCents,
      host_payout_cents: hostPayoutCents,
      status: 'pending',
    });
    if (insertPaymentError) throw new Error(`insert discover_payments: ${insertPaymentError.message}`);

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
});
