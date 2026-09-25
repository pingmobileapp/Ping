import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Location text -> coordinates, cached in geocode_cache so a venue that
// shows up night after night is only looked up once. Nominatim is tried
// first; Photon (also OpenStreetMap data) whenever Nominatim has no
// answer - Nominatim started refusing every request from Supabase's
// servers on 2026-09-24, and Photon also resolves fuzzier venue strings
// ("Greater Zion Stadium, Saint George, UT") that Nominatim misses.
//
// A miss is only cached when both services actually answered "no match".
// A refused/failed request is never cached - it used to be, which turned
// a temporary outage into a permanent "this place doesn't exist".

type Coords = { lat: number; lng: number };
// 'error' = the service didn't answer (refused, rate-limited, network);
// null = it answered and found nothing.
type Lookup = Coords | null | 'error';

// Both public instances ask for roughly 1 request/second from one client.
let lastCallAt = 0;
async function throttle() {
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < 1100) await new Promise((r) => setTimeout(r, 1100 - elapsed));
  lastCallAt = Date.now();
}

async function nominatim(query: string, userAgent: string): Promise<Lookup> {
  await throttle();
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
    if (!res.ok) {
      console.error('Nominatim refused:', res.status, query);
      return 'error';
    }
    const results = await res.json();
    const first = Array.isArray(results) ? results[0] : null;
    const lat = first ? Number(first.lat) : NaN;
    const lng = first ? Number(first.lon) : NaN;
    return Number.isNaN(lat) || Number.isNaN(lng) ? null : { lat, lng };
  } catch (err) {
    console.error('Nominatim failed:', query, err);
    return 'error';
  }
}

async function photon(query: string, userAgent: string): Promise<Lookup> {
  await throttle();
  try {
    const url = `https://photon.komoot.io/api/?limit=5&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
    if (!res.ok) {
      console.error('Photon refused:', res.status, query);
      return 'error';
    }
    const data = await res.json();
    // Photon has no country filter, so pick the first US match.
    const us = (data?.features ?? []).find((f: any) => f?.properties?.countrycode === 'US');
    const [lng, lat] = us?.geometry?.coordinates ?? [];
    return typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null;
  } catch (err) {
    console.error('Photon failed:', query, err);
    return 'error';
  }
}

export async function geocodeLocation(
  admin: ReturnType<typeof createClient>,
  locationText: string,
  userAgent = 'PingApp-Discover/1.0'
): Promise<Coords | null> {
  const key = locationText.trim().toLowerCase();
  if (!key) return null;

  const { data: cached } = await admin
    .from('geocode_cache')
    .select('lat, lng')
    .eq('location_text', key)
    .maybeSingle();
  if (cached) {
    return cached.lat !== null && cached.lng !== null ? { lat: cached.lat, lng: cached.lng } : null;
  }

  const first = await nominatim(locationText, userAgent);
  const result = first && first !== 'error' ? first : await photon(locationText, userAgent);
  if (result === 'error' || (result === null && first === 'error')) return null;

  await admin.from('geocode_cache').upsert({
    location_text: key,
    lat: result ? result.lat : null,
    lng: result ? result.lng : null,
  });
  return result;
}
