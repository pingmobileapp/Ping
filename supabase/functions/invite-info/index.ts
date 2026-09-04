import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Called from docs/invite.html — a fully public, unauthenticated page
// (the person receiving the text has no Supabase session). Deliberately
// returns only what's needed to show a single event: never the guest
// list, never other invitees' info.
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
      .select('rsvp_status, events(title, location, event_date, host_id, image_url)')
      .eq('id', inviteeId)
      .maybeSingle();

    if (error || !invitee || !invitee.events) {
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

    return new Response(
      JSON.stringify({
        eventTitle: event.title,
        location: event.location,
        eventDate: event.event_date,
        hostName,
        rsvpStatus: invitee.rsvp_status,
        imageUrl: event.image_url || null,
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
