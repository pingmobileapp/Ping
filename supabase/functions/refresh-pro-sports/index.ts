import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getRegion, swapExamples, type Region } from '../_shared/regions.ts';
import { crawlerModel, noteUsage } from '../_shared/anthropic.ts';
import { feedGames } from '../_shared/schedules.ts';
import { cityStateOf } from '../_shared/location.ts';
import { geocodeLocation } from '../_shared/geocode.ts';

// Companion to refresh-college-sports. Teams with a free structured feed
// (ESPN / MLB stats API - see _shared/schedules.ts and each team's `feed` in
// regions.ts) are read from it directly at zero token cost. Only teams with
// no feed fall back to AI web search (team pages are JS-rendered and
// inconsistent, so fetching them directly isn't reliable). Covers Utah's professional teams. Two real teams
// were deliberately left out after checking current status: Utah Warriors
// (Major League Rugby) suspended operations and withdrew from the league
// in November 2025 - no longer an active team - and there is no WNBA team
// in Utah yet as of the 2026 season. Writes into the same activities
// table under its own source='ai_search_prosports', always
// category='sports'.

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
  category: 'sports';
  description: string | null;
  location: string | null;
  lat: number | null;
  lng: number | null;
  starts_at: string;
  ends_at: string | null;
  price_label: string | null;
  url: string | null;
  confidence: 'high' | 'low';
  distance_miles: number | null;
  time_tba: boolean;
};

const SOURCE_BASE = 'ai_search_prosports';

const DAYS_AHEAD = 30;
const RADIUS_MILES = 25;
const RADIUS_SLACK_MILES = 15; // same as college sports - a pro venue is a
// real destination worth showing a bit further out than a default listing.

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

// Home games for every team that has a structured feed. Returns null if any
// feed call fails so the caller leaves last run's rows alone rather than
// replacing them with a partial set.
async function fetchFeedActivities(region: Region, debug: Record<string, unknown>): Promise<ActivityRow[] | null> {
  const fromMs = Date.now();
  const toMs = fromMs + DAYS_AHEAD * 24 * 60 * 60000;
  const rows: ActivityRow[] = [];
  const counts: Record<string, number> = {};
  for (const team of region.pro.teams) {
    if (!team.feed) continue;
    const games = await feedGames(team.feed, null, fromMs, toMs);
    if (games === null) {
      debug.prosportsFeed = { failedTeam: team.name };
      return null;
    }
    counts[team.name] = games.length;
    for (const g of games) {
      rows.push({
        source: `${SOURCE_BASE}${region.sourceSuffix}`,
        external_id: null,
        title: g.title,
        category: 'sports',
        description: g.description ? `${team.league}: ${g.description}` : null,
        location: g.location,
        lat: null,
        lng: null,
        starts_at: g.startsAt,
        ends_at: null,
        price_label: 'See ticket site',
        url: g.url ?? `https://${team.site}`,
        confidence: 'high',
        distance_miles: null,
        time_tba: g.timeTba,
      });
    }
  }
  debug.prosportsFeed = counts;
  return rows;
}

const PRO_SPORTS_SCHEMA = {
  type: 'object',
  properties: {
    games: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'e.g. "Utah Jazz vs. Denver Nuggets" - home team first, then opponent.' },
          date: { type: 'string', description: 'ISO yyyy-mm-dd, local to the venue.' },
          start_time: { type: ['string', 'null'], description: '24-hour HH:mm local time, null only if truly TBD.' },
          end_time: { type: ['string', 'null'], description: 'Estimate ~3 hours after start if not stated - null only if start_time is also null.' },
          location: { type: 'string', description: 'The home venue and city, e.g. "Delta Center, Salt Lake City, UT".' },
          price_label: { type: 'string', description: 'e.g. "Tickets from $35", "See ticket site" if prices vary/unclear.' },
          url: { type: 'string', description: 'A real URL from your search results - prefer the team\'s own site.' },
          description: { type: ['string', 'null'], description: 'One short sentence naming the league and both teams.' },
        },
        required: ['title', 'date', 'start_time', 'end_time', 'location', 'price_label', 'url', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['games'],
  additionalProperties: false,
};

async function fetchProSportsActivities(
  anchorLabel: string,
  region: Region,
  debug: Record<string, unknown>
): Promise<ActivityRow[] | null> {
  // Teams with a feed are handled by fetchFeedActivities - nothing for the
  // model to do (and nothing to pay for) if that covers everyone.
  const aiTeams = region.pro.teams.filter((t) => !t.feed);
  if (aiTeams.length === 0) {
    debug.prosports = 'all_teams_covered_by_feeds';
    return [];
  }
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set - skipping pro sports pass');
    debug.prosports = 'no_api_key';
    return null;
  }

  try {
    const today = new Date();
    const isoToday = today.toISOString().slice(0, 10);
    const isoEnd = new Date(today.getTime() + DAYS_AHEAD * 24 * 60 * 60000).toISOString().slice(0, 10);

    const teamsText = aiTeams.map((t) => `${t.name} (${t.league}, ${t.site})`).join('; ');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: crawlerModel(),
        max_tokens: 8000,
        system:
          `Find HOME games only (played at the team's own home venue - never an away/road game) between ` +
          `${isoToday} and ${isoEnd} for these ${region.pro.label}: ${teamsText}. For each team, search its ` +
          `own official site first since that's the source of truth - if a team's own schedule page won't load ` +
          `useful results, fall back to a reliable secondary source (ESPN, the league's own site) rather than ` +
          `skipping that team entirely. Only include a game you found a real, dated search result for - never ` +
          `guess or estimate a date/opponent. Skip a team entirely if you can't confirm anything in range for it ` +
          `(e.g. offseason) rather than inventing something. You won't necessarily find every game for every team ` +
          `within your search budget - prioritize confirming real games over covering everything. Once you've ` +
          `searched what you can, call record_games with everything you found - that call is mandatory, do not ` +
          `end your turn with only a text response. If you found nothing confirmed, call it with an empty list ` +
          `rather than padding it with anything uncertain.`,
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: Math.min(18, aiTeams.length * 4) },
          { name: 'record_games', description: 'Record the home games found.', input_schema: swapExamples(PRO_SPORTS_SCHEMA, [['Utah Jazz vs. Denver Nuggets', region.examples.proGame], ['Delta Center, Salt Lake City, UT', region.examples.proVenue]]) },
        ],
        messages: [
          {
            role: 'user',
            content: `Find upcoming home games for ${region.pro.userLabel} near ${anchorLabel}.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Anthropic API error:', response.status, detail);
      debug.prosports = { status: response.status, detail };
      return null;
    }

    const result = await response.json();
    noteUsage('refresh-pro-sports', debug, result);
    const toolUse = (result.content || []).find(
      (block: any) => block.type === 'tool_use' && block.name === 'record_games'
    );
    const rawGames = toolUse?.input?.games;
    if (!Array.isArray(rawGames)) {
      console.error('No record_games call in pro sports response - stop_reason:', result.stop_reason);
      debug.prosports = {
        stop_reason: result.stop_reason,
        content_types: (result.content || []).map((b: any) => b.type),
      };
      return null;
    }
    debug.prosports = { rawCount: rawGames.length };

    return rawGames
      // start_time required, not defaulted to midnight - a real game was
      // seen live sitting at a confident-looking "12:00 AM" (the model
      // hadn't actually found this source's start time) while the exact
      // same game from another source correctly showed 6:35 PM, ~18 hours
      // apart - far outside dedup's matching window, so both stayed
      // visible as if they were different games. A wrong-but-plausible
      // timestamp is worse than dropping the row - the real time is
      // usually still findable from a source that did report it.
      .filter((g: any) => g?.title && g?.date && g?.start_time && g?.url)
      .map((g: any): ActivityRow => {
        const startsAt = zonedDateTimeToUtcIso(g.date, g.start_time, region.timezone);
        const endsAt = g.end_time ? zonedDateTimeToUtcIso(g.date, g.end_time, region.timezone) : null;
        return {
          source: `${SOURCE_BASE}${region.sourceSuffix}`,
          external_id: null,
          title: g.title,
          category: 'sports',
          description: g.description || null,
          location: g.location || null,
          lat: null,
          lng: null,
          starts_at: startsAt,
          ends_at: endsAt,
          price_label: g.price_label || null,
          url: g.url,
          confidence: 'low',
          distance_miles: null,
          time_tba: false,
        };
      })
      // Defensive - seen live in the sibling concerts crawler that the
      // model can return a date before "today" despite explicit prompt
      // instructions not to.
      .filter((row) => new Date(row.starts_at).getTime() >= Date.now());
  } catch (err) {
    console.error('pro sports pass failed:', err);
    debug.prosports = { exception: String(err) };
    return null;
  }
}

const FUNCTION_NAME = 'refresh-pro-sports';

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

    const feedRows = await fetchFeedActivities(region, debug);
    const aiRows = await fetchProSportsActivities(label, region, debug);
    // Either half failing leaves last run's rows untouched, same as before.
    const rawGames = feedRows !== null && aiRows !== null ? [...feedRows, ...aiRows] : null;
    const games = rawGames !== null ? await verifyDistances(admin, rawGames, lat, lng) : null;

    if (games !== null) {
      await admin.from('activities').delete().eq('source', sourceName);
      if (games.length > 0) {
        const { error } = await admin.from('activities').insert(games);
        if (error) throw new Error(`insert failed: ${error.message}`);
      }
    }

    const errors: string[] = [];
    if (games === null) errors.push(`pro sports fetch failed - left existing ${sourceName} rows untouched`);

    return new Response(
      JSON.stringify({
        count: games === null ? 'failed (left untouched)' : games.length,
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
