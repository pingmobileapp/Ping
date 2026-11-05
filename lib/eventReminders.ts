import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase';

// Shared by EventDetailContent's RSVP'd-Ping reminder picker and
// AddPersonalItemModal's personal-item one, so both offer the same choices.
export const REMINDER_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Off', value: null },
  { label: '30 min', value: 30 },
  { label: '1 hr', value: 60 },
  { label: '1 day', value: 1440 },
];

// Local (on-device) scheduled notifications — these work in Expo Go, unlike
// remote push (dropped from Expo Go as of SDK 53). The OS alarm fires on its
// own regardless of whether the app is open, so there's no reliable moment to
// write a DB row "when it fires." Instead we insert the in-app notification
// row up front, at schedule time, but date it at the future fire time —
// useNotifications filters out not-yet-due rows, so it only shows up (and
// turns the logo red) once it's actually due.
const identifierFor = (eventId: string) => `event-reminder-${eventId}`;

// Saved on each one-time reminder so syncRemindersToEventTimes can tell
// when the event has since moved.
type ReminderData = { startsAt: string; minutesBefore: number };

async function ensurePermission() {
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') return true;
  const { status: requested } = await Notifications.requestPermissionsAsync();
  return requested === 'granted';
}

const labelFor = (minutesBefore: number) =>
  minutesBefore >= 1440
    ? `${Math.round(minutesBefore / 1440)} day${minutesBefore >= 2880 ? 's' : ''}`
    : minutesBefore >= 60
    ? `${Math.round(minutesBefore / 60)} hour${minutesBefore >= 120 ? 's' : ''}`
    : `${minutesBefore} minutes`;

// The actual local-notification scheduling, shared by scheduleEventReminder
// (a real Ping, which also tracks the reminder in the `notifications` table
// for the in-app bell) and schedulePersonalItemReminder (a personal item,
// which has no Supabase row at all to track it against - see that
// function's own comment). Returns whether it actually got scheduled, so a
// caller that also needs to persist something can skip that when it's a
// no-op (already past, or permission denied).
async function scheduleLocalNotification(
  identifier: string,
  title: string,
  body: string,
  fireDate: Date,
  data?: ReminderData
): Promise<boolean> {
  if (fireDate.getTime() <= Date.now()) return false;
  if (!(await ensurePermission())) return false;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  await Notifications.scheduleNotificationAsync({
    identifier,
    content: { title, body, ...(data ? { data } : {}) },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireDate },
  });
  return true;
}

async function cancelLocalNotification(identifier: string) {
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
}

export async function scheduleEventReminder(
  userId: string,
  eventId: string,
  eventTitle: string,
  eventDate: Date,
  minutesBefore: number
) {
  await cancelEventReminder(userId, eventId);

  const fireDate = new Date(eventDate.getTime() - minutesBefore * 60000);
  const body = `Starting in ${labelFor(minutesBefore)}`;
  const scheduled = await scheduleLocalNotification(identifierFor(eventId), eventTitle, body, fireDate, {
    startsAt: eventDate.toISOString(),
    minutesBefore,
  });
  if (!scheduled) return;

  const { error } = await supabase.from('notifications').insert({
    recipient_id: userId,
    type: 'event_reminder',
    event_id: eventId,
    title: eventTitle,
    body,
    created_at: fireDate.toISOString(),
  });
  if (error) console.error('Error saving reminder notification:', error);
}

export async function cancelEventReminder(userId: string, eventId: string) {
  await cancelLocalNotification(identifierFor(eventId));

  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('recipient_id', userId)
    .eq('event_id', eventId)
    .eq('type', 'event_reminder');
  if (error) console.error('Error clearing reminder notification:', error);
}

// Schedules a notification that fires every year on the given month/day/
// time, rather than once - the DATE trigger scheduleLocalNotification uses
// can't represent "forever, annually" at all. Cross-platform per
// expo-notifications' own docs (achieves it via a native
// UNCalendarNotificationTrigger on iOS internally).
async function scheduleYearlyLocalNotification(identifier: string, title: string, body: string, fireDate: Date): Promise<boolean> {
  if (!(await ensurePermission())) return false;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  await Notifications.scheduleNotificationAsync({
    identifier,
    content: { title, body },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.YEARLY,
      day: fireDate.getDate(),
      month: fireDate.getMonth(),
      hour: fireDate.getHours(),
      minute: fireDate.getMinutes(),
    },
  });
  return true;
}

const personalItemIdentifierFor = (itemId: string) => `personal-item-reminder-${itemId}`;

// Since a personal item's reminder is deliberately NOT stored as a native
// EventKit alarm (see below), there's nowhere left to read "what reminder
// did I pick for this" back from when the edit form reopens - this is that
// state instead, purely on-device (a device calendar event id, like the
// reminder scheduled against it, means nothing on another device anyway).
const PERSONAL_REMINDER_STORAGE_KEY = 'ping.personalItemReminderMinutes';

async function getPersonalReminderMap(): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(PERSONAL_REMINDER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('Error reading personal item reminders:', err);
    return {};
  }
}

async function savePersonalReminderMap(map: Record<string, number>): Promise<void> {
  try {
    await AsyncStorage.setItem(PERSONAL_REMINDER_STORAGE_KEY, JSON.stringify(map));
  } catch (err) {
    console.error('Error saving personal item reminders:', err);
  }
}

// Only call when reopening an existing personal item to edit it - lets the
// reminder picker show what was actually selected, since it can no longer
// be read back from the calendar event's own (deliberately unused) alarm.
export async function getPersonalItemReminderMinutes(itemId: string): Promise<number | null> {
  const map = await getPersonalReminderMap();
  return map[itemId] ?? null;
}

// Same reasoning as PERSONAL_REMINDER_STORAGE_KEY above - "important date"
// isn't a calendar-native concept either, so it needs its own on-device
// record to read back when the edit form reopens.
const IMPORTANT_DATE_STORAGE_KEY = 'ping.personalItemImportantDates';

async function getImportantDateSet(): Promise<Record<string, true>> {
  try {
    const raw = await AsyncStorage.getItem(IMPORTANT_DATE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('Error reading important dates:', err);
    return {};
  }
}

async function saveImportantDateSet(set: Record<string, true>): Promise<void> {
  try {
    await AsyncStorage.setItem(IMPORTANT_DATE_STORAGE_KEY, JSON.stringify(set));
  } catch (err) {
    console.error('Error saving important dates:', err);
  }
}

export async function isPersonalItemImportant(itemId: string): Promise<boolean> {
  const set = await getImportantDateSet();
  return !!set[itemId];
}

// For filtering a whole list at once (see Home's "Important Dates" filter)
// - one AsyncStorage read for every visible item would mean redundant
// reads of the same small blob, so this fetches the full set once instead,
// same pattern as lib/hiddenEvents.ts's getHiddenEventIds().
export async function getAllImportantItemIds(): Promise<Set<string>> {
  const set = await getImportantDateSet();
  return new Set(Object.keys(set));
}

// Independent of whether a reminder is currently scheduled - the checkbox
// should still read back correctly on re-edit even if the reminder was
// separately turned Off, so this is its own call from AddPersonalItemModal
// rather than something schedulePersonalItemReminder manages as a
// side effect.
export async function setPersonalItemImportant(itemId: string, important: boolean): Promise<void> {
  const set = await getImportantDateSet();
  if (important) set[itemId] = true;
  else delete set[itemId];
  await saveImportantDateSet(set);
}

// A personal item (AddPersonalItemModal) lives entirely in the phone's own
// calendar - there's no Supabase `events` row for it at all (notifications
// table rows require a real one via foreign key), so this only ever does
// the local-notification half, never the in-app bell tracking. This is
// also deliberately used INSTEAD OF a native EventKit alarm on the
// calendar event itself (see AddPersonalItemModal passing null for that
// param) - a native alarm shows as a generic "Calendar" notification with
// no Ping branding, which undercuts exactly the reminders someone set
// through Ping in the first place.
//
// `important` (an "Important date" like a birthday or anniversary, always
// paired with yearly recurrence in AddPersonalItemModal) switches this to
// a real annual notification instead of a one-time alarm - without this,
// even a yearly-recurring item's reminder would only ever fire once, for
// the very first occurrence, since a plain DATE trigger can't repeat.
export async function schedulePersonalItemReminder(
  itemId: string,
  itemTitle: string,
  itemDate: Date,
  minutesBefore: number,
  important = false
) {
  await cancelPersonalItemReminder(itemId);
  const fireDate = new Date(itemDate.getTime() - minutesBefore * 60000);

  if (important) {
    const body = minutesBefore > 0 ? `Coming up in ${labelFor(minutesBefore)}` : 'Today!';
    await scheduleYearlyLocalNotification(personalItemIdentifierFor(itemId), `🎉 ${itemTitle}`, body, fireDate);
  } else {
    const body = `Starting in ${labelFor(minutesBefore)}`;
    await scheduleLocalNotification(personalItemIdentifierFor(itemId), itemTitle, body, fireDate, {
      startsAt: itemDate.toISOString(),
      minutesBefore,
    });
  }

  const map = await getPersonalReminderMap();
  map[itemId] = minutesBefore;
  await savePersonalReminderMap(map);
}

export async function cancelPersonalItemReminder(itemId: string) {
  await cancelLocalNotification(personalItemIdentifierFor(itemId));

  const map = await getPersonalReminderMap();
  if (itemId in map) {
    delete map[itemId];
    await savePersonalReminderMap(map);
  }
}

// Only call when the item itself is being deleted - forgets it was ever
// marked important too, not just its reminder. A save that merely turns
// the reminder Off while keeping "Important date" checked calls
// cancelPersonalItemReminder above without this, then re-asserts the flag
// via setPersonalItemImportant right after - see AddPersonalItemModal.
export async function forgetPersonalItem(itemId: string) {
  await cancelPersonalItemReminder(itemId);
  await setPersonalItemImportant(itemId, false);
}

// Reminders are scheduled for a fixed time, so one set before an event
// moved (a Week-view drag, an edit, or the host moving a Ping) still went
// off at the old time (TestFlight 1.1.18, 2026-11-05). Home calls this
// whenever its events load: every one-time reminder whose event now starts
// at a different time, or has a new title, is scheduled again - or just
// dropped if the new time has already passed. Events not passed in (not
// loaded, or a repeating item) are left alone. Yearly "important date"
// reminders are left alone too; their own edit form reschedules them.
// One run at a time: Home can call this again before the last run has
// finished, and two runs moving the same reminder would each save a bell row.
let syncQueue: Promise<void> = Promise.resolve();
export function syncRemindersToEventTimes(
  userId: string,
  pings: { id: string; title: string; event_date: string }[],
  personalItems: { id: string; title: string; startDate: Date }[]
): Promise<void> {
  syncQueue = syncQueue.then(() => syncReminders(userId, pings, personalItems));
  return syncQueue;
}

async function syncReminders(
  userId: string,
  pings: { id: string; title: string; event_date: string }[],
  personalItems: { id: string; title: string; startDate: Date }[]
) {
  let scheduled: Notifications.NotificationRequest[];
  try {
    scheduled = await Notifications.getAllScheduledNotificationsAsync();
  } catch (err) {
    console.error('Error reading scheduled reminders:', err);
    return;
  }
  const pingsById = new Map(pings.map((p) => [p.id, p]));
  const itemsById = new Map(personalItems.map((i) => [i.id, i]));

  for (const n of scheduled) {
    const { title, body } = n.content;
    // Only one-time reminders say "Starting in ..." (see labelFor above).
    if (!body?.startsWith('Starting in ')) continue;
    const data = n.content.data as Partial<ReminderData> | undefined;
    // Reminders set before 1.1.19 have no data: read the lead time back
    // from the body, and treat the start time as unknown (always resync).
    const minutesBefore = data?.minutesBefore ?? minutesFromLabel(body.slice('Starting in '.length));
    if (minutesBefore == null) continue;

    try {
      if (n.identifier.startsWith('event-reminder-')) {
        const ping = pingsById.get(n.identifier.slice('event-reminder-'.length));
        if (!ping) continue;
        const start = new Date(ping.event_date);
        if (data?.startsAt && new Date(data.startsAt).getTime() === start.getTime() && title === ping.title) continue;
        await scheduleEventReminder(userId, ping.id, ping.title, start, minutesBefore);
      } else if (n.identifier.startsWith('personal-item-reminder-')) {
        const item = itemsById.get(n.identifier.slice('personal-item-reminder-'.length));
        if (!item) continue;
        if (data?.startsAt && new Date(data.startsAt).getTime() === item.startDate.getTime() && title === item.title) continue;
        await schedulePersonalItemReminder(item.id, item.title, item.startDate, minutesBefore);
      }
    } catch (err) {
      console.error('Error moving reminder:', n.identifier, err);
    }
  }
}

// The reverse of labelFor.
function minutesFromLabel(label: string): number | null {
  const m = label.match(/^(\d+) (minute|hour|day)s?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'day' ? n * 1440 : m[2] === 'hour' ? n * 60 : n;
}
