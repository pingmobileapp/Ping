import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image } from 'react-native';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { colors, EVENT_IMAGE_ASPECT_RATIO } from '../lib/theme';
import { displayName } from '../lib/displayName';
import { submitRsvp } from '../lib/rsvp';
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
  const [myInviteeId, setMyInviteeId] = useState<string | null>(null);
  const [selected, setSelected] = useState<RsvpChoice | null>(null);
  const [responding, setResponding] = useState(false);
  const [conflictState, setConflictState] = useState<ConflictState>({ kind: 'loading' });

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
      const [{ data: eventData, error: eventError }, { data: inviteeData, error: inviteeError }] = await Promise.all([
        supabase
          .from('events')
          .select('id, title, location, event_date, end_date, is_all_day, host_id, image_url')
          .eq('id', eventId)
          .single(),
        supabase
          .from('invitees')
          .select('id, rsvp_status')
          .eq('event_id', eventId)
          .eq('user_id', session.user.id)
          .maybeSingle(),
      ]);

      if (eventError) console.error('Error fetching event for popup:', eventError);
      if (inviteeError) console.error('Error fetching invitee for popup:', inviteeError);
      if (cancelled) return;

      setEvent((eventData as PopupEvent) || null);
      setMyInviteeId(inviteeData?.id || null);

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

  const handleRespond = async (status: RsvpChoice) => {
    if (!session?.user?.id || !event || responding) return;
    setResponding(true);
    setSelected(status);

    await submitRsvp({
      eventId: event.id,
      hostId: event.host_id,
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

  const dateLabel = event ? formatEventDate(event.event_date, event.end_date, 'long') : '';
  const timeLabel = event ? formatEventTime(event.event_date, event.is_all_day, event.end_date) : '';

  return (
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
                {RSVP_OPTIONS.map((opt) => (
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
                ))}
              </View>

              <TouchableOpacity onPress={() => onOpenFull(event.id)}>
                <Text style={styles.viewFullLink}>View full details</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
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
