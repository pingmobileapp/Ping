import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getRegion, swapExamples, type Region } from '../_shared/regions.ts';
import { crawlerModel, noteUsage } from '../_shared/anthropic.ts';
import { cityStateOf } from '../_shared/location.ts';
import { geocodeLocation } from '../_shared/geocode.ts';

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

// A full year, not the 30-day window the nightly passes use - this job
// runs once a year (see the cron schedule), so it needs to catch a summer
// festival even when run in early spring, months before it happens.
const SOURCE_BASE = 'ai_search_citydays';

const DAYS_AHEAD = 365;
const RADIUS_MILES = 25;
const RADIUS_SLACK_MILES = 15; // wider than the other passes - a real
// destination festival (a whole city's "Days" celebration) is worth
// showing even a bit further out than a random Tuesday farmers market.

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
  region: Region,
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
        model: crawlerModel(),
        max_tokens: 24000,
        system:
          `${region.cityDays.intro} Search for the real, current celebration for each of these cities: ` +
          `${region.cityDays.cities.join(', ')}. For each one, find its ${currentYear} dates if they haven't passed yet as of ` +
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
          { name: 'record_activities', description: 'Record the city days celebrations found.', input_schema: swapExamples(CITY_DAYS_SCHEMA, [['Lehi Round-Up Days', region.examples.cityDayName]]) },
        ],
        messages: [
          {
            role: 'user',
            content: `${region.cityDays.userPrompt} near ${anchorLabel} for this year or next.`,
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
    noteUsage('refresh-city-days', debug, result);
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
    console.error('city days pass failed:', err);
    debug.citydays = { exception: String(err) };
    return null;
  }
}

const FUNCTION_NAME = 'refresh-city-days';

async function run(req: Request): Promise<Response> {
  try {
    let debugRequested = false;
    let regionId: unknown;
    try {
      const body = await req.json();
      debugRequested = !!body?.debug;
      regionId = body?.region;
    } catch {
      // No/invalid JSON body.
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

    const rawActivities = await fetchCityDaysActivities(label, region, debug);
    const activities = rawActivities !== null ? await verifyDistances(admin, rawActivities, lat, lng) : null;

    // Note: no "delete anything already past" housekeeping here, unlike
    // the other passes - this runs yearly, not nightly, so leave that
    // cleanup to whichever of the other (nightly) functions runs next.

    const errors: string[] = [];

    if (activities !== null) {
      await admin.from('activities').delete().eq('source', sourceName);
      if (activities.length > 0) {
        const { error } = await admin.from('activities').insert(activities);
        if (error) errors.push(`citydays insert: ${error.message}`);
      }
    } else {
      errors.push(`city days fetch failed - left existing ${sourceName} rows untouched`);
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
