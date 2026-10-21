import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// RSVP from the invite web page (docs/invite.html) - for someone who got a
// Ping invite by text and doesn't have the app (asked for 2026-10-20: about
// 40% of phones are Android, and some iPhone people won't install an app).
// Like invite-info, the invitee id in the link is the only key: whoever has
// the link can answer for that one invite, the same as Evite and Paperless
// Post links. It can only change that invitee row's RSVP - nothing else.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const STATUSES = ['accepted', 'interested', 'declined'] as const;
type Status = (typeof STATUSES)[number];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const { i: inviteeId, status } = await req.json();
    if (typeof inviteeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(inviteeId)) return json({ error: 'bad_invite' }, 400);
    if (!STATUSES.includes(status)) return json({ error: 'bad_status' }, 400);

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: invitee } = await supabase
      .from('invitees')
      .select(
        'id, rsvp_status, contact_id, user_id, event_id, events(id, title, status, event_date, end_date, host_id, price_cents, capacity, accepted_count)'
      )
      .eq('id', inviteeId)
      .maybeSingle();
    const event = invitee?.events as any;
    if (!invitee || !event || event.status !== 'sent') return json({ error: 'not_found' }, 404);

    // A day of grace after it ends, then answering a past event stops.
    const endsAt = new Date(event.end_date || event.event_date).getTime();
    if (endsAt < Date.now() - 24 * 60 * 60 * 1000) return json({ error: 'past' }, 409);

    // Paying for a ticket happens in the app (Stripe Checkout) - the page
    // can't take money, so it can't say "going" to a priced event.
    if (status === 'accepted' && event.price_cents && event.price_cents > 0) return json({ error: 'paid' }, 409);

    // Same limit the app's RLS capacity check enforces.
    if (
      status === 'accepted' &&
      invitee.rsvp_status !== 'accepted' &&
      event.capacity != null &&
      (event.accepted_count ?? 0) >= event.capacity
    ) {
      return json({ error: 'full' }, 409);
    }

    if (invitee.rsvp_status === status) return json({ status });

    const { error: updateError } = await supabase
      .from('invitees')
      .update({ rsvp_status: status, responded_at: new Date().toISOString() })
      .eq('id', inviteeId);
    if (updateError) throw updateError;

    // Same as the app: declining gives back anything they'd said they'd bring.
    if (status === 'declined') {
      await supabase.from('item_claims').delete().eq('invitee_id', inviteeId);
    }

    // Tell every host - primary and co-hosts - the way lib/rsvp.ts does,
    // using the name the host saved for this person.
    let name = 'A guest';
    if (invitee.contact_id) {
      const { data: contact } = await supabase.from('contacts').select('name').eq('id', invitee.contact_id).maybeSingle();
      if (contact?.name) name = contact.name;
    } else if (invitee.user_id) {
      const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', invitee.user_id).maybeSingle();
      if (profile?.full_name) name = profile.full_name;
    }

    const { data: coHosts } = await supabase.from('event_hosts').select('user_id').eq('event_id', event.id);
    const hostIds = Array.from(
      new Set([event.host_id, ...(coHosts || []).map((h: { user_id: string }) => h.user_id)].filter(Boolean))
    ).filter((id) => id !== invitee.user_id) as string[];

    if (hostIds.length > 0) {
      const verb = status === 'accepted' ? 'accepted' : status === 'declined' ? 'declined' : 'is interested in';
      const title = 'RSVP update';
      const body = `${name} ${verb} ${event.title}`;
      // One consolidated "event activity" row per host per event - same
      // upsert as lib/notify.ts's consolidateNotification.
      const { error: notifError } = await supabase.from('notifications').upsert(
        hostIds.map((id) => ({
          recipient_id: id,
          notif_group: 'event_activity',
          type: 'rsvp_update',
          event_id: event.id,
          group_id: null,
          thread_key: event.id,
          title,
          body,
          created_at: new Date().toISOString(),
          read_at: null,
        })),
        { onConflict: 'recipient_id,notif_group,thread_key' }
      );
      if (notifError) console.error('Error saving host notification:', notifError);

      const { error: pushError } = await supabase.functions.invoke('send-push', {
        body: { user_ids: hostIds, title, body, data: { eventId: event.id, type: 'rsvp_update' } },
      });
      if (pushError) console.error('Push failed:', pushError);
    }

    return json({ status });
  } catch (err) {
    console.error(err);
    return json({ error: 'server' }, 500);
  }
});
