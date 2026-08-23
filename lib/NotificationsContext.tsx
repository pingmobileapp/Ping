import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import * as Notifications from 'expo-notifications';
import { supabase } from '../supabase';
import { useAuth } from './AuthContext';
import { useNotifications } from './useNotifications';
import { submitRsvp, RsvpStatus } from './rsvp';
import { displayName } from './displayName';

const QUICK_RSVP_ACTIONS: Record<string, Exclude<RsvpStatus, 'pending'>> = {
  accept: 'accepted',
  interested: 'interested',
  decline: 'declined',
};

// Fired when someone RSVPs straight from the notification's Accept/
// Interested/Decline quick-actions instead of opening the InvitePopup -
// looks up the same data the popup would have already had loaded.
async function submitQuickRsvp(eventId: string, userId: string, status: Exclude<RsvpStatus, 'pending'>) {
  const [{ data: eventRow }, { data: inviteeRow }, { data: profile }] = await Promise.all([
    supabase.from('events').select('title, host_id').eq('id', eventId).maybeSingle(),
    supabase.from('invitees').select('id').eq('event_id', eventId).eq('user_id', userId).maybeSingle(),
    supabase.from('profiles').select('full_name, email').eq('id', userId).maybeSingle(),
  ]);
  if (!eventRow) return;

  await submitRsvp({
    eventId,
    hostId: eventRow.host_id,
    eventTitle: eventRow.title,
    userId,
    myInviteeId: inviteeRow?.id || null,
    responderName: displayName(profile),
    status,
  });
}

type PendingEventModal = { eventId: string; startOnMessages: boolean } | null;
type PendingGroupChat = { groupId: string; groupName?: string } | null;

type NotificationsContextType = ReturnType<typeof useNotifications> & {
  popupEventId: string | null;
  openInvitePopup: (eventId: string) => void;
  closeInvitePopup: () => void;
  pendingEventModal: PendingEventModal;
  openEventModal: (eventId: string, startOnMessages?: boolean) => void;
  clearEventModal: () => void;
  pendingGroupChat: PendingGroupChat;
  openGroupChat: (groupId: string, groupName?: string) => void;
  clearGroupChat: () => void;
};

const noopAsync = async () => {};

const NotificationsContext = createContext<NotificationsContextType>({
  notifications: [],
  pendingInvites: [],
  unreadCount: 0,
  loading: true,
  refresh: noopAsync,
  markRead: noopAsync,
  markAllRead: noopAsync,
  deleteNotification: noopAsync,
  popupEventId: null,
  openInvitePopup: () => {},
  closeInvitePopup: () => {},
  pendingEventModal: null,
  openEventModal: () => {},
  clearEventModal: () => {},
  pendingGroupChat: null,
  openGroupChat: () => {},
  clearGroupChat: () => {},
});

function getNotificationData(data: unknown): { type: string; eventId?: string; groupId?: string } | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as any;
  return typeof d.type === 'string' ? d : null;
}

function isInviteNotificationData(data: unknown): data is { type: string; eventId: string } {
  const d = getNotificationData(data);
  return !!d && d.type === 'invite' && !!d.eventId;
}

// A single shared instance so the Home screen's badge and the Notifications
// screen's list are always looking at the exact same state — two separate
// hook instances bridged only by focus-refetch left the badge unable to
// notice changes made on the other screen.
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const notificationsValue = useNotifications(session?.user?.id);
  const [popupEventId, setPopupEventId] = useState<string | null>(null);
  // Invites still waiting to be shown after the current one is dismissed -
  // see the catch-up effect below, which is what actually fills this.
  const [inviteQueue, setInviteQueue] = useState<string[]>([]);
  const [pendingEventModal, setPendingEventModal] = useState<PendingEventModal>(null);
  const [pendingGroupChat, setPendingGroupChat] = useState<PendingGroupChat>(null);

  const openInvitePopup = (eventId: string) => setPopupEventId(eventId);
  // X'ing out or responding both call this (InvitePopup calls onClose
  // after a successful RSVP too) - either way, move on to the next queued
  // invite instead of just closing, until the queue's empty.
  const closeInvitePopup = () => {
    if (inviteQueue.length > 0) {
      const [next, ...rest] = inviteQueue;
      setPopupEventId(next);
      setInviteQueue(rest);
    } else {
      setPopupEventId(null);
    }
  };
  const openEventModal = (eventId: string, startOnMessages = false) =>
    setPendingEventModal({ eventId, startOnMessages });
  const clearEventModal = () => setPendingEventModal(null);
  const openGroupChat = (groupId: string, groupName?: string) => setPendingGroupChat({ groupId, groupName });
  const clearGroupChat = () => setPendingGroupChat(null);

  // Catches up on every invite that arrived since the app was last opened,
  // showing them one after another (via the queue + closeInvitePopup
  // above) instead of leaving people to stumble onto them in Notifications
  // - runs once per app session, right after the pending-invites list
  // first loads.
  const hasCaughtUpRef = useRef(false);
  useEffect(() => {
    if (hasCaughtUpRef.current || notificationsValue.loading) return;
    hasCaughtUpRef.current = true;

    const ids = notificationsValue.pendingInvites.map((p) => p.event_id);
    if (ids.length === 0) return;

    if (popupEventId) {
      // A push notification tap already opened one before this ran -
      // queue the rest behind it rather than override what's showing.
      setInviteQueue((prev) => [...prev, ...ids.filter((id) => id !== popupEventId)]);
    } else {
      const [first, ...rest] = ids;
      setPopupEventId(first);
      setInviteQueue(rest);
    }
  }, [notificationsValue.loading, notificationsValue.pendingInvites, popupEventId]);

  // Turns an incoming/tapped push notification into the right in-app view
  // instead of leaving the tap to do nothing (no listener for this existed
  // before) or relying on the native banner alone - an invite opens the
  // InvitePopup, anything else with an event opens the same card modal used
  // everywhere else in the app (Home screen listens for pendingEventModal).
  useEffect(() => {
    if (!session?.user?.id) return;

    const receivedSub = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data;
      if (isInviteNotificationData(data)) openInvitePopup(data.eventId);
    });

    const handleResponse = (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data;

      if (isInviteNotificationData(data)) {
        const quickStatus = QUICK_RSVP_ACTIONS[response.actionIdentifier];
        if (quickStatus) {
          submitQuickRsvp(data.eventId, session.user.id, quickStatus);
          return;
        }
        openInvitePopup(data.eventId);
        return;
      }

      const generic = getNotificationData(data);
      if (generic?.eventId) {
        openEventModal(generic.eventId, generic.type === 'message');
      } else if (generic?.groupId) {
        openGroupChat(generic.groupId);
      }
    };

    const responseSub = Notifications.addNotificationResponseReceivedListener(handleResponse);
    // getLastNotificationResponseAsync returns whatever notification response
    // was received most recently, full stop - not "since last checked." Left
    // uncleared, the very first notification someone ever taps gets replayed
    // through handleResponse on every cold start from then on, reopening
    // that same old event (often flipped to the Message Board side) with no
    // relation to whatever they're actually doing at the time.
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        handleResponse(response);
        Notifications.clearLastNotificationResponseAsync();
      }
    });

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, [session?.user?.id]);

  const value: NotificationsContextType = {
    ...notificationsValue,
    popupEventId,
    openInvitePopup,
    closeInvitePopup,
    pendingEventModal,
    openEventModal,
    clearEventModal,
    pendingGroupChat,
    openGroupChat,
    clearGroupChat,
  };

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export const useNotificationsContext = () => useContext(NotificationsContext);
