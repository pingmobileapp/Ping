// Free, structured schedule feeds for pro and college sports. These replace
// AI web search for every team a feed covers: same data, zero token cost, and
// the times come straight from the source instead of being read off a page by
// a model. Teams no feed covers (small-college, minor-league, independent) are
// still handed to the AI crawlers as a much smaller remainder.
//
// ESPN's site API and MLB's stats API are unauthenticated and undocumented /
// unofficial, so every call here fails soft (returns null) - a crawler treats
// null as "leave last run's rows alone", never as "no games".

export type FeedGame = {
  title: string;
  startsAt: string; // ISO UTC - a noon placeholder on the game date when timeTba
  timeTba: boolean;
  location: string | null;
  url: string | null;
  description: string | null;
};

// Noon UTC-6ish lands on the same calendar date in every US timezone, so a
// date-only game shows on the right day wherever it's read.
const tbaPlaceholder = (dateKey: string): string => `${dateKey}T18:00:00.000Z`;

// ESPN parks a game with no announced time at midnight US Eastern, so its
// real date is the Eastern calendar date - read as UTC or Mountain time it
// would fall on the day before.
const easternDateKey = (ms: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ms)
  );

export type TeamFeed =
  | { kind: 'espn'; path: string; id: string } // e.g. path 'basketball/nba'
  | { kind: 'mlb'; sportId: number; id: number };

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const MLB_BASE = 'https://statsapi.mlb.com/api/v1';

// Maps the sport names used in regions.ts college config to ESPN paths.
export const ESPN_COLLEGE_PATHS: Record<string, string> = {
  football: 'football/college-football',
  "men's basketball": 'basketball/mens-college-basketball',
  "women's basketball": 'basketball/womens-college-basketball',
};

function venueLabel(venue: any): string | null {
  if (!venue?.fullName) return null;
  const parts = [venue.fullName, venue.address?.city, venue.address?.state].filter(Boolean);
  return parts.join(', ');
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'PingApp-Discover/1.0' } });
    if (!res.ok) {
      console.error('schedule feed error:', res.status, url);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('schedule feed failed:', url, err);
    return null;
  }
}

// Home games (plus neutral-site games, which the caller's distance check
// keeps or drops) for one ESPN team between fromMs and toMs.
export async function espnGames(
  path: string,
  teamId: string,
  sportLabel: string | null,
  fromMs: number,
  toMs: number
): Promise<FeedGame[] | null> {
  const data = await getJson(`${ESPN_BASE}/${path}/teams/${teamId}/schedule`);
  if (!data || !Array.isArray(data.events)) return null;

  const games: FeedGame[] = [];
  for (const event of data.events) {
    const comp = event?.competitions?.[0];
    if (!comp) continue;
    // timeValid=false means the date is set but the kickoff time isn't -
    // kept as a date-only game rather than trusting ESPN's midnight
    // placeholder as a real "12:00 AM" start.
    const timeTba = comp.timeValid === false || event.timeValid === false;
    const status = comp.status?.type?.name ?? event.status?.type?.name;
    if (status && status !== 'STATUS_SCHEDULED') continue;

    const mine = (comp.competitors || []).find((c: any) => String(c.team?.id) === String(teamId));
    const opponent = (comp.competitors || []).find((c: any) => String(c.team?.id) !== String(teamId));
    if (!mine || !opponent) continue;
    if (mine.homeAway !== 'home' && !comp.neutralSite) continue;

    const rawMs = Date.parse(event.date);
    if (Number.isNaN(rawMs)) continue;
    const startsAt = timeTba ? tbaPlaceholder(easternDateKey(rawMs)) : new Date(rawMs).toISOString();
    const startMs = Date.parse(startsAt);
    if (startMs < fromMs || startMs > toMs) continue;

    const link = (event.links || []).find(
      (l: any) => Array.isArray(l.rel) && l.rel.includes('desktop') && l.rel.includes('event')
    );
    const me = mine.team?.displayName ?? data.team?.displayName;
    const them = opponent.team?.displayName;
    if (!me || !them) continue;

    games.push({
      title: `${me} vs. ${them}`,
      startsAt,
      timeTba,
      location: venueLabel(comp.venue),
      url: link?.href ?? data.team?.clubhouse ?? null,
      description: `${sportLabel ? `${sportLabel}: ` : ''}${me} host ${them}.`,
    });
  }
  return games;
}

// Home games for one MiLB/MLB team from MLB's stats API.
export async function mlbGames(
  sportId: number,
  teamId: number,
  fromMs: number,
  toMs: number
): Promise<FeedGame[] | null> {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const data = await getJson(
    `${MLB_BASE}/schedule?sportId=${sportId}&teamId=${teamId}&startDate=${day(fromMs)}&endDate=${day(toMs)}&hydrate=venue(location)`
  );
  if (!data || !Array.isArray(data.dates)) return null;

  const games: FeedGame[] = [];
  for (const date of data.dates) {
    for (const g of date.games || []) {
      if (g.status?.abstractGameState !== 'Preview') continue;
      if (g.teams?.home?.team?.id !== teamId) continue;
      const timeTba = !!g.status?.startTimeTBD;
      if (timeTba && !g.officialDate) continue;
      const startsAt = timeTba ? tbaPlaceholder(g.officialDate) : g.gameDate;
      const startMs = Date.parse(startsAt);
      if (Number.isNaN(startMs) || startMs < fromMs || startMs > toMs) continue;

      const home = g.teams.home.team.name;
      const away = g.teams.away.team.name;
      const loc = g.venue?.location;
      games.push({
        title: `${home} vs. ${away}`,
        startsAt: new Date(startMs).toISOString(),
        timeTba,
        location: g.venue?.name
          ? [g.venue.name, loc?.city, loc?.stateAbbrev ?? loc?.state].filter(Boolean).join(', ')
          : null,
        url: null,
        description: `${home} host ${away}.`,
      });
    }
  }
  return games;
}

export async function feedGames(
  feed: TeamFeed,
  sportLabel: string | null,
  fromMs: number,
  toMs: number
): Promise<FeedGame[] | null> {
  return feed.kind === 'espn'
    ? espnGames(feed.path, feed.id, sportLabel, fromMs, toMs)
    : mlbGames(feed.sportId, feed.id, fromMs, toMs);
}
