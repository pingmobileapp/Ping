// Discover holds crawled events for more than one area (see
// supabase/functions/_shared/regions.ts). This decides which area's events a
// given person should see, so someone in Boise isn't shown Utah events and
// vice versa. No location (denied, or not asked yet) means Utah - what
// everyone saw before there was a second area.

export type DiscoverRegion = 'utah' | 'boise';

type LatLng = { latitude: number; longitude: number };

// Same point the Boise crawlers are anchored on (Meridian, ID).
const BOISE_ANCHOR: LatLng = { latitude: 43.6121, longitude: -116.3915 };

// Someone this close to Meridian is treated as a Treasure Valley user -
// generous enough to cover Mountain Home, McCall and the surrounding towns.
const BOISE_USER_RADIUS_MILES = 100;

// Crawled events are verified to be within ~30 miles of their anchor, so
// anything within this many miles of Meridian is a Boise-area event.
const BOISE_EVENT_RADIUS_MILES = 60;

function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function regionForCoords(coords: LatLng | null): DiscoverRegion {
  if (!coords) return 'utah';
  const miles = haversineMiles(coords.latitude, coords.longitude, BOISE_ANCHOR.latitude, BOISE_ANCHOR.longitude);
  return miles <= BOISE_USER_RADIUS_MILES ? 'boise' : 'utah';
}

// Which area an activity belongs to, or null when it isn't tied to one.
// Ping listings (a host listing their own event on Discover) are the null
// case: they carry no coordinates and should reach everyone, exactly as
// before.
export function regionOfActivity(activity: {
  source: string;
  lat: number | null;
  lng: number | null;
}): DiscoverRegion | null {
  if (activity.source === 'ping') return null;
  if (activity.source.endsWith('_boise')) return 'boise';
  // Ticketmaster/SeatGeek rows are shared between areas (same source name),
  // so they're told apart by where they actually are.
  if (activity.lat !== null && activity.lng !== null) {
    const miles = haversineMiles(activity.lat, activity.lng, BOISE_ANCHOR.latitude, BOISE_ANCHOR.longitude);
    return miles <= BOISE_EVENT_RADIUS_MILES ? 'boise' : 'utah';
  }
  return 'utah';
}

export function filterActivitiesForRegion<T extends { source: string; lat: number | null; lng: number | null }>(
  activities: T[],
  region: DiscoverRegion
): T[] {
  return activities.filter((a) => {
    const r = regionOfActivity(a);
    return r === null || r === region;
  });
}

// Priority lookups (see SOURCE_PRIORITY) know Utah's source names; a Boise
// source is the same crawler with a "_boise" suffix.
export function baseSource(source: string): string {
  return source.endsWith('_boise') ? source.slice(0, -'_boise'.length) : source;
}

// How far from the person an event can be and still show up.
export const DISCOVER_RADIUS_MILES = 25;

// Narrows to events within DISCOVER_RADIUS_MILES of where the person actually
// is. Only applies with a known location; and an event with no coordinates
// (a Ping listing, or one that couldn't be geocoded) is kept, since it can't
// be shown to be too far away.
export function filterActivitiesNearby<T extends { lat: number | null; lng: number | null }>(
  activities: T[],
  coords: LatLng | null,
  maxMiles: number = DISCOVER_RADIUS_MILES
): T[] {
  if (!coords) return activities;
  return activities.filter(
    (a) =>
      a.lat === null ||
      a.lng === null ||
      haversineMiles(coords.latitude, coords.longitude, a.lat, a.lng) <= maxMiles
  );
}
