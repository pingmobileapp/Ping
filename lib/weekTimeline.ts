import { PingEvent } from '../components/EventCard';
import { ExternalEvent } from './calendarConflicts';
import { colors } from './theme';
import { externalItemDuplicatesPing } from './eventDedup';
import { eachDayKeyInRange } from './eventDate';

export type AllDayItem = { id: string; title: string; dayKey: string };
// startMinutes/endMinutes are minutes since that day's midnight - directly
// usable as top = (startMinutes/60) * HOUR_BLOCK_HEIGHT, matching the same
// math react-native-calendars' own Packer.js uses.
// stackIndex is how many other events this one overlaps that already came
// before it (see packDayEvents) - WeekGrid nudges each one right by
// stackIndex steps so overlapping events cascade into view as offset
// cards instead of stacking flush on top of each other, all still full-
// width rather than split into side-by-side lanes.
export type DayColumnEvent = {
  id: string;
  title: string;
  startMinutes: number;
  endMinutes: number;
  color?: string;
  stackIndex: number;
};

type RawDayEvent = Omit<DayColumnEvent, 'stackIndex'>;

const eventsOverlap = (a: RawDayEvent, b: RawDayEvent) => a.endMinutes > b.startMinutes && a.startMinutes < b.endMinutes;

// For each event (in start order), stackIndex is how many still-running
// earlier events it overlaps - the count that determines how far right
// WeekGrid nudges its card. Deliberately not lane/interval-graph packing
// (which would also split cards into narrower side-by-side columns) - the
// desired look is a simple cascade of same-width offset cards.
export function packDayEvents(dayEvents: RawDayEvent[]): DayColumnEvent[] {
  const sorted = [...dayEvents].sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
  const active: RawDayEvent[] = [];

  return sorted.map((ev) => {
    for (let i = active.length - 1; i >= 0; i--) {
      if (!eventsOverlap(active[i], ev)) active.splice(i, 1);
    }
    const stackIndex = active.length;
    active.push(ev);
    return { ...ev, stackIndex };
  });
}

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
  const rawColumns: Record<string, RawDayEvent[]> = {};
  const pingTimedEntries: { title: string; start: Date }[] = [];

  const pushSegment = (seg: { start: Date; end: Date }, id: string, title: string, color: string) => {
    const dayKey = toDayKey(seg.start);
    const startMinutes = seg.start.getHours() * 60 + seg.start.getMinutes();
    const endMinutes = startMinutes + (seg.end.getTime() - seg.start.getTime()) / 60000;
    (rawColumns[dayKey] ||= []).push({ id, title, startMinutes, endMinutes, color });
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

  const columns: Record<string, DayColumnEvent[]> = {};
  for (const dayKey of Object.keys(rawColumns)) {
    columns[dayKey] = packDayEvents(rawColumns[dayKey]);
  }
  return columns;
}

// Same idea as buildDayColumns but for all-day items - excluded from the
// hourly grid entirely (a fixed-height day column has no sensible way to
// draw a full-day block) and bucketed per day instead, for a chip strip.
// A multi-day all-day item (event_date through end_date) needs to show up
// in every day's chip strip it spans, not just its start day - pushes the
// same item onto each day key from start through end (inclusive, matching
// the convention the month view's own multi-day bar already uses - see
// eachDayKeyInRange), clipped to the rendered range.
const pushAllDayAcrossSpan = (
  columns: Record<string, AllDayItem[]>,
  id: string,
  title: string,
  start: Date,
  end: Date | null,
  rangeStart: Date,
  rangeEnd: Date
) => {
  const spanKeys = eachDayKeyInRange(toDayKey(start), toDayKey(end ?? start));
  const rangeStartKey = toDayKey(rangeStart);
  const rangeEndKey = toDayKey(rangeEnd);
  for (const key of spanKeys) {
    if (key < rangeStartKey || key >= rangeEndKey) continue;
    (columns[key] ||= []).push({ id, title, dayKey: key });
  }
};

// One stacked bar per event for Month view's day cells (Apple-Calendar
// style) - id/title/color only, no minute positioning, since a Month cell
// stacks bars in a plain list rather than laying them out on an hourly
// axis the way WeekGrid's DayColumnEvent does.
export type MonthDayBar = { id: string; title: string; color: string };

// Merges buildAllDayColumns + buildDayColumns into one ordered per-day list
// - all-day/multi-day items first, then timed events by start time,
// matching Apple Calendar's own convention. Reuses the exact same
// dedup/color rules Week's grid already applies (a Ping is colors.primary,
// a phone-calendar/personal item is colors.textMuted, matched by the
// `ping-`/`ext-` id prefix both builders already use), so Month and Week
// always agree on what a given day contains.
export function buildMonthDayBars(
  rangeStart: Date,
  rangeEnd: Date,
  pings: PingEvent[],
  external: ExternalEvent[]
): Record<string, MonthDayBar[]> {
  const allDay = buildAllDayColumns(rangeStart, rangeEnd, pings, external);
  const timed = buildDayColumns(rangeStart, rangeEnd, pings, external);
  const result: Record<string, MonthDayBar[]> = {};
  for (const key of new Set([...Object.keys(allDay), ...Object.keys(timed)])) {
    const allDayBars = (allDay[key] || []).map((item) => ({
      id: item.id,
      title: item.title,
      color: item.id.startsWith('ping-') ? colors.primary : colors.textMuted,
    }));
    const timedBars = [...(timed[key] || [])]
      .sort((a, b) => a.startMinutes - b.startMinutes)
      .map((item) => ({ id: item.id, title: item.title, color: item.color || colors.primary }));
    result[key] = [...allDayBars, ...timedBars];
  }
  return result;
}

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
    const end = p.end_date ? new Date(p.end_date) : null;
    // Cheap pre-check before doing any day-by-day work - the span has to
    // at least overlap the rendered range somewhere.
    if ((end ?? start) < rangeStart || start >= rangeEnd) continue;
    pingAllDayEntries.push({ title: p.title, start });
    pushAllDayAcrossSpan(columns, `ping-${p.id}`, p.title, start, end, rangeStart, rangeEnd);
  }

  for (const e of external) {
    if (!e.allDay) continue;
    const end = e.endDate ? new Date(e.endDate) : null;
    if ((end ?? e.startDate) < rangeStart || e.startDate >= rangeEnd) continue;
    if (externalItemDuplicatesPing(pingAllDayEntries, { title: e.title, start: e.startDate })) continue;
    pushAllDayAcrossSpan(columns, `ext-${e.id}`, e.title, e.startDate, end, rangeStart, rangeEnd);
  }

  return columns;
}
