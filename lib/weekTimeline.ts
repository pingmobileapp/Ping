import { PingEvent } from '../components/EventCard';
import { ExternalEvent } from './calendarConflicts';
import { colors } from './theme';

export type TimelineEvent = { id: string; start: string; end: string; title: string; color?: string };
export type AllDayItem = { id: string; title: string; dayKey: string };

const pad = (n: number) => String(n).padStart(2, '0');

// react-native-calendars' Timeline expects "YYYY-MM-DD HH:mm:ss" strings,
// not Date objects or epoch values.
const toTimelineDateTime = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const toDayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const inWeek = (d: Date, weekStart: Date, weekEnd: Date) => d >= weekStart && d < weekEnd;

// No stored link ties a Ping to a same-named entry someone's synced
// calendar independently picked up (e.g. a family calendar invite for the
// same real-world gathering) - a Ping and an external item are treated as
// the same event, and the external one dropped, when their titles are a
// reasonably close match and they start within 90 minutes of each other.
const normalizeTitle = (t: string) => t.trim().toLowerCase();
const titlesLikelyMatch = (a: string, b: string) => {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
};
const MATCH_WINDOW_MS = 90 * 60000;

// Timeline has no all-day semantics of its own - an all-day item placed on
// the hourly grid would render as a misleading full-day block, so those are
// excluded here and routed to buildWeekAllDayItems (a separate chip strip)
// instead.
export function buildWeekTimelineEvents(
  weekStart: Date,
  pings: PingEvent[],
  external: ExternalEvent[]
): TimelineEvent[] {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const events: TimelineEvent[] = [];
  const pingTimedEntries: { title: string; start: Date }[] = [];

  for (const p of pings) {
    if (p.is_all_day) continue;
    const start = new Date(p.event_date);
    if (!inWeek(start, weekStart, weekEnd)) continue;
    pingTimedEntries.push({ title: p.title, start });
    // Matches CreateEventModal's own default duration when no end is set.
    const end = p.end_date ? new Date(p.end_date) : new Date(start.getTime() + 60 * 60000);
    events.push({
      id: `ping-${p.id}`,
      start: toTimelineDateTime(start),
      end: toTimelineDateTime(end),
      title: p.title,
      color: colors.primary,
    });
  }

  for (const e of external) {
    if (e.allDay) continue;
    if (!inWeek(e.startDate, weekStart, weekEnd)) continue;
    const duplicatesPing = pingTimedEntries.some(
      (p) =>
        titlesLikelyMatch(p.title, e.title) &&
        Math.abs(p.start.getTime() - e.startDate.getTime()) <= MATCH_WINDOW_MS,
    );
    if (duplicatesPing) continue;
    events.push({
      id: `ext-${e.id}`,
      start: toTimelineDateTime(e.startDate),
      end: toTimelineDateTime(e.endDate),
      title: e.title,
      color: colors.textMuted,
    });
  }

  return events;
}

export function buildWeekAllDayItems(
  weekStart: Date,
  pings: PingEvent[],
  external: ExternalEvent[]
): AllDayItem[] {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const items: AllDayItem[] = [];
  const pingAllDayEntries: { title: string; dayKey: string }[] = [];

  for (const p of pings) {
    if (!p.is_all_day) continue;
    const start = new Date(p.event_date);
    if (!inWeek(start, weekStart, weekEnd)) continue;
    pingAllDayEntries.push({ title: p.title, dayKey: toDayKey(start) });
    items.push({ id: `ping-${p.id}`, title: p.title, dayKey: toDayKey(start) });
  }

  for (const e of external) {
    if (!e.allDay) continue;
    if (!inWeek(e.startDate, weekStart, weekEnd)) continue;
    const dayKey = toDayKey(e.startDate);
    const duplicatesPing = pingAllDayEntries.some(
      (p) => p.dayKey === dayKey && titlesLikelyMatch(p.title, e.title),
    );
    if (duplicatesPing) continue;
    items.push({ id: `ext-${e.id}`, title: e.title, dayKey });
  }

  return items;
}
