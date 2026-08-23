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

  for (const p of pings) {
    if (p.is_all_day) continue;
    const start = new Date(p.event_date);
    if (!inWeek(start, weekStart, weekEnd)) continue;
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

  for (const p of pings) {
    if (!p.is_all_day) continue;
    const start = new Date(p.event_date);
    if (!inWeek(start, weekStart, weekEnd)) continue;
    items.push({ id: `ping-${p.id}`, title: p.title, dayKey: toDayKey(start) });
  }

  for (const e of external) {
    if (!e.allDay) continue;
    if (!inWeek(e.startDate, weekStart, weekEnd)) continue;
    items.push({ id: `ext-${e.id}`, title: e.title, dayKey: toDayKey(e.startDate) });
  }

  return items;
}
