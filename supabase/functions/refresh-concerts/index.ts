import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getRegion, type Region } from '../_shared/regions.ts';
import { crawlerModel, noteUsage } from '../_shared/anthropic.ts';
import { cityStateOf } from '../_shared/location.ts';
import { geocodeLocation } from '../_shared/geocode.ts';

// Companion to refresh-college-sports/refresh-pro-sports, same
// architecture and same reason for AI web search over direct site
// fetching (venue calendars are commonly JS-rendered or split across
// whichever ticketing platform - Ticketmaster, AXS, the venue's own site -
// happens to host that show, with no one consistent page to hardcode).
// Covers upcoming shows at a fixed list of well-known concert venues - but
// only the ones Ticketmaster (refresh-activities) isn't already returning
// shows for. That pass is free, so a venue with real Ticketmaster listings
// is skipped here and only the rest (own-site / Etix / no-ticketing rooms)
// pay for AI search.
// Writes into the same activities table under its own
// source='ai_search_concerts', always category='music'.

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
  source: string;
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

const SOURCE_BASE = 'ai_search_concerts';

const DAYS_AHEAD = 30;
const RADIUS_MILES = 25;
const RADIUS_SLACK_MILES = 15;

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
          date: { type: 'string', description: 'ISO yyyy-mm-dd, local to the venue.' },
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

// Venue names differ between our config and Ticketmaster's ("The Union Event
// Center" vs "The Union", "Knitting Factory Concert House" vs "Knitting
// Factory - Boise"), so compare on the first two words minus "the".
function venueKey(name: string): string {
  const words = name
    .split(',')[0]
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w !== 'the');
  return words.slice(0, 2).join('');
}

// A venue counts as covered when Ticketmaster has at least this many
// upcoming shows there - an actively ticketed room, not a one-off listing.
const TM_COVERED_MIN_SHOWS = 3;

async function venuesNeedingSearch(
  admin: ReturnType<typeof createClient>,
  region: Region,
  debug: Record<string, unknown>
): Promise<Region['concerts']['venues']> {
  const { data, error } = await admin
    .from('activities')
    .select('location')
    .eq('source', 'ticketmaster')
    .gte('starts_at', new Date().toISOString())
    .lte('starts_at', new Date(Date.now() + DAYS_AHEAD * 24 * 60 * 60000).toISOString())
    .limit(2000);
  if (error || !data) {
    // Can't tell what Ticketmaster covers - search everything, as before.
    debug.concertsCoverage = `lookup failed: ${error?.message}`;
    return region.concerts.venues;
  }
  const counts = new Map<string, number>();
  for (const row of data) {
    if (!row.location) continue;
    const key = venueKey(row.location);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const covered: string[] = [];
  const needed = region.concerts.venues.filter((v) => {
    const key = venueKey(v.name);
    let n = 0;
    for (const [k, c] of counts) if (k.startsWith(key) || key.startsWith(k)) n += c;
    if (n >= TM_COVERED_MIN_SHOWS) {
      covered.push(`${v.name} (${n})`);
      return false;
    }
    return true;
  });
  debug.concertsCoverage = { coveredByTicketmaster: covered, searching: needed.map((v) => v.name) };
  return needed;
}

async function fetchConcertActivities(
  anchorLabel: string,
  region: Region,
  venues: Region['concerts']['venues'],
  debug: Record<string, unknown>
): Promise<ActivityRow[] | null> {
  if (venues.length === 0) {
    debug.concerts = 'all_venues_covered_by_ticketmaster';
    return [];
  }
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

    const venuesText = venues.map((v) => `${v.name} (${v.city})`).join('; ');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: crawlerModel(),
        max_tokens: 16000,
        system:
          `Find upcoming shows/concerts between ${isoToday} and ${isoEnd} at these specific ${region.concerts.label}: ` +
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
          { type: 'web_search_20250305', name: 'web_search', max_uses: Math.min(20, venues.length * 3) },
          { name: 'record_shows', description: 'Record the shows found.', input_schema: CONCERTS_SCHEMA },
        ],
        messages: [
          {
            role: 'user',
            content: `Find upcoming concerts/shows at these specific ${region.concerts.label} near ${anchorLabel}: ${venuesText}.`,
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
    noteUsage('refresh-concerts', debug, result);
    const toolUse = (result.content || []).find(
      (block: any) => block.type === 'tool_use' && block.name === 'record_shows'
    );
    const rawShows = toolUse?.input?.shows;
    if (!Array.isArray(rawShows)) {
      console.error('No record_shows call in concerts response - stop_reason:', result.stop_reason);
      debug.concerts = {
        stop_reason: result.stop_reason,
        content_types: (result.content || []).map((b: any) => b.type),
        text: (result.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').slice(0, 500),
      };
      return null;
    }
    debug.concerts = { rawCount: rawShows.length };

    return rawShows
      // start_time required, not defaulted to 19:00 - see the matching fix
      // in refresh-activities-utahagenda for the live duplicate bug a
      // fabricated default time caused there (same risk here in principle,
      // even though 19:00 is a less obviously-wrong guess than midnight).
      .filter((s: any) => s?.title && s?.venue && s?.date && s?.start_time && s?.url)
      .map((s: any): ActivityRow => {
        const venueMatch = region.concerts.venues.find((v) => v.name === s.venue || String(s.venue).startsWith(v.name));
        const location = venueMatch ? `${venueMatch.name}, ${venueMatch.city}` : s.venue;
        const startsAt = zonedDateTimeToUtcIso(s.date, s.start_time, region.timezone);
        return {
          source: `${SOURCE_BASE}${region.sourceSuffix}`,
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

const FUNCTION_NAME = 'refresh-concerts';

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

    const venues = await venuesNeedingSearch(admin, region, debug);
    const rawShows = await fetchConcertActivities(label, region, venues, debug);
    const shows = rawShows !== null ? await verifyDistances(admin, rawShows, lat, lng) : null;

    if (shows !== null) {
      await admin.from('activities').delete().eq('source', sourceName);
      if (shows.length > 0) {
        const { error } = await admin.from('activities').insert(shows);
        if (error) throw new Error(`insert failed: ${error.message}`);
      }
    }

    const errors: string[] = [];
    if (shows === null) errors.push(`concerts fetch failed - left existing ${sourceName} rows untouched`);

    return new Response(
      JSON.stringify({
        count: shows === null ? 'failed (left untouched)' : shows.length,
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
