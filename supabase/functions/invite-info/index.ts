import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Called from docs/invite.html — a fully public, unauthenticated page
// (the person receiving the text has no Supabase session). Deliberately
// returns only what's needed to show a single event: never the guest
// list, never other invitees' info. Counts and the What to bring list are
// fine (2026-10-25): the list says what's coming, never who's bringing it,
// except this invitee's own entries.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const inviteeId = url.searchParams.get('i');

    if (!inviteeId) {
      return new Response(JSON.stringify({ error: 'Missing invitee id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: invitee, error } = await supabase
      .from('invitees')
      .select('id, event_id, rsvp_status, events(title, description, location, event_date, end_date, is_all_day, host_id, image_url, stops, status, price_cents, capacity, accepted_count)')
      .eq('id', inviteeId)
      .maybeSingle();

    if (error || !invitee || !invitee.events || (invitee.events as any).status !== 'sent') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const event = invitee.events as any;
    let hostName = 'Someone';
    if (event.host_id) {
      const { data: host } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', event.host_id)
        .maybeSingle();
      hostName = host?.full_name || hostName;
    }

    const countStatus = async (status: string) => {
      const { count } = await supabase
        .from('invitees')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', invitee.event_id)
        .eq('rsvp_status', status);
      return count ?? 0;
    };
    const [goingCount, maybeCount] = await Promise.all([countStatus('accepted'), countStatus('interested')]);

    const { data: itemRows } = await supabase
      .from('items')
      .select('id, name, quantity_needed, allow_custom, created_at, item_claims(id, invitee_id, quantity, note)')
      .eq('event_id', invitee.event_id)
      .order('created_at', { ascending: true });
    const items = (itemRows || []).map((item: any) => {
      const claims = item.item_claims || [];
      const mine = claims.filter((c: any) => c.invitee_id === invitee.id);
      return {
        id: item.id,
        name: item.name,
        allowCustom: !!item.allow_custom,
        needed: item.quantity_needed,
        covered: claims.reduce((sum: number, c: any) => sum + (c.quantity || 0), 0),
        mine: mine.reduce((sum: number, c: any) => sum + (c.quantity || 0), 0),
        // Write-in lists: what everyone's bringing (text only), flagging
        // this invitee's own so the page can offer Remove.
        entries: item.allow_custom
          ? claims
              .filter((c: any) => c.note)
              .map((c: any) => ({ id: c.id, note: c.note, mine: c.invitee_id === invitee.id }))
          : [],
      };
    });

    return new Response(
      JSON.stringify({
        eventTitle: event.title,
        description: event.description || null,
        goingCount,
        maybeCount,
        items,
        location: event.location,
        eventDate: event.event_date,
        endDate: event.end_date || null,
        isAllDay: !!event.is_all_day,
        // A multi-day Ping's itinerary (see lib/stops.ts) - just what the
        // page shows, not the app's internal stop ids.
        stops: Array.isArray(event.stops)
          ? event.stops
              .filter((s: any) => s && typeof s.day === 'string')
              .map((s: any) => ({ day: s.day, name: s.name || '', address: s.address || '' }))
          : [],
        hostName,
        rsvpStatus: invitee.rsvp_status,
        imageUrl: event.image_url || null,
        // For the page's RSVP buttons (see invite-rsvp): a priced event is
        // paid for in the app, a full one can't take another "going", and
        // a day after it ends nobody needs to answer anymore.
        isPaid: !!(event.price_cents && event.price_cents > 0),
        isFull:
          event.capacity != null && (event.accepted_count ?? 0) >= event.capacity && invitee.rsvp_status !== 'accepted',
        isPast: new Date(event.end_date || event.event_date).getTime() < Date.now() - 24 * 60 * 60 * 1000,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
