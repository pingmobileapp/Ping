import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, AppState } from 'react-native';
import { colors } from '../lib/theme';
import { buildInviteMessage } from '../lib/sms';
import { openSmsComposer } from '../lib/smsCompose';

export type QueueContact = { inviteeId: string; name: string; phone: string };

type Props = {
  visible: boolean;
  contacts: QueueContact[];
  eventTitle: string;
  eventDate: Date;
  location: string;
  isAllDay?: boolean;
  onDone: () => void;
  // Fires once this modal has actually finished its own close animation
  // (native Modal `onDismiss`, iOS-only). The parent's own close/finish
  // logic belongs here, not in onDone directly - this modal is nested
  // inside CreateEventModal's/ShareInviteModal's own Modal, and telling
  // both to dismiss in the same tick is a known way to hang iOS's modal
  // presentation. onDone only hides this modal; onClosed is the signal
  // that it's safe to also close what's underneath it.
  onClosed?: () => void;
};

// Shown right after sending invites, for whichever invitees don't have the
// app. Twilio-based auto-send was abandoned after repeated toll-free
// registration rejections, so this is the only thing that reaches these
// invitees now: it hands off to the host's own Messages app (pre-filled,
// via the sms: URL scheme) one contact at a time, rather than sending from
// a business number. Neither iOS
// nor Android lets an app auto-send on the user's behalf, so advancing to
// the next contact happens when the app comes back to the foreground after
// they leave Messages (see the AppState listener below) - close enough to
// "just keep hitting send" without pretending it's fully automatic.
export default function NonAppInviteQueue({
  visible,
  contacts,
  eventTitle,
  eventDate,
  location,
  isAllDay,
  onDone,
  onClosed,
}: Props) {
  const [index, setIndex] = useState(0);
  const awaitingReturnRef = useRef(false);

  useEffect(() => {
    if (visible) setIndex(0);
    else awaitingReturnRef.current = false;
  }, [visible]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && awaitingReturnRef.current) {
        awaitingReturnRef.current = false;
        setIndex((i) => i + 1);
      }
    });
    return () => subscription.remove();
  }, []);

  const current = contacts[index];
  const isComplete = index >= contacts.length;

  const handleText = async () => {
    if (!current) return;
    const body = buildInviteMessage(eventTitle, eventDate, location, current.inviteeId, isAllDay);
    awaitingReturnRef.current = true;
    const opened = await openSmsComposer(current.phone, body);
    if (!opened) awaitingReturnRef.current = false;
  };

  const handleSkip = () => setIndex((i) => i + 1);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDone} onDismiss={onClosed}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.handle} />

          {isComplete ? (
            <>
              <Text style={styles.header}>All set! 🎉</Text>
              <Text style={styles.subheader}>
                You've gone through everyone who doesn't have Ping yet.
              </Text>
              <TouchableOpacity style={styles.primaryButton} onPress={onDone}>
                <Text style={styles.primaryButtonText}>Close</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <View style={styles.headerRow}>
                <Text style={styles.header}>Text your invite</Text>
                <TouchableOpacity onPress={onDone}>
                  <Text style={styles.laterText}>Finish later</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.subheader}>
                {contacts.length > 1
                  ? `${index + 1} of ${contacts.length} don't have Ping yet — send them a text from your own Messages app.`
                  : `${current.name} doesn't have Ping yet — send them a text from your own Messages app.`}
              </Text>

              <View style={styles.contactCard}>
                <Text style={styles.contactName}>{current.name}</Text>
                <Text style={styles.contactPhone}>{current.phone}</Text>
              </View>

              <TouchableOpacity style={styles.primaryButton} onPress={handleText}>
                <Text style={styles.primaryButtonText}>Open Messages</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.skipButton} onPress={handleSkip}>
                <Text style={styles.skipText}>Skip {current.name}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(43,43,43,0.4)' },
  card: { backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 12 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  header: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  laterText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  subheader: { color: colors.textSecondary, fontSize: 13, marginTop: 4, marginBottom: 20, lineHeight: 18 },
  contactCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    paddingVertical: 20,
    alignItems: 'center',
    marginBottom: 20,
  },
  contactName: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  contactPhone: { fontSize: 14, color: colors.textSecondary, marginTop: 4 },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonText: { color: colors.textOnPrimary, fontSize: 16, fontWeight: '700' },
  skipButton: { paddingVertical: 14, alignItems: 'center' },
  skipText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
});
