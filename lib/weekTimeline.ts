import { PingEvent } from '../components/EventCard';
import { ExternalEvent } from './calendarConflicts';
import { colors } from './theme';
import { externalItemDuplicatesPing } from './eventDedup';
import { eachDayKeyInRange } from './eventDate';
import { hiddenKeyFor } from './hiddenEvents';
import type { InterestedActivity } from './discoverActivities';

export type AllDayItem = { id: string; title: string; dayKey: string };
// startMinutes/endMinutes are minutes since that day's midnight - directly
// usable as top = (startMinutes/60) * HOUR_BLOCK_HEIGHT, matching the same
// math react-native-calendars' own Packer.js uses.
// stackIndex is how many other events this one overlaps that already came
// before it (see packDayEvents) - WeekGrid nudges each one right by
// stackIndex steps so overlapping events cascade into view as offset
// cards instead of stacking flush on top of each other, all still full-
// width rather than split into side-by-side lanes.
// lane/laneCount are for a WIDENED day only: there, overlapping events sit
// side by side (lane 0..laneCount-1 within their overlap group) so every
// title is readable - asked for 2026-10-11, "an easier way to see
// overlapping events". Since 2026-10-22 every day uses lanes, like Apple
// Calendar; stackIndex is no longer drawn.
export type DayColumnEvent = {
  id: string;
  title: string;
  // Apple-Calendar-style block colors (see blockPalette): a pale tint
  // fill, a solid stripe down the left edge, and dark text in the same hue.
  fill: string;
  stripe: string;
  // Start time (and location, when there is one) shown under the title
  // when the block is tall enough.
  subtitle?: string;
  startMinutes: number;
  endMinutes: number;
  textColor: string;
  stackIndex: number;
  lane: number;
  laneCount: number;
};

type RawDayEvent = Omit<DayColumnEvent, 'stackIndex' | 'lane' | 'laneCount'>;

// Mixes a #rrggbb color toward white (amount > 0) or black (amount < 0).
function mixHex(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const target = amount > 0 ? 255 : 0;
  const a = Math.abs(amount);
  const ch = (shift: number) => {
    const c = (n >> shift) & 255;
    return Math.round(c + (target - c) * a).toString(16).padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

// The tint / stripe / text trio for one calendar color, matching how Apple
// Calendar draws a timed event (asked for 2026-10-22 - Pierson's wife keeps
// Apple Calendar for Week view because of how it reads).
export function blockPalette(base: string): { fill: string; stripe: string; textColor: string } {
  return { fill: mixHex(base, 0.8), stripe: base, textColor: mixHex(base, -0.55) };
}

// One color for every Ping, so they stand out from the phone's own items:
// the red of the Ping logo, softened a little. (Ping's light blue blended
// into the blue most people's phone calendars use.)
const PING_BLOCK = blockPalette('#E5383B');
// Phone calendar items with no color of their own.
const FALLBACK_BLOCK = blockPalette('#8E8E93');
// Starred Discover events - amber, like their Upcoming cards.
const STARRED_BLOCK = blockPalette('#E0A100');

const timeLabel = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(':00', '');

const eventsOverlap = (a: RawDayEvent, b: RawDayEvent) => a.endMinutes > b.startMinutes && a.startMinutes < b.endMinutes;

// For each event (in start order), stackIndex is how many still-running
// earlier events it overlaps - the count that determines how far right
// WeekGrid nudges its card. Deliberately not lane/interval-graph packing
// (which would also split cards into narrower side-by-side columns) - the
// desired look is a simple cascade of same-width offset cards.
export function packDayEvents(dayEvents: RawDayEvent[]): DayColumnEvent[] {
  const sorted = [...dayEvents].sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
  const active: RawDayEvent[] = [];

  const packed: DayColumnEvent[] = sorted.map((ev) => {
    for (let i = active.length - 1; i >= 0; i--) {
      if (!eventsOverlap(active[i], ev)) active.splice(i, 1);
    }
    const stackIndex = active.length;
    active.push(ev);
    return { ...ev, stackIndex, lane: 0, laneCount: 1 };
  });

  // Lanes: walk events in start order, grouping ones that overlap (directly
  // or through a chain). Each event takes the first lane whose last event
  // has already ended; every event in a group shares the group's lane count.
  let group: DayColumnEvent[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -1;
  const closeGroup = () => {
    group.forEach((g) => (g.laneCount = laneEnds.length));
    group = [];
    laneEnds = [];
  };
  for (const ev of packed) {
    if (group.length > 0 && ev.startMinutes >= groupEnd) closeGroup();
    let lane = laneEnds.findIndex((end) => end <= ev.startMinutes);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(ev.endMinutes);
    } else {
      laneEnds[lane] = ev.endMinutes;
    }
    ev.lane = lane;
    group.push(ev);
    groupEnd = Math.max(groupEnd, ev.endMinutes);
  }
  closeGroup();

  return packed;
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
  external: ExternalEvent[],
  interested: InterestedActivity[] = []
): Record<string, DayColumnEvent[]> {
  const rawColumns: Record<string, RawDayEvent[]> = {};
  const pingTimedEntries: { title: string; start: Date }[] = [];

  const pushSegment = (
    seg: { start: Date; end: Date },
    id: string,
    title: string,
    palette: { fill: string; stripe: string; textColor: string },
    trueStart: Date,
    location?: string | null
  ) => {
    const dayKey = toDayKey(seg.start);
    const startMinutes = seg.start.getHours() * 60 + seg.start.getMinutes();
    const endMinutes = startMinutes + (seg.end.getTime() - seg.start.getTime()) / 60000;
    // The real start time, even on a later day's piece of an overnight item.
    const subtitle = [timeLabel(trueStart), location?.trim()].filter(Boolean).join(' · ');
    (rawColumns[dayKey] ||= []).push({ id, title, startMinutes, endMinutes, ...palette, subtitle });
  };

  for (const p of pings) {
    if (p.is_all_day) continue;
    const start = new Date(p.event_date);
    // Matches CreateEventModal's own default duration when no end is set.
    const end = p.end_date ? new Date(p.end_date) : new Date(start.getTime() + 60 * 60000);
    pingTimedEntries.push({ title: p.title, start });
    for (const seg of splitByDay(start, end)) {
      if (!inRange(seg.start, rangeStart, rangeEnd)) continue;
      pushSegment(seg, `ping-${p.id}`, p.title, PING_BLOCK, start, p.location);
    }
  }

  for (const e of external) {
    if (e.allDay) continue;
    if (externalItemDuplicatesPing(pingTimedEntries, { title: e.title, start: e.startDate })) continue;
    // hiddenKeyFor, not a bare e.id - EventKit can hand back the same id for
    // more than one occurrence of a recurring event, and Week view's own
    // press/long-press handlers resolve this id straight back to one
    // ExternalEvent (see handleWeekItemPress/handleWeekItemLongPress) - a
    // bare id there would resolve to whichever occurrence happens to come
    // first in externalEvents, not the one actually pressed.
    for (const seg of splitByDay(e.startDate, e.endDate)) {
      if (!inRange(seg.start, rangeStart, rangeEnd)) continue;
      pushSegment(
        seg,
        `ext-${hiddenKeyFor(e)}`,
        e.title,
        e.calendarColor ? blockPalette(e.calendarColor) : FALLBACK_BLOCK,
        e.startDate,
        e.location
      );
    }
  }

  // Starred Discover events, as a reminder of what's on even when nothing is
  // planned - pale yellow like their Upcoming cards. Snapshots with no end
  // get the same one-hour default as a Ping.
  for (const a of interested) {
    const start = new Date(a.startsAt);
    const rawEnd = a.endsAt ? new Date(a.endsAt) : null;
    const end = rawEnd && rawEnd > start ? rawEnd : new Date(start.getTime() + 60 * 60000);
    for (const seg of splitByDay(start, end)) {
      if (!inRange(seg.start, rangeStart, rangeEnd)) continue;
      pushSegment(seg, `int-${a.activityKey}`, `★ ${a.title}`, STARRED_BLOCK, start);
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
export type MonthDayBar = { id: string; title: string; color: string; textColor?: string };

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
  external: ExternalEvent[],
  interested: InterestedActivity[] = []
): Record<string, MonthDayBar[]> {
  const allDay = buildAllDayColumns(rangeStart, rangeEnd, pings, external);
  const timed = buildDayColumns(rangeStart, rangeEnd, pings, external, interested);
  const result: Record<string, MonthDayBar[]> = {};
  for (const key of new Set([...Object.keys(allDay), ...Object.keys(timed)])) {
    const allDayBars = (allDay[key] || []).map((item) => ({
      id: item.id,
      title: item.title,
      color: item.id.startsWith('ping-') ? colors.primary : colors.textMuted,
    }));
    const timedBars = [...(timed[key] || [])]
      .sort((a, b) => a.startMinutes - b.startMinutes)
      // Month keeps its own solid-bar look (the Apple-style tints are Week
      // view only, for now).
      .map((item) => ({
        id: item.id,
        title: item.title,
        color: item.id.startsWith('ping-') ? colors.primary : item.id.startsWith('int-') ? colors.warningPale : colors.textMuted,
        textColor: item.id.startsWith('int-') ? colors.textPrimary : undefined,
      }));
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
    // EventKit's all-day endDate is exclusive (midnight of the day AFTER
    // the last day), but pushAllDayAcrossSpan/eachDayKeyInRange treat the
    // end as inclusive - subtract a day so a single-day all-day event
    // (e.g. a synced birthday) doesn't also show up on the following day.
    const end = e.endDate
      ? new Date(Math.max(e.startDate.getTime(), e.endDate.getTime() - 24 * 60 * 60000))
      : null;
    if ((end ?? e.startDate) < rangeStart || e.startDate >= rangeEnd) continue;
    if (externalItemDuplicatesPing(pingAllDayEntries, { title: e.title, start: e.startDate })) continue;
    // Same non-unique-id reasoning as buildDayColumns above.
    pushAllDayAcrossSpan(columns, `ext-${hiddenKeyFor(e)}`, e.title, e.startDate, end, rangeStart, rangeEnd);
  }

  return columns;
}
