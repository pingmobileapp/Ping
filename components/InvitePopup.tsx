import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image } from 'react-native';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { colors, EVENT_IMAGE_ASPECT_RATIO } from '../lib/theme';
import { displayName } from '../lib/displayName';
import { submitRsvp } from '../lib/rsvp';
import { startEventCheckout } from '../lib/discoverCheckout';
import { toListingActivity, activityKey, fetchInterestedKeys, toggleInterest } from '../lib/discoverActivities';
import { formatPrice } from '../lib/pricing';
import TicketModal from './TicketModal';
import { formatEventDate, formatEventTime } from '../lib/eventDate';
import {
  getCalendarPermissionStatus,
  requestCalendarAccess,
  findConflicts,
  CalendarConflict,
} from '../lib/calendarConflicts';

type PopupEvent = {
  id: string;
  title: string;
  location: string;
  event_date: string;
  end_date: string | null;
  is_all_day: boolean;
  host_id: string | null;
  image_url: string | null;
  price_cents: number | null;
  discoverable: boolean;
  description: string | null;
  discover_category: string | null;
  capacity: number | null;
  accepted_count: number | null;
};

type RsvpChoice = 'accepted' | 'interested' | 'declined';

const RSVP_OPTIONS: { label: string; value: RsvpChoice; color: string }[] = [
  { label: 'Accept', value: 'accepted', color: colors.success },
  { label: 'Interested', value: 'interested', color: colors.warning },
  { label: 'Decline', value: 'declined', color: colors.danger },
];

type Props = {
  eventId: string | null;
  onClose: () => void;
  onOpenFull: (eventId: string) => void;
};

type ConflictState =
  | { kind: 'loading' }
  | { kind: 'undetermined' }
  | { kind: 'denied' }
  | { kind: 'clear' }
  | { kind: 'conflicts'; items: CalendarConflict[] };

export default function InvitePopup({ eventId, onClose, onOpenFull }: Props) {
  const { session } = useAuth();

  const [loading, setLoading] = useState(false);
  const [event, setEvent] = useState<PopupEvent | null>(null);
  const [hostName, setHostName] = useState('Someone');
  const [coHostIds, setCoHostIds] = useState<string[]>([]);
  const [myInviteeId, setMyInviteeId] = useState<string | null>(null);
  const [myRsvpStatus, setMyRsvpStatus] = useState<RsvpChoice | null>(null);
  const [ticketModalVisible, setTicketModalVisible] = useState(false);
  const [selected, setSelected] = useState<RsvpChoice | null>(null);
  const [responding, setResponding] = useState(false);
  const [conflictState, setConflictState] = useState<ConflictState>({ kind: 'loading' });
  // Only meaningful for a paid Discover Ping's "Interested" button - see
  // isPaidDiscoverEvent and handleToggleInterestStar below, and
  // EventDetailContent.tsx's identical pattern for why this exists.
  const [interestedStar, setInterestedStar] = useState(false);

  const runConflictCheck = useCallback(async (eventDate: Date) => {
    const status = await getCalendarPermissionStatus();
    if (status === 'denied') {
      setConflictState({ kind: 'denied' });
      return;
    }
    if (status === 'undetermined') {
      setConflictState({ kind: 'undetermined' });
      return;
    }
    const conflicts = await findConflicts(eventDate);
    setConflictState(conflicts.length > 0 ? { kind: 'conflicts', items: conflicts } : { kind: 'clear' });
  }, []);

  useEffect(() => {
    if (!eventId || !session?.user?.id) return;

    let cancelled = false;
    setLoading(true);
    setSelected(null);
    setConflictState({ kind: 'loading' });

    (async () => {
      const [{ data: eventData, error: eventError }, { data: inviteeData, error: inviteeError }, { data: coHostData }] =
        await Promise.all([
          supabase
            .from('events')
            .select(
              'id, title, location, event_date, end_date, is_all_day, host_id, image_url, price_cents, discoverable, description, discover_category, capacity, accepted_count'
            )
            .eq('id', eventId)
            .single(),
          supabase
            .from('invitees')
            .select('id, rsvp_status')
            .eq('event_id', eventId)
            .eq('user_id', session.user.id)
            .maybeSingle(),
          supabase.from('event_hosts').select('user_id').eq('event_id', eventId),
        ]);

      if (eventError) console.error('Error fetching event for popup:', eventError);
      if (inviteeError) console.error('Error fetching invitee for popup:', inviteeError);
      if (cancelled) return;

      setEvent((eventData as PopupEvent) || null);
      setMyInviteeId(inviteeData?.id || null);
      setMyRsvpStatus((inviteeData?.rsvp_status as RsvpChoice) || null);
      setCoHostIds((coHostData || []).map((r) => r.user_id));

      if (eventData?.host_id) {
        const { data: hostProfile } = await supabase
          .from('profiles')
          .select('full_name, email')
          .eq('id', eventData.host_id)
          .maybeSingle();
        if (!cancelled) setHostName(displayName(hostProfile));
      }

      setLoading(false);

      if (eventData?.event_date) {
        runConflictCheck(new Date(eventData.event_date));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [eventId, session?.user?.id, runConflictCheck]);

  // Checks this event's Discover star state - only used for a paid Discover
  // Ping's "Interested" button (see isPaidDiscoverEvent below), which reuses
  // Discover's own star mechanism instead of an RSVP status.
  useEffect(() => {
    if (!event) return;
    fetchInterestedKeys().then((keys) =>
      setInterestedStar(keys.has(activityKey({ title: event.title, startsAt: event.event_date })))
    );
  }, [event?.id, event?.title, event?.event_date]);

  // A tappable version of what the Week view's calendar-item taps already
  // show (see handleWeekItemPress in app/(tabs)/index.tsx) - a quick
  // read-only peek, not a navigation, so it doesn't add another moving
  // part to this popup's already-fragile "open something else from here"
  // interactions.
  const showConflictDetails = (item: CalendarConflict) => {
    const dateLabel = item.startDate.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const timeLabel = item.allDay
      ? 'All day'
      : `${item.startDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} – ${item.endDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    Alert.alert(item.title, `${dateLabel} · ${timeLabel}`);
  };

  const handleEnableCalendar = async () => {
    const granted = await requestCalendarAccess();
    if (!granted) {
      setConflictState({ kind: 'denied' });
      return;
    }
    if (event) runConflictCheck(new Date(event.event_date));
  };

  // A paid Discover Ping's "Interested" doesn't create/clear an invitee row
  // the way the free-event version does - see EventDetailContent.tsx's
  // identical handleToggleInterestStar for the full reasoning. Optimistic,
  // reverting only if the write actually fails.
  const handleToggleInterestStar = async () => {
    if (!event) return;
    const wasInterested = interestedStar;
    setInterestedStar(!wasInterested);
    const ok = await toggleInterest(toListingActivity(event), !wasInterested);
    if (!ok) setInterestedStar(wasInterested);
  };

  const handleRespond = async (status: RsvpChoice) => {
    if (!session?.user?.id || !event || responding) return;
    setResponding(true);
    setSelected(status);

    // A priced event routes through Stripe Checkout instead of a direct
    // RSVP - discover-checkout creates the invitee row itself once
    // stripe-webhook confirms payment (see EventDetailContent's
    // handleRsvp/handleDiscoverJoin for the same branch). The popup can't
    // usefully poll for that from here, so it just closes and lets
    // whatever screen the buyer lands on next reflect the real state.
    if (status === 'accepted' && event.price_cents) {
      const { opened, error } = await startEventCheckout(event.id);
      if (!opened) Alert.alert('Could not start checkout', error || 'Something went wrong.');
      setResponding(false);
      onClose();
      return;
    }

    await submitRsvp({
      eventId: event.id,
      hostIds: [event.host_id, ...coHostIds].filter((id): id is string => !!id),
      eventTitle: event.title,
      userId: session.user.id,
      myInviteeId,
      responderName: displayName({ full_name: session.user.user_metadata?.full_name, email: session.user.email }),
      status,
    });

    setResponding(false);
    setTimeout(onClose, 700);
  };

  if (!eventId) return null;

  // Same rule as EventDetailContent.tsx's isPaidDiscoverEvent: Accept
  // becomes "Buy" and there's no Decline once money's involved, and
  // Interested becomes the Discover star instead of an RSVP status.
  const isPaidDiscoverEvent = !!event && event.discoverable && event.price_cents != null && event.price_cents > 0;

  const dateLabel = event ? formatEventDate(event.event_date, event.end_date, 'long') : '';
  const timeLabel = event ? formatEventTime(event.event_date, event.is_all_day, event.end_date) : '';

  return (
    <>
    <Modal visible={!!eventId} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <TouchableOpacity style={styles.closeButton} onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.closeButtonText}>✕</Text>
          </TouchableOpacity>

          {loading || !event ? (
            <ActivityIndicator color={colors.primary} style={{ paddingVertical: 40 }} />
          ) : (
            <>
              {event.image_url && <Image source={{ uri: event.image_url }} style={styles.image} />}

              <Text style={styles.inviter}>{hostName} invited you to</Text>
              <Text style={styles.title}>{event.title}</Text>
              <Text style={styles.detail}>{dateLabel}</Text>
              <Text style={styles.detail}>{timeLabel}</Text>
              {!!event.location && <Text style={styles.detail}>{event.location}</Text>}

              {conflictState.kind === 'undetermined' && (
                <TouchableOpacity style={styles.calendarPrompt} onPress={handleEnableCalendar}>
                  <Text style={styles.calendarPromptText}>Check my calendar for conflicts</Text>
                </TouchableOpacity>
              )}
              {conflictState.kind === 'clear' && <Text style={styles.conflictClear}>No conflicts on your calendar</Text>}
              {conflictState.kind === 'conflicts' && (
                <TouchableOpacity onPress={() => showConflictDetails(conflictState.items[0])}>
                  <Text style={styles.conflictWarning}>
                    ⚠️ You have another event around this time — {conflictState.items[0].title}
                  </Text>
                </TouchableOpacity>
              )}

              <View style={styles.rsvpRow}>
                {isPaidDiscoverEvent ? (
                  <>
                    <TouchableOpacity
                      style={[
                        styles.rsvpButton,
                        { borderColor: colors.success },
                        (selected === 'accepted' || myRsvpStatus === 'accepted') && { backgroundColor: colors.success },
                      ]}
                      onPress={() =>
                        myRsvpStatus === 'accepted' ? setTicketModalVisible(true) : handleRespond('accepted')
                      }
                      disabled={responding}
                    >
                      <Text
                        style={[
                          styles.rsvpButtonText,
                          { color: colors.success },
                          (selected === 'accepted' || myRsvpStatus === 'accepted') && styles.rsvpButtonTextSelected,
                        ]}
                      >
                        {myRsvpStatus === 'accepted' ? 'View Ticket' : 'Buy'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.rsvpButton,
                        { borderColor: colors.warning },
                        interestedStar && { backgroundColor: colors.warning },
                      ]}
                      onPress={handleToggleInterestStar}
                    >
                      <Text
                        style={[
                          styles.rsvpButtonText,
                          { color: colors.warning },
                          interestedStar && styles.rsvpButtonTextSelected,
                        ]}
                      >
                        Interested
                      </Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  RSVP_OPTIONS.map((opt) => (
                    <TouchableOpacity
                      key={opt.value}
                      style={[
                        styles.rsvpButton,
                        { borderColor: opt.color },
                        selected === opt.value && { backgroundColor: opt.color },
                      ]}
                      onPress={() => handleRespond(opt.value)}
                      disabled={responding}
                    >
                      <Text
                        style={[
                          styles.rsvpButtonText,
                          { color: opt.color },
                          selected === opt.value && styles.rsvpButtonTextSelected,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))
                )}
              </View>

              <TouchableOpacity onPress={() => onOpenFull(event.id)}>
                <Text style={styles.viewFullLink}>View full details</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
    {!!event && (
      <TicketModal
        visible={ticketModalVisible}
        onClose={() => setTicketModalVisible(false)}
        title={event.title}
        dateLabel={dateLabel}
        timeLabel={timeLabel}
        location={event.location}
        priceLabel={event.price_cents != null ? formatPrice(event.price_cents) : null}
        buyerName={displayName({
          full_name: session?.user?.user_metadata?.full_name,
          email: session?.user?.email,
        })}
      />
    )}
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(43,43,43,0.5)',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.background,
    borderRadius: 20,
    padding: 24,
  },
  closeButton: { position: 'absolute', top: 14, right: 14, zIndex: 1 },
  closeButtonText: { fontSize: 18, color: colors.textMuted },
  image: { width: '100%', aspectRatio: EVENT_IMAGE_ASPECT_RATIO, borderRadius: 14, marginBottom: 14 },
  inviter: { fontSize: 14, color: colors.textSecondary, marginBottom: 4 },
  title: { fontSize: 22, fontWeight: '700', color: colors.textPrimary, marginBottom: 10 },
  detail: { fontSize: 15, color: colors.textSecondary, marginBottom: 2 },
  calendarPrompt: { marginTop: 12, alignSelf: 'flex-start' },
  calendarPromptText: { fontSize: 13, color: colors.primaryDark, textDecorationLine: 'underline' },
  conflictClear: { marginTop: 12, fontSize: 13, color: colors.success },
  conflictWarning: { marginTop: 12, fontSize: 13, color: colors.warning },
  rsvpRow: { flexDirection: 'row', marginTop: 20, gap: 8 },
  rsvpButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  rsvpButtonText: { fontSize: 14, fontWeight: '700' },
  rsvpButtonTextSelected: { color: colors.textOnPrimary },
  viewFullLink: { marginTop: 16, fontSize: 13, color: colors.primaryDark, textAlign: 'center' },
});
