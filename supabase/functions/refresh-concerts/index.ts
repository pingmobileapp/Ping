import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Companion to refresh-college-sports/refresh-pro-sports, same
// architecture and same reason for AI web search over direct site
// fetching (venue calendars are commonly JS-rendered or split across
// whichever ticketing platform - Ticketmaster, AXS, the venue's own site -
// happens to host that show, with no one consistent page to hardcode).
// Covers upcoming shows at a fixed list of well-known Utah concert venues.
// Writes into the same activities table under its own
// source='ai_search_concerts', always category='music'.

const ANCHOR_TIMEZONE = Deno.env.get('DISCOVER_ANCHOR_TIMEZONE') || 'America/Denver';

function zonedDateTimeToUtcIso(dateStr: string, timeStr: string, timeZone: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guessUtcMs = Date.UTC(y, m - 1, d, hh, mm);

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(guessUtcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get('hour') % 24;
  const asIfLocalMs = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'));

  const offsetMs = guessUtcMs - asIfLocalMs;
  return new Date(guessUtcMs + offsetMs).toISOString();
}

type ActivityRow = {
  source: 'ai_search_concerts';
  external_id: null;
  title: string;
  category: 'music';
  description: string | null;
  location: string | null;
  lat: number | null;
  lng: number | null;
  starts_at: string;
  ends_at: string | null;
  price_label: string | null;
  url: string | null;
  confidence: 'low';
  distance_miles: number | null;
};

const DAYS_AHEAD = 30;
const RADIUS_MILES = 25;
const RADIUS_SLACK_MILES = 15;

const VENUES: { name: string; city: string }[] = [
  { name: 'USANA Amphitheatre', city: 'West Valley City, UT' },
  { name: 'Maverik Center', city: 'West Valley City, UT' },
  { name: 'Delta Center', city: 'Salt Lake City, UT' },
  { name: 'The Union Event Center', city: 'Salt Lake City, UT' },
  { name: 'The Complex', city: 'Salt Lake City, UT' },
  { name: 'The Depot', city: 'Salt Lake City, UT' },
  { name: 'Kilby Court', city: 'Salt Lake City, UT' },
  { name: 'Red Butte Garden Outdoor Concert Series', city: 'Salt Lake City, UT' },
  { name: 'Velour Live Music Gallery', city: 'Provo, UT' },
  { name: 'The State Room', city: 'Salt Lake City, UT' },
  { name: "Peery's Egyptian Theater", city: 'Ogden, UT' },
];

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

const CONCERTS_SCHEMA = {
  type: 'object',
  properties: {
    shows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The performing artist/act name, e.g. "Noah Kahan".' },
          venue: { type: 'string', description: 'Which of the given venues this show is at, verbatim.' },
          date: { type: 'string', description: 'ISO yyyy-mm-dd, local to Utah.' },
          start_time: { type: ['string', 'null'], description: '24-hour HH:mm local time (doors or show time), null only if truly unstated.' },
          price_label: { type: 'string', description: 'e.g. "Tickets from $30", "See ticket site" if prices vary/unclear.' },
          url: { type: 'string', description: 'A real URL from your search results - the venue\'s own site or its ticketing page.' },
          description: { type: ['string', 'null'], description: 'One short sentence - genre or what kind of show it is, if known.' },
        },
        required: ['title', 'venue', 'date', 'start_time', 'price_label', 'url', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['shows'],
  additionalProperties: false,
};

async function fetchConcertActivities(
  anchorLabel: string,
  debug: Record<string, unknown>
): Promise<ActivityRow[] | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set - skipping concerts pass');
    debug.concerts = 'no_api_key';
    return null;
  }

  try {
    const today = new Date();
    const isoToday = today.toISOString().slice(0, 10);
    const isoEnd = new Date(today.getTime() + DAYS_AHEAD * 24 * 60 * 60000).toISOString().slice(0, 10);

    const venuesText = VENUES.map((v) => `${v.name} (${v.city})`).join('; ');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 32000,
        system:
          `Find upcoming shows/concerts between ${isoToday} and ${isoEnd} at these specific Utah venues: ` +
          `${venuesText}. For each venue, search for its own upcoming events page or ticketing listing (the ` +
          `venue's own site, or whichever ticketing platform - Ticketmaster, AXS, etc. - hosts its calendar). ` +
          `Only include a show you found a real, dated search result for - never guess an artist or date. Skip a ` +
          `venue entirely if you can't confirm anything in range for it rather than inventing something. You ` +
          `won't necessarily find every show at every venue within your search budget - prioritize confirming ` +
          `real shows over covering everything. The "venue" field on each result must be one of the exact venue ` +
          `names given above. Once you've searched what you can, call record_shows with everything you found - ` +
          `that call is mandatory, do not end your turn with only a text response. If you found nothing ` +
          `confirmed, call it with an empty list rather than padding it with anything uncertain.`,
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 20 },
          { name: 'record_shows', description: 'Record the shows found.', input_schema: CONCERTS_SCHEMA },
        ],
        messages: [
          {
            role: 'user',
            content: `Find upcoming concerts/shows at these specific Utah venues near ${anchorLabel}.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Anthropic API error:', response.status, detail);
      debug.concerts = { status: response.status, detail };
      return null;
    }

    const result = await response.json();
    const toolUse = (result.content || []).find(
      (block: any) => block.type === 'tool_use' && block.name === 'record_shows'
    );
    const rawShows = toolUse?.input?.shows;
    if (!Array.isArray(rawShows)) {
      console.error('No record_shows call in concerts response - stop_reason:', result.stop_reason);
      debug.concerts = {
        stop_reason: result.stop_reason,
        content_types: (result.content || []).map((b: any) => b.type),
      };
      return null;
    }
    debug.concerts = { rawCount: rawShows.length };

    return rawShows
      .filter((s: any) => s?.title && s?.venue && s?.date && s?.url)
      .map((s: any): ActivityRow => {
        const venueMatch = VENUES.find((v) => v.name === s.venue);
        const location = venueMatch ? `${venueMatch.name}, ${venueMatch.city}` : s.venue;
        const startsAt = zonedDateTimeToUtcIso(s.date, s.start_time || '19:00', ANCHOR_TIMEZONE);
        return {
          source: 'ai_search_concerts',
          external_id: null,
          title: s.title,
          category: 'music',
          description: s.description || null,
          location,
          lat: null,
          lng: null,
          starts_at: startsAt,
          ends_at: null,
          price_label: s.price_label || null,
          url: s.url,
          confidence: 'low',
          distance_miles: null,
        };
      })
      // Seen live: the model returned a show dated before "today" despite
      // the prompt's explicit date range - a plain instruction isn't
      // enough to rely on alone, this is the actual enforcement.
      .filter((row) => new Date(row.starts_at).getTime() >= Date.now());
  } catch (err) {
    console.error('concerts pass failed:', err);
    debug.concerts = { exception: String(err) };
    return null;
  }
}

serve(async (req) => {
  try {
    let debugRequested = false;
    try {
      const body = await req.json();
      debugRequested = !!body?.debug;
    } catch {
      // No/invalid JSON body.
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

    const rawShows = await fetchConcertActivities(label, debug);
    const shows = rawShows !== null ? await verifyDistances(admin, rawShows, lat, lng) : null;

    if (shows !== null) {
      await admin.from('activities').delete().eq('source', 'ai_search_concerts');
      if (shows.length > 0) {
        const { error } = await admin.from('activities').insert(shows);
        if (error) throw new Error(`insert failed: ${error.message}`);
      }
    }

    const errors: string[] = [];
    if (shows === null) errors.push('concerts fetch failed - left existing ai_search_concerts rows untouched');

    return new Response(
      JSON.stringify({
        count: shows === null ? 'failed (left untouched)' : shows.length,
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
