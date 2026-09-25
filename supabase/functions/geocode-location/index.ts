import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { geocodeLocation } from '../_shared/geocode.ts';

// Lets the app resolve a Ping's free-text location (e.g. "Creekside Park",
// "123 Main St, Provo, UT") to real coordinates for per-event weather (see
// lib/eventWeather.ts) - called directly from the client, unlike Nominatim
// itself, which asks that bulk/repeated lookups be server-side and cached
// rather than hit directly from many end-user devices. Reuses the exact
// same geocode_cache table and lookup logic refresh-activities already
// uses for Discover activities, so a location that's been resolved once
// (from either feature) never needs a fresh Nominatim call again. A
// location that fails to geocode - "Living Room", "Mom and Dad's house" -
// is cached as a permanent miss too, which is what lets the app fall back
// to general-area weather for it without hammering Nominatim every time.

serve(async (req) => {
  try {
    const { location } = await req.json();
    if (!location || typeof location !== 'string') {
      return new Response(JSON.stringify({ error: 'location required' }), { status: 400 });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY');
      return new Response(JSON.stringify({ error: 'not configured' }), { status: 500 });
    }
    const admin = createClient(supabaseUrl, serviceRoleKey);

    const coords = await geocodeLocation(admin, location, 'PingApp-EventWeather/1.0');
    return new Response(JSON.stringify(coords ?? { lat: null, lng: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
