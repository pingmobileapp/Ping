import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// A dedicated companion to refresh-activities and refresh-activities-
// utahagenda, this time for allevents.in - unlike utahagenda.com (one
// statewide set of pages), allevents.in is organized per-city
// (allevents.in/{city-slug}-us/all), so this hands Claude the specific
// nearby-city pages directly rather than one shared set. Kept as its own
// function/cron job for the same reason as the utahagenda one: combining
// a broad search pass with several full-page fetches in one request blew
// past Supabase Edge Functions' 150s idle timeout - bounded, single-
// purpose passes each comfortably fit where one combined pass didn't.
// Writes into the same public.activities table under its own
// source='ai_search_allevents' so this function's delete-and-replace
// each run never touches the other two passes' own rows.

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
  source: 'ai_search_allevents';
  external_id: null;
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
  confidence: 'low';
  distance_miles: number | null;
};

const DAYS_AHEAD = 30;
const RADIUS_MILES = 25;
const RADIUS_SLACK_MILES = 5;

// Nearby-city landing pages, closest to the anchor (Alpine, UT) first -
// one fetch per city, no slack for Claude to go chasing extra links, so
// total runtime stays predictable. Picked to actually cover a 25mi
// radius: the small towns directly adjacent to Alpine, plus the larger
// cities further out that draw more events.
const ALLEVENTS_URLS = [
  'https://allevents.in/lehi-us/all',
  'https://allevents.in/american-fork-us/all',
  'https://allevents.in/highland-us/all',
  'https://allevents.in/pleasant-grove-us/all',
  'https://allevents.in/orem-us/all',
  'https://allevents.in/provo-us/all',
  'https://allevents.in/draper-us/all',
  'https://allevents.in/sandy-us/all',
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

// Only cache misses ever hit Nominatim itself, so this only throttles
// genuinely new locations. Shares the geocode_cache table with the other
// two functions (separate module-level rate-limit clock per isolate).
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
          url: { type: 'string', description: 'The real allevents.in URL for this specific activity.' },
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

// Returns null on genuine failure - see refresh-activities' matching
// function for why that distinction (vs. a real empty array) matters.
async function fetchAllEventsActivities(
  anchorLabel: string,
  debug: Record<string, unknown>
): Promise<ActivityRow[] | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set - skipping allevents pass');
    debug.allevents = 'no_api_key';
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
        max_tokens: 16000,
        system:
          `You fetch and read specific allevents.in city event-listing pages to find real, currently-scheduled ` +
          `activities near ${anchorLabel}, within about ${RADIUS_MILES} miles, happening between ${isoToday} and ` +
          `${isoEnd}. Each page is already scoped to one nearby city, so most of what's on it is relevant - just ` +
          `skip anything whose venue is clearly not actually near ${anchorLabel} despite being listed there. Only ` +
          `fetch the pages you were given - don't follow additional links. Only include something with a real ` +
          `date you actually read on the page - never guess or invent a date, time, price, or URL. Once you've ` +
          `fetched all the pages and have a good list, call record_activities with everything you found - that ` +
          `call is mandatory, do not end your turn with only a text response. If a page has nothing relevant, ` +
          `that's fine - call record_activities with an empty list rather than padding it with anything uncertain.`,
        tools: [
          { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 8, max_content_tokens: 8000 },
          { name: 'record_activities', description: 'Record the activities found on allevents.in.', input_schema: AI_SEARCH_SCHEMA },
        ],
        messages: [
          {
            role: 'user',
            content: `Fetch and read these allevents.in pages, and find activities near ${anchorLabel}:\n${ALLEVENTS_URLS.join('\n')}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Anthropic API error:', response.status, detail);
      debug.allevents = { status: response.status, detail };
      return null;
    }

    const result = await response.json();
    const toolUse = (result.content || []).find(
      (block: any) => block.type === 'tool_use' && block.name === 'record_activities'
    );
    const rawActivities = toolUse?.input?.activities;
    if (!Array.isArray(rawActivities)) {
      console.error('No record_activities call in allevents response - stop_reason:', result.stop_reason);
      debug.allevents = {
        stop_reason: result.stop_reason,
        content_types: (result.content || []).map((b: any) => b.type),
      };
      return null;
    }
    debug.allevents = { rawCount: rawActivities.length };

    return rawActivities
      // start_time required, not defaulted to midnight - see the matching
      // fix in refresh-activities-utahagenda for the live duplicate bug
      // this caused.
      .filter((a: any) => a?.title && a?.date && a?.start_time && a?.url && CATEGORIES.includes(a.category))
      .map((a: any): ActivityRow => {
        const startsAt = zonedDateTimeToUtcIso(a.date, a.start_time, ANCHOR_TIMEZONE);
        const endsAt = a.end_time ? zonedDateTimeToUtcIso(a.date, a.end_time, ANCHOR_TIMEZONE) : null;
        return {
          source: 'ai_search_allevents',
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
    console.error('allevents pass failed:', err);
    debug.allevents = { exception: String(err) };
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
      // No/invalid JSON body (e.g. the cron job posts an empty body).
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

    const rawActivities = await fetchAllEventsActivities(label, debug);
    const activities = rawActivities !== null ? await verifyDistances(admin, rawActivities, lat, lng) : null;

    // Housekeeping: drop anything already over, regardless of source -
    // harmless to run in every one of these functions.
    await admin.from('activities').delete().lt('starts_at', new Date().toISOString());

    const errors: string[] = [];

    if (activities !== null) {
      await admin.from('activities').delete().eq('source', 'ai_search_allevents');
      if (activities.length > 0) {
        const { error } = await admin.from('activities').insert(activities);
        if (error) errors.push(`allevents insert: ${error.message}`);
      }
    } else {
      errors.push('allevents fetch failed - left existing ai_search_allevents rows untouched');
    }

    return new Response(
      JSON.stringify({
        count: activities === null ? 'failed (left untouched)' : activities.length,
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
