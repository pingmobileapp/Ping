import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { colors } from '../../lib/theme';
import {
  Activity,
  ActivityCategory,
  CATEGORY_LABELS,
  fetchActivities,
} from '../../lib/discoverActivities';
import {
  createPersonalCalendarEvent,
  getCalendarPermissionStatus,
  requestCalendarAccess,
} from '../../lib/calendarConflicts';

const formatDateHeading = (date: Date): string =>
  date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const formatTime = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const formatActivityTime = (activity: Activity): string => {
  const start = formatTime(new Date(activity.startsAt));
  if (!activity.endsAt) return start;
  return `${start} – ${formatTime(new Date(activity.endsAt))}`;
};

// Real data, written by the refresh-activities edge function on a nightly
// schedule (see supabase/activities_cron.sql) - this screen only reads
// what's already in the activities table via fetchActivities.
export default function DiscoverScreen() {
  const params = useLocalSearchParams<{ date?: string; gapStart?: string; gapEnd?: string }>();
  const [selectedCategory, setSelectedCategory] = useState<ActivityCategory | null>(null);
  const [showAllDay, setShowAllDay] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);

  const hasScope = !!params.date;
  const gapStartMinutes = params.gapStart ? Number(params.gapStart) : null;
  const gapEndMinutes = params.gapEnd ? Number(params.gapEnd) : null;

  useEffect(() => {
    setLoading(true);
    fetchActivities({ dateKey: params.date })
      .then(setActivities)
      .finally(() => setLoading(false));
  }, [params.date]);

  const timeScoped = useMemo(() => {
    if (showAllDay || gapStartMinutes === null || gapEndMinutes === null) return activities;
    return activities.filter((a) => {
      const start = new Date(a.startsAt);
      const mins = start.getHours() * 60 + start.getMinutes();
      return mins >= gapStartMinutes && mins <= gapEndMinutes;
    });
  }, [activities, gapStartMinutes, gapEndMinutes, showAllDay]);

  const visibleActivities = useMemo(() => {
    if (!selectedCategory) return timeScoped;
    return timeScoped.filter((a) => a.category === selectedCategory);
  }, [timeScoped, selectedCategory]);

  const categories = Object.keys(CATEGORY_LABELS) as ActivityCategory[];

  const handleAddToCalendar = async (activity: Activity) => {
    const status = await getCalendarPermissionStatus();
    let granted = status === 'granted';
    if (status === 'undetermined') granted = await requestCalendarAccess();
    if (!granted) {
      Alert.alert('Calendar access needed', 'Enable calendar access in Settings to add this to your calendar.');
      return;
    }
    const start = new Date(activity.startsAt);
    const end = activity.endsAt ? new Date(activity.endsAt) : new Date(start.getTime() + 60 * 60000);
    try {
      const details = [activity.location, activity.description, activity.url].filter(Boolean).join('\n');
      await createPersonalCalendarEvent(activity.title, start, end, false, details);
      Alert.alert('Added', `${activity.title} was added to your calendar.`);
    } catch (err) {
      console.error('Error adding activity to calendar:', err);
      Alert.alert('Error', 'Could not add that to your calendar.');
    }
  };

  const handleBook = (activity: Activity) => {
    if (!activity.url) return;
    Linking.openURL(activity.url).catch(() => {
      Alert.alert('Error', 'Could not open that link.');
    });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Discover</Text>
        {hasScope ? (
          <Text style={styles.subtitle}>
            {formatDateHeading(new Date(`${params.date}T00:00:00`))}
            {gapStartMinutes !== null && gapEndMinutes !== null && !showAllDay
              ? ` · ${formatTime(new Date(0, 0, 0, Math.floor(gapStartMinutes / 60), gapStartMinutes % 60))} – ${formatTime(
                  new Date(0, 0, 0, Math.floor(gapEndMinutes / 60), gapEndMinutes % 60)
                )}`
              : ''}
            {' · within 25 mi'}
          </Text>
        ) : (
          <Text style={styles.subtitle}>What&apos;s happening near you, within 25 mi</Text>
        )}
        {hasScope && gapStartMinutes !== null && gapEndMinutes !== null && (
          <TouchableOpacity onPress={() => setShowAllDay((v) => !v)}>
            <Text style={styles.toggleText}>{showAllDay ? 'Show just my free time' : 'See all day'}</Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={categories}
        keyExtractor={(c) => c}
        style={styles.chipRow}
        contentContainerStyle={styles.chipRowContent}
        ListHeaderComponent={
          <TouchableOpacity
            style={[styles.chip, selectedCategory === null && styles.chipActive]}
            onPress={() => setSelectedCategory(null)}
          >
            <Text style={[styles.chipText, selectedCategory === null && styles.chipTextActive]}>All</Text>
          </TouchableOpacity>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.chip, selectedCategory === item && styles.chipActive]}
            onPress={() => setSelectedCategory((prev) => (prev === item ? null : item))}
          >
            <Text style={[styles.chipText, selectedCategory === item && styles.chipTextActive]}>
              {CATEGORY_LABELS[item]}
            </Text>
          </TouchableOpacity>
        )}
      />

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={visibleActivities}
          keyExtractor={(a) => a.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.cardCategory}>{CATEGORY_LABELS[item.category]}</Text>
                {item.distanceMiles !== null && (
                  <Text style={styles.cardDistance}>{item.distanceMiles.toFixed(1)} mi</Text>
                )}
              </View>
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardMeta}>
                {formatDateHeading(new Date(item.startsAt))} · {formatActivityTime(item)}
              </Text>
              {!!item.location && <Text style={styles.cardMeta}>{item.location}</Text>}
              {!!item.description && <Text style={styles.cardDescription}>{item.description}</Text>}
              <View style={styles.cardFooterRow}>
                <Text style={styles.cardPrice}>{item.priceLabel || 'See listing'}</Text>
                <Text style={styles.cardSource}>via {item.source}</Text>
              </View>
              <View style={styles.cardActionsRow}>
                <TouchableOpacity style={styles.bookButton} onPress={() => handleBook(item)} disabled={!item.url}>
                  <Text style={styles.bookButtonText}>Book</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.calendarButton} onPress={() => handleAddToCalendar(item)}>
                  <Text style={styles.calendarButtonText}>Add to My Calendar</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              Nothing found for this window yet - try &quot;See all day&quot; or a different filter.
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 60 },
  header: { paddingHorizontal: 20, marginBottom: 12 },
  title: { color: colors.textPrimary, fontSize: 26, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, fontSize: 14, marginTop: 4 },
  toggleText: { color: colors.primary, fontSize: 13, fontWeight: '600', marginTop: 8 },
  chipRow: { flexGrow: 0, marginBottom: 8 },
  chipRowContent: { paddingHorizontal: 20, gap: 8 },
  chip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 100,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
  },
  chipActive: { backgroundColor: colors.primary },
  chipText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: colors.textOnPrimary },
  listContent: { paddingHorizontal: 20, paddingBottom: 40, gap: 14 },
  card: {
    backgroundColor: colors.surfaceLight,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
  },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  cardCategory: { color: colors.primaryDark, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  cardDistance: { color: colors.textMuted, fontSize: 12 },
  cardTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: '700', marginBottom: 4 },
  cardMeta: { color: colors.textSecondary, fontSize: 13, marginBottom: 2 },
  cardDescription: { color: colors.textMuted, fontSize: 13, marginTop: 4, fontStyle: 'italic' },
  cardFooterRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  cardPrice: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
  cardSource: { color: colors.textMuted, fontSize: 12 },
  cardActionsRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  bookButton: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  bookButtonText: { color: colors.textOnPrimary, fontSize: 14, fontWeight: '700' },
  calendarButton: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.primary,
    paddingVertical: 10,
    alignItems: 'center',
  },
  calendarButtonText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 60, fontSize: 15, paddingHorizontal: 20 },
});
