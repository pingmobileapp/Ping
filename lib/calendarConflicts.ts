import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';

export type CalendarPermissionStatus = 'granted' | 'denied' | 'undetermined';

export type CalendarConflict = {
  title: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
};

const CONFLICT_WINDOW_BEFORE_MINUTES = 30;
const CONFLICT_WINDOW_AFTER_MINUTES = 90;
// Bounds how far ahead the Upcoming list pulls in phone-calendar events -
// unlike Ping events (a handful of family plans), a synced external
// calendar can hold hundreds of recurring entries indefinitely, so this
// keeps the list from filling up with things a year out.
const UPCOMING_WINDOW_DAYS = 60;
// Ping's own dedicated calendar (see getOrCreatePingCalendarId) only ever
// holds what the user explicitly added through Ping - personal items and
// Scan a Schedule imports - so it can't balloon the way a synced calendar
// can, and a season-long schedule (sports, school) routinely runs past the
// 60-day window above. Queried separately with this much longer window.
const PING_CALENDAR_WINDOW_DAYS = 365;

export type ExternalEvent = {
  id: string;
  title: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  // True for events Ping itself wrote (see createPersonalCalendarEvent).
  // Detected via a dedicated device calendar when creating one succeeded,
  // or a note marker when it fell back to some other writable calendar
  // (see PING_NOTE_MARKER). Governs edit-form messaging and whether the
  // marker gets (re)written on save - not whether editing is allowed at
  // all, see `editable` for that.
  isPersonal: boolean;
  // Whether the calendar this event lives on accepts writes at all (some
  // subscriptions, holiday calendars, and read-only shared calendars
  // don't). Editing/deleting a non-personal event still changes the real
  // event wherever it's synced from (Google, iCloud, a shared family
  // calendar) - it's not private to Ping the way a personal item is.
  editable: boolean;
};

const PING_CALENDAR_TITLE = 'Ping';
// Whether a personal item ends up in its own dedicated calendar (below) or
// falls back to some other writable one, this note is what makes it
// findable as "Ping's to edit" either way - calendar identity alone isn't
// reliable since calendar creation can fail on devices where every synced
// account refuses new calendars.
const PING_NOTE_MARKER = 'Added via Ping';

export async function getCalendarPermissionStatus(): Promise<CalendarPermissionStatus> {
  const { status } = await Calendar.getCalendarPermissionsAsync();
  return status as CalendarPermissionStatus;
}

export async function requestCalendarAccess(): Promise<boolean> {
  const { status } = await Calendar.requestCalendarPermissionsAsync();
  return status === 'granted';
}

// Only call once permission is confirmed granted — this never prompts.
export async function findConflicts(eventDate: Date): Promise<CalendarConflict[]> {
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const calendarIds = calendars.map((c) => c.id);
  if (calendarIds.length === 0) return [];

  const windowStart = new Date(eventDate.getTime() - CONFLICT_WINDOW_BEFORE_MINUTES * 60000);
  const windowEnd = new Date(eventDate.getTime() + CONFLICT_WINDOW_AFTER_MINUTES * 60000);

  const events = await Calendar.getEventsAsync(calendarIds, windowStart, windowEnd);

  return events
    .filter((e) => e.title)
    .map((e) => ({
      title: e.title,
      startDate: new Date(e.startDate),
      endDate: new Date(e.endDate),
      allDay: !!e.allDay,
    }));
}

// Only call once permission is confirmed granted — this never prompts.
// Feeds the Home screen's Upcoming list so phone-calendar events show up
// alongside Ping events without needing to leave the app.
export async function getUpcomingExternalEvents(): Promise<ExternalEvent[]> {
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  if (calendars.length === 0) return [];
  const pingCalendarIdList = calendars.filter((c) => c.title === PING_CALENDAR_TITLE).map((c) => c.id);
  const otherCalendarIdList = calendars.filter((c) => c.title !== PING_CALENDAR_TITLE).map((c) => c.id);
  const pingCalendarIds = new Set(pingCalendarIdList);
  const writableCalendarIds = new Set(
    calendars.filter((c) => c.allowsModifications).map((c) => c.id)
  );

  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60000);
  const pingWindowEnd = new Date(windowStart.getTime() + PING_CALENDAR_WINDOW_DAYS * 24 * 60 * 60000);

  const [otherEvents, pingEvents] = await Promise.all([
    otherCalendarIdList.length ? Calendar.getEventsAsync(otherCalendarIdList, windowStart, windowEnd) : Promise.resolve([]),
    pingCalendarIdList.length ? Calendar.getEventsAsync(pingCalendarIdList, windowStart, pingWindowEnd) : Promise.resolve([]),
  ]);
  const events = [...otherEvents, ...pingEvents];

  return events
    .filter((e) => e.title)
    .map((e) => ({
      id: e.id,
      title: e.title,
      startDate: new Date(e.startDate),
      endDate: new Date(e.endDate),
      allDay: !!e.allDay,
      isPersonal: pingCalendarIds.has(e.calendarId) || (e.notes || '').includes(PING_NOTE_MARKER),
      editable: writableCalendarIds.has(e.calendarId),
    }));
}

// Cached once resolved so a batch of creates (Scan a Schedule can add
// several at once) reuses the same id instead of re-querying/re-deriving
// it before every single event - besides the redundant work, re-running
// the "does a Ping calendar already exist" lookup on every call is exactly
// the kind of repeated call that's fragile against a calendar list that
// hasn't settled yet right after creating it (see the batch-loss bug this
// was added for).
let cachedPingCalendarId: string | null = null;

// Personal items get their own dedicated device calendar (created once,
// lazily) rather than landing in whatever the user's default calendar is -
// that's what makes an event "Ping's to edit" unambiguous later (see
// isPersonal above), and it keeps these out of the user's own iCloud/Gmail
// calendar clutter too.
async function getOrCreatePingCalendarId(): Promise<string> {
  if (cachedPingCalendarId) return cachedPingCalendarId;

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const existing = calendars.find((c) => c.title === PING_CALENDAR_TITLE && c.allowsModifications);
  if (existing) {
    cachedPingCalendarId = existing.id;
    return existing.id;
  }

  // The OS's notion of "default calendar" is very often a synced work/
  // school/Google account, and iOS refuses to create a new calendar under
  // most of those sources - a local, on-device source almost always
  // accepts it, so try that first and only fall back to the default.
  const sources: Calendar.Source[] = [];
  const localSource = calendars.find((c) => c.source?.type === Calendar.SourceType.LOCAL)?.source;
  if (localSource) sources.push(localSource);
  if (Platform.OS === 'ios') {
    try {
      const defaultSource = (await Calendar.getDefaultCalendarAsync()).source;
      if (!sources.some((s) => s.id === defaultSource.id)) sources.push(defaultSource);
    } catch {}
  } else if (sources.length === 0) {
    sources.push({ isLocalAccount: true, name: PING_CALENDAR_TITLE, type: Calendar.SourceType.LOCAL });
  }

  for (const source of sources) {
    try {
      const id = await Calendar.createCalendarAsync({
        title: PING_CALENDAR_TITLE,
        color: '#5DADE2',
        entityType: Calendar.EntityTypes.EVENT,
        sourceId: source.id,
        source,
        name: 'pingPersonalItems',
        ownerAccount: source.name ?? 'personal',
        accessLevel: Calendar.CalendarAccessLevel.OWNER,
      });
      cachedPingCalendarId = id;
      return id;
    } catch (err) {
      console.error('Could not create Ping calendar under source', source, err);
    }
  }

  // Every source refused a new calendar - fall back to writing straight
  // into any calendar that already accepts new events, so the save itself
  // still succeeds even though this particular item won't be tagged as
  // Ping's own (isPersonal) until a Ping calendar can be created. Not
  // cached - a real Ping calendar may become creatable later (e.g. after
  // the transient failure that led here clears), and this fallback isn't
  // guaranteed stable enough to keep reusing blindly.
  const fallback = calendars.find((c) => c.allowsModifications);
  if (fallback) return fallback.id;
  throw new Error('No writable calendar available on this device.');
}

// Only call once permission is confirmed granted — this never prompts.
// Writes a personal item straight to the phone's own calendar rather than
// Supabase: nothing here needs to be shared with or visible to anyone
// else, and the phone calendar is already the source of truth this app
// reads "just for me" events back from (see getUpcomingExternalEvents), so
// round-tripping through it is what makes a personal item show up in the
// Upcoming list for free, with no new table or list-merging logic needed.
export async function createPersonalCalendarEvent(
  title: string,
  startDate: Date,
  endDate: Date,
  allDay: boolean
): Promise<void> {
  const calendarId = await getOrCreatePingCalendarId();
  await Calendar.createEventAsync(calendarId, { title, startDate, endDate, allDay, notes: PING_NOTE_MARKER });
}

// Also used to edit calendar events Ping didn't create (anything from the
// user's own phone calendars, as long as its calendar allows writes - see
// ExternalEvent.editable). isPersonal controls whether the marker gets
// (re)written - it must never be stamped onto a real external/shared
// calendar event just because the user edited it here, or the next fetch
// would wrongly treat someone else's calendar entry as Ping's own to
// freely delete.
export async function updateCalendarEvent(
  eventId: string,
  title: string,
  startDate: Date,
  endDate: Date,
  allDay: boolean,
  isPersonal: boolean
): Promise<void> {
  const updates: Partial<Calendar.Event> = { title, startDate, endDate, allDay };
  if (isPersonal) updates.notes = PING_NOTE_MARKER;
  await Calendar.updateEventAsync(eventId, updates);
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  await Calendar.deleteEventAsync(eventId);
}
