import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Companion to refresh-college-sports/refresh-pro-sports/refresh-concerts,
// same architecture - AI web search rather than direct site fetching.
// Unlike colleges, Utah high schools don't run their own detailed
// self-published athletics sites, so the search is pointed at MaxPreps
// (the standard national high-school sports aggregator, well-indexed and
// consistent across schools) as the primary source, falling back to the
// school's own site/UHSAA only if MaxPreps doesn't have it. Scoped to
// Utah's 6A classification for the 2025-27 UHSAA realignment cycle (17
// schools, verified against two independent sources) - other
// classifications would be a separate function/source if wanted later,
// same as college sports vs. pro sports are kept separate. Writes into
// the same activities table under its own source='ai_search_hs6a', always
// category='sports'.

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
  source: 'ai_search_hs6a';
  external_id: null;
  title: string;
  category: 'sports';
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

// Utah's 6A classification, 2025-27 UHSAA realignment cycle - verified via
// uhsaa.org and cross-checked against a second independent source.
const SCHOOLS: string[] = [
  // Region 1
  'Davis High School',
  'Farmington High School',
  'Layton High School',
  'Syracuse High School',
  'Weber High School',
  // Region 2
  'Bingham High School',
  'Cedar Valley High School',
  'Copper Hills High School',
  'Herriman High School',
  'Mountain Ridge High School',
  'Riverton High School',
  'Westlake High School',
  // Region 3
  'American Fork High School',
  'Corner Canyon High School',
  'Lehi High School',
  'Lone Peak High School',
  'Skyridge High School',
];

const SPORTS = ['football', "boys' basketball", "girls' basketball"];

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

const HS_SPORTS_SCHEMA = {
  type: 'object',
  properties: {
    games: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'e.g. "Davis Football vs. Syracuse" - home team first, then opponent.' },
          date: { type: 'string', description: 'ISO yyyy-mm-dd, local to Utah.' },
          start_time: { type: ['string', 'null'], description: '24-hour HH:mm local time, null only if truly unstated.' },
          end_time: { type: ['string', 'null'], description: 'Estimate ~2.5 hours after start if not stated - null only if start_time is also null.' },
          location: { type: 'string', description: 'The home school and city, e.g. "Davis High School, Kaysville, UT".' },
          url: { type: 'string', description: 'A real URL from your search results - prefer MaxPreps.' },
          description: { type: ['string', 'null'], description: 'One short sentence naming the sport and both teams.' },
        },
        required: ['title', 'date', 'start_time', 'end_time', 'location', 'url', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['games'],
  additionalProperties: false,
};

async function fetchHsSportsActivities(
  anchorLabel: string,
  debug: Record<string, unknown>
): Promise<ActivityRow[] | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set - skipping 6A high school sports pass');
    debug.hs6a = 'no_api_key';
    return null;
  }

  try {
    const today = new Date();
    const isoToday = today.toISOString().slice(0, 10);
    const isoEnd = new Date(today.getTime() + DAYS_AHEAD * 24 * 60 * 60000).toISOString().slice(0, 10);

    const schoolsText = SCHOOLS.join(', ');
    const sportsText = SPORTS.join(', ');

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
          `Find HOME games only (played at the school's own field/gym - never an away/road game) between ` +
          `${isoToday} and ${isoEnd} in ${sportsText} for these Utah 6A high schools: ${schoolsText}. Search ` +
          `MaxPreps first (e.g. site:maxpreps.com "Davis High School" football schedule) since it's the most ` +
          `consistently reliable source across Utah high schools - fall back to the school's own athletics page ` +
          `or UHSAA (uhsaa.org) only if MaxPreps doesn't have a given school/sport. Only include a game you found ` +
          `a real, dated search result for - never guess an opponent or date. Skip a school/sport combination ` +
          `entirely if you can't confirm anything in range for it (offseason, schedule not posted yet, etc.) ` +
          `rather than inventing something. You won't necessarily find every game for every school within your ` +
          `search budget - prioritize confirming real games over covering everything. Once you've searched what ` +
          `you can, call record_games with everything you found - that call is mandatory, do not end your turn ` +
          `with only a text response. If you found nothing confirmed, call it with an empty list rather than ` +
          `padding it with anything uncertain.`,
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 28 },
          { name: 'record_games', description: 'Record the home games found.', input_schema: HS_SPORTS_SCHEMA },
        ],
        messages: [
          {
            role: 'user',
            content: `Find upcoming home games for Utah's 6A high school teams near ${anchorLabel}.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Anthropic API error:', response.status, detail);
      debug.hs6a = { status: response.status, detail };
      return null;
    }

    const result = await response.json();
    const toolUse = (result.content || []).find(
      (block: any) => block.type === 'tool_use' && block.name === 'record_games'
    );
    const rawGames = toolUse?.input?.games;
    if (!Array.isArray(rawGames)) {
      console.error('No record_games call in 6A high school sports response - stop_reason:', result.stop_reason);
      debug.hs6a = {
        stop_reason: result.stop_reason,
        content_types: (result.content || []).map((b: any) => b.type),
      };
      return null;
    }
    debug.hs6a = { rawCount: rawGames.length };

    return rawGames
      .filter((g: any) => g?.title && g?.date && g?.url)
      .map((g: any): ActivityRow => {
        const startsAt = zonedDateTimeToUtcIso(g.date, g.start_time || '00:00', ANCHOR_TIMEZONE);
        const endsAt = g.end_time ? zonedDateTimeToUtcIso(g.date, g.end_time, ANCHOR_TIMEZONE) : null;
        return {
          source: 'ai_search_hs6a',
          external_id: null,
          title: g.title,
          category: 'sports',
          description: g.description || null,
          location: g.location || null,
          lat: null,
          lng: null,
          starts_at: startsAt,
          ends_at: endsAt,
          price_label: null,
          url: g.url,
          confidence: 'low',
          distance_miles: null,
        };
      })
      // Defensive - seen live in the concerts crawler that the model can
      // return a date before "today" despite explicit prompt instructions.
      .filter((row) => new Date(row.starts_at).getTime() >= Date.now());
  } catch (err) {
    console.error('6A high school sports pass failed:', err);
    debug.hs6a = { exception: String(err) };
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

    const rawGames = await fetchHsSportsActivities(label, debug);
    const games = rawGames !== null ? await verifyDistances(admin, rawGames, lat, lng) : null;

    if (games !== null) {
      await admin.from('activities').delete().eq('source', 'ai_search_hs6a');
      if (games.length > 0) {
        const { error } = await admin.from('activities').insert(games);
        if (error) throw new Error(`insert failed: ${error.message}`);
      }
    }

    const errors: string[] = [];
    if (games === null) errors.push('6A high school sports fetch failed - left existing ai_search_hs6a rows untouched');

    return new Response(
      JSON.stringify({
        count: games === null ? 'failed (left untouched)' : games.length,
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
