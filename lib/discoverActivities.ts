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
  // Null until real per-user device location exists (see the Open Slots
  // roadmap) - AI-search rows in particular have no reliable coordinates
  // to measure from yet. The UI just omits distance when this is null
  // rather than showing a fake number.
  distanceMiles: number | null;
  startsAt: string; // ISO
  endsAt: string | null; // ISO
  priceLabel: string | null;
  url: string | null;
  confidence: 'high' | 'low';
};

type ActivityRow = {
  id: string;
  source: string;
  title: string;
  category: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  price_label: string | null;
  url: string | null;
  confidence: string;
};

const isKnownCategory = (c: string): c is ActivityCategory => c in CATEGORY_LABELS;

const toActivity = (row: ActivityRow): Activity => ({
  id: row.id,
  source: row.source,
  title: row.title,
  category: isKnownCategory(row.category) ? row.category : 'community',
  description: row.description,
  location: row.location,
  distanceMiles: null,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  priceLabel: row.price_label,
  url: row.url,
  confidence: row.confidence === 'low' ? 'low' : 'high',
});

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

  const { data, error } = await supabase
    .from('activities')
    .select('id, source, title, category, description, location, starts_at, ends_at, price_label, url, confidence')
    .gte('starts_at', rangeStart.toISOString())
    .lte('starts_at', rangeEnd.toISOString())
    .order('starts_at', { ascending: true });

  if (error) {
    console.error('Error fetching activities:', error);
    return [];
  }

  return (data as ActivityRow[]).map(toActivity);
}
