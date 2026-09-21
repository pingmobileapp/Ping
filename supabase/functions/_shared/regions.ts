import type { TeamFeed } from './schedules.ts';

// Per-region settings for the Discover crawlers (refresh-*). A crawler picks
// its region from the request body ({"region": "boise"}); no body means
// Utah, exactly as before. Rows a region writes carry that region's
// sourceSuffix ('' for Utah, '_boise' for Boise) so one region's
// delete-and-replace each run never touches another region's rows.
//
// refresh-activities-utahagenda keeps its name for both regions - for Boise
// it reads the Treasure Valley event calendars listed under `calendar`.

export type RegionId = 'utah' | 'boise';

type Anchor = { lat: number; lng: number; label: string };

// Example strings shown to the model inside each crawler's tool schema.
// They're only illustrations, but leaving another region's examples in
// would nudge results toward that region.
type Examples = {
  cityDayName: string;
  collegeGame: string;
  collegeVenue: string;
  proGame: string;
  proVenue: string;
  hsGame: string;
  hsVenue: string;
};

export type Region = {
  id: RegionId;
  sourceSuffix: string;
  timezone: string;
  anchor: () => Anchor;
  examples: Examples;
  calendar: {
    siteLabel: string;
    urls: string[];
    guidance: (anchorLabel: string) => string;
  };
  allevents: { urls: string[]; maxTokens: number };
  cityDays: { intro: string; cities: string[]; userPrompt: string };
  college: {
    label: string;
    userLabel: string;
    // espnId + espnSports: the sports ESPN's free schedule feed covers for
    // this school (see schedules.ts). Any sport not listed there goes to the
    // AI crawler instead.
    schools: { name: string; site: string; sports: string[]; espnId?: string; espnSports?: string[] }[];
  };
  pro: {
    label: string;
    userLabel: string;
    // feed: a free structured schedule source (see schedules.ts); a team
    // without one is handed to the AI crawler instead.
    teams: { name: string; league: string; site: string; feed?: TeamFeed }[];
  };
  concerts: {
    label: string;
    venues: { name: string; city: string }[];
  };
  hs: {
    label: string;
    userLabel: string;
    stateName: string;
    governingBody: string;
    exampleSchool: string;
    schools: string[];
    sports: string[];
  };
};

const UTAH: Region = {
  id: 'utah',
  sourceSuffix: '',
  timezone: Deno.env.get('DISCOVER_ANCHOR_TIMEZONE') || 'America/Denver',
  anchor: () => ({
    lat: Number(Deno.env.get('DISCOVER_ANCHOR_LAT') ?? '0'),
    lng: Number(Deno.env.get('DISCOVER_ANCHOR_LNG') ?? '0'),
    label: Deno.env.get('DISCOVER_ANCHOR_LABEL') ?? 'the area',
  }),
  examples: {
    cityDayName: 'Lehi Round-Up Days',
    collegeGame: 'BYU Football vs. Arizona',
    collegeVenue: 'LaVell Edwards Stadium, Provo, UT',
    proGame: 'Utah Jazz vs. Denver Nuggets',
    proVenue: 'Delta Center, Salt Lake City, UT',
    hsGame: 'Davis Football vs. Syracuse',
    hsVenue: 'Davis High School, Kaysville, UT',
  },
  calendar: {
    siteLabel: 'utahagenda.com',
    urls: [
      'https://utahagenda.com/utah-movies-in-the-park/',
      'https://utahagenda.com/todays-utah-events/',
      'https://utahagenda.com/best-utah-city-events/',
      'https://utahagenda.com/best-of-utah/',
    ],
    guidance: (anchorLabel) =>
      `These pages cover the whole state, so only keep what's actually near ${anchorLabel} - skip ` +
      `anything for a clearly distant city. The "movies in the park" page lists free outdoor movie nights at ` +
      `parks across Utah - pull every showing within range, not just the first one you see, and check whether ` +
      `it recurs (e.g. weekly all summer) so you can list several upcoming dates rather than just one. If a ` +
      `page links to a more specific city or category page that looks relevant, fetch that one too.`,
  },
  allevents: {
    maxTokens: 16000,
    urls: [
      'https://allevents.in/lehi-us/all',
      'https://allevents.in/american-fork-us/all',
      'https://allevents.in/highland-us/all',
      'https://allevents.in/pleasant-grove-us/all',
      'https://allevents.in/orem-us/all',
      'https://allevents.in/provo-us/all',
      'https://allevents.in/draper-us/all',
      'https://allevents.in/sandy-us/all',
    ],
  },
  cityDays: {
    intro:
      `Most Utah cities run their own annual "[City] Days" summer celebration (e.g. Lehi Round-Up Days, ` +
      `American Fork Steel Days, Pleasant Grove Strawberry Days, Alpine Days) - a multi-day festival with a ` +
      `parade, carnival, rodeo, or fireworks, usually announced on that city's own website with no single ` +
      `directory listing all of them.`,
    cities: [
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
    ],
    userPrompt: `Find each Utah city's annual "Days" celebration`,
  },
  college: {
    label: 'Utah college teams',
    userLabel: "Utah's Division I college teams",
    schools: [
      { name: 'BYU', site: 'byucougars.com', sports: ['football', "men's basketball", "women's basketball"], espnId: '252', espnSports: ['football', "men's basketball", "women's basketball"] },
      { name: 'University of Utah', site: 'utahutes.com', sports: ['football', "men's basketball", "women's basketball"], espnId: '254', espnSports: ['football', "men's basketball", "women's basketball"] },
      { name: 'Utah State University', site: 'utahstateaggies.com', sports: ['football', "men's basketball", "women's basketball"], espnId: '328', espnSports: ['football', "men's basketball", "women's basketball"] },
      // Utah Valley has no football program - omitted from its sports list
      // rather than left for the model to guess about.
      { name: 'Utah Valley University', site: 'gouvu.com', sports: ["men's basketball", "women's basketball"], espnId: '3084', espnSports: ["men's basketball", "women's basketball"] },
      { name: 'Weber State University', site: 'weberstatesports.com', sports: ['football', "men's basketball", "women's basketball"], espnId: '2692', espnSports: ['football', "men's basketball", "women's basketball"] },
      { name: 'Southern Utah University', site: 'suutbirds.com', sports: ['football', "men's basketball", "women's basketball"], espnId: '253', espnSports: ['football', "men's basketball", "women's basketball"] },
      { name: 'Utah Tech University', site: 'utahtechtrailblazers.com', sports: ['football', "men's basketball", "women's basketball"], espnId: '3101', espnSports: ['football', "men's basketball", "women's basketball"] },
    ],
  },
  pro: {
    label: 'Utah professional teams',
    userLabel: "Utah's professional sports teams",
    teams: [
      { name: 'Utah Mammoth', league: 'NHL', site: 'nhl.com/utah', feed: { kind: 'espn', path: 'hockey/nhl', id: '129764' } },
      { name: 'Real Salt Lake', league: 'MLS', site: 'rsl.com', feed: { kind: 'espn', path: 'soccer/usa.1', id: '4771' } },
      { name: 'Utah Royals FC', league: 'NWSL', site: 'utahroyalsfc.com', feed: { kind: 'espn', path: 'soccer/usa.nwsl', id: '19141' } },
      { name: 'Utah Jazz', league: 'NBA', site: 'nba.com/jazz', feed: { kind: 'espn', path: 'basketball/nba', id: '26' } },
      { name: 'Salt Lake Bees', league: 'AAA baseball, Pacific Coast League', site: 'milb.com/salt-lake', feed: { kind: 'mlb', sportId: 11, id: 561 } },
    ],
  },
  concerts: {
    label: 'Utah venues',
    venues: [
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
    ],
  },
  hs: {
    label: 'Utah 6A high schools',
    userLabel: "Utah's 6A high school teams",
    stateName: 'Utah',
    governingBody: 'UHSAA (uhsaa.org)',
    exampleSchool: 'Davis High School',
    // Utah's 6A classification, 2025-27 UHSAA realignment cycle - verified via
    // uhsaa.org and cross-checked against a second independent source.
    schools: [
      'Davis High School',
      'Farmington High School',
      'Layton High School',
      'Syracuse High School',
      'Weber High School',
      'Bingham High School',
      'Cedar Valley High School',
      'Copper Hills High School',
      'Herriman High School',
      'Mountain Ridge High School',
      'Riverton High School',
      'Westlake High School',
      'American Fork High School',
      'Corner Canyon High School',
      'Lehi High School',
      'Lone Peak High School',
      'Skyridge High School',
    ],
    sports: ['football', "boys' basketball", "girls' basketball"],
  },
};

// Treasure Valley (Boise area). Anchored on Meridian - the middle of the
// valley - so Boise, Eagle, Star, Kuna, Nampa, Caldwell, Middleton, Garden
// City and Emmett all fall inside the 25 mile radius (Emmett is the
// farthest at about 19 miles). America/Boise is Mountain time, same UTC
// offset and DST rules as America/Denver.
const BOISE: Region = {
  id: 'boise',
  sourceSuffix: '_boise',
  timezone: 'America/Boise',
  anchor: () => ({
    lat: 43.6121,
    lng: -116.3915,
    label: 'Meridian, Idaho (the Treasure Valley: Boise, Eagle, Star, Kuna, Nampa, Caldwell, Middleton, Garden City, and Emmett)',
  }),
  examples: {
    cityDayName: 'Meridian Days',
    collegeGame: 'Boise State Football vs. Fresno State',
    collegeVenue: 'Albertsons Stadium, Boise, ID',
    proGame: 'Idaho Steelheads vs. Allen Americans',
    proVenue: 'Idaho Central Arena, Boise, ID',
    hsGame: 'Rocky Mountain Football vs. Eagle',
    hsVenue: 'Rocky Mountain High School, Meridian, ID',
  },
  calendar: {
    siteLabel: 'Treasure Valley event calendars',
    // thisisboise.com publishes a new page each year, named for the year.
    urls: [
      'https://totallyboise.com/events',
      'https://boisewithkids.com/events/',
      'https://www.hellomeridian.com/calendar',
      'https://seekidaho.com/calendar',
      `https://thisisboise.com/${new Date().getFullYear()}-boise-and-treasure-valley-area-annual-event-calendar/`,
    ],
    guidance: (anchorLabel) =>
      `These pages cover the whole Treasure Valley (and sometimes the wider region), so only keep what's ` +
      `actually near ${anchorLabel} - skip anything for a clearly distant city. Pull every dated listing within ` +
      `range, not just the first one you see, and check whether it recurs (e.g. a weekly farmers market or a ` +
      `summer concert or movie series) so you can list several upcoming dates rather than just one. If a page ` +
      `links to a more specific city or category page that looks relevant, fetch that one too.`,
  },
  allevents: {
    // Boise pages carry more listings; 16000 ran out of room before the model
    // could record its results.
    maxTokens: 32000,
    // Slugs checked live - allevents.in has no page for Kuna.
    urls: [
      'https://allevents.in/boise/all',
      'https://allevents.in/meridian-id/all',
      'https://allevents.in/eagle-id/all',
      'https://allevents.in/star-id/all',
      'https://allevents.in/nampa/all',
      'https://allevents.in/caldwell-id/all',
      'https://allevents.in/garden-city-id/all',
      'https://allevents.in/emmett-id/all',
    ],
  },
  cityDays: {
    intro:
      `Most Treasure Valley cities run their own annual community celebration (e.g. Meridian Days, Eagle Fun ` +
      `Days, Kuna Days, Emmett's Cherry Festival, Nampa's Parade America, the Caldwell Night Rodeo) - usually a ` +
      `multi-day festival with a parade, carnival, rodeo, or fireworks, announced on that city's own website ` +
      `with no single directory listing all of them.`,
    cities: [
      'Boise',
      'Garden City',
      'Meridian',
      'Eagle',
      'Star',
      'Kuna',
      'Nampa',
      'Caldwell',
      'Middleton',
      'Emmett',
    ],
    userPrompt: `Find each Treasure Valley city's annual community celebration`,
  },
  college: {
    label: 'Treasure Valley college teams',
    userLabel: 'Treasure Valley college teams (Boise State, College of Idaho, Northwest Nazarene)',
    schools: [
      { name: 'Boise State University', site: 'broncosports.com', sports: ['football', "men's basketball", "women's basketball"], espnId: '68', espnSports: ['football', "men's basketball", "women's basketball"] },
      { name: 'College of Idaho', site: 'yoteathletics.com', sports: ['football', "men's basketball", "women's basketball"], espnId: '108382', espnSports: ['football'] },
      // Northwest Nazarene has no football program.
      { name: 'Northwest Nazarene University', site: 'nnusports.com', sports: ["men's basketball", "women's basketball"] },
    ],
  },
  pro: {
    label: 'Treasure Valley professional teams',
    userLabel: "the Treasure Valley's professional sports teams",
    // Idaho Horsemen (indoor football) left out: dormant, last played 2025.
    teams: [
      { name: 'Idaho Steelheads', league: 'ECHL hockey', site: 'idahosteelheads.com' },
      { name: 'Boise Hawks', league: 'independent baseball, Pioneer League', site: 'boisehawks.com' },
      { name: 'Athletic Club Boise', league: 'USL League One soccer', site: 'acboise.com' },
    ],
  },
  concerts: {
    label: 'Treasure Valley venues',
    venues: [
      { name: 'ExtraMile Arena', city: 'Boise, ID' },
      { name: 'Idaho Central Arena', city: 'Boise, ID' },
      { name: 'Ford Idaho Center', city: 'Nampa, ID' },
      { name: 'Outlaw Field at the Idaho Botanical Garden', city: 'Boise, ID' },
      { name: 'Treefort Music Hall', city: 'Boise, ID' },
      { name: 'Revolution Concert House', city: 'Garden City, ID' },
      { name: 'Knitting Factory Concert House', city: 'Boise, ID' },
      { name: 'Morrison Center for the Performing Arts', city: 'Boise, ID' },
      { name: 'Egyptian Theatre', city: 'Boise, ID' },
      { name: 'Neurolux Lounge', city: 'Boise, ID' },
      { name: 'Albertsons Stadium', city: 'Boise, ID' },
    ],
  },
  hs: {
    label: 'Idaho 6A high schools',
    userLabel: "the Treasure Valley's 6A high school teams",
    stateName: 'Idaho',
    governingBody: 'IHSAA (idhsaa.org)',
    exampleSchool: 'Rocky Mountain High School',
    // Idaho's top classification (6A, 1400+ enrollment) in the 2026-28 IHSAA
    // cycle, Treasure Valley (District III) schools only - read directly
    // from the IHSAA 2026-28 member schools directory.
    schools: [
      'Boise High School',
      'Borah High School',
      'Capital High School',
      'Centennial High School',
      'Eagle High School',
      'Kuna High School',
      'Meridian High School',
      'Middleton High School',
      'Mountain View High School',
      'Owyhee High School',
      'Ridgevue High School',
      'Rocky Mountain High School',
      'Timberline High School',
    ],
    sports: ['football', "boys' basketball", "girls' basketball"],
  },
};

const REGIONS: Record<RegionId, Region> = { utah: UTAH, boise: BOISE };

// No region (or an empty body, which is what the existing cron jobs send)
// means Utah - existing behavior is unchanged. An unrecognized region is an
// error rather than silently falling back to Utah.
export function getRegion(id: unknown): Region {
  if (id === undefined || id === null || id === '') return UTAH;
  const region = REGIONS[id as RegionId];
  if (!region) throw new Error(`Unknown region: ${String(id)}`);
  return region;
}

// Returns a copy of a tool schema with each [utahExample, thisRegionExample]
// pair swapped in. For Utah the pair is identical, so the schema is unchanged.
export function swapExamples<T>(schema: T, pairs: [string, string][]): T {
  let json = JSON.stringify(schema);
  for (const [from, to] of pairs) json = json.split(from).join(to);
  return JSON.parse(json) as T;
}
