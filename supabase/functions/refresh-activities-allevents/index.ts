import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getRegion, type Region } from '../_shared/regions.ts';
import { crawlerModel, noteUsage } from '../_shared/anthropic.ts';
import { cityStateOf } from '../_shared/location.ts';
import { geocodeLocation } from '../_shared/geocode.ts';

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
  source: string;
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

const SOURCE_BASE = 'ai_search_allevents';

const DAYS_AHEAD = 30;
const RADIUS_MILES = 25;
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
// genuinely new locations. Shares the geocode_cache table with the other
// two functions (separate module-level rate-limit clock per isolate).

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
      const cityState = cityStateOf(row.location);
      const geo =
        (await geocodeLocation(admin, row.location)) ??
        (cityState ? await geocodeLocation(admin, cityState) : null);
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
  region: Region,
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
        model: crawlerModel(),
        max_tokens: region.allevents.maxTokens,
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
            content: `Fetch and read these allevents.in pages, and find activities near ${anchorLabel}:\n${region.allevents.urls.join('\n')}`,
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
    noteUsage('refresh-activities-allevents', debug, result);
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
        const startsAt = zonedDateTimeToUtcIso(a.date, a.start_time, region.timezone);
        const endsAt = a.end_time ? zonedDateTimeToUtcIso(a.date, a.end_time, region.timezone) : null;
        return {
          source: `${SOURCE_BASE}${region.sourceSuffix}`,
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

const FUNCTION_NAME = 'refresh-activities-allevents';

async function run(req: Request): Promise<Response> {
  try {
    let debugRequested = false;
    let regionId: unknown;
    try {
      const body = await req.json();
      debugRequested = !!body?.debug;
      regionId = body?.region;
    } catch {
      // No/invalid JSON body (e.g. the cron job posts an empty body).
    }
    let region: Region;
    try {
      region = getRegion(regionId);
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 400 });
    }
    const debug: Record<string, unknown> = {};

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'not configured' }), { status: 500 });
    }
    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { lat, lng, label } = region.anchor();
    const sourceName = SOURCE_BASE + region.sourceSuffix;

    const rawActivities = await fetchAllEventsActivities(label, region, debug);
    const activities = rawActivities !== null ? await verifyDistances(admin, rawActivities, lat, lng) : null;

    // Housekeeping: drop anything already over, regardless of source -
    // harmless to run in every one of these functions.
    await admin.from('activities').delete().lt('starts_at', new Date().toISOString());

    const errors: string[] = [];

    if (activities !== null) {
      await admin.from('activities').delete().eq('source', sourceName);
      if (activities.length > 0) {
        const { error } = await admin.from('activities').insert(activities);
        if (error) errors.push(`allevents insert: ${error.message}`);
      }
    } else {
      errors.push(`allevents fetch failed - left existing ${sourceName} rows untouched`);
    }

    return new Response(
      JSON.stringify({
        count: activities === null ? 'failed (left untouched)' : activities.length,
        errors,
        usage: debug.usage ?? null,
        ...(debugRequested ? { debug } : {}),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

// Supabase closes a request that sends nothing back for 150 seconds, and the
// Boise crawls (more pages/venues to look up) can run longer than that. So a
// Boise run answers right away and does its work in the background, where
// only the longer overall function limit applies - cron doesn't read the
// response anyway. Utah runs are untouched: same request, same response.
serve(async (req) => {
  const text = await req.text();
  const again = () => new Request(req.url, { method: 'POST', body: text });
  let regionId: unknown;
  let debugRequested = false;
  try {
    const parsed = JSON.parse(text);
    regionId = parsed?.region;
    debugRequested = !!parsed?.debug;
  } catch {
    // No/invalid JSON body - Utah, handled by run() as before.
  }
  // Debugging aid: a Boise run with "debug": true stays attached and sends a
  // blank keep-alive every 15s so the 150s idle limit doesn't cut it off,
  // then returns the real outcome (the normal background path only logs it).
  if (regionId === 'boise' && debugRequested) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const keepAlive = setInterval(() => controller.enqueue(encoder.encode(' ')), 15000);
        try {
          const res = await run(again());
          controller.enqueue(encoder.encode(await res.text()));
        } catch (err) {
          controller.enqueue(encoder.encode(JSON.stringify({ error: String(err) })));
        } finally {
          clearInterval(keepAlive);
          controller.close();
        }
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (regionId === 'boise' && typeof EdgeRuntime !== 'undefined') {
    // Record how the run ends (see supabase/crawler_runs.sql). A row still
    // 'running' long after the start means the run was cut off. Logging
    // problems never affect the run itself.
    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const logClient = url && serviceKey ? createClient(url, serviceKey) : null;
    let runId: string | null = null;
    const started = (async () => {
      try {
        const { data } = await logClient!
          .from('crawler_runs')
          .insert({ function_name: FUNCTION_NAME, region: 'boise' })
          .select('id')
          .single();
        runId = data?.id ?? null;
      } catch (err) {
        console.error('crawler_runs insert failed:', err);
      }
    })();
    const finish = async (status: string, detail: string) => {
      try {
        await started;
        if (logClient && runId) {
          await logClient
            .from('crawler_runs')
            .update({ status, detail: detail.slice(0, 4000), finished_at: new Date().toISOString() })
            .eq('id', runId);
        }
      } catch (err) {
        console.error('crawler_runs update failed:', err);
      }
    };
    EdgeRuntime.waitUntil(
      run(again())
        .then(async (res) => {
          const body = await res.text();
          console.log('background run finished:', res.status, body);
          await finish(res.ok ? 'finished' : 'failed', `${res.status} ${body}`);
        })
        .catch(async (err) => {
          console.error('background run failed:', err);
          await finish('failed', String(err));
        })
    );
    return new Response(JSON.stringify({ accepted: true, region: 'boise', note: 'running in the background' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return await run(again());
});
