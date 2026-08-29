import { supabase } from '../supabase';
import { getCurrentCoords, getLocationPermissionStatus } from './location';

// Shows expected weather on the lower-right of a Ping's card (see
// EventCard.tsx). A specific, real-sounding location ("Creekside Park",
// "123 Main St, Provo, UT") gets its own actual forecast via geocoding;
// something that isn't a real geocodable place ("Living Room", "Mom and
// Dad's house") - or no location at all - falls back to the device's
// general area instead of showing nothing. Never prompts for location
// permission itself (Home isn't where someone opted into that) - only
// uses it if already granted, e.g. from using Discover.

export type DailyWeather = { tempF: number; icon: string } | null;

const WEATHER_ICONS: Record<number, string> = {
  0: '☀️',
  1: '🌤️',
  2: '⛅',
  3: '☁️',
  45: '🌫️',
  48: '🌫️',
  51: '🌦️',
  53: '🌦️',
  55: '🌦️',
  56: '🌧️',
  57: '🌧️',
  61: '🌧️',
  63: '🌧️',
  65: '🌧️',
  66: '🌧️',
  67: '🌧️',
  71: '🌨️',
  73: '🌨️',
  75: '🌨️',
  77: '🌨️',
  80: '🌦️',
  81: '🌧️',
  82: '⛈️',
  85: '🌨️',
  86: '🌨️',
  95: '⛈️',
  96: '⛈️',
  99: '⛈️',
};

// Session-lifetime only, not persisted - geocoding results rarely change
// and re-fetching per app open is cheap (a handful of requests, all
// cached server-side in geocode_cache regardless), so there's no need for
// AsyncStorage durability here.
const geocodeCache = new Map<string, { lat: number; lng: number } | null>();
const forecastCache = new Map<string, Record<string, DailyWeather>>();

async function geocodeEventLocation(location: string): Promise<{ lat: number; lng: number } | null> {
  const key = location.trim().toLowerCase();
  if (!key) return null;
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;

  let result: { lat: number; lng: number } | null = null;
  try {
    const { data, error } = await supabase.functions.invoke('geocode-location', { body: { location } });
    if (!error && data && data.lat != null && data.lng != null) {
      result = { lat: data.lat, lng: data.lng };
    }
  } catch (err) {
    console.error('Error geocoding event location:', err);
  }
  geocodeCache.set(key, result);
  return result;
}

async function fetchForecastForCoords(lat: number, lng: number): Promise<Record<string, DailyWeather>> {
  // Rounded to ~1km - plenty for a daily forecast, and keeps nearby events
  // (or repeated device-location fallbacks) sharing one cache entry/fetch
  // instead of a fresh call each time for a near-identical spot.
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (forecastCache.has(key)) return forecastCache.get(key)!;

  let map: Record<string, DailyWeather> = {};
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&daily=temperature_2m_max,weathercode&temperature_unit=fahrenheit&timezone=auto&forecast_days=16`;
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      const days: string[] = json?.daily?.time ?? [];
      const highs: number[] = json?.daily?.temperature_2m_max ?? [];
      const codes: number[] = json?.daily?.weathercode ?? [];
      days.forEach((dateKey, i) => {
        if (highs[i] == null) return;
        map[dateKey] = { tempF: Math.round(highs[i]), icon: WEATHER_ICONS[codes[i]] ?? '🌡️' };
      });
    }
  } catch (err) {
    console.error('Error fetching forecast:', err);
  }
  forecastCache.set(key, map);
  return map;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toDateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const haversineMiles = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const R = 3958.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Nominatim's free-text search will happily match something like "Living
// Room" to an actual place literally named that - seen live matching to a
// residential subdivision in North Carolina for a family whose event was
// in Utah. A wildly-distant "confident" match is worse than no match at
// all (looks authoritative, is wrong), so anything more than this many
// miles from the device's own location is treated as a bad match rather
// than trusted.
const MAX_PLAUSIBLE_MILES_FROM_DEVICE = 100;

// Resolves weather for a batch of Ping events at once - groups by unique
// location text so every event sharing the same spot (or every event with
// no location, falling back to the same device-area coords) only
// geocodes/fetches once, not once per card.
export async function fetchWeatherForEvents(
  events: { id: string; location: string | null; event_date: string }[]
): Promise<Record<string, DailyWeather>> {
  const permission = await getLocationPermissionStatus();
  const deviceCoords = permission === 'granted' ? await getCurrentCoords() : null;

  const uniqueLocations = Array.from(new Set(events.map((e) => (e.location || '').trim()).filter(Boolean)));
  const geocoded = new Map<string, { lat: number; lng: number } | null>();
  for (const loc of uniqueLocations) {
    let coords = await geocodeEventLocation(loc);
    if (coords && deviceCoords) {
      const distance = haversineMiles(deviceCoords.latitude, deviceCoords.longitude, coords.lat, coords.lng);
      if (distance > MAX_PLAUSIBLE_MILES_FROM_DEVICE) coords = null;
    }
    geocoded.set(loc, coords);
  }

  const result: Record<string, DailyWeather> = {};
  for (const event of events) {
    const dateKey = toDateKey(new Date(event.event_date));
    const specific = event.location ? geocoded.get(event.location.trim()) : null;
    const coords = specific ?? (deviceCoords ? { lat: deviceCoords.latitude, lng: deviceCoords.longitude } : null);
    if (!coords) {
      result[event.id] = null;
      continue;
    }
    const forecast = await fetchForecastForCoords(coords.lat, coords.lng);
    result[event.id] = forecast[dateKey] ?? null;
  }
  return result;
}
