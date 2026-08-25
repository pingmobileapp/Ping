import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
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

export async function scheduleEventReminder(
  userId: string,
  eventId: string,
  eventTitle: string,
  eventDate: Date,
  minutesBefore: number
) {
  await cancelEventReminder(userId, eventId);

  const fireDate = new Date(eventDate.getTime() - minutesBefore * 60000);
  if (fireDate.getTime() <= Date.now()) return;

  if (!(await ensurePermission())) return;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const body = `Starting in ${labelFor(minutesBefore)}`;

  await Notifications.scheduleNotificationAsync({
    identifier: identifierFor(eventId),
    content: { title: eventTitle, body },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireDate },
  });

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
  await Notifications.cancelScheduledNotificationAsync(identifierFor(eventId)).catch(() => {});

  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('recipient_id', userId)
    .eq('event_id', eventId)
    .eq('type', 'event_reminder');
  if (error) console.error('Error clearing reminder notification:', error);
}
