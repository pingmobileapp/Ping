import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// A dedicated companion to refresh-activities, specifically for
// utahagenda.com - it catalogs a lot of local activities (fairs,
// festivals, free "movies in the park" nights, city-by-city calendars)
// more thoroughly than a general web search tends to surface. Kept as its
// own function/cron job rather than folded into refresh-activities' single
// Anthropic call because combining a broad monthly web_search pass with
// several full-page web_fetch reads in one request blew past Supabase Edge
// Functions' 150s idle timeout (seen live as an IDLE_TIMEOUT error) - two
// bounded passes each comfortably fit where one combined pass didn't.
// Writes into the same public.activities table, under its own
// source='ai_search_utahagenda' so this function's delete-and-replace each
// run never touches refresh-activities' own 'ai_search' rows.

// The AI reports times as read on the source page - local wall-clock time
// in whatever zone the anchor location is in, not UTC. Building a
// timestamp string with no zone/offset and handing it to Postgres gets
// silently interpreted as UTC, which is wrong by a fixed 6-7 hour
// (DST-dependent) margin. zonedDateTimeToUtcIso below does a real,
// DST-aware conversion via Intl's own timezone database instead of a
// naive string - shared logic with refresh-activities' own copy.
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
  source: 'ai_search_utahagenda';
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

// The specific utahagenda.com pages worth reading in full - web_fetch can
// only fetch a URL that's explicitly present in the conversation (a
// security restriction on the tool), so these are handed to Claude
// directly rather than left for it to discover via search.
const UTAHAGENDA_URLS = [
  'https://utahagenda.com/utah-movies-in-the-park/',
  'https://utahagenda.com/todays-utah-events/',
  'https://utahagenda.com/best-utah-city-events/',
  'https://utahagenda.com/best-of-utah/',
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
// genuinely new locations - a venue that recurs night after night gets
// geocoded once, ever. Shares the geocode_cache table with
// refresh-activities (separate module-level rate-limit clock, since these
// are two separate function deployments/isolates).
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
          url: { type: 'string', description: 'The real utahagenda.com URL (or a further link on that page) for this specific activity.' },
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
async function fetchUtahAgendaActivities(
  anchorLabel: string,
  debug: Record<string, unknown>
): Promise<ActivityRow[] | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set - skipping utahagenda pass');
    debug.utahagenda = 'no_api_key';
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
          `You fetch and read specific pages on utahagenda.com to find real, currently-scheduled activities and ` +
          `events near ${anchorLabel}, within about ${RADIUS_MILES} miles, happening between ${isoToday} and ` +
          `${isoEnd}. These pages cover the whole state, so only keep what's actually near ${anchorLabel} - skip ` +
          `anything for a clearly distant city. The "movies in the park" page lists free outdoor movie nights at ` +
          `parks across Utah - pull every showing within range, not just the first one you see, and check whether ` +
          `it recurs (e.g. weekly all summer) so you can list several upcoming dates rather than just one. If a ` +
          `page links to a more specific city or category page that looks relevant, fetch that one too. Only ` +
          `include something with a real date you actually read on the page - never guess or invent a date, time, ` +
          `price, or URL. Once you've fetched what's useful and have a good list, call record_activities with ` +
          `everything you found - that call is mandatory, do not end your turn with only a text response. If a ` +
          `page has nothing relevant, that's fine - call record_activities with an empty list rather than padding ` +
          `it with anything uncertain.`,
        tools: [
          { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 8, max_content_tokens: 8000 },
          { name: 'record_activities', description: 'Record the activities found on utahagenda.com.', input_schema: AI_SEARCH_SCHEMA },
        ],
        messages: [
          {
            role: 'user',
            content: `Fetch and read these utahagenda.com pages, and find activities near ${anchorLabel}:\n${UTAHAGENDA_URLS.join('\n')}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Anthropic API error:', response.status, detail);
      debug.utahagenda = { status: response.status, detail };
      return null;
    }

    const result = await response.json();
    const toolUse = (result.content || []).find(
      (block: any) => block.type === 'tool_use' && block.name === 'record_activities'
    );
    const rawActivities = toolUse?.input?.activities;
    if (!Array.isArray(rawActivities)) {
      console.error('No record_activities call in utahagenda response - stop_reason:', result.stop_reason);
      debug.utahagenda = {
        stop_reason: result.stop_reason,
        content_types: (result.content || []).map((b: any) => b.type),
      };
      return null;
    }
    debug.utahagenda = { rawCount: rawActivities.length };

    return rawActivities
      // start_time required, not defaulted to midnight - seen live as the
      // actual cause of an obvious-looking duplicate: the same real event
      // from this source showed a confident "12:00 AM" (no time was
      // actually found) while another source correctly had 6:35 PM, ~18
      // hours apart and so outside dedup's matching window - both stayed
      // visible as if they were different events. A wrong-but-plausible
      // timestamp is worse than dropping the row.
      .filter((a: any) => a?.title && a?.date && a?.start_time && a?.url && CATEGORIES.includes(a.category))
      .map((a: any): ActivityRow => {
        const startsAt = zonedDateTimeToUtcIso(a.date, a.start_time, ANCHOR_TIMEZONE);
        const endsAt = a.end_time ? zonedDateTimeToUtcIso(a.date, a.end_time, ANCHOR_TIMEZONE) : null;
        return {
          source: 'ai_search_utahagenda',
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
    console.error('utahagenda pass failed:', err);
    debug.utahagenda = { exception: String(err) };
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

    const rawActivities = await fetchUtahAgendaActivities(label, debug);
    const activities = rawActivities !== null ? await verifyDistances(admin, rawActivities, lat, lng) : null;

    // Housekeeping: drop anything already over, regardless of source -
    // harmless to run in both this function and refresh-activities, so
    // neither depends on the other's schedule for this.
    await admin.from('activities').delete().lt('starts_at', new Date().toISOString());

    const errors: string[] = [];

    if (activities !== null) {
      await admin.from('activities').delete().eq('source', 'ai_search_utahagenda');
      if (activities.length > 0) {
        const { error } = await admin.from('activities').insert(activities);
        if (error) errors.push(`utahagenda insert: ${error.message}`);
      }
    } else {
      errors.push('utahagenda fetch failed - left existing ai_search_utahagenda rows untouched');
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
