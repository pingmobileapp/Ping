import { geocodeEventLocation } from './eventWeather';

// A Ping's times are entered in one time zone (events.time_zone): the
// host's own by default, or the place it's at. event_date/end_date stay
// exact moments; this file converts between those and the clock in that
// zone. Added after a Ping typed in Utah for a trip to Arizona showed an
// hour early once the phone switched zones (TestFlight 1.1.11, 2026-10-22).
//
// Create and Edit keep their pickers' Dates as "wall clock" values: the
// phone-local fields of the Date are the hours and minutes in the Ping's
// zone. wallClockIn turns a saved moment into one, instantFromWallClock
// turns one back. In the phone's own zone both are no-ops.

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function partsIn(instant: Date, timeZone: string) {
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  for (const p of format.formatToParts(instant)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some engines write midnight as "24" with hour12: false.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// How far ahead of UTC the zone's clock is at that moment, in ms.
function offsetMs(instantMs: number, timeZone: string): number {
  const p = partsIn(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

const isDeviceZone = (timeZone: string | null | undefined) => !timeZone || timeZone === deviceTimeZone();

export function wallClockIn(instant: Date, timeZone: string | null | undefined): Date {
  if (isDeviceZone(timeZone)) return new Date(instant);
  try {
    const p = partsIn(instant, timeZone!);
    return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, instant.getMilliseconds());
  } catch {
    return new Date(instant);
  }
}

export function instantFromWallClock(wall: Date, timeZone: string | null | undefined): Date {
  if (isDeviceZone(timeZone)) return new Date(wall);
  try {
    const target = Date.UTC(
      wall.getFullYear(),
      wall.getMonth(),
      wall.getDate(),
      wall.getHours(),
      wall.getMinutes(),
      wall.getSeconds(),
    );
    // Twice, so a time right next to a daylight-saving switch settles on
    // the offset actually in effect then.
    let guess = target - offsetMs(target, timeZone!);
    guess = target - offsetMs(guess, timeZone!);
    return new Date(guess + wall.getMilliseconds());
  } catch {
    return new Date(wall);
  }
}

// "MST", "PDT" - or "GMT+1" where there's no common abbreviation.
export function zoneAbbreviation(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

// The choices in the Time Zone picker, US first. Any other zone (the
// phone's own, or one found from a Ping's location) is added by name.
export const COMMON_TIME_ZONES: { label: string; zone: string }[] = [
  { label: 'Pacific Time', zone: 'America/Los_Angeles' },
  { label: 'Mountain Time', zone: 'America/Denver' },
  { label: 'Arizona', zone: 'America/Phoenix' },
  { label: 'Central Time', zone: 'America/Chicago' },
  { label: 'Eastern Time', zone: 'America/New_York' },
  { label: 'Alaska', zone: 'America/Anchorage' },
  { label: 'Hawaii', zone: 'Pacific/Honolulu' },
  { label: 'Puerto Rico', zone: 'America/Puerto_Rico' },
  { label: 'Mexico City', zone: 'America/Mexico_City' },
  { label: 'London', zone: 'Europe/London' },
  { label: 'Paris, Berlin, Rome', zone: 'Europe/Paris' },
  { label: 'Athens', zone: 'Europe/Athens' },
  { label: 'Dubai', zone: 'Asia/Dubai' },
  { label: 'India', zone: 'Asia/Kolkata' },
  { label: 'Tokyo', zone: 'Asia/Tokyo' },
  { label: 'Sydney', zone: 'Australia/Sydney' },
  { label: 'Auckland', zone: 'Pacific/Auckland' },
];

// "Arizona", or the city from the zone's name ("America/Boise" → "Boise").
export function zoneLabel(timeZone: string): string {
  const known = COMMON_TIME_ZONES.find((z) => z.zone === timeZone);
  if (known) return known.label;
  const city = timeZone.split('/').pop() ?? timeZone;
  return city.replace(/_/g, ' ');
}

// "6:30 PM MST" - the Ping's start on its own clock, for the event screen
// when that zone isn't the viewer's. Null when there's nothing to add.
export function timeInEventZone(instant: Date, timeZone: string | null | undefined): string | null {
  if (isDeviceZone(timeZone)) return null;
  // Same clock right now (Phoenix vs Denver in winter) - nothing to say.
  if (offsetMs(instant.getTime(), timeZone!) === offsetMs(instant.getTime(), deviceTimeZone())) return null;
  try {
    const time = instant.toLocaleTimeString('en-US', { timeZone: timeZone!, hour: 'numeric', minute: '2-digit' });
    return `${time} ${zoneAbbreviation(timeZone!, instant)}`;
  } catch {
    return null;
  }
}

const zoneCache = new Map<string, string | null>();

// The time zone a Ping's location is in, or null. Only for text that reads
// like a real address or town ("Scottsdale, AZ", "7700 E McCormick Pkwy") -
// a free-text geocoder will happily match "Living Room" to a street in
// another state, and a wrong zone here would quietly shift the Ping's time.
export async function timeZoneForLocation(location: string): Promise<string | null> {
  const text = location.trim();
  if (!text || !/[\d,]/.test(text)) return null;
  const key = text.toLowerCase();
  if (zoneCache.has(key)) return zoneCache.get(key)!;
  let zone: string | null = null;
  try {
    const coords = await geocodeEventLocation(text);
    if (coords) {
      const res = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lng}&timezone=auto&forecast_days=1`,
      );
      if (res.ok) {
        const json = await res.json();
        if (typeof json?.timezone === 'string' && json.timezone.includes('/')) zone = json.timezone;
      }
    }
  } catch (err) {
    console.error('Error looking up time zone for location:', err);
  }
  zoneCache.set(key, zone);
  return zone;
}
