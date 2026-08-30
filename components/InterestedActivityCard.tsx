import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { colors } from '../lib/theme';
import { formatEventDate, formatEventTime } from '../lib/eventDate';
import { InterestedActivity } from '../lib/discoverActivities';

type Props = {
  activity: InterestedActivity;
  onPress?: (activity: InterestedActivity) => void;
  onUnstar?: (activity: InterestedActivity) => void;
};

// A Discover activity you've starred (see the hollow/solid star on
// explore.tsx's cards) - light yellow rather than the cream Ping cards
// use, so "something I'm just interested in, haven't committed to" reads
// as visually distinct from a real Ping at a glance. Tapping the star
// again un-stars it right from here, same as tapping it again on Discover
// would - deciding "actually no" shouldn't require navigating back there.
export default function InterestedActivityCard({ activity, onPress, onUnstar }: Props) {
  const dateLabel = formatEventDate(activity.startsAt, null, 'short');
  const timeLabel = formatEventTime(activity.startsAt, false, activity.endsAt);

  return (
    <TouchableOpacity style={styles.wrapper} activeOpacity={0.85} onPress={() => onPress?.(activity)}>
      <View style={styles.inner}>
        <TouchableOpacity
          style={styles.starButton}
          onPress={() => onUnstar?.(activity)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.starIcon}>★</Text>
        </TouchableOpacity>

        <Text style={styles.title} numberOfLines={1}>
          {activity.title}
        </Text>

        <View style={styles.statBar}>
          <Text style={styles.statText}>
            {dateLabel} · {timeLabel}
          </Text>
          {!!activity.location && (
            <Text style={styles.statText} numberOfLines={1}>
              {activity.location}
            </Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginHorizontal: 20, marginVertical: 8, borderRadius: 20 },
  inner: {
    backgroundColor: colors.warningPale,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.warning,
    padding: 12,
  },
  starButton: { position: 'absolute', top: 14, right: 14, zIndex: 2 },
  starIcon: { fontSize: 22, color: colors.warning },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', marginBottom: 6, paddingRight: 28 },
  statBar: { borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.08)', paddingTop: 6, gap: 2 },
  statText: { color: colors.textSecondary, fontSize: 13 },
});
