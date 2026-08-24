import { PingEvent } from '../components/EventCard';
import { ExternalEvent } from './calendarConflicts';
import { colors } from './theme';
import { externalItemDuplicatesPing } from './eventDedup';

export type AllDayItem = { id: string; title: string; dayKey: string };
// startMinutes/endMinutes are minutes since that day's midnight - directly
// usable as top = (startMinutes/60) * HOUR_BLOCK_HEIGHT, matching the same
// math react-native-calendars' own Packer.js uses.
export type DayColumnEvent = { id: string; title: string; startMinutes: number; endMinutes: number; color?: string };

const pad = (n: number) => String(n).padStart(2, '0');

const toDayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const inRange = (d: Date, rangeStart: Date, rangeEnd: Date) => d >= rangeStart && d < rangeEnd;

// WeekGrid renders each day as its own fixed-height column - an event that
// crosses midnight needs to actually continue into the next column rather
// than just running past the bottom of the first one and disappearing.
// Splitting into one segment per calendar day it touches (each clipped to
// that day's 00:00-23:59:59, except the true start/end) is what makes it
// read as continuing across the columns it spans.
const splitByDay = (start: Date, end: Date): { start: Date; end: Date }[] => {
  const segments: { start: Date; end: Date }[] = [];
  let segStart = start;
  while (true) {
    const dayEnd = new Date(segStart);
    dayEnd.setHours(23, 59, 59, 999);
    if (end <= dayEnd) {
      segments.push({ start: segStart, end });
      break;
    }
    segments.push({ start: segStart, end: dayEnd });
    const nextDayStart = new Date(segStart);
    nextDayStart.setDate(nextDayStart.getDate() + 1);
    nextDayStart.setHours(0, 0, 0, 0);
    segStart = nextDayStart;
  }
  return segments;
};

// Buckets every timed (non-all-day) Ping/external event across a date
// range into per-day columns for WeekGrid's continuously-scrolling
// multi-week canvas - keyed by dayKey for O(1) per-column lookup.
export function buildDayColumns(
  rangeStart: Date,
  rangeEnd: Date,
  pings: PingEvent[],
  external: ExternalEvent[]
): Record<string, DayColumnEvent[]> {
  const columns: Record<string, DayColumnEvent[]> = {};
  const pingTimedEntries: { title: string; start: Date }[] = [];

  const pushSegment = (seg: { start: Date; end: Date }, id: string, title: string, color: string) => {
    const dayKey = toDayKey(seg.start);
    const startMinutes = seg.start.getHours() * 60 + seg.start.getMinutes();
    const endMinutes = startMinutes + (seg.end.getTime() - seg.start.getTime()) / 60000;
    (columns[dayKey] ||= []).push({ id, title, startMinutes, endMinutes, color });
  };

  for (const p of pings) {
    if (p.is_all_day) continue;
    const start = new Date(p.event_date);
    // Matches CreateEventModal's own default duration when no end is set.
    const end = p.end_date ? new Date(p.end_date) : new Date(start.getTime() + 60 * 60000);
    pingTimedEntries.push({ title: p.title, start });
    for (const seg of splitByDay(start, end)) {
      if (!inRange(seg.start, rangeStart, rangeEnd)) continue;
      pushSegment(seg, `ping-${p.id}`, p.title, colors.primary);
    }
  }

  for (const e of external) {
    if (e.allDay) continue;
    if (externalItemDuplicatesPing(pingTimedEntries, { title: e.title, start: e.startDate })) continue;
    for (const seg of splitByDay(e.startDate, e.endDate)) {
      if (!inRange(seg.start, rangeStart, rangeEnd)) continue;
      pushSegment(seg, `ext-${e.id}`, e.title, colors.textMuted);
    }
  }

  return columns;
}

// Same idea as buildDayColumns but for all-day items - excluded from the
// hourly grid entirely (a fixed-height day column has no sensible way to
// draw a full-day block) and bucketed per day instead, for a chip strip.
export function buildAllDayColumns(
  rangeStart: Date,
  rangeEnd: Date,
  pings: PingEvent[],
  external: ExternalEvent[]
): Record<string, AllDayItem[]> {
  const columns: Record<string, AllDayItem[]> = {};
  const pingAllDayEntries: { title: string; start: Date }[] = [];

  for (const p of pings) {
    if (!p.is_all_day) continue;
    const start = new Date(p.event_date);
    if (!inRange(start, rangeStart, rangeEnd)) continue;
    pingAllDayEntries.push({ title: p.title, start });
    const dayKey = toDayKey(start);
    (columns[dayKey] ||= []).push({ id: `ping-${p.id}`, title: p.title, dayKey });
  }

  for (const e of external) {
    if (!e.allDay) continue;
    if (!inRange(e.startDate, rangeStart, rangeEnd)) continue;
    if (externalItemDuplicatesPing(pingAllDayEntries, { title: e.title, start: e.startDate })) continue;
    const dayKey = toDayKey(e.startDate);
    (columns[dayKey] ||= []).push({ id: `ext-${e.id}`, title: e.title, dayKey });
  }

  return columns;
}
