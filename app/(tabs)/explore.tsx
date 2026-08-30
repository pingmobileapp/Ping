import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { openBrowserAsync } from 'expo-web-browser';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors } from '../../lib/theme';
import {
  Activity,
  ActivityCategory,
  activityKey,
  CATEGORY_LABELS,
  distanceFromCoords,
  fetchActivities,
  fetchInterestedKeys,
  isFreeActivity,
  toggleInterest,
} from '../../lib/discoverActivities';
import {
  createPersonalCalendarEvent,
  getCalendarPermissionStatus,
  requestCalendarAccess,
} from '../../lib/calendarConflicts';
import {
  Coords,
  LocationPermissionStatus,
  getCurrentCoords,
  getLocationPermissionStatus,
  requestLocationAccess,
} from '../../lib/location';
import { DailyWeather, fetchWeatherForEvents } from '../../lib/eventWeather';

const pad = (n: number) => String(n).padStart(2, '0');
const toDateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (dateKey: string, delta: number): string => {
  const [y, m, d] = dateKey.split('-').map(Number);
  return toDateKey(new Date(y, m - 1, d + delta));
};

// How many days ahead the date strip offers - matches DAYS_AHEAD in the
// refresh-activities edge functions, since there's no point letting
// someone swipe/tap past the window the backend actually populated.
const DATE_STRIP_DAYS = 30;
const DATE_CHIP_WIDTH = 52;

const formatDateHeading = (date: Date): string =>
  date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const formatTime = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// The card's source line is what lets someone verify a result themselves
// (especially the AI-search ones, which are inherently less certain than a
// ticketing platform's own data) - showing the raw internal source id
// ("ai_search") tells them nothing useful, but the actual domain the URL
// points to ("allevents.in", "lehicity.libcal.com") is exactly where the
// info came from.
const sourceDomain = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

const formatActivityTime = (activity: Activity): string => {
  const start = formatTime(new Date(activity.startsAt));
  if (!activity.endsAt) return start;
  return `${start} – ${formatTime(new Date(activity.endsAt))}`;
};

// Real data, written by the refresh-activities edge functions on a
// nightly schedule (see supabase/activities_cron.sql) - this screen only
// reads what's already in the activities table via fetchActivities.
export default function DiscoverScreen() {
  const params = useLocalSearchParams<{ date?: string; gapStart?: string; gapEnd?: string }>();
  const router = useRouter();
  // Always viewing exactly one day - defaults to today when opened
  // straight from the tab bar, or to the long-pressed day when arriving
  // from a WeekGrid gap. Swiping or tapping a date chip below moves this
  // independently of how the screen was entered.
  const [selectedDate, setSelectedDate] = useState(() => params.date ?? toDateKey(new Date()));
  const [selectedCategory, setSelectedCategory] = useState<ActivityCategory | null>(null);
  // Independent of category - free events show up across every category,
  // so this combines with whatever category is selected rather than
  // replacing it (e.g. "Free" + "Music" is a valid combination).
  const [freeOnly, setFreeOnly] = useState(false);
  const [showAllDay, setShowAllDay] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [weatherByPingId, setWeatherByPingId] = useState<Record<string, DailyWeather>>({});
  const [interestedKeys, setInterestedKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [locationPermission, setLocationPermission] = useState<LocationPermissionStatus | null>(null);
  const [coords, setCoords] = useState<Coords | null>(null);
  const dateListRef = useRef<FlatList<string>>(null);

  // Only meaningful while still looking at the exact day/gap that was
  // long-pressed - swiping to a different day makes a stale time window
  // from a different day's schedule meaningless, so it silently stops
  // applying rather than filtering the new day by the old day's gap.
  const gapAppliesHere = params.date === selectedDate;
  const gapStartMinutes = gapAppliesHere && params.gapStart ? Number(params.gapStart) : null;
  const gapEndMinutes = gapAppliesHere && params.gapEnd ? Number(params.gapEnd) : null;

  // A fresh long-press navigation (a new params.date) should jump the
  // view there, even if the user had swiped elsewhere on a previous visit
  // to this screen.
  useEffect(() => {
    if (params.date) setSelectedDate(params.date);
  }, [params.date]);

  useEffect(() => {
    setLoading(true);
    fetchActivities({ dateKey: selectedDate })
      .then(setActivities)
      .finally(() => setLoading(false));
  }, [selectedDate]);

  useEffect(() => {
    fetchInterestedKeys().then(setInterestedKeys);
  }, [selectedDate]);

  // Optimistic - flips the star immediately rather than waiting on the
  // round trip, reverting only if the write actually failed.
  const handleToggleInterest = async (activity: Activity) => {
    const key = activityKey(activity);
    const wasInterested = interestedKeys.has(key);
    setInterestedKeys((prev) => {
      const next = new Set(prev);
      if (wasInterested) next.delete(key);
      else next.add(key);
      return next;
    });
    const ok = await toggleInterest(activity, !wasInterested);
    if (!ok) {
      setInterestedKeys((prev) => {
        const next = new Set(prev);
        if (wasInterested) next.add(key);
        else next.delete(key);
        return next;
      });
    }
  };

  // Weather only for Ping-sourced listings, not the aggregator activities
  // (Ticketmaster etc.) - those weren't part of this ask, and already show
  // their own verified distance instead.
  useEffect(() => {
    const pingItems = activities
      .filter((a) => a.source === 'ping' && a.pingEventId)
      .map((a) => ({ id: a.pingEventId!, location: a.location, event_date: a.startsAt }));
    if (pingItems.length === 0) return;
    fetchWeatherForEvents(pingItems).then((result) =>
      setWeatherByPingId((prev) => ({ ...prev, ...result }))
    );
  }, [activities]);

  // Checks silently on load (no prompt) so returning users who already
  // granted access get real per-user distance without an extra tap -
  // first-time users see the inline banner below instead.
  useEffect(() => {
    getLocationPermissionStatus().then((status) => {
      setLocationPermission(status);
      if (status === 'granted') getCurrentCoords().then(setCoords);
    });
  }, []);

  const handleEnableLocation = async () => {
    const granted = await requestLocationAccess();
    setLocationPermission(granted ? 'granted' : 'denied');
    if (granted) setCoords(await getCurrentCoords());
  };

  const dateStripKeys = useMemo(() => {
    const start = toDateKey(new Date());
    return Array.from({ length: DATE_STRIP_DAYS }, (_, i) => addDays(start, i));
  }, []);

  useEffect(() => {
    const index = dateStripKeys.indexOf(selectedDate);
    if (index >= 0) {
      dateListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    }
  }, [selectedDate, dateStripKeys]);

  const changeDay = (delta: number) => {
    setSelectedDate((prev) => addDays(prev, delta));
  };

  // Lets the results area itself be swiped left/right to move a day,
  // the same way Home's Upcoming list can be swiped to change months -
  // activeOffsetX/failOffsetY keep this from hijacking the list's own
  // vertical scroll, only taking over once the drag is clearly horizontal.
  const daySwipe = Gesture.Pan()
    .activeOffsetX([-20, 20])
    .failOffsetY([-10, 10])
    .onEnd((e) => {
      if (e.translationX <= -40) {
        runOnJS(changeDay)(1);
      } else if (e.translationX >= 40) {
        runOnJS(changeDay)(-1);
      }
    });

  const timeScoped = useMemo(() => {
    if (showAllDay || gapStartMinutes === null || gapEndMinutes === null) return activities;
    return activities.filter((a) => {
      const start = new Date(a.startsAt);
      const mins = start.getHours() * 60 + start.getMinutes();
      return mins >= gapStartMinutes && mins <= gapEndMinutes;
    });
  }, [activities, gapStartMinutes, gapEndMinutes, showAllDay]);

  const visibleActivities = useMemo(() => {
    let list = timeScoped;
    if (selectedCategory) list = list.filter((a) => a.category === selectedCategory);
    if (freeOnly) list = list.filter(isFreeActivity);
    return list;
  }, [timeScoped, selectedCategory, freeOnly]);

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

  // See EventCard.tsx's matching comment - same undocumented-but-commonly-
  // reported scheme, same graceful fallback if it can't be opened.
  const handleWeatherPress = () => {
    Linking.openURL('weather://').catch(() => {
      Alert.alert('Could not open Weather', "Your phone's Weather app couldn't be opened.");
    });
  };

  const handleViewListing = (activity: Activity) => {
    if (!activity.pingEventId) return;
    router.push({ pathname: '/event/[id]', params: { id: activity.pingEventId } });
  };

  const handleBook = (activity: Activity) => {
    if (!activity.url) return;
    // Not Linking.openURL - some of these domains (Ticketmaster in
    // particular) register Universal Links on iOS, so a plain Linking
    // call can hand off to that site's own native app instead of opening
    // the page, and that app doesn't always handle every URL shape the
    // website itself does (seen live as a "page not found" for a URL that
    // loads fine in an actual browser). openBrowserAsync opens an in-app
    // browser instead, which doesn't participate in that handoff - same
    // approach ExternalLink already uses elsewhere in this app.
    openBrowserAsync(activity.url).catch(() => {
      Alert.alert('Error', 'Could not open that link.');
    });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Discover</Text>
        <Text style={styles.subtitle}>
          {formatDateHeading(new Date(`${selectedDate}T00:00:00`))}
          {gapStartMinutes !== null && gapEndMinutes !== null && !showAllDay
            ? ` · ${formatTime(new Date(0, 0, 0, Math.floor(gapStartMinutes / 60), gapStartMinutes % 60))} – ${formatTime(
                new Date(0, 0, 0, Math.floor(gapEndMinutes / 60), gapEndMinutes % 60)
              )}`
            : ''}
          {' · within 25 mi'}
        </Text>
        {gapStartMinutes !== null && gapEndMinutes !== null && (
          <TouchableOpacity onPress={() => setShowAllDay((v) => !v)}>
            <Text style={styles.toggleText}>{showAllDay ? 'Show just my free time' : 'See all day'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {locationPermission === 'undetermined' && (
        <TouchableOpacity style={styles.locationPromptRow} onPress={handleEnableLocation}>
          <Text style={styles.locationPromptText}>📍 Use your location to see what&apos;s actually near you</Text>
        </TouchableOpacity>
      )}

      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={categories}
        keyExtractor={(c) => c}
        style={styles.chipRow}
        contentContainerStyle={styles.chipRowContent}
        ListHeaderComponent={
          // A plain Fragment here doesn't lay its children out in a row -
          // FlatList gives ListHeaderComponent its own single slot in the
          // horizontal flow, and a bare Fragment's children fall back to
          // View's default column direction inside that one slot (seen
          // live as "Free" stacking under "All" instead of beside it).
          <View style={styles.chipHeaderRow}>
            <TouchableOpacity
              style={[styles.chip, selectedCategory === null && styles.chipActive]}
              onPress={() => setSelectedCategory(null)}
            >
              <Text style={[styles.chipText, selectedCategory === null && styles.chipTextActive]}>All</Text>
            </TouchableOpacity>
            {/* Independent toggle, not part of the category selection above -
                see freeOnly. */}
            <TouchableOpacity style={[styles.chip, freeOnly && styles.chipActive]} onPress={() => setFreeOnly((v) => !v)}>
              <Text style={[styles.chipText, freeOnly && styles.chipTextActive]}>Free</Text>
            </TouchableOpacity>
          </View>
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

      <FlatList
        ref={dateListRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        data={dateStripKeys}
        keyExtractor={(d) => d}
        style={styles.dateRow}
        contentContainerStyle={styles.dateRowContent}
        getItemLayout={(_, index) => ({ length: DATE_CHIP_WIDTH, offset: DATE_CHIP_WIDTH * index, index })}
        onScrollToIndexFailed={(info) => {
          setTimeout(() => dateListRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 }), 50);
        }}
        renderItem={({ item, index }) => {
          const [y, m, d] = item.split('-').map(Number);
          const date = new Date(y, m - 1, d);
          const active = item === selectedDate;
          return (
            <TouchableOpacity
              style={[styles.dateChip, active && styles.dateChipActive]}
              onPress={() => setSelectedDate(item)}
            >
              <Text style={[styles.dateChipDow, active && styles.dateChipTextActive]}>
                {index === 0 ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'short' })}
              </Text>
              <Text style={[styles.dateChipNum, active && styles.dateChipTextActive]}>{d}</Text>
            </TouchableOpacity>
          );
        }}
      />

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : (
        <GestureDetector gesture={daySwipe}>
          <FlatList
            style={{ flex: 1 }}
            data={visibleActivities}
            keyExtractor={(a) => a.id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => {
              const distance = distanceFromCoords(item, coords);
              const weather = item.pingEventId ? weatherByPingId[item.pingEventId] : null;
              const interested = interestedKeys.has(activityKey(item));
              return (
                <View style={styles.card}>
                  {/* Not for a Ping you're hosting/joined - that already has its
                      own RSVP, starring it too would just be a confusing second
                      way to say the same thing. */}
                  {item.source !== 'ping' && (
                    <TouchableOpacity
                      style={styles.starButton}
                      onPress={() => handleToggleInterest(item)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.starIcon}>{interested ? '★' : '☆'}</Text>
                    </TouchableOpacity>
                  )}
                  <View style={styles.cardHeaderRow}>
                    <Text style={styles.cardCategory}>{CATEGORY_LABELS[item.category]}</Text>
                    {distance !== null && <Text style={styles.cardDistance}>{distance.toFixed(1)} mi</Text>}
                  </View>
                  <Text style={[styles.cardTitle, { paddingRight: 28 }]}>{item.title}</Text>
                  <View style={styles.cardMetaRow}>
                    <Text style={[styles.cardMeta, { flexShrink: 1 }]} numberOfLines={1}>
                      {formatDateHeading(new Date(item.startsAt))} · {formatActivityTime(item)}
                    </Text>
                    {!!weather && (
                      <TouchableOpacity onPress={handleWeatherPress} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={styles.cardWeatherText}>
                          {weather.icon} {weather.highF}°/{weather.lowF}°
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {!!item.location && <Text style={styles.cardMeta}>{item.location}</Text>}
                  {!!item.description && <Text style={styles.cardDescription}>{item.description}</Text>}
                  <View style={styles.cardFooterRow}>
                    <Text style={styles.cardPrice}>{item.priceLabel || 'See listing'}</Text>
                    {item.source === 'ping' ? (
                      <Text style={styles.cardSource}>posted on Ping</Text>
                    ) : (
                      !!sourceDomain(item.url) && <Text style={styles.cardSource}>via {sourceDomain(item.url)}</Text>
                    )}
                  </View>
                  {item.confidence === 'low' && (
                    <Text style={styles.aiDisclaimer}>
                      ⚠️ Found via AI search, not a ticketing platform - worth double-checking the details before
                      you go.
                    </Text>
                  )}
                  <View style={styles.cardActionsRow}>
                    {item.source === 'ping' ? (
                      <TouchableOpacity style={styles.bookButton} onPress={() => handleViewListing(item)}>
                        <Text style={styles.bookButtonText}>View & RSVP</Text>
                      </TouchableOpacity>
                    ) : (
                      <>
                        <TouchableOpacity style={styles.bookButton} onPress={() => handleBook(item)} disabled={!item.url}>
                          {/* AI-search results aren't a real booking flow - this link
                              is how someone verifies the details themselves, so it
                              shouldn't imply a purchase the way "Book" does. */}
                          <Text style={styles.bookButtonText}>{item.source.startsWith('ai_search') ? 'View Source' : 'Book'}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.calendarButton} onPress={() => handleAddToCalendar(item)}>
                          <Text style={styles.calendarButtonText}>Add to My Calendar</Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                </View>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                Nothing found for this day yet - try &quot;See all day&quot;, a different filter, or swipe to
                another day.
              </Text>
            }
          />
        </GestureDetector>
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
  locationPromptRow: { paddingHorizontal: 20, marginBottom: 12 },
  locationPromptText: { color: colors.primaryDark, fontSize: 13 },
  dateRow: { flexGrow: 0, marginBottom: 8 },
  dateRowContent: { paddingHorizontal: 20, gap: 6 },
  dateChip: {
    width: DATE_CHIP_WIDTH - 6,
    backgroundColor: colors.surfaceLight,
    borderRadius: 12,
    paddingVertical: 8,
    alignItems: 'center',
    marginRight: 6,
  },
  dateChipActive: { backgroundColor: colors.primary },
  dateChipDow: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
  dateChipNum: { color: colors.textPrimary, fontSize: 16, fontWeight: '700', marginTop: 2 },
  dateChipTextActive: { color: colors.textOnPrimary },
  chipRow: { flexGrow: 0, marginBottom: 8 },
  chipRowContent: { paddingHorizontal: 20, gap: 8 },
  chipHeaderRow: { flexDirection: 'row', gap: 8 },
  chip: {
    backgroundColor: colors.surfaceLight,
    borderRadius: 100,
    paddingHorizontal: 12,
    paddingVertical: 5,
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
  starButton: { position: 'absolute', top: 14, right: 14, zIndex: 2 },
  starIcon: { fontSize: 24, color: colors.warning },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  cardCategory: { color: colors.primaryDark, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  cardDistance: { color: colors.textMuted, fontSize: 12 },
  cardTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: '700', marginBottom: 4 },
  cardMeta: { color: colors.textSecondary, fontSize: 13, marginBottom: 2 },
  cardMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  cardWeatherText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 2 },
  cardDescription: { color: colors.textMuted, fontSize: 13, marginTop: 4, fontStyle: 'italic' },
  cardFooterRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  cardPrice: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
  cardSource: { color: colors.textMuted, fontSize: 12 },
  aiDisclaimer: { color: colors.primaryDark, fontSize: 12, marginTop: 8, lineHeight: 16 },
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
