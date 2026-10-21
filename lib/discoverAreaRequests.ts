import * as Location from 'expo-location';
import { supabase } from '../supabase';
import { Coords } from './location';

// "Let me know when Discover comes to my area" (see the out-of-area card on
// the Discover tab). One row per person in discover_area_requests - asking
// again from somewhere else just updates it.

export type AreaRequest = { city: string | null; region: string | null };

export async function fetchMyAreaRequest(userId: string): Promise<AreaRequest | null> {
  const { data } = await supabase
    .from('discover_area_requests')
    .select('city, region')
    .eq('user_id', userId)
    .maybeSingle();
  return data ?? null;
}

// The phone's own reverse geocoding (no third-party service), and only a
// rounded (~7 mile) point is stored - enough to see where demand is, not
// where anyone lives.
export async function requestDiscoverForMyArea(userId: string, coords: Coords): Promise<AreaRequest | null> {
  let place: Location.LocationGeocodedAddress | undefined;
  try {
    [place] = await Location.reverseGeocodeAsync(coords);
  } catch (err) {
    console.error('Reverse geocode failed:', err);
  }
  const row = {
    user_id: userId,
    city: place?.city ?? place?.subregion ?? null,
    region: place?.region ?? null,
    country: place?.isoCountryCode ?? place?.country ?? null,
    lat: Math.round(coords.latitude * 10) / 10,
    lng: Math.round(coords.longitude * 10) / 10,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('discover_area_requests').upsert(row, { onConflict: 'user_id' });
  if (error) {
    console.error('Error saving Discover area request:', error);
    return null;
  }
  return { city: row.city, region: row.region };
}

export function describeArea(request: AreaRequest | null): string {
  if (!request) return 'your area';
  if (request.city && request.region) return `${request.city}, ${request.region}`;
  return request.city || request.region || 'your area';
}
