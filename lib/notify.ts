import { supabase } from '../supabase';

export type NotificationType =
  | 'invite'
  | 'event_canceled'
  | 'event_updated'
  | 'message'
  | 'group_message'
  | 'rsvp_update'
  | 'item_claimed'
  | 'event_reminder'
  | 'report';

type NotifyOptions = {
  eventId?: string;
  groupId?: string;
  type?: NotificationType;
  // Muted threads still get an in-app notification row (so there's
  // something to review later), just no push banner/buzz for it.
  silent?: boolean;
};

// A recipient only ever plays one role on a given event - the guest side
// (invite, event_updated) and the host side (rsvp_update, item_claimed)
// never both land on the same person for the same event, since you can't be
// your own guest - so bucketing all four together still only ever merges
// "your" activity on that event into one row, not someone else's unrelated
// update. Message threads stay in their own bucket: a chat is a different
// kind of thing than "news about this event" and shouldn't bump one off the
// notification, or vice versa.
const NOTIF_GROUP: Partial<Record<NotificationType, string>> = {
  invite: 'event_activity',
  event_updated: 'event_activity',
  rsvp_update: 'event_activity',
  item_claimed: 'event_activity',
  message: 'message',
  group_message: 'message',
};

export async function notify(
  userIds: (string | null | undefined)[],
  title: string,
  body: string,
  opts?: NotifyOptions
) {
  const ids = Array.from(new Set(userIds.filter(Boolean))) as string[];
  if (ids.length === 0) return;

  const notifGroup = opts?.type ? NOTIF_GROUP[opts.type] : undefined;
  if (opts?.type && notifGroup) {
    // Chat messages arrive in bursts, someone can flip their RSVP several
    // times before the event, and an invite is just the first entry in
    // that same event's story - collapse all of a recipient's activity for
    // one event (or one group's messages) into a single row, updated and
    // bumped back to unread each time, instead of piling up a new
    // notification per change - same as how a phone shows one thread for
    // several texts in a row rather than a line per text.
    const type = opts.type;
    const eventId = opts.eventId ?? null;
    const groupId = opts.groupId ?? null;
    await Promise.all(ids.map((id) => consolidateNotification(id, notifGroup, type, eventId, groupId, title, body)));
  } else if (opts?.type) {
    const { error } = await supabase.from('notifications').insert(
      ids.map((id) => ({
        recipient_id: id,
        type: opts.type,
        event_id: opts.eventId ?? null,
        group_id: opts.groupId ?? null,
        title,
        body,
      }))
    );
    if (error) console.error('Error saving notification:', error);
  }

  if (opts?.silent) return;

  // A priced event's Accept can't be a one-tap quick-action from the
  // notification tray - it needs to open Stripe Checkout, which a
  // backgrounded notification response can't do. send-push picks a
  // no-quick-actions category when this is true (see
  // lib/pushNotifications.ts's 'invite_priced' category), so tapping the
  // notification just opens the app to InvitePopup like a normal tap
  // already does, instead of instantly (and wrongly) accepting for free.
  let hasPrice = false;
  if (opts?.type === 'invite' && opts.eventId) {
    const { data: priceRow } = await supabase.from('events').select('price_cents').eq('id', opts.eventId).maybeSingle();
    hasPrice = !!(priceRow?.price_cents && priceRow.price_cents > 0);
  }

  // Awaited so the row above is committed before send-push queries each
  // recipient's unread count for the push's badge number - otherwise the
  // badge could undercount by whatever this call just wrote.
  await supabase.functions
    .invoke('send-push', {
      body: {
        user_ids: ids,
        title,
        body,
        data: { eventId: opts?.eventId, groupId: opts?.groupId, type: opts?.type, hasPrice },
      },
    })
    .catch((err) => console.error('Push notification failed:', err));
}

async function consolidateNotification(
  recipientId: string,
  notifGroup: string,
  type: NotificationType,
  eventId: string | null,
  groupId: string | null,
  title: string,
  body: string
) {
  // A separate SELECT-then-INSERT/UPDATE here was a check-then-act race:
  // two messages landing close together (normal for an actual
  // conversation) could both run their SELECT before either's INSERT
  // committed, so both saw "no existing row" and both inserted - producing
  // exactly the duplicate lines this is supposed to prevent. thread_key
  // (event_id or group_id, always non-null for these consolidated types)
  // plus notif_group (which types share one merged row - see NOTIF_GROUP
  // above) backs a real unique index, so this upsert is atomic at the
  // database level instead of racy round-trips from the client. `type` is
  // still stored (and still overwritten each time) purely for display/
  // routing - it's not part of what identifies "the same row" anymore.
  const { error } = await supabase.from('notifications').upsert(
    {
      recipient_id: recipientId,
      notif_group: notifGroup,
      type,
      event_id: eventId,
      group_id: groupId,
      thread_key: eventId ?? groupId,
      title,
      body,
      created_at: new Date().toISOString(),
      read_at: null,
    },
    { onConflict: 'recipient_id,notif_group,thread_key' }
  );
  if (error) console.error('Error upserting notification:', error);
}
