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
async function scheduleLocalNotification(identifier: string, title: string, body: string, fireDate: Date): Promise<boolean> {
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
    content: { title, body },
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
  const scheduled = await scheduleLocalNotification(identifierFor(eventId), eventTitle, body, fireDate);
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

// A personal item (AddPersonalItemModal) lives entirely in the phone's own
// calendar - there's no Supabase `events` row for it at all (notifications
// table rows require a real one via foreign key), so this only ever does
// the local-notification half, never the in-app bell tracking. This is
// also deliberately used INSTEAD OF a native EventKit alarm on the
// calendar event itself (see AddPersonalItemModal passing null for that
// param) - a native alarm shows as a generic "Calendar" notification with
// no Ping branding, which undercuts exactly the reminders someone set
// through Ping in the first place.
export async function schedulePersonalItemReminder(
  itemId: string,
  itemTitle: string,
  itemDate: Date,
  minutesBefore: number
) {
  await cancelPersonalItemReminder(itemId);
  const fireDate = new Date(itemDate.getTime() - minutesBefore * 60000);
  const body = `Starting in ${labelFor(minutesBefore)}`;
  await scheduleLocalNotification(personalItemIdentifierFor(itemId), itemTitle, body, fireDate);

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
