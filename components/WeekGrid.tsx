import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from 'react-native';
import Animated, {
  runOnJS,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue,
} from 'react-native-reanimated';
import { HOUR_BLOCK_HEIGHT } from 'react-native-calendars/src/timeline/Packer';
import { colors } from '../lib/theme';
import { DayColumnEvent, AllDayItem } from '../lib/weekTimeline';

const TIMELINE_LEFT_INSET = 50;
const DAY_LABEL_ROW_HEIGHT = 36;
const ALL_DAY_ROW_HEIGHT = 32;
const GRID_HEIGHT = 24 * HOUR_BLOCK_HEIGHT;

const pad = (n: number) => String(n).padStart(2, '0');
const toDayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfWeek = (d: Date) => {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - r.getDay());
  return r;
};
const formatHour = (hour: number) => {
  if (hour === 0) return '';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
};

export type WeekGridHandle = { scrollByDays: (delta: number) => void };

type Props = {
  rangeStart: Date;
  dayCount: number;
  // How many days into the range the initially-visible week starts - the
  // range extends both before and after it (see weekGridRangeStart in
  // app/(tabs)/index.tsx), so without this the grid would always open
  // showing the very start of the range instead of the week the user
  // actually asked for.
  initialDayIndex: number;
  eventsByDay: Record<string, DayColumnEvent[]>;
  allDayByDay: Record<string, AllDayItem[]>;
  height: number;
  onEventPress: (id: string) => void;
  onVisibleWeekChange: (weekStart: Date) => void;
};

// A continuously horizontally-scrollable multi-day hourly grid - built from
// scratch rather than on top of react-native-calendars' Timeline, which has
// no horizontal scroll of its own at all (its one ScrollView is
// vertical-only; day columns are laid out via absolute `left` positioning
// in a fixed-width container) and doesn't forward a ref, so its position
// can't be driven or read from outside. See the plan this was built from
// for the full reasoning.
//
// Structure: one vertical ScrollView (hours) containing a row of
// [hour-label sidebar | horizontal ScrollView (days, day-snapping)] - the
// sidebar shares the SAME vertical scroll as the day columns for free
// (same content, no sync code needed) since it's a sibling inside that one
// vertical ScrollView, not a separate scroll view of its own. The day-label
// header and all-day strip sit OUTSIDE that vertical scroll (so they never
// move vertically) but need their OWN horizontal position kept in sync with
// the main grid's horizontal scroll - that's the one place real syncing is
// needed, done via useAnimatedScrollHandler + scrollTo (both run on the UI
// thread, so there's no visible lag between the header/strip and the grid).
const WeekGrid = forwardRef<WeekGridHandle, Props>(
  (
    { rangeStart, dayCount, initialDayIndex, eventsByDay, allDayByDay, height, onEventPress, onVisibleWeekChange },
    ref,
  ) => {
    const columnWidth = Dimensions.get('window').width - TIMELINE_LEFT_INSET;
    const dayColumnWidth = columnWidth / 7;

    const dayKeys = useMemo(
      () =>
        Array.from({ length: dayCount }, (_, i) => {
          const d = new Date(rangeStart);
          d.setDate(d.getDate() + i);
          return d;
        }),
      [rangeStart, dayCount],
    );

    const mainScrollRef = useAnimatedRef<Animated.ScrollView>();
    const dayHeaderRef = useAnimatedRef<Animated.ScrollView>();
    const allDayRef = useAnimatedRef<Animated.ScrollView>();
    const verticalScrollRef = useRef<Animated.ScrollView>(null);
    const scrollX = useSharedValue(0);

    const horizontalScrollHandler = useAnimatedScrollHandler({
      onScroll: (event) => {
        scrollX.value = event.contentOffset.x;
        scrollTo(dayHeaderRef, event.contentOffset.x, 0, false);
        scrollTo(allDayRef, event.contentOffset.x, 0, false);
      },
    });

    // Without this the grid would always open at the very start of the
    // pre-rendered range (rangeStart), not the week the user actually
    // asked for - jumps once, on mount, no animation (a visible slide from
    // the range's edge to the right week on every open would be jarring).
    // Also scrolls vertically to roughly the current time, matching what
    // Timeline's own scrollToNow did before this replaced it.
    useEffect(() => {
      const x = initialDayIndex * dayColumnWidth;
      scrollX.value = x;
      mainScrollRef.current?.scrollTo({ x, y: 0, animated: false });
      dayHeaderRef.current?.scrollTo({ x, y: 0, animated: false });
      allDayRef.current?.scrollTo({ x, y: 0, animated: false });
      const now = new Date();
      const nowY = Math.max(0, (now.getHours() - 1) * HOUR_BLOCK_HEIGHT);
      verticalScrollRef.current?.scrollTo({ x: 0, y: nowY, animated: false });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reports which week is leading the viewport back up to the header
    // title (app/(tabs)/index.tsx) - only when it actually changes, not on
    // every pixel of scroll.
    const lastReportedWeekKey = useRef<string | null>(null);
    const reportVisibleWeek = (dayIndex: number) => {
      const clamped = Math.max(0, Math.min(dayCount - 1, dayIndex));
      const day = new Date(rangeStart);
      day.setDate(day.getDate() + clamped);
      const weekStart = startOfWeek(day);
      const key = toDayKey(weekStart);
      if (key !== lastReportedWeekKey.current) {
        lastReportedWeekKey.current = key;
        onVisibleWeekChange(weekStart);
      }
    };
    useAnimatedReaction(
      () => Math.round(scrollX.value / dayColumnWidth),
      (dayIndex) => {
        runOnJS(reportVisibleWeek)(dayIndex);
      },
    );

    useImperativeHandle(ref, () => ({
      // scrollTo here is the ScrollView instance's own imperative method
      // (via the ref's .current, same as any plain ref), not Reanimated's
      // standalone worklet-only scrollTo helper used above in the scroll
      // handler and mount effect - this runs from a normal onPress in
      // app/(tabs)/index.tsx, on the JS thread, so it needs the version
      // that's actually callable from there.
      scrollByDays: (delta: number) => {
        const target = Math.max(0, scrollX.value + delta * dayColumnWidth);
        mainScrollRef.current?.scrollTo({ x: target, y: 0, animated: true });
      },
    }));

    const now = new Date();
    const today = toDayKey(now);
    const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_BLOCK_HEIGHT;

    return (
      <View style={{ height }}>
        <View style={styles.headerRow}>
          <View style={{ width: TIMELINE_LEFT_INSET }} />
          <Animated.ScrollView
            ref={dayHeaderRef}
            horizontal
            scrollEnabled={false}
            showsHorizontalScrollIndicator={false}
          >
            {dayKeys.map((d) => {
              const key = toDayKey(d);
              return (
                <View key={key} style={[styles.dayLabelCell, { width: dayColumnWidth }]}>
                  <Text style={styles.dayLabelDow}>{d.toLocaleDateString(undefined, { weekday: 'short' })}</Text>
                  <Text style={[styles.dayLabelNum, key === today && styles.dayLabelNumToday]}>{d.getDate()}</Text>
                </View>
              );
            })}
          </Animated.ScrollView>
        </View>

        <View style={styles.allDayRow}>
          <View style={{ width: TIMELINE_LEFT_INSET }} />
          <Animated.ScrollView ref={allDayRef} horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false}>
            {dayKeys.map((d) => {
              const key = toDayKey(d);
              const dayItems = allDayByDay[key] || [];
              const first = dayItems[0];
              return (
                <View key={key} style={[styles.allDayCell, { width: dayColumnWidth }]}>
                  {first && (
                    <TouchableOpacity style={styles.allDayChip} onPress={() => onEventPress(first.id)}>
                      <Text style={styles.allDayChipText} numberOfLines={1}>
                        {first.title}
                        {dayItems.length > 1 ? ` +${dayItems.length - 1}` : ''}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </Animated.ScrollView>
        </View>

        <Animated.ScrollView ref={verticalScrollRef} showsVerticalScrollIndicator={false}>
          <View style={{ flexDirection: 'row' }}>
            <View style={{ width: TIMELINE_LEFT_INSET, height: GRID_HEIGHT }}>
              {Array.from({ length: 24 }, (_, hour) => (
                <Text key={hour} style={[styles.hourLabel, { top: hour * HOUR_BLOCK_HEIGHT - 6 }]}>
                  {formatHour(hour)}
                </Text>
              ))}
            </View>
            <Animated.ScrollView
              ref={mainScrollRef}
              horizontal
              snapToInterval={dayColumnWidth}
              decelerationRate="fast"
              onScroll={horizontalScrollHandler}
              scrollEventThrottle={16}
              showsHorizontalScrollIndicator={false}
              style={{ height: GRID_HEIGHT }}
            >
              {dayKeys.map((d) => {
                const key = toDayKey(d);
                const dayEvents = eventsByDay[key] || [];
                return (
                  <View key={key} style={[styles.dayColumn, { width: dayColumnWidth }]}>
                    {Array.from({ length: 23 }, (_, i) => (
                      <View key={i} style={[styles.hourLine, { top: (i + 1) * HOUR_BLOCK_HEIGHT }]} />
                    ))}
                    {key === today && (
                      <View style={[styles.nowLine, { top: nowTop }]}>
                        <View style={styles.nowDot} />
                      </View>
                    )}
                    {dayEvents.map((ev, i) => (
                      <TouchableOpacity
                        key={`${ev.id}-${i}`}
                        style={[
                          styles.eventBlock,
                          {
                            top: (ev.startMinutes / 60) * HOUR_BLOCK_HEIGHT,
                            height: Math.max(18, ((ev.endMinutes - ev.startMinutes) / 60) * HOUR_BLOCK_HEIGHT),
                            backgroundColor: ev.color || colors.primary,
                          },
                        ]}
                        onPress={() => onEventPress(ev.id)}
                      >
                        <Text style={styles.eventBlockText} numberOfLines={2}>
                          {ev.title}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                );
              })}
            </Animated.ScrollView>
          </View>
        </Animated.ScrollView>
      </View>
    );
  },
);

export default WeekGrid;

const styles = StyleSheet.create({
  headerRow: { height: DAY_LABEL_ROW_HEIGHT, flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.divider },
  dayLabelCell: { alignItems: 'center', justifyContent: 'center' },
  dayLabelDow: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
  dayLabelNum: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  dayLabelNumToday: { color: colors.primary },
  allDayRow: { height: ALL_DAY_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center' },
  allDayCell: { paddingHorizontal: 2, justifyContent: 'center' },
  allDayChip: { backgroundColor: colors.primaryPale, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  allDayChipText: { color: colors.textPrimary, fontSize: 10, fontWeight: '600' },
  hourLabel: { position: 'absolute', left: 0, right: 8, textAlign: 'right', fontSize: 11, color: colors.textSecondary },
  dayColumn: { height: GRID_HEIGHT },
  hourLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: colors.divider },
  nowLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: colors.danger, flexDirection: 'row', alignItems: 'center' },
  nowDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger, marginLeft: -4 },
  eventBlock: { position: 'absolute', left: 2, right: 2, borderRadius: 6, padding: 4, overflow: 'hidden' },
  eventBlockText: { color: colors.textOnPrimary, fontSize: 11, fontWeight: '600' },
});
