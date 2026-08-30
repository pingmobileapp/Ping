import { supabase } from '../supabase';

// Backs the Discover feature - real data now, written by the
// refresh-activities edge function (Ticketmaster/SeatGeek + an
// AI-assisted web search for the long tail, see that function's own
// comments) on a nightly schedule (supabase/activities_cron.sql). This
// file only reads what's already there; nothing here calls an external
// API or AI itself.

export type ActivityCategory =
  | 'movies'
  | 'music'
  | 'dance'
  | 'carnival'
  | 'farmers_market'
  | 'family'
  | 'sports'
  | 'community';

export const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  movies: 'Movies',
  music: 'Music',
  dance: 'Dances',
  carnival: 'Carnivals',
  farmers_market: 'Farmers Markets',
  family: 'Family',
  sports: 'Sports',
  community: 'Community',
};

export type Activity = {
  id: string;
  source: string;
  title: string;
  category: ActivityCategory;
  description: string | null;
  location: string | null;
  lat: number | null;
  lng: number | null;
  // The distance refresh-activities verified against its fixed anchor
  // location, not the actual device - see distanceFromCoords below for the
  // real per-user figure once location permission is granted. Null only
  // means it couldn't be geocoded/verified at all, never "trust it, it's
  // probably close."
  distanceMiles: number | null;
  startsAt: string; // ISO
  endsAt: string | null; // ISO
  priceLabel: string | null;
  url: string | null;
  confidence: 'high' | 'low';
  // Set only for a Ping a host listed on Discover (source === 'ping') -
  // the real events.id to open via /event/[id] for the full RSVP/detail
  // experience, since these aren't ticketed listings with an external URL.
  pingEventId?: string;
};

// The join key discover_interests actually keys on - see that table's own
// comment for why this is title+time rather than the activity's own id
// (every ai_search_* source deletes and reinserts nightly with fresh ids,
// so a star tied to the raw id would vanish the very next refresh even
// for the exact same real-world event).
export const activityKey = (activity: { title: string; startsAt: string }): string =>
  `${activity.title.trim().toLowerCase()}|${activity.startsAt}`;

type ActivityRow = {
  id: string;
  source: string;
  title: string;
  category: string;
  description: string | null;
  location: string | null;
  lat: number | null;
  lng: number | null;
  starts_at: string;
  ends_at: string | null;
  price_label: string | null;
  url: string | null;
  confidence: string;
  distance_miles: number | null;
};

const isKnownCategory = (c: string): c is ActivityCategory => c in CATEGORY_LABELS;

const toActivity = (row: ActivityRow): Activity => ({
  id: row.id,
  source: row.source,
  title: row.title,
  category: isKnownCategory(row.category) ? row.category : 'community',
  description: row.description,
  location: row.location,
  lat: row.lat,
  lng: row.lng,
  distanceMiles: row.distance_miles,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  priceLabel: row.price_label,
  url: row.url,
  confidence: row.confidence === 'low' ? 'low' : 'high',
});

// Recomputes a real distance from the device's actual location once it's
// available, rather than showing the figure refresh-activities verified
// against its fixed anchor (see DISCOVER_ANCHOR_LAT/LNG) - falls back to
// that server-verified distance if the activity has no coordinates of its
// own (a geocoding miss) or the device hasn't granted location yet.
export function distanceFromCoords(activity: Activity, coords: { latitude: number; longitude: number } | null): number | null {
  if (!coords || activity.lat === null || activity.lng === null) return activity.distanceMiles;
  const R = 3958.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(activity.lat - coords.latitude);
  const dLng = toRad(activity.lng - coords.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(coords.latitude)) * Math.cos(toRad(activity.lat)) * Math.sin(dLng / 2) ** 2;
  const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(distance * 10) / 10;
}

// Ticketmaster/SeatGeek pull in plenty of paid listings, so "Free" is its
// own filter rather than a category - matches the AI search prompt's own
// price_label convention ("Free", "Free entry", etc.) without also
// catching something like "$5 (free for kids)".
export const isFreeActivity = (activity: Activity): boolean =>
  !!activity.priceLabel && /^free\b/i.test(activity.priceLabel.trim());

// Real-world events picked up by more than one source look like separate
// rows to the database - the same BYU game can show up via Ticketmaster,
// via the AI web search, and via the utahagenda.com crawl all at once,
// with no shared id to tie them together. Title wording alone is a weak
// signal ("BYU Football Game" vs "BYU Cougars Football vs. Utah State"),
// so venue+time is the main confirming signal - but venue+time ALONE is
// not safe either: a large venue like an expo center routinely hosts
// multiple genuinely distinct events at the exact same start time (seen
// live: "Crystal Festival" and "Rocky Mountain Gun Show," same venue,
// same timestamp, two completely unrelated events). Titles must always
// share at least some minimal real overlap before venue+time gets to
// confirm a match at all - that's what keeps this from merging two
// different things that just happen to share a building.
const TIME_TOLERANCE_MS = 90 * 60000;
const MIN_TITLE_OVERLAP = 0.12;
const LOCATION_SIMILARITY_THRESHOLD = 0.4;
const STRONG_TITLE_THRESHOLD = 0.6;

// Ticketmaster/SeatGeek carry real prices, links, and venue data pulled
// straight from the ticketing platform itself - when the same real event
// also turns up via AI search, the ticketed listing is the one worth
// keeping.
const SOURCE_PRIORITY: Record<string, number> = {
  ticketmaster: 3,
  seatgeek: 3,
  ai_search_utahagenda: 2,
  ai_search_collegesports: 2,
  ai_search_prosports: 2,
  ai_search_concerts: 2,
  ai_search_hs6a: 2,
  ai_search: 1,
};

const wordSet = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );

const jaccardSimilarity = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection++;
  return intersection / (a.size + b.size - intersection);
};

// Keeps the highest-priority activity out of each cluster of apparent
// duplicates - order activities are compared in doesn't matter, since
// every candidate is checked against the full priority-sorted "kept" list
// built so far.
export function dedupeActivities(activities: Activity[]): Activity[] {
  const bySourcePriority = [...activities].sort(
    (a, b) => (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0)
  );

  const kept: Activity[] = [];
  for (const candidate of bySourcePriority) {
    const candidateStart = new Date(candidate.startsAt).getTime();
    const candidateLocation = wordSet(candidate.location ?? '');
    const candidateTitle = wordSet(candidate.title);

    const isDuplicate = kept.some((existing) => {
      if (Math.abs(new Date(existing.startsAt).getTime() - candidateStart) > TIME_TOLERANCE_MS) return false;

      const titleSimilarity = jaccardSimilarity(candidateTitle, wordSet(existing.title));
      // Titles sharing basically nothing are never the same event, no
      // matter how well the venue/time line up - this is what protects
      // two unrelated events at the same venue/time from merging.
      if (titleSimilarity < MIN_TITLE_OVERLAP) return false;
      if (titleSimilarity >= STRONG_TITLE_THRESHOLD) return true;

      const existingLocation = wordSet(existing.location ?? '');
      if (candidateLocation.size === 0 || existingLocation.size === 0) return false;
      return jaccardSimilarity(candidateLocation, existingLocation) >= LOCATION_SIMILARITY_THRESHOLD;
    });

    if (!isDuplicate) kept.push(candidate);
  }

  return kept.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

type EventListingRow = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  event_date: string;
  end_date: string | null;
  discover_category: string | null;
};

const toListingActivity = (row: EventListingRow): Activity => ({
  id: `ping-${row.id}`,
  source: 'ping',
  title: row.title,
  category: row.discover_category && isKnownCategory(row.discover_category) ? row.discover_category : 'community',
  description: row.description,
  location: row.location,
  lat: null,
  lng: null,
  distanceMiles: null,
  startsAt: row.event_date,
  endsAt: row.end_date,
  // Ping listings have no ticketing/payment path yet (a future phase of
  // Discover) - every one shown today is free to join.
  priceLabel: 'Free',
  url: null,
  confidence: 'high',
  pingEventId: row.id,
});

// Pings a host has explicitly listed on Discover (see the "List on
// Discover" toggle in CreateEventModal/EditEventModal) - a real events row
// each, so no dedup pass needed the way the multi-source aggregator
// activities do.
async function fetchUserListings(rangeStart: Date, rangeEnd: Date): Promise<Activity[]> {
  const { data, error } = await supabase
    .from('events')
    .select('id, title, description, location, event_date, end_date, discover_category')
    .eq('discoverable', true)
    .eq('status', 'sent')
    .gte('event_date', rangeStart.toISOString())
    .lte('event_date', rangeEnd.toISOString())
    .order('event_date', { ascending: true });

  if (error) {
    console.error('Error fetching Discover listings:', error);
    return [];
  }

  return (data as EventListingRow[]).map(toListingActivity);
}

// dateKey: scope to just that one day (yyyy-mm-dd), as when arriving from
// a long-pressed gap in WeekGrid. Omitted for the plain "browse" case,
// which instead looks ahead daysAhead days from now.
export async function fetchActivities(options: { dateKey?: string; daysAhead?: number }): Promise<Activity[]> {
  let rangeStart: Date;
  let rangeEnd: Date;

  if (options.dateKey) {
    const [y, m, d] = options.dateKey.split('-').map(Number);
    rangeStart = new Date(y, m - 1, d, 0, 0, 0);
    rangeEnd = new Date(y, m - 1, d, 23, 59, 59);
  } else {
    rangeStart = new Date();
    rangeEnd = new Date();
    rangeEnd.setDate(rangeEnd.getDate() + (options.daysAhead ?? 30));
  }

  const [{ data, error }, listings] = await Promise.all([
    supabase
      .from('activities')
      .select(
        'id, source, title, category, description, location, lat, lng, starts_at, ends_at, price_label, url, confidence, distance_miles'
      )
      .gte('starts_at', rangeStart.toISOString())
      .lte('starts_at', rangeEnd.toISOString())
      .order('starts_at', { ascending: true }),
    fetchUserListings(rangeStart, rangeEnd),
  ]);

  if (error) {
    console.error('Error fetching activities:', error);
    return listings.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }

  const deduped = dedupeActivities((data as ActivityRow[]).map(toActivity));
  return [...deduped, ...listings].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
  );
}

// The full set of the current user's starred activity_keys - Discover
// checks each card it renders against this to decide filled vs. hollow.
export async function fetchInterestedKeys(): Promise<Set<string>> {
  const { data, error } = await supabase.from('discover_interests').select('activity_key');
  if (error) {
    console.error('Error fetching Discover interests:', error);
    return new Set();
  }
  return new Set((data || []).map((r) => r.activity_key));
}

// Stars/unstars one activity. A full snapshot of its display fields is
// stored on star (see discover_interests.sql) so Home can render it
// straight from this table later with no join back to activities needed -
// that source row may not even exist anymore by the time Home reads it
// back, since AI-search sources delete-and-reinsert nightly.
export async function toggleInterest(activity: Activity, interested: boolean): Promise<boolean> {
  const key = activityKey(activity);
  if (interested) {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return false;
    const { error } = await supabase.from('discover_interests').insert({
      user_id: userId,
      activity_key: key,
      title: activity.title,
      category: activity.category,
      description: activity.description,
      location: activity.location,
      starts_at: activity.startsAt,
      ends_at: activity.endsAt,
      price_label: activity.priceLabel,
      url: activity.url,
    });
    if (error) {
      console.error('Error starring activity:', error);
      return false;
    }
  } else {
    const { error } = await supabase.from('discover_interests').delete().eq('activity_key', key);
    if (error) {
      console.error('Error unstarring activity:', error);
      return false;
    }
  }
  return true;
}

// Unstars by key alone - for callers (Home) that only have the lightweight
// discover_interests snapshot on hand, not a full Activity to pass through
// toggleInterest.
export async function removeInterestByKey(key: string): Promise<boolean> {
  const { error } = await supabase.from('discover_interests').delete().eq('activity_key', key);
  if (error) {
    console.error('Error unstarring activity:', error);
    return false;
  }
  return true;
}

export type InterestedActivity = {
  activityKey: string;
  title: string;
  location: string | null;
  startsAt: string;
  endsAt: string | null;
};

// Powers Home's light-yellow "interested" cards - a full read from
// discover_interests, not activities, so it shows exactly what the user
// starred even if that night's crawl didn't happen to re-find it.
export async function fetchInterestedActivities(rangeStart: Date, rangeEnd: Date): Promise<InterestedActivity[]> {
  const { data, error } = await supabase
    .from('discover_interests')
    .select('activity_key, title, location, starts_at, ends_at')
    .gte('starts_at', rangeStart.toISOString())
    .lte('starts_at', rangeEnd.toISOString())
    .order('starts_at', { ascending: true });

  if (error) {
    console.error('Error fetching interested activities:', error);
    return [];
  }

  return (data || []).map((row) => ({
    activityKey: row.activity_key,
    title: row.title,
    location: row.location,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  }));
}
