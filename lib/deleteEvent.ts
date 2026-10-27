import { Alert } from 'react-native';
import { supabase } from '../supabase';
import { notify } from './notify';

// Deleting an event, shared by Edit's Delete Event button and the event
// screen's ••• menu (asked for 2026-10-26 - deleting meant opening Edit and
// scrolling to the bottom).

type DeletableEvent = { id: string; title: string; event_date: string; recurrence_id?: string | null };

// Everything below used to run as one unguarded chain of awaits in
// EditEventModal - a step that never resolves (a genuinely stuck request)
// froze the app on delete in family testing, so the whole sequence races a
// timeout and fails loudly instead.
const TIMEOUT_MS = 15000;

// Returns the names of guests who couldn't be told automatically (texted
// invitees with no account), collected before their invitee rows are gone.
export async function deleteEvent(
  event: DeletableEvent,
  { notifyGuests, applyToFuture, myUserId }: { notifyGuests: boolean; applyToFuture: boolean; myUserId?: string }
): Promise<string[]> {
  let unreachableNames: string[] = [];
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Timed out deleting event')), TIMEOUT_MS)
  );

  await Promise.race([
    (async () => {
      // "This and following events" needs every sibling occurrence's id up
      // front - everything below then operates across all of them.
      let eventIds = [event.id];
      if (applyToFuture && event.recurrence_id) {
        const { data: siblingRows } = await supabase
          .from('events')
          .select('id')
          .eq('recurrence_id', event.recurrence_id)
          .gte('event_date', event.event_date);
        if (siblingRows && siblingRows.length > 0) eventIds = siblingRows.map((r) => r.id);
      }

      if (notifyGuests) {
        // Only the current occurrence's invitees - a family doesn't need a
        // separate cancellation notice for each of 10 canceled weeks.
        const { data: allInvitees } = await supabase
          .from('invitees')
          .select('user_id, invited_via, contacts(name, phone)')
          .eq('event_id', event.id);
        const recipientIds = (allInvitees || [])
          .map((i) => i.user_id)
          .filter((id): id is string => !!id && id !== myUserId);
        if (recipientIds.length > 0) {
          await notify(
            recipientIds,
            'Event canceled',
            applyToFuture
              ? `"${event.title}" and its remaining repeats have been canceled.`
              : `"${event.title}" has been canceled.`,
            { eventId: event.id, type: 'event_canceled' }
          );
        }
        unreachableNames = (allInvitees || [])
          .filter((i: any) => !i.user_id && i.invited_via === 'sms' && i.contacts?.phone)
          .map((i: any) => i.contacts?.name || 'Guest');
      }

      // Cascade delete configuration on the DB side is unknown, so clean up
      // dependents manually rather than risk a foreign-key failure.
      const { data: eventItems } = await supabase.from('items').select('id').in('event_id', eventIds);
      const itemIds = (eventItems || []).map((i) => i.id);
      if (itemIds.length > 0) {
        await supabase.from('item_claims').delete().in('item_id', itemIds);
      }
      await supabase.from('items').delete().in('event_id', eventIds);
      await supabase.from('messages').delete().in('event_id', eventIds);
      await supabase.from('invitees').delete().in('event_id', eventIds);
      await supabase.from('event_hosts').delete().in('event_id', eventIds);

      const { error } = await supabase.from('events').delete().in('id', eventIds);
      if (error) throw error;
    })(),
    timeout,
  ]);

  return unreachableNames;
}

// The confirm questions before a delete: which occurrences (for a repeating
// event), then whether to tell guests - skipped when nobody else is on it,
// since there's no one to tell.
export async function confirmDeleteEvent(
  event: DeletableEvent,
  myUserId: string | undefined,
  onConfirm: (choice: { notifyGuests: boolean; applyToFuture: boolean }) => void
) {
  const { count } = await supabase
    .from('invitees')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', event.id)
    .or(myUserId ? `user_id.is.null,user_id.neq.${myUserId}` : 'user_id.is.null');
  const hasGuests = (count ?? 0) > 0;

  const askNotify = (applyToFuture: boolean) => {
    if (!hasGuests) {
      Alert.alert('Delete this event?', 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => onConfirm({ notifyGuests: false, applyToFuture }) },
      ]);
      return;
    }
    Alert.alert('Delete this event?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete silently', style: 'destructive', onPress: () => onConfirm({ notifyGuests: false, applyToFuture }) },
      { text: 'Notify & delete', style: 'destructive', onPress: () => onConfirm({ notifyGuests: true, applyToFuture }) },
    ]);
  };

  if (event.recurrence_id) {
    Alert.alert('Delete which events?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'This event only', style: 'destructive', onPress: () => askNotify(false) },
      { text: 'This and following events', style: 'destructive', onPress: () => askNotify(true) },
    ]);
    return;
  }
  askNotify(false);
}

// After a delete, texted guests without the app still need to hear it from
// the host.
export function alertUnreachable(names: string[], onDone: () => void) {
  if (names.length === 0) {
    onDone();
    return;
  }
  Alert.alert(
    "Some guests won't be notified",
    `${names.join(', ')} won't get an automatic notice since they don't have Ping — you'll need to text them yourself to let them know it was canceled.`,
    [{ text: 'OK', onPress: onDone }]
  );
}
