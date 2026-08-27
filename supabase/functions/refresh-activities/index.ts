import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Backs the Discover feature (see app/(tabs)/explore.tsx and the Open
// Slots roadmap) - a scheduled job (see supabase/activities_cron.sql) that
// refreshes public.activities so the app only ever does a plain SELECT,
// never calling an external API or AI itself. Two passes:
//   1. AI web search (Claude) for the long tail no ticketing API covers
//      well - farmers markets, carnivals, community events. Always runs;
//      ANTHROPIC_API_KEY is already configured.
//   2. Ticketmaster/SeatGeek for the mainstream/ticketed side. Each is
//      skipped entirely (not an error) if its own API key secret isn't
//      set yet - both slot in automatically the moment those secrets
//      exist, with no code change needed.
// Anchored on a fixed location for now (DISCOVER_ANCHOR_LAT/LNG/LABEL)
// since there's no real per-user device location yet - see the Open
// Slots roadmap for when that gets added.

const CATEGORIES = [
  'movies',
  'music',
  'dance',
  'carnival',
  'farmers_market',
  'family',
  'sports',
  'community',
] as const;

type Category = (typeof CATEGORIES)[number];

type ActivityRow = {
  source: 'ai_search' | 'ticketmaster' | 'seatgeek';
  external_id: string | null;
  title: string;
  category: Category;
  description: string | null;
  location: string | null;
  lat: number | null;
  lng: number | null;
  starts_at: string;
  ends_at: string | null;
  price_label: string | null;
  url: string | null;
  confidence: 'high' | 'low';
  // Real, computed distance from the anchor - null only means "couldn't be
  // verified" (geocoding found no match), never "trust me, it's close." See
  // verifyDistances below, which is what actually fills this in.
  distance_miles: number | null;
};

const DAYS_AHEAD = 30;
const RADIUS_MILES = 25;
// How much slack to give a verified distance before dropping a result -
// catches things that are clearly not nearby without nitpicking a result
// that's a mile or two over due to geocoding imprecision or a slightly
// generous read of "within 25 miles" in the search prompt.
const RADIUS_SLACK_MILES = 5;

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Only cache misses ever hit Nominatim itself, so this only throttles
// genuinely new locations - a venue that recurs night after night gets
// geocoded once, ever.
let lastGeocodeCallAt = 0;

async function geocodeLocation(
  admin: ReturnType<typeof createClient>,
  locationText: string
): Promise<{ lat: number; lng: number } | null> {
  const key = locationText.trim().toLowerCase();
  if (!key) return null;

  const { data: cached } = await admin
    .from('geocode_cache')
    .select('lat, lng')
    .eq('location_text', key)
    .maybeSingle();
  if (cached) {
    return cached.lat !== null && cached.lng !== null ? { lat: cached.lat, lng: cached.lng } : null;
  }

  // Nominatim's public-instance usage policy asks for roughly 1
  // request/second from a single client.
  const elapsed = Date.now() - lastGeocodeCallAt;
  if (elapsed < 1100) await new Promise((r) => setTimeout(r, 1100 - elapsed));
  lastGeocodeCallAt = Date.now();

  try {
    const url =
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(locationText)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'PingApp-Discover/1.0' } });
    if (!res.ok) {
      await admin.from('geocode_cache').insert({ location_text: key, lat: null, lng: null });
      return null;
    }
    const results = await res.json();
    const first = Array.isArray(results) ? results[0] : null;
    const lat = first ? Number(first.lat) : null;
    const lng = first ? Number(first.lon) : null;
    const resolved = lat !== null && lng !== null && !Number.isNaN(lat) && !Number.isNaN(lng);
    await admin.from('geocode_cache').upsert({ location_text: key, lat: resolved ? lat : null, lng: resolved ? lng : null });
    return resolved ? { lat: lat as number, lng: lng as number } : null;
  } catch (err) {
    console.error('Geocoding failed for', locationText, err);
    return null;
  }
}

// The real verification step: geocodes anything without known coordinates
// (Ticketmaster/SeatGeek usually already have them from their own API),
// computes an actual haversine distance from the anchor, and drops
// anything that's confirmed to be further than RADIUS_MILES +
// RADIUS_SLACK_MILES away - rather than trusting the search prompt's
// "within 25 miles" or the model's own sense of what's nearby. A result
// that couldn't be geocoded at all is kept (not punished for a geocoding
// miss) with distance_miles left null.
async function verifyDistances(
  admin: ReturnType<typeof createClient>,
  rows: ActivityRow[],
  anchorLat: number,
  anchorLng: number
): Promise<ActivityRow[]> {
  const verified: ActivityRow[] = [];
  for (const row of rows) {
    let { lat, lng } = row;
    if ((lat === null || lng === null) && row.location) {
      const geo = await geocodeLocation(admin, row.location);
      if (geo) {
        lat = geo.lat;
        lng = geo.lng;
      }
    }

    if (lat !== null && lng !== null) {
      const distance = haversineMiles(anchorLat, anchorLng, lat, lng);
      if (distance > RADIUS_MILES + RADIUS_SLACK_MILES) continue;
      verified.push({ ...row, lat, lng, distance_miles: Math.round(distance * 10) / 10 });
    } else {
      verified.push({ ...row, distance_miles: null });
    }
  }
  return verified;
}

const AI_SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    activities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES as unknown as string[] },
          date: { type: 'string', description: 'ISO yyyy-mm-dd, the date this specific occurrence happens.' },
          start_time: { type: ['string', 'null'], description: '24-hour HH:mm local time, null if all-day/unclear.' },
          end_time: { type: ['string', 'null'] },
          location: { type: 'string', description: 'Venue name and/or city.' },
          price_label: { type: 'string', description: 'e.g. "Free", "$10", "$8+". "Unknown" if truly not stated.' },
          url: { type: 'string', description: 'A real URL from your search results for this specific activity.' },
          description: { type: ['string', 'null'], description: 'One short sentence, or null.' },
        },
        required: ['title', 'category', 'date', 'start_time', 'end_time', 'location', 'price_label', 'url', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['activities'],
  additionalProperties: false,
};

// Returns null on a genuine failure (bad API response, or the model never
// actually called record_activities) - as opposed to a real empty array,
// which means the call succeeded and legitimately found nothing. The
// caller (see serve() below) only replaces last run's ai_search rows on
// success - null leaves them untouched, so a transient API failure or a
// truncated response doesn't wipe out real data with nothing.
async function fetchAiSearchActivities(
  anchorLabel: string,
  debug: Record<string, unknown>
): Promise<ActivityRow[] | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set - skipping AI search pass');
    debug.ai_search = 'no_api_key';
    return null;
  }

  try {
    const today = new Date();
    const isoToday = today.toISOString().slice(0, 10);
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + DAYS_AHEAD);
    const isoEnd = endDate.toISOString().slice(0, 10);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        // Each web search round (server_tool_use + web_search_tool_result +
        // the model's own reasoning between rounds) burns real tokens before
        // any of it becomes the final record_activities call - 4096 was
        // exhausted mid-search, hitting max_tokens with no tool call at all.
        // Raised further alongside DAYS_AHEAD/max_uses below, since covering
        // a full month means more search rounds and a longer result list.
        max_tokens: 24000,
        system:
          `Search the web to find real, currently-scheduled local activities and events near ${anchorLabel}, ` +
          `within about ${RADIUS_MILES} miles, happening between ${isoToday} and ${isoEnd} - that's a full month, ` +
          `not just the next few days, so search specifically for later weeks too (e.g. "events near ${anchorLabel} ` +
          `next month", "[month name] calendar of events") rather than stopping once you have enough for the first ` +
          `week or two. If something recurs on a regular schedule (a weekly farmers market, a recurring story time), ` +
          `include several of its upcoming occurrences spread across the window as separate dated entries, not just ` +
          `the next one. Prioritize the kinds of things a general ticketing platform search tends to miss: farmers ` +
          `markets, carnivals/fairs, community events, dances, family activities, library/park-district events - but ` +
          `include anything else worth knowing about too. Only include something if you found it via an actual ` +
          `search result with a real date - never guess or invent a date, time, price, or URL. Every result must ` +
          `carry the real URL of the page you actually found it on, so someone can click through and verify the ` +
          `details themselves - never fabricate or guess at a URL. If you're not confident something is real and ` +
          `currently scheduled, leave it out rather than include it. Aim for up to 40 results, spread across the ` +
          `whole month rather than clustered in the first few days. Once you've searched enough to have a good ` +
          `list covering the full window, call record_activities with everything you found - that call is ` +
          `mandatory, do not end your turn with only a text response.`,
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 10 },
          { name: 'record_activities', description: 'Record the activities found via web search.', input_schema: AI_SEARCH_SCHEMA },
        ],
        messages: [
          { role: 'user', content: `Find local activities and events near ${anchorLabel} for the next ${DAYS_AHEAD} days.` },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Anthropic API error:', response.status, detail);
      debug.ai_search = { status: response.status, detail };
      return null;
    }

    const result = await response.json();
    const toolUse = (result.content || []).find(
      (block: any) => block.type === 'tool_use' && block.name === 'record_activities'
    );
    const rawActivities = toolUse?.input?.activities;
    if (!Array.isArray(rawActivities)) {
      console.error('No record_activities call in AI search response - stop_reason:', result.stop_reason);
      debug.ai_search = {
        stop_reason: result.stop_reason,
        content_types: (result.content || []).map((b: any) => b.type),
        text: (result.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' '),
      };
      return null;
    }
    debug.ai_search = { rawCount: rawActivities.length };

    // A url is what makes a result verifiable - if the model didn't give
    // one (even though the schema requires it), drop the row rather than
    // show something no one can double-check.
    return rawActivities
      .filter((a: any) => a?.title && a?.date && a?.url && CATEGORIES.includes(a.category))
      .map((a: any): ActivityRow => {
        const startsAt = a.start_time ? `${a.date}T${a.start_time}:00` : `${a.date}T00:00:00`;
        const endsAt = a.end_time ? `${a.date}T${a.end_time}:00` : null;
        return {
          source: 'ai_search',
          external_id: null,
          title: a.title,
          category: a.category,
          description: a.description || null,
          location: a.location || null,
          lat: null,
          lng: null,
          starts_at: startsAt,
          ends_at: endsAt,
          price_label: a.price_label || null,
          url: a.url,
          confidence: 'low',
          distance_miles: null,
        };
      });
  } catch (err) {
    console.error('AI search pass failed:', err);
    debug.ai_search = { exception: String(err) };
    return null;
  }
}

// Ticketmaster's own segment/genre taxonomy mapped onto ours - anything
// unrecognized falls into 'community' rather than being dropped, since
// that's the closest "miscellaneous local thing" bucket the app has.
const mapTicketmasterCategory = (segment: string | undefined, genre: string | undefined): Category => {
  const s = (segment || '').toLowerCase();
  const g = (genre || '').toLowerCase();
  if (s.includes('film')) return 'movies';
  if (s.includes('sports')) return 'sports';
  if (s.includes('music')) return g.includes('dance') ? 'dance' : 'music';
  if (g.includes('dance')) return 'dance';
  if (g.includes('fair') || g.includes('festival')) return 'carnival';
  if (s.includes('family')) return 'family';
  return 'community';
};

async function fetchTicketmasterActivities(lat: number, lng: number): Promise<ActivityRow[]> {
  const apiKey = Deno.env.get('TICKETMASTER_API_KEY');
  if (!apiKey) return [];

  const startDateTime = new Date().toISOString().slice(0, 19) + 'Z';
  const end = new Date();
  end.setDate(end.getDate() + DAYS_AHEAD);
  const endDateTime = end.toISOString().slice(0, 19) + 'Z';

  const url =
    `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${apiKey}` +
    `&latlong=${lat},${lng}&radius=${RADIUS_MILES}&unit=miles` +
    `&startDateTime=${startDateTime}&endDateTime=${endDateTime}&sort=date,asc&size=50`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error('Ticketmaster API error:', res.status, await res.text());
      return [];
    }
    const data = await res.json();
    const events = data?._embedded?.events || [];
    return events.map((e: any): ActivityRow => {
      const venue = e._embedded?.venues?.[0];
      const classification = e.classifications?.[0];
      const priceRange = e.priceRanges?.[0];
      return {
        source: 'ticketmaster',
        external_id: e.id,
        title: e.name,
        category: mapTicketmasterCategory(classification?.segment?.name, classification?.genre?.name),
        description: null,
        location: venue?.name || null,
        lat: venue?.location?.latitude ? Number(venue.location.latitude) : null,
        lng: venue?.location?.longitude ? Number(venue.location.longitude) : null,
        starts_at: e.dates?.start?.dateTime || `${e.dates?.start?.localDate}T00:00:00`,
        ends_at: null,
        price_label: priceRange ? `$${priceRange.min}${priceRange.max !== priceRange.min ? `-$${priceRange.max}` : ''}` : 'See listing',
        url: e.url || null,
        confidence: 'high',
        distance_miles: null,
      };
    });
  } catch (err) {
    console.error('Ticketmaster fetch failed:', err);
    return [];
  }
}

async function fetchSeatGeekActivities(lat: number, lng: number): Promise<ActivityRow[]> {
  const clientId = Deno.env.get('SEATGEEK_CLIENT_ID');
  if (!clientId) return [];

  const url =
    `https://api.seatgeek.com/2/events?client_id=${clientId}` +
    `&lat=${lat}&lon=${lng}&range=${RADIUS_MILES}mi&per_page=50&sort=datetime_local.asc`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error('SeatGeek API error:', res.status, await res.text());
      return [];
    }
    const data = await res.json();
    const events = data?.events || [];
    return events.map((e: any): ActivityRow => ({
      source: 'seatgeek',
      external_id: String(e.id),
      title: e.title,
      category: e.type === 'movie' ? 'movies' : e.type?.includes('sports') || e.type === 'baseball' || e.type === 'basketball' ? 'sports' : e.type === 'concert' ? 'music' : 'community',
      description: null,
      location: e.venue?.name || null,
      lat: e.venue?.location?.lat ?? null,
      lng: e.venue?.location?.lon ?? null,
      starts_at: e.datetime_local,
      ends_at: null,
      price_label: e.stats?.lowest_price ? `$${e.stats.lowest_price}+` : 'See listing',
      url: e.url || null,
      confidence: 'high',
      distance_miles: null,
    }));
  } catch (err) {
    console.error('SeatGeek fetch failed:', err);
    return [];
  }
}

serve(async (req) => {
  try {
    let debugRequested = false;
    try {
      const body = await req.json();
      debugRequested = !!body?.debug;
    } catch {
      // No/invalid JSON body (e.g. the cron job posts an empty body) - not
      // an error, debug just stays off.
    }
    const debug: Record<string, unknown> = {};

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'not configured' }), { status: 500 });
    }
    const admin = createClient(supabaseUrl, serviceRoleKey);

    const lat = Number(Deno.env.get('DISCOVER_ANCHOR_LAT') ?? '0');
    const lng = Number(Deno.env.get('DISCOVER_ANCHOR_LNG') ?? '0');
    const label = Deno.env.get('DISCOVER_ANCHOR_LABEL') ?? 'the area';

    const [rawAiActivities, rawTicketmasterActivities, rawSeatgeekActivities] = await Promise.all([
      fetchAiSearchActivities(label, debug),
      fetchTicketmasterActivities(lat, lng),
      fetchSeatGeekActivities(lat, lng),
    ]);

    // The real verification pass - geocodes anything without known
    // coordinates and drops whatever's confirmed to be outside the radius,
    // rather than trusting the search prompt's "within 25 miles" or
    // Ticketmaster/SeatGeek's own radius search unverified. Sequential
    // (not part of the Promise.all above) since geocoding is rate-limited.
    const aiActivities = rawAiActivities !== null ? await verifyDistances(admin, rawAiActivities, lat, lng) : null;
    const ticketmasterActivities = await verifyDistances(admin, rawTicketmasterActivities, lat, lng);
    const seatgeekActivities = await verifyDistances(admin, rawSeatgeekActivities, lat, lng);

    // Housekeeping: drop anything already over, regardless of source.
    await admin.from('activities').delete().lt('starts_at', new Date().toISOString());

    const errors: string[] = [];

    // aiActivities is null on a genuine failure (bad API response, or the
    // model never called record_activities) - only replace last run's
    // ai_search rows when this run actually succeeded, even if it found
    // zero results. Otherwise a single bad night (an Anthropic API hiccup,
    // a truncated response) would wipe out real data and leave nothing in
    // its place until the next successful run.
    if (aiActivities !== null) {
      // AI-search rows have no stable id across runs (see ActivityRow) -
      // fully replaced each time rather than upserted.
      await admin.from('activities').delete().eq('source', 'ai_search');
      if (aiActivities.length > 0) {
        const { error } = await admin.from('activities').insert(aiActivities);
        if (error) errors.push(`ai_search insert: ${error.message}`);
      }
    } else {
      errors.push('ai_search fetch failed - left existing ai_search rows untouched');
    }

    const upsertBatch = [...ticketmasterActivities, ...seatgeekActivities];
    if (upsertBatch.length > 0) {
      const { error } = await admin.from('activities').upsert(upsertBatch, { onConflict: 'source,external_id' });
      if (error) errors.push(`ticketmaster/seatgeek upsert: ${error.message}`);
    }

    return new Response(
      JSON.stringify({
        counts: {
          ai_search: aiActivities === null ? 'failed (left untouched)' : aiActivities.length,
          ticketmaster: ticketmasterActivities.length,
          seatgeek: seatgeekActivities.length,
        },
        errors,
        ...(debugRequested ? { debug } : {}),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
