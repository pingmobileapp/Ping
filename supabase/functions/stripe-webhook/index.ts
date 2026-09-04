import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Public endpoint - Stripe calls this directly with no Supabase auth,
// deployed with --no-verify-jwt. This is the only thing that ever marks a
// discover_payments row 'paid' or 'refunded'; the client's return from the
// Checkout browser is just a fast-path UI refresh, never the source of
// truth (the customer can close the app before that redirect happens -
// see Stripe's own webhook docs).
//
// Manual signature verification since this codebase talks to Stripe via
// plain fetch everywhere, not the `stripe` npm package (see
// stripe-connect-onboarding) - algorithm from
// https://docs.stripe.com/webhooks#verify-manually.
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=') as [string, string]));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // Reject anything older than 5 minutes - Stripe's own default tolerance,
  // guards against a captured-and-replayed request.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signedPayload = `${timestamp}.${payload}`;
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

serve(async (req) => {
  try {
    const rawBody = await req.text();
    const sigHeader = req.headers.get('Stripe-Signature');
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      console.error('STRIPE_WEBHOOK_SECRET is not set');
      return new Response('Webhook not configured', { status: 500 });
    }
    if (!sigHeader || !(await verifyStripeSignature(rawBody, sigHeader, webhookSecret))) {
      return new Response('Invalid signature', { status: 400 });
    }

    const stripeEvent = JSON.parse(rawBody);
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Idempotency - Stripe retries delivery, this table is what stops a
    // retried event from being double-processed (insert-on-conflict, same
    // pattern as lib/notify.ts's consolidateNotification).
    const { error: dedupeError } = await admin.from('stripe_webhook_events').insert({ id: stripeEvent.id });
    if (dedupeError) {
      if (dedupeError.code === '23505') {
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }
      throw new Error(`insert stripe_webhook_events: ${dedupeError.message}`);
    }

    if (stripeEvent.type !== 'checkout.session.completed') {
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    const session = stripeEvent.data.object;
    const paymentIntentId = session.payment_intent as string;

    const { data: payment, error: paymentError } = await admin
      .from('discover_payments')
      .select('id, event_id, user_id, invitee_id, status')
      .eq('stripe_checkout_session_id', session.id)
      .maybeSingle();
    if (paymentError) throw new Error(`look up discover_payments: ${paymentError.message}`);
    if (!payment) {
      console.error('No discover_payments row for checkout session', session.id);
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }
    if (payment.status !== 'pending') {
      // Already handled (belt-and-suspenders on top of the dedupe table above).
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    const { data: eventRow, error: eventError } = await admin
      .from('events')
      .select('title, host_id, capacity, accepted_count')
      .eq('id', payment.event_id)
      .maybeSingle();
    if (eventError) throw new Error(`look up event: ${eventError.message}`);
    if (!eventRow) throw new Error(`event ${payment.event_id} missing for payment ${payment.id}`);

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;
    const hasCapacity = eventRow.capacity == null || (eventRow.accepted_count ?? 0) < eventRow.capacity;

    if (!hasCapacity) {
      // The event filled up in the window between starting checkout and
      // this webhook landing - this booking never happened, so fully
      // undo it: refund the buyer, pull the transfer back from the host,
      // and give the platform's fee back too.
      const refundRes = await fetch('https://api.stripe.com/v1/refunds', {
        method: 'POST',
        headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          payment_intent: paymentIntentId,
          reverse_transfer: 'true',
          refund_application_fee: 'true',
        }),
      });
      const refundJson = await refundRes.json();
      if (!refundRes.ok) console.error('Refund failed:', refundJson);

      const { error: updateError } = await admin
        .from('discover_payments')
        .update({ status: 'refunded', stripe_payment_intent_id: paymentIntentId, updated_at: new Date().toISOString() })
        .eq('id', payment.id);
      if (updateError) throw new Error(`update discover_payments: ${updateError.message}`);

      // The buyer has no other way to find out what happened to their
      // money - calling send-push directly with the service-role key
      // rather than reimplementing its Expo-push/badge-count logic here
      // (the one deliberate exception to this codebase's usual
      // duplicate-rather-than-delegate pattern between edge functions,
      // since send-push is first-party glue code, not a third-party API).
      try {
        await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-push`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            apikey: Deno.env.get('SUPABASE_ANON_KEY')!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            user_ids: [payment.user_id],
            title: 'Refunded',
            body: "That event filled up right as you were paying - you've been fully refunded.",
            data: { type: 'refund', eventId: payment.event_id },
          }),
        });
      } catch (pushErr) {
        console.error('Failed to send refund push:', pushErr);
      }

      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    // Capacity's fine - make the RSVP real. Update if this buyer already
    // had a pending invitee row (a direct invite), insert otherwise (a
    // Discover self-join) - mirrors submitRsvp's own branching exactly.
    if (payment.invitee_id) {
      const { error: updateInviteeError } = await admin
        .from('invitees')
        .update({ rsvp_status: 'accepted', responded_at: new Date().toISOString() })
        .eq('id', payment.invitee_id);
      if (updateInviteeError) throw new Error(`update invitees: ${updateInviteeError.message}`);
    } else {
      const { error: insertInviteeError } = await admin.from('invitees').insert({
        event_id: payment.event_id,
        user_id: payment.user_id,
        rsvp_status: 'accepted',
        invited_via: 'discover',
        responded_at: new Date().toISOString(),
      });
      if (insertInviteeError) throw new Error(`insert invitees: ${insertInviteeError.message}`);
    }

    const { error: markPaidError } = await admin
      .from('discover_payments')
      .update({ status: 'paid', stripe_payment_intent_id: paymentIntentId, updated_at: new Date().toISOString() })
      .eq('id', payment.id);
    if (markPaidError) throw new Error(`update discover_payments: ${markPaidError.message}`);

    // Tell the host someone booked - a normal free RSVP goes through
    // submitRsvp (lib/rsvp.ts), which already notifies every host via
    // notify(). A paid booking never touches that code path at all (this
    // webhook is the only thing that ever marks a discover_payments row
    // 'paid' - see the comment at the top of this file), so without this
    // the host had no way to find out a paid booking happened. Mirrors
    // notify()'s own 'rsvp_update' shape (same notif_group/thread_key
    // convention, so a paid booking consolidates into the same one row a
    // free RSVP would) since that shared lib can't be imported into a Deno
    // edge function.
    try {
      const { data: coHosts } = await admin.from('event_hosts').select('user_id').eq('event_id', payment.event_id);
      const recipientIds = Array.from(
        new Set(
          [eventRow.host_id, ...(coHosts || []).map((h: { user_id: string }) => h.user_id)].filter(
            (id): id is string => !!id && id !== payment.user_id
          )
        )
      );

      if (recipientIds.length > 0) {
        const { data: buyerProfile } = await admin
          .from('profiles')
          .select('full_name, email')
          .eq('id', payment.user_id)
          .maybeSingle();
        const buyerName =
          buyerProfile?.full_name ||
          (buyerProfile?.email ? buyerProfile.email.split('@')[0] : null) ||
          'Someone';
        const title = 'RSVP update';
        const body = `${buyerName} accepted ${eventRow.title}`;

        const { error: notifyError } = await admin.from('notifications').upsert(
          recipientIds.map((recipientId) => ({
            recipient_id: recipientId,
            notif_group: 'event_activity',
            type: 'rsvp_update',
            event_id: payment.event_id,
            group_id: null,
            thread_key: payment.event_id,
            title,
            body,
            created_at: new Date().toISOString(),
            read_at: null,
          })),
          { onConflict: 'recipient_id,notif_group,thread_key' }
        );
        if (notifyError) console.error('Error saving booking notification:', notifyError);

        await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-push`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            apikey: Deno.env.get('SUPABASE_ANON_KEY')!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            user_ids: recipientIds,
            title,
            body,
            data: { eventId: payment.event_id, type: 'rsvp_update' },
          }),
        }).catch((pushErr) => console.error('Failed to send booking-notification push:', pushErr));
      }
    } catch (notifyErr) {
      // Never fail the webhook over a notification hiccup - the booking
      // itself already succeeded above.
      console.error('Error notifying host of paid booking:', notifyErr);
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
});
