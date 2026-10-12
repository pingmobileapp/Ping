import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../lib/theme';
import { LatestGroupMessageInfo } from '../lib/useLatestGroupMessages';

export type PingGroup = {
  id: string;
  name: string;
};

type Props = {
  group: PingGroup;
  snippet?: LatestGroupMessageInfo | null;
  unread?: boolean;
  onPress?: (group: PingGroup) => void;
};

export default function CompactGroupRow({ group, snippet, unread = false, onPress }: Props) {
  const previewText = snippet ? `${snippet.senderName}: ${snippet.body}` : 'No messages yet';

  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => onPress?.(group)}>
      <View style={styles.textCol}>
        <Text style={[styles.title, unread && styles.titleUnread]} numberOfLines={1}>
          {group.name}
        </Text>
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
  title: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  titleUnread: { fontWeight: '800' },
  preview: { color: colors.textSecondary, fontSize: 14, marginTop: 2 },
  previewUnread: { color: colors.textPrimary, fontWeight: '600' },
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.danger },
});
