import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { supabase } from '../supabase';
import { NotificationType } from './notify';

export type NotificationRow = {
  id: string;
  type: NotificationType;
  event_id: string | null;
  group_id: string | null;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
};

// Chat messages (event and group) live in Messages, with a red dot there,
// not in the Notifications list (TestFlight feedback, build 113). They still
// turn the Ping logo red and count toward the app icon badge.
export const isMessageNotification = (n: { type: string }) => n.type === 'message' || n.type === 'group_message';

export type PendingInvite = {
  id: string;
  event_id: string;
  events: {
    id: string;
    title: string;
    location: string;
    event_date: string;
    host_id: string | null;
    is_public: boolean;
    image_url: string | null;
    status: 'sent' | 'draft';
  };
};

// Pending-invite reminders are always computed live from `invitees` rather
// than stored — they naturally disappear once the user actually responds, no
// separate "mark as seen" bookkeeping needed.
export function useNotifications(userId?: string | null) {
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    if (!userId) return;

    const [{ data: notifs, error: notifsError }, { data: pending, error: pendingError }] = await Promise.all([
      // event_reminder rows are inserted up front dated at their future fire
      // time (see lib/eventReminders.ts) so they don't count as "new" or show
      // up here until that time actually arrives.
      supabase
        .from('notifications')
        .select('*')
        .eq('recipient_id', userId)
        .lte('created_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('invitees')
        .select('id, event_id, events(*)')
        .eq('user_id', userId)
        .eq('rsvp_status', 'pending')
        .is('responded_at', null),
    ]);

    if (notifsError) console.error('Error fetching notifications:', notifsError);
    if (pendingError) console.error('Error fetching pending invites:', pendingError);

    setNotifications((notifs as NotificationRow[]) || []);

    const now = Date.now();
    const upcoming = ((pending as any[]) || []).filter(
      (p) => p.events && new Date(p.events.event_date).getTime() >= now
    ) as PendingInvite[];
    upcoming.sort((a, b) => new Date(a.events.event_date).getTime() - new Date(b.events.event_date).getTime());
    setPendingInvites(upcoming);
  }, [userId]);

  useEffect(() => {
    fetchAll().finally(() => setLoading(false));
  }, [fetchAll]);

  // A future-dated event_reminder row "becoming due" isn't a database write
  // — nothing fires a realtime event for it. A minute-granularity poll is
  // the simplest reliable way to notice that transition without needing the
  // app to be reopened.
  useEffect(() => {
    if (!userId) return;
    const interval = setInterval(fetchAll, 60000);
    return () => clearInterval(interval);
  }, [userId, fetchAll]);

  // Mobile OSes routinely suspend the realtime websocket while the app is
  // backgrounded — a push notification still arrives (that's delivered by
  // APNs independently), but the in-app badge/list can silently stop
  // reflecting new rows until something explicitly refetches. Doing that
  // every time the app comes back to the foreground means what you saw in
  // the push is always there when you actually open the app, regardless of
  // whether the socket reconnected on its own.
  useEffect(() => {
    if (!userId) return;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') fetchAll();
    });
    return () => subscription.remove();
  }, [userId, fetchAll]);

  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`notifications-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        (payload) => {
          const row = payload.new as NotificationRow;
          // A reminder scheduled for the future still fires this INSERT
          // event immediately — ignore it here, it'll surface on a later
          // refresh() once its dated created_at has actually passed.
          if (new Date(row.created_at).getTime() > Date.now()) return;
          setNotifications((prev) => (prev.some((n) => n.id === row.id) ? prev : [row, ...prev]));
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        (payload) => {
          // A repeated chat message updates its existing unread row in
          // place (see lib/notify.ts consolidateMessageNotification)
          // rather than inserting a new one — move it back to the top with
          // its refreshed body/timestamp.
          const row = payload.new as NotificationRow;
          setNotifications((prev) => {
            const rest = prev.filter((n) => n.id !== row.id);
            return [row, ...rest];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const markRead = useCallback(async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n))
    );
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id);
    if (error) console.error('Error marking notification read:', error);
  }, []);

  const markAllRead = useCallback(async () => {
    // Only what the Notifications list shows - message notifications clear
    // when their conversation is opened.
    const unreadIds = notifications.filter((n) => !n.read_at && !isMessageNotification(n)).map((n) => n.id);
    if (unreadIds.length === 0) return;
    const now = new Date().toISOString();
    const marked = new Set(unreadIds);
    setNotifications((prev) => prev.map((n) => (marked.has(n.id) ? { ...n, read_at: now } : n)));
    const { error } = await supabase.from('notifications').update({ read_at: now }).in('id', unreadIds);
    if (error) console.error('Error marking all notifications read:', error);
  }, [notifications]);

  // Optimistic removal with no rollback on failure (unlike markRead/
  // markAllRead) - a swipe-to-delete that silently reappears after a beat
  // reads as broken, and a failed delete just means it comes back on the
  // next refresh instead, which is a much smaller papercut.
  const deleteNotification = useCallback(async (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    const { error } = await supabase.from('notifications').delete().eq('id', id);
    if (error) console.error('Error deleting notification:', error);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read_at).length + pendingInvites.length;
  const unreadMessageCount = notifications.filter((n) => !n.read_at && isMessageNotification(n)).length;
  const unreadOtherCount = unreadCount - unreadMessageCount;

  // Pushes carry their own badge number (see supabase/functions/send-push),
  // but that only ever grows a stale number until the next push - reading
  // notifications in-app (or the pending-invite list shrinking) needs to
  // clear it here too, not just wait for the next message to correct it.
  //
  // Debounced rather than called directly on every change: unreadCount can
  // tick several times in quick succession (a burst of realtime
  // notification updates, e.g. several people pinging at once), and a
  // native module call fired repeatedly back-to-back in that situation was
  // implicated in a real crash during multi-person testing - this
  // coalesces a rapid run of changes into a single call ~400ms after
  // things settle instead of one call per tick.
  const badgeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!userId) return;
    if (badgeTimeoutRef.current) clearTimeout(badgeTimeoutRef.current);
    badgeTimeoutRef.current = setTimeout(() => {
      Notifications.setBadgeCountAsync(unreadCount).catch((err) =>
        console.error('Error setting badge count:', err)
      );
    }, 400);
    return () => {
      if (badgeTimeoutRef.current) clearTimeout(badgeTimeoutRef.current);
    };
  }, [userId, unreadCount]);

  return {
    notifications,
    pendingInvites,
    unreadCount,
    unreadMessageCount,
    unreadOtherCount,
    loading,
    refresh: fetchAll,
    markRead,
    markAllRead,
    deleteNotification,
  };
}
