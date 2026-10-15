// Itinerary stops on a Ping - where the group is each day/night
// of a trip (asked for 2026-10-13: a motorcycle ride staying at a different
// hotel each night). Stored as a JSON array on events.stops; any number of
// stops per day, kept in day order.
import * as Crypto from 'expo-crypto';
import { eachDayKeyInRange } from './eventDate';

export type EventStop = {
  id: string;
  day: string; // YYYY-MM-DD, local
  name: string;
  address: string;
};

export const MAX_STOPS = 60; // matches the events_stops_is_small_array check

export const toDayKey = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export function newStop(day: string): EventStop {
  return { id: Crypto.randomUUID(), day, name: '', address: '' };
}

// Every day a stop can land on - the event's own date range.
export function stopDays(start: Date, end: Date | null): string[] {
  const startKey = toDayKey(start);
  const endKey = end ? toDayKey(end) : startKey;
  return endKey < startKey ? [startKey] : eachDayKeyInRange(startKey, endKey);
}

// What actually gets saved: blank rows dropped, text trimmed, any stop the
// date range no longer covers (the trip got shortened) moved onto the
// nearest day it still has, then day order - stable, so stops on the same
// day keep the order the host added them in.
export function cleanStops(stops: EventStop[], days: string[]): EventStop[] {
  if (days.length === 0) return [];
  const first = days[0];
  const last = days[days.length - 1];
  return stops
    .map((s) => ({ ...s, name: s.name.trim(), address: s.address.trim() }))
    .filter((s) => s.name || s.address)
    .map((s) => ({ ...s, day: s.day < first ? first : s.day > last ? last : s.day }))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.day === b.s.day ? a.i - b.i : a.s.day < b.s.day ? -1 : 1))
    .map(({ s }) => s)
    .slice(0, MAX_STOPS);
}

// A repeating multi-day Ping copies its stops onto each occurrence, moved
// by however many days that occurrence starts after the first one.
export function shiftStops(stops: EventStop[], fromStart: Date, toStart: Date): EventStop[] {
  const from = new Date(fromStart.getFullYear(), fromStart.getMonth(), fromStart.getDate());
  const to = new Date(toStart.getFullYear(), toStart.getMonth(), toStart.getDate());
  const offset = Math.round((to.getTime() - from.getTime()) / 86400000);
  if (offset === 0) return stops;
  return stops.map((s) => {
    const [y, m, d] = s.day.split('-').map(Number);
    return { ...s, id: Crypto.randomUUID(), day: toDayKey(new Date(y, m - 1, d + offset)) };
  });
}

// Defensive read of the jsonb column - rows from before it existed, or
// anything malformed, just mean "no stops".
export function parseStops(value: unknown): EventStop[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s) => s && typeof s === 'object' && typeof s.day === 'string')
    .map((s) => ({
      id: typeof s.id === 'string' ? s.id : Crypto.randomUUID(),
      day: s.day,
      name: typeof s.name === 'string' ? s.name : '',
      address: typeof s.address === 'string' ? s.address : '',
    }));
}

export function formatStopDay(day: string, style: 'chip' | 'heading' = 'heading'): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(
    undefined,
    style === 'chip' ? { weekday: 'short', day: 'numeric' } : { weekday: 'long', month: 'short', day: 'numeric' }
  );
}
