import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../lib/theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  title: string;
  dateLabel: string;
  timeLabel: string;
  location: string | null;
  priceLabel: string | null;
  buyerName: string;
};

// Proof of purchase for a paid Discover Ping - there's no QR code/ticket-ID
// infrastructure behind this (no scanner on the host's end either), so this
// is deliberately just a clear on-screen confirmation the buyer can show
// the host at the door: their name, what they paid, and what they bought it
// for. Shared by the Discover card, EventDetailContent, and InvitePopup so
// "your ticket" looks the same no matter where it's opened from.
export default function TicketModal({ visible, onClose, title, dateLabel, timeLabel, location, priceLabel, buyerName }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <TouchableOpacity style={styles.closeButton} onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.closeButtonText}>✕</Text>
          </TouchableOpacity>

          <View style={styles.checkCircle}>
            <Text style={styles.checkText}>✓</Text>
          </View>
          <Text style={styles.confirmed}>You&apos;re confirmed</Text>

          <View style={styles.divider} />

          <Text style={styles.eventTitle}>{title}</Text>
          <Text style={styles.detail}>{dateLabel}</Text>
          <Text style={styles.detail}>{timeLabel}</Text>
          {!!location && <Text style={styles.detail}>{location}</Text>}
          {!!priceLabel && <Text style={styles.paid}>Paid {priceLabel}</Text>}

          <View style={styles.divider} />

          <Text style={styles.buyerLabel}>Ticket holder</Text>
          <Text style={styles.buyerName}>{buyerName}</Text>

          <Text style={styles.note}>Show this screen at the event as proof of purchase.</Text>
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
    alignItems: 'center',
  },
  closeButton: { position: 'absolute', top: 14, right: 14, zIndex: 1 },
  closeButtonText: { fontSize: 18, color: colors.textMuted },
  checkCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  checkText: { color: colors.white, fontSize: 30, fontWeight: '700' },
  confirmed: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginTop: 10 },
  divider: { height: 1, backgroundColor: colors.divider, width: '100%', marginVertical: 16 },
  eventTitle: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, textAlign: 'center', marginBottom: 8 },
  detail: { fontSize: 15, color: colors.textSecondary, textAlign: 'center', marginBottom: 2 },
  paid: { fontSize: 15, fontWeight: '700', color: colors.success, marginTop: 8 },
  buyerLabel: { fontSize: 12, color: colors.textMuted, textTransform: 'uppercase' },
  buyerName: { fontSize: 17, fontWeight: '600', color: colors.textPrimary, marginTop: 2 },
  note: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginTop: 16 },
});
