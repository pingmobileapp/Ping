import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// A dedicated, low-frequency companion to the other refresh-activities-*
// functions - nearly every Utah city runs its own annual "[City] Days"
// summer festival (Lehi Round-Up Days, American Fork Steel Days, Pleasant
// Grove Strawberry Days, Alpine Days, etc.), each announced on that city's
// own site with no single directory listing all of them. Unlike the other
// passes (nightly, 30-day rolling window), this one searches out to a full
// year ahead and is meant to run rarely (see supabase/activities_cron.sql -
// scheduled once a year, around when cities start announcing summer dates),
// since a given year's dates don't change once set. Writes into the same
// activities table under its own source='ai_search_citydays' so its
// delete-and-replace never touches the other passes' rows.

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
  source: 'ai_search_citydays';
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

// A full year, not the 30-day window the nightly passes use - this job
// runs once a year (see the cron schedule), so it needs to catch a summer
// festival even when run in early spring, months before it happens.
const DAYS_AHEAD = 365;
const RADIUS_MILES = 25;
const RADIUS_SLACK_MILES = 15; // wider than the other passes - a real
// destination festival (a whole city's "Days" celebration) is worth
// showing even a bit further out than a random Tuesday farmers market.

// Utah County cities (plus a few just outside it) that traditionally run
// their own annual "[City] Days" celebration - a real, well-known Utah
// summer tradition with no single directory covering all of them.
const CITIES = [
  'Alpine',
  'Highland',
  'Cedar Hills',
  'Lehi',
  'American Fork',
  'Pleasant Grove',
  'Lindon',
  'Orem',
  'Provo',
  'Springville',
  'Spanish Fork',
  'Payson',
  'Eagle Mountain',
  'Saratoga Springs',
  'Draper',
  'Sandy',
  'Riverton',
  'Bluffdale',
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

const CITY_DAYS_SCHEMA = {
  type: 'object',
  properties: {
    activities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The festival\'s actual name, e.g. "Lehi Round-Up Days".' },
          category: { type: 'string', enum: CATEGORIES as unknown as string[] },
          date: { type: 'string', description: 'ISO yyyy-mm-dd for one specific day of the celebration (its opening day or a real single flagship event within it).' },
          start_time: { type: ['string', 'null'], description: '24-hour HH:mm local time, null if all-day/unclear.' },
          end_time: { type: ['string', 'null'] },
          location: { type: 'string', description: 'City and/or venue.' },
          price_label: { type: 'string', description: 'e.g. "Free", "$10", "$8+". "Unknown" if truly not stated.' },
          url: { type: 'string', description: 'A real URL from your search results for this celebration.' },
          description: { type: ['string', 'null'], description: 'One short sentence - what the celebration includes (parade, rodeo, carnival, fireworks, etc.) and its full date range if multi-day.' },
        },
        required: ['title', 'category', 'date', 'start_time', 'end_time', 'location', 'price_label', 'url', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['activities'],
  additionalProperties: false,
};

async function fetchCityDaysActivities(
  anchorLabel: string,
  debug: Record<string, unknown>
): Promise<ActivityRow[] | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set - skipping city days pass');
    debug.citydays = 'no_api_key';
    return null;
  }

  try {
    const today = new Date();
    const isoToday = today.toISOString().slice(0, 10);
    const currentYear = today.getFullYear();
    const nextYear = currentYear + 1;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 24000,
        system:
          `Most Utah cities run their own annual "[City] Days" summer celebration (e.g. Lehi Round-Up Days, ` +
          `American Fork Steel Days, Pleasant Grove Strawberry Days, Alpine Days) - a multi-day festival with a ` +
          `parade, carnival, rodeo, or fireworks, usually announced on that city's own website with no single ` +
          `directory listing all of them. Search for the real, current celebration for each of these cities: ` +
          `${CITIES.join(', ')}. For each one, find its ${currentYear} dates if they haven't passed yet as of ` +
          `${isoToday}, or its ${nextYear} dates if ${currentYear}'s has already happened and ${nextYear}'s are ` +
          `already announced. Only include a city if you found a real, dated celebration via an actual search ` +
          `result - never guess a date, and skip a city entirely rather than invent one for it (not every city ` +
          `may have announced next year's dates yet - that's fine, just skip it). You won't necessarily find all ` +
          `of them within your search budget - prioritize actually confirming real dates over covering every ` +
          `city. Once you've searched what you can, call record_activities with everything you found - that call ` +
          `is mandatory, do not end your turn with only a text response. If you found nothing confirmed, call it ` +
          `with an empty list rather than padding it with anything uncertain.`,
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 14 },
          { name: 'record_activities', description: 'Record the city days celebrations found.', input_schema: CITY_DAYS_SCHEMA },
        ],
        messages: [
          {
            role: 'user',
            content: `Find each Utah city's annual "Days" celebration near ${anchorLabel} for this year or next.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Anthropic API error:', response.status, detail);
      debug.citydays = { status: response.status, detail };
      return null;
    }

    const result = await response.json();
    const toolUse = (result.content || []).find(
      (block: any) => block.type === 'tool_use' && block.name === 'record_activities'
    );
    const rawActivities = toolUse?.input?.activities;
    if (!Array.isArray(rawActivities)) {
      console.error('No record_activities call in city days response - stop_reason:', result.stop_reason);
      debug.citydays = {
        stop_reason: result.stop_reason,
        content_types: (result.content || []).map((b: any) => b.type),
      };
      return null;
    }
    debug.citydays = { rawCount: rawActivities.length };

    return rawActivities
      // start_time required, not defaulted to midnight - see the matching
      // fix in refresh-activities-utahagenda for the live duplicate bug
      // this caused.
      .filter((a: any) => a?.title && a?.date && a?.start_time && a?.url && CATEGORIES.includes(a.category))
      .map((a: any): ActivityRow => {
        const startsAt = zonedDateTimeToUtcIso(a.date, a.start_time, ANCHOR_TIMEZONE);
        const endsAt = a.end_time ? zonedDateTimeToUtcIso(a.date, a.end_time, ANCHOR_TIMEZONE) : null;
        return {
          source: 'ai_search_citydays',
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
    console.error('city days pass failed:', err);
    debug.citydays = { exception: String(err) };
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

    const rawActivities = await fetchCityDaysActivities(label, debug);
    const activities = rawActivities !== null ? await verifyDistances(admin, rawActivities, lat, lng) : null;

    // Note: no "delete anything already past" housekeeping here, unlike
    // the other passes - this runs yearly, not nightly, so leave that
    // cleanup to whichever of the other (nightly) functions runs next.

    const errors: string[] = [];

    if (activities !== null) {
      await admin.from('activities').delete().eq('source', 'ai_search_citydays');
      if (activities.length > 0) {
        const { error } = await admin.from('activities').insert(activities);
        if (error) errors.push(`citydays insert: ${error.message}`);
      }
    } else {
      errors.push('city days fetch failed - left existing ai_search_citydays rows untouched');
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
