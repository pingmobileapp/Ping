import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// "What to bring" from the invite web page (docs/invite.html), for someone
// who got the invite by text and doesn't have the app (2026-10-25). Like
// invite-rsvp, the invitee id in the link is the only key, and it can only
// add or remove that invitee's own item_claims rows on that one event.
// The enforce_item_claim_limit trigger still applies: specific items never
// go over what's needed, and the same write-in twice is refused.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ACTIONS = ['claim', 'unclaim', 'add', 'remove'] as const;
type Action = (typeof ACTIONS)[number];
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_NOTE = 80;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const { i: inviteeId, action, itemId, claimId, note } = await req.json();
    if (typeof inviteeId !== 'string' || !UUID.test(inviteeId)) return json({ error: 'bad_invite' }, 400);
    if (!ACTIONS.includes(action)) return json({ error: 'bad_action' }, 400);
    const act = action as Action;

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: invitee } = await supabase
      .from('invitees')
      .select('id, rsvp_status, contact_id, user_id, event_id, events(id, title, status, event_date, end_date, host_id)')
      .eq('id', inviteeId)
      .maybeSingle();
    const event = invitee?.events as any;
    if (!invitee || !event || event.status !== 'sent') return json({ error: 'not_found' }, 404);

    const endsAt = new Date(event.end_date || event.event_date).getTime();
    if (endsAt < Date.now() - 24 * 60 * 60 * 1000) return json({ error: 'past' }, 409);

    // Removing your own entry.
    if (act === 'remove') {
      if (typeof claimId !== 'string' || !UUID.test(claimId)) return json({ error: 'bad_claim' }, 400);
      const { error } = await supabase.from('item_claims').delete().eq('id', claimId).eq('invitee_id', inviteeId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (typeof itemId !== 'string' || !UUID.test(itemId)) return json({ error: 'bad_item' }, 400);
    const { data: item } = await supabase
      .from('items')
      .select('id, name, event_id, quantity_needed, allow_custom')
      .eq('id', itemId)
      .maybeSingle();
    if (!item || item.event_id !== invitee.event_id) return json({ error: 'not_found' }, 404);

    // Same as the app: someone who can't come isn't bringing anything.
    if (act !== 'unclaim' && invitee.rsvp_status === 'declined') return json({ error: 'declined' }, 409);

    const { data: myClaim } = await supabase
      .from('item_claims')
      .select('id, quantity')
      .eq('item_id', itemId)
      .eq('invitee_id', inviteeId)
      .limit(1)
      .maybeSingle();

    let broughtName: string | null = null;
    let error: { code?: string; message?: string } | null = null;

    if (act === 'add') {
      if (!item.allow_custom) return json({ error: 'bad_item' }, 400);
      const text = typeof note === 'string' ? note.trim().slice(0, MAX_NOTE) : '';
      if (!text) return json({ error: 'empty' }, 400);
      ({ error } = await supabase.from('item_claims').insert([{ item_id: itemId, invitee_id: inviteeId, quantity: 1, note: text }]));
      broughtName = text;
    } else if (item.allow_custom) {
      return json({ error: 'bad_item' }, 400);
    } else if (act === 'claim') {
      // One more of a specific item - the trigger refuses going over.
      if (myClaim) {
        ({ error } = await supabase
          .from('item_claims')
          .update({ quantity: myClaim.quantity + 1 })
          .eq('id', myClaim.id));
      } else {
        ({ error } = await supabase.from('item_claims').insert([{ item_id: itemId, invitee_id: inviteeId, quantity: 1 }]));
      }
      broughtName = item.name;
    } else if (myClaim) {
      ({ error } =
        myClaim.quantity > 1
          ? await supabase.from('item_claims').update({ quantity: myClaim.quantity - 1 }).eq('id', myClaim.id)
          : await supabase.from('item_claims').delete().eq('id', myClaim.id));
    }

    if (error) {
      if (error.message?.includes('item_full')) return json({ error: 'full' }, 409);
      if (error.code === '23505') return json({ error: 'duplicate' }, 409);
      throw error;
    }

    // Let every host know, the way the app does for a claim.
    if (broughtName) {
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
        const title = 'Someone is bringing something';
        const body = `${name} is bringing "${broughtName}" to ${event.title}`;
        const { error: notifError } = await supabase.from('notifications').upsert(
          hostIds.map((id) => ({
            recipient_id: id,
            notif_group: 'event_activity',
            type: 'item_claimed',
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
          body: { user_ids: hostIds, title, body, data: { eventId: event.id, type: 'item_claimed' } },
        });
        if (pushError) console.error('Push failed:', pushError);
      }
    }

    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ error: 'server' }, 500);
  }
});
