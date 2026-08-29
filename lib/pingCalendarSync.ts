import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createPersonalCalendarEvent,
  deleteCalendarEvent,
  getCalendarPermissionStatus,
  requestCalendarAccess,
  updateCalendarEvent,
} from './calendarConflicts';

// Keeps a Ping you've accepted on your own phone calendar too - without
// this, accepting only ever shows up inside Ping's own Home list, and
// someone who doesn't have the app open that day has no reminder it's
// coming at all. Removes it again if you change your answer away from
// accepted, or un-join entirely (a Discover self-leave). Calendar event
// ids are meaningless outside the device that created them, so this maps
// Ping event id -> device calendar event id purely in local storage,
// never synced to Supabase.

const STORAGE_KEY = 'ping.acceptedEventCalendarIds';

type StoredMap = Record<string, string>;

async function getStoredMap(): Promise<StoredMap> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('Error reading accepted-event calendar ids:', err);
    return {};
  }
}

async function saveStoredMap(map: StoredMap): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (err) {
    console.error('Error saving accepted-event calendar ids:', err);
  }
}

export type SyncableEvent = {
  id: string;
  title: string;
  event_date: string;
  end_date: string | null;
  is_all_day: boolean;
  location: string;
};

// Never forces the calendar permission prompt on someone who's already
// said no - only asks the first time an "accepted" RSVP actually needs to
// write something, same as other permission-gated actions in this app.
export async function syncAcceptedEventToDeviceCalendar(
  event: SyncableEvent,
  status: 'accepted' | 'declined' | 'interested'
): Promise<void> {
  const map = await getStoredMap();
  const existingId = map[event.id];

  if (status !== 'accepted') {
    if (!existingId) return;
    try {
      await deleteCalendarEvent(existingId);
    } catch (err) {
      console.error('Error removing calendar event for un-accepted Ping:', err);
    }
    delete map[event.id];
    await saveStoredMap(map);
    return;
  }

  let granted = (await getCalendarPermissionStatus()) === 'granted';
  if (!granted) granted = await requestCalendarAccess();
  if (!granted) return;

  const start = new Date(event.event_date);
  const end = event.end_date ? new Date(event.end_date) : new Date(start.getTime() + 60 * 60000);

  try {
    if (existingId) {
      await updateCalendarEvent(
        existingId,
        event.title,
        start,
        end,
        event.is_all_day,
        false,
        undefined,
        undefined,
        undefined,
        // null (not undefined) forces an explicit empty alarms array -
        // otherwise the OS/calendar account's own default alert time can
        // attach a native "Calendar" reminder to this, competing with
        // Ping's own branded push-notification reminders (see
        // scheduleEventReminder) for an event someone might reasonably
        // expect Ping itself gets credit for reminding them about.
        null,
        event.location || undefined
      );
    } else {
      const calendarEventId = await createPersonalCalendarEvent(
        event.title,
        start,
        end,
        event.is_all_day,
        undefined,
        undefined,
        null,
        event.location || undefined
      );
      map[event.id] = calendarEventId;
      await saveStoredMap(map);
    }
  } catch (err) {
    console.error('Error syncing accepted Ping to device calendar:', err);
  }
}

// For a Discover self-leave, where the invitee row is deleted outright
// rather than switched to a non-accepted status - same cleanup, just with
// no status to branch on first.
export async function removeEventFromDeviceCalendar(pingEventId: string): Promise<void> {
  const map = await getStoredMap();
  const existingId = map[pingEventId];
  if (!existingId) return;
  try {
    await deleteCalendarEvent(existingId);
  } catch (err) {
    console.error('Error removing calendar event:', err);
  }
  delete map[pingEventId];
  await saveStoredMap(map);
}
