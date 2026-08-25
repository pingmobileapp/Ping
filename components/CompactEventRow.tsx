import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../lib/theme';
import { PingEvent } from './EventCard';
import { LatestMessageInfo } from '../lib/useLatestMessages';
import { formatEventDate } from '../lib/eventDate';

type Props = {
  event: PingEvent;
  snippet?: LatestMessageInfo | null;
  unread?: boolean;
  onPress?: (event: PingEvent) => void;
};

export default function CompactEventRow({ event, snippet, unread = false, onPress }: Props) {
  const dateLabel = formatEventDate(event.event_date, event.end_date, 'compact');

  const previewText = snippet ? `${snippet.senderName}: ${snippet.body}` : 'No messages yet';

  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => onPress?.(event)}>
      <View style={styles.textCol}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, unread && styles.titleUnread]} numberOfLines={1}>
            {!!event.recurrence_id && '↻ '}
            {event.title}
          </Text>
          <Text style={[styles.date, unread && styles.dateUnread]}>{dateLabel}</Text>
        </View>
        <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>
          {previewText}
        </Text>
      </View>
      {unread && <View style={styles.unreadDot} />}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    gap: 10,
  },
  textCol: { flex: 1 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', flexShrink: 1 },
  titleUnread: { fontWeight: '800' },
  date: { color: colors.textMuted, fontSize: 12, marginLeft: 8 },
  dateUnread: { color: colors.primary, fontWeight: '700' },
  preview: { color: colors.textSecondary, fontSize: 14, marginTop: 2 },
  previewUnread: { color: colors.textPrimary, fontWeight: '600' },
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary },
});
